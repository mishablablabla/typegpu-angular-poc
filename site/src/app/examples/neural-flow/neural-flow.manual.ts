import {
  Component,
  DestroyRef,
  ElementRef,
  ErrorHandler,
  NgZone,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { common } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
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
  type NeuralState,
  type PointerInput,
} from './neural-flow.model';
import { ActivityReader, QUIET, type Activity } from './neural-flow.readback';
import { edgesData, noInputs, paramsData, pointerData, restingNeurons, shellData, sitesData, viewData } from './neural-flow.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-neural-flow-scene-manual',
  imports: [NeuralFlowPanel],
  template: `
    <app-neural-flow-panel
      [cursor]="cursor()"
      [used]="used()"
      [selected]="selected()"
      [connectivity]="connectivity()"
      [stateName]="mode()"
      [activity]="activity()"
    >
      <canvas role="img" aria-label="Neural flow: a procedural brain with signals travelling along its neural connections, drawn on the GPU"
        #canvas
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
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  // Application state: the camera, the pointer and what it selected; and what the GPU reports. The template needs a few things from it.
  private state = initialState();
  protected readonly used = signal(false);
  protected readonly selected = signal(-1);
  protected readonly cursor = signal('grab');
  protected readonly activity = signal<Activity>(QUIET);
  private readonly clock = new SimClock();
  private wall = 0;
  private lastPointer: { x: number; y: number } | undefined;

  constructor() {
    const gpu = inject(ManualGpu).state();
    if (gpu.status !== 'ready') throw new Error('NeuralFlowScene must only exist while the GPU is ready');
    const { root } = gpu;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);
    const reduced = injectReducedMotion();

    // Resources, and their cleanup. The topology is uploaded once, here.
    const neurons = root.createBuffer(Neurons, restingNeurons()).$usage('storage');
    const inputs = root.createBuffer(Inputs).$usage('storage');
    const light = root.createBuffer(Accum).$usage('storage');
    const shown = root.createBuffer(Shown).$usage('storage');
    const sites = root.createReadonly(Sites, sitesData());
    const edges = root.createReadonly(Edges, edgesData());
    const shell = root.createReadonly(Shell, shellData());
    const view = root.createUniform(View);
    const params = root.createUniform(Params);
    const pointer = root.createUniform(Pointer);
    const time = root.createUniform(Clock);
    const reader = new ActivityReader(neurons, (activity) => this.activity.set(activity));
    destroyRef.onDestroy(() => {
      reader.dispose();
      neurons.destroy();
      inputs.destroy();
      light.destroy();
      shown.destroy();
      sites.buffer.destroy();
      edges.buffer.destroy();
      shell.buffer.destroy();
      view.buffer.destroy();
      params.buffer.destroy();
      pointer.buffer.destroy();
      time.buffer.destroy();
    });

    // Two compute passes for the network, three that splat the brain as light, one that fades the light, and a render pass.
    const arrivals = root.createGuardedComputePipeline(arrivalKernel(edges, neurons.as('readonly'), inputs.as('mutable'), params, time));
    const fire = root.createGuardedComputePipeline(neuronKernel(neurons.as('mutable'), sites, inputs.as('mutable'), params, pointer, time));
    const splatShell = root.createGuardedComputePipeline(shellKernel(light.as('mutable'), shell, view));
    const splatNeurons = root.createGuardedComputePipeline(neuronSplatKernel(light.as('mutable'), neurons.as('readonly'), sites, view, pointer, time));
    const splatEdges = root.createGuardedComputePipeline(edgeSplatKernel(light.as('mutable'), edges, neurons.as('readonly'), sites, view, params, time));
    const resolve = root.createGuardedComputePipeline(resolveKernel(light.as('mutable'), shown.as('mutable'), time));
    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: neuralFragment(shown.as('readonly'), view),
    });

    // Canvas context and pixel size: browser only, after the view exists.
    let context: GPUCanvasContext | undefined;
    let size = { width: 1, height: 1 };
    afterNextRender(() => {
      const canvas = this.canvasRef().nativeElement;
      context = root.configureContext({ canvas });
      const observer = new ResizeObserver(([entry]) => {
        const box = entry?.contentBoxSize[0];
        if (!box) return;
        // CSS pixels times the pixel ratio, but never more than the limit.
        const scale = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
        canvas.width = Math.max(1, Math.round(box.inlineSize * scale));
        canvas.height = Math.max(1, Math.round(box.blockSize * scale));
        size = { width: canvas.width, height: canvas.height };
      });
      observer.observe(canvas);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    // Render loop: outside the zone, stopped on destroy, errors reported once.
    let frameId = 0;
    let stopped = false;
    let start: number | undefined;
    let last: number | undefined;
    let seenReset: number | undefined;
    let sent: { camera?: NeuralState['camera']; width?: number; height?: number; stimulus?: NeuralState['stimulus']; hovered?: number; selected?: number; params?: string } = {};
    const frame = (now: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        start ??= now;
        const elapsed = (now - start) / 1000;
        const deltaSeconds = last === undefined ? 0 : (now - last) / 1000;
        last = now;
        this.wall = elapsed;
        if (!context) return;

        // The reset button counts clicks: back to the starting view, the neurons at rest, and the controls to their defaults.
        if (seenReset !== undefined && this.reset() !== seenReset) {
          this.commit(resetState());
          neurons.write(restingNeurons());
          inputs.write(noInputs());
          this.setParam()('mode', DEFAULTS.state);
          this.setParam()('frequency', DEFAULTS.frequency);
          this.setParam()('connectivity', DEFAULTS.connectivity);
          this.setParam()('stimulation', DEFAULTS.stimulation);
        }
        seenReset = this.reset();

        // Camera inertia and the idle drift: the state moves on by itself.
        this.commit(advance(this.state, Math.min(deltaSeconds, 0.05), elapsed, reduced()));

        // Mirror the state and the controls into the uniforms, writing only what changed.
        const { camera, stimulus, hovered, selected } = this.state;
        if (camera !== sent.camera || size.width !== sent.width || size.height !== sent.height) {
          view.write(viewData(this.state, size));
          sent = { ...sent, camera, width: size.width, height: size.height };
        }
        if (stimulus !== sent.stimulus || hovered !== sent.hovered || selected !== sent.selected) {
          pointer.write(pointerData(this.state));
          sent = { ...sent, stimulus, hovered, selected };
        }
        const key = `${this.mode()}|${this.frequency()}|${this.connectivity()}|${this.stimulation()}`;
        if (key !== sent.params) {
          params.write(paramsData(this.mode(), this.frequency(), this.connectivity(), this.stimulation()));
          sent = { ...sent, params: key };
        }
        this.clock.advance(deltaSeconds, reduced());
        time.write({ time: this.clock.time, prev: this.clock.prev, dt: this.clock.dt, decay: this.clock.decay });

        // Pulses arrive, neurons fire; then the surface, the neurons and the connections are drawn as light, which fades into the picture.
        arrivals.dispatchThreads(EDGE_COUNT);
        fire.dispatchThreads(NEURONS);
        splatShell.dispatchThreads(SHELL_COUNT);
        splatNeurons.dispatchThreads(NEURONS);
        splatEdges.dispatchThreads(EDGE_COUNT, EDGE_SAMPLES);
        resolve.dispatchThreads(GRID_W, GRID_H);
        draw.withColorAttachment({ view: context }).draw(3);
        reader.poll(elapsed, this.clock.time, this.state.selected);
      } catch (error) {
        stopped = true;
        errors.handleError(error);
      }
    };
    zone.runOutsideAngular(() => (frameId = requestAnimationFrame(frame)));
    destroyRef.onDestroy(() => {
      stopped = true;
      cancelAnimationFrame(frameId);
    });
  }

  /** Takes a new state, and tells the template about the things it shows. */
  private commit(next: NeuralState): void {
    if (next === this.state) return;
    this.state = next;
    if (next.used !== this.used()) this.used.set(next.used);
    if (next.selected !== this.selected()) this.selected.set(next.selected);
    const cursor = next.mode === 'orbit' ? 'grabbing' : next.mode === 'stimulate' || next.hovered >= 0 ? 'crosshair' : 'grab';
    if (cursor !== this.cursor()) this.cursor.set(cursor);
  }

  protected down(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.commit(pointerDown(this.state, this.input(event)));
  }

  protected move(event: PointerEvent): void {
    this.commit(pointerMove(this.state, this.input(event)));
  }

  protected up(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.lastPointer = undefined;
    this.commit(pointerUp(this.state, this.wall));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.commit(pointerLeave(this.state));
  }

  protected zoom(event: WheelEvent): void {
    event.preventDefault();
    this.commit(wheel(this.state, event.deltaY, this.wall));
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
  selector: 'app-neural-flow-manual',
  imports: [NeuralFlowScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-neural-flow-scene-manual
          [mode]="mode()" [frequency]="frequency()" [connectivity]="connectivity()" [stimulation]="stimulation()" [reset]="reset()" [setParam]="setParam()"
        />
      }
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
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class NeuralFlowManual {
  readonly mode = input.required<string>();
  readonly frequency = input.required<number>();
  readonly connectivity = input.required<number>();
  readonly stimulation = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();
  protected readonly gpu = inject(ManualGpu);
}
