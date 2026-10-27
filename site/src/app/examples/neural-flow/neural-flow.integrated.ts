import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectBuffer, injectFrame, injectReadonly, injectRoot, injectUniform } from '@typegpu-poc/angular';
import {
  Accum,
  Clock,
  Edges,
  Inputs,
  Neurons,
  Params,
  Pointer,
  Shown,
  Shell,
  Sites,
  View,
  arrivalKernel,
  edgeSplatKernel,
  neuralFragment,
  neuronKernel,
  neuronSplatKernel,
  resolveKernel,
  shellKernel,
} from './neural-flow.gpu';
import { NeuralFlowPanel } from './neural-flow.panel';
import {
  DEFAULTS,
  EDGE_COUNT,
  EDGE_SAMPLES,
  GRID_H,
  GRID_W,
  MAX_PIXEL_RATIO,
  NEURONS,
  SHELL_COUNT,
  SimClock,
  advance,
  initialState,
  pointerDown,
  pointerLeave,
  pointerMove,
  pointerUp,
  reset as resetState,
  wheel,
  type PointerInput,
} from './neural-flow.model';
import { ActivityReader, QUIET, type Activity } from './neural-flow.readback';
import { edgesData, noInputs, paramsData, pointerData, restingNeurons, shellData, sitesData, viewData } from './neural-flow.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-neural-flow-scene',
  imports: [TgpuCanvas, NeuralFlowPanel],
  template: `
    <app-neural-flow-panel
      [cursor]="cursor()"
      [used]="state().used"
      [selected]="state().selected"
      [connectivity]="connectivity()"
      [stateName]="mode()"
      [activity]="activity()"
    >
      <canvas role="img" aria-label="Neural flow: a procedural brain with signals travelling along its neural connections, drawn on the GPU"
        [tgpuCanvas]="canvasOptions"
        (pointerdown)="down($event)"
        (pointermove)="move($event)"
        (pointerup)="up($event)"
        (pointercancel)="up($event)"
        (pointerleave)="leave()"
        (wheel)="zoom($event)"
      >Neural flow: a procedural brain with signals travelling along its neural connections, drawn on the GPU</canvas>
    </app-neural-flow-panel>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class NeuralFlowScene {
  readonly mode = input.required<string>();
  readonly frequency = input.required<number>();
  readonly connectivity = input.required<number>();
  readonly stimulation = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly reduced = injectReducedMotion();
  /** The canvas follows its CSS size, with a limit on the pixel ratio. */
  protected readonly canvasOptions = { maxPixelRatio: MAX_PIXEL_RATIO };

  // Application state: the camera, the pointer and what it selected, as one signal of immutable state; and what the GPU reports.
  protected readonly state = signal(initialState());
  protected readonly activity = signal<Activity>(QUIET);
  private readonly clock = new SimClock();
  private wall = 0;
  private lastPointer: { x: number; y: number } | undefined;
  protected readonly cursor = computed(() => {
    const { mode, hovered } = this.state();
    return mode === 'orbit' ? 'grabbing' : mode === 'stimulate' || hovered >= 0 ? 'crosshair' : 'grab';
  });

  // GPU resources, each owned by this component. The topology is uploaded once; the controls, the camera and the pointer are mirrored from signals.
  private readonly neurons = injectBuffer(Neurons, { initial: restingNeurons() }).$usage('storage');
  private readonly inputs = injectBuffer(Inputs).$usage('storage');
  private readonly light = injectBuffer(Accum).$usage('storage');
  private readonly shown = injectBuffer(Shown).$usage('storage');
  private readonly sites = injectReadonly(Sites, { initial: sitesData() });
  private readonly edges = injectReadonly(Edges, { initial: edgesData() });
  private readonly shell = injectReadonly(Shell, { initial: shellData() });
  private readonly view = injectUniform(View, { from: computed(() => viewData(this.state(), this.canvas().size())) });
  private readonly params = injectUniform(Params, {
    from: computed(() => paramsData(this.mode(), this.frequency(), this.connectivity(), this.stimulation())),
  });
  private readonly pointer = injectUniform(Pointer, { from: computed(() => pointerData(this.state())) });
  private readonly time = injectUniform(Clock);

  // Two compute passes for the network, three that splat the brain as light, one that fades the light, and a render pass.
  private readonly arrivals = this.root.createGuardedComputePipeline(
    arrivalKernel(this.edges, this.neurons.as('readonly'), this.inputs.as('mutable'), this.params, this.time),
  );
  private readonly fire = this.root.createGuardedComputePipeline(
    neuronKernel(this.neurons.as('mutable'), this.sites, this.inputs.as('mutable'), this.params, this.pointer, this.time),
  );
  private readonly splatShell = this.root.createGuardedComputePipeline(shellKernel(this.light.as('mutable'), this.shell, this.view));
  private readonly splatNeurons = this.root.createGuardedComputePipeline(
    neuronSplatKernel(this.light.as('mutable'), this.neurons.as('readonly'), this.sites, this.view, this.pointer, this.time),
  );
  private readonly splatEdges = this.root.createGuardedComputePipeline(
    edgeSplatKernel(this.light.as('mutable'), this.edges, this.neurons.as('readonly'), this.sites, this.view, this.params, this.time),
  );
  private readonly resolve = this.root.createGuardedComputePipeline(resolveKernel(this.light.as('mutable'), this.shown.as('mutable'), this.time));
  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: neuralFragment(this.shown.as('readonly'), this.view),
  });

  private readonly reader = new ActivityReader(this.neurons, (activity) => this.activity.set(activity));
  private seenReset: number | undefined;

  constructor() {
    injectFrame(({ deltaSeconds, elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.wall = elapsedSeconds;

      // The reset button counts clicks: back to the starting view, the neurons at rest, and the controls to their defaults.
      if (this.seenReset !== undefined && this.reset() !== this.seenReset) {
        this.state.set(resetState());
        this.neurons.write(restingNeurons());
        this.inputs.write(noInputs());
        this.setParam()('mode', DEFAULTS.state);
        this.setParam()('frequency', DEFAULTS.frequency);
        this.setParam()('connectivity', DEFAULTS.connectivity);
        this.setParam()('stimulation', DEFAULTS.stimulation);
      }
      this.seenReset = this.reset();

      // Camera inertia and the idle drift: the state moves on by itself.
      const moved = advance(this.state(), Math.min(deltaSeconds, 0.05), elapsedSeconds, this.reduced());
      if (moved !== this.state()) this.state.set(moved);

      this.clock.advance(deltaSeconds, this.reduced());
      this.time.write({ time: this.clock.time, prev: this.clock.prev, dt: this.clock.dt, decay: this.clock.decay });
      // Pulses arrive, neurons fire; then the surface, the neurons and the connections are drawn as light, which fades into the picture.
      this.arrivals.dispatchThreads(EDGE_COUNT);
      this.fire.dispatchThreads(NEURONS);
      this.splatShell.dispatchThreads(SHELL_COUNT);
      this.splatNeurons.dispatchThreads(NEURONS);
      this.splatEdges.dispatchThreads(EDGE_COUNT, EDGE_SAMPLES);
      this.resolve.dispatchThreads(GRID_W, GRID_H);
      this.draw.withColorAttachment({ view: context }).draw(3);
      this.reader.poll(elapsedSeconds, this.clock.time, this.state().selected);
    });
  }

  protected down(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.state.update((state) => pointerDown(state, this.input(event)));
  }

  protected move(event: PointerEvent): void {
    this.state.update((state) => pointerMove(state, this.input(event)));
  }

  protected up(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.lastPointer = undefined;
    this.state.update((state) => pointerUp(state, this.wall));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.state.update((state) => pointerLeave(state));
  }

  protected zoom(event: WheelEvent): void {
    event.preventDefault();
    this.state.update((state) => wheel(state, event.deltaY, this.wall));
  }

  /** A pointer event as the model wants it: a position on the canvas from -1 to 1, and the movement since the last one. */
  private input(event: PointerEvent): PointerInput {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const last = this.lastPointer;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: 1 - ((event.clientY - rect.top) / rect.height) * 2,
      aspect: rect.width / rect.height,
      now: this.wall,
      sim: this.clock.time,
      strength: this.stimulation(),
      dx: last ? (event.clientX - last.x) / rect.height : 0,
      dy: last ? (event.clientY - last.y) / rect.height : 0,
    };
  }
}

@Component({
  selector: 'app-neural-flow',
  imports: [NeuralFlowScene, TgpuReady],
  template: `
    <app-neural-flow-scene
      *tgpuReady="let root; else fallback"
      [mode]="mode()" [frequency]="frequency()" [connectivity]="connectivity()" [stimulation]="stimulation()" [reset]="reset()" [setParam]="setParam()"
    />
    <ng-template #fallback let-gpuState>
      @switch (gpuState.status) {
        @case ('unsupported') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">WebGPU is not available</p><p>This example needs WebGPU. Try a recent Chrome or Edge.</p></div>
        }
        @case ('failed') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">GPU initialization failed</p><button type="button" (click)="gpu.retry()">Retry</button></div>
        }
        @case ('lost') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">The GPU device was lost</p><button type="button" (click)="gpu.retry()">Reconnect</button></div>
        }
        @default {
          <div class="gpu-spinner" role="status"><span class="sr-only">Starting the GPU…</span></div>
        }
      }
    </ng-template>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class NeuralFlowIntegrated {
  readonly mode = input.required<string>();
  readonly frequency = input.required<number>();
  readonly connectivity = input.required<number>();
  readonly stimulation = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();
  protected readonly gpu = inject(TypeGpu);
}
