import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectBuffer, injectFrame, injectRoot, injectUniform, type FrameRef } from '@typegpu-poc/angular';
import { Accum, Clock, Disturbance, Params, Particles, Shown, View, RIPPLE_SAMPLES, coreFragment, fieldKernel, plasmaKernel, resolveKernel, rippleKernel, structureKernel } from './core.gpu';
import { CorePanel } from './core.panel';
import {
  DEFAULTS,
  FIELD_LINES,
  GRID_H,
  GRID_W,
  LINE_SAMPLES,
  MAX_PIXEL_RATIO,
  MAX_EVENTS,
  PARTICLES,
  STRANDS,
  STRAND_SAMPLES,
  advance,
  initialState,
  pointerDown,
  pointerLeave,
  pointerMove,
  pointerUp,
  reset as resetState,
  trailDecay,
  wheel,
  type PointerInput,
} from './core.model';
import { disturbanceData, paramsData, viewData } from './core.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-core-scene',
  imports: [TgpuCanvas, CorePanel],
  template: `
    <app-core-panel [cursor]="cursor()" [used]="state().used">
      <canvas role="img" aria-label="THE CORE: a fictional fusion reactor with plasma particles and field lines, drawn on the GPU"
        [tgpuCanvas]="canvasOptions"
        (pointerdown)="down($event)"
        (pointermove)="move($event)"
        (pointerup)="up($event)"
        (pointercancel)="up($event)"
        (pointerleave)="leave()"
        (wheel)="zoom($event)"
      >THE CORE: a fictional fusion reactor with plasma particles and field lines, drawn on the GPU</canvas>
    </app-core-panel>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
  // `data-paused` says whether the frame loop is stopped because the reactor is scrolled out of view.
  host: { '[attr.data-paused]': 'frame.paused()' },
})
export class CoreScene {
  readonly confinement = input.required<number>();
  readonly energy = input.required<number>();
  readonly instability = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number) => void>();

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly reduced = injectReducedMotion();
  /** The canvas follows its CSS size, with a limit on the pixel ratio. */
  protected readonly canvasOptions = { maxPixelRatio: MAX_PIXEL_RATIO };

  // Application state: the camera, the pointer and the disturbances it made, as one signal of immutable state.
  protected readonly state = signal(initialState());
  private now = 0;
  private lastPointer: { x: number; y: number } | undefined;
  protected readonly cursor = computed(() => {
    const { mode, over } = this.state();
    return mode === 'orbit' ? 'grabbing' : mode === 'plasma' || over ? 'crosshair' : 'grab';
  });

  // GPU resources, each owned by this component and mirrored from signals where something outside drives them.
  private readonly particles = injectBuffer(Particles).$usage('storage');
  private readonly light = injectBuffer(Accum).$usage('storage');
  private readonly shown = injectBuffer(Shown).$usage('storage');
  private readonly view = injectUniform(View, { from: computed(() => viewData(this.state(), this.canvas().size())) });
  private readonly disturbance = injectUniform(Disturbance, { from: computed(() => disturbanceData(this.state())) });
  private readonly params = injectUniform(Params, {
    from: computed(() => paramsData(this.confinement(), this.energy(), this.instability(), this.reduced())),
  });
  private readonly clock = injectUniform(Clock);

  // Five compute passes and a render pass over the same buffers.
  private readonly plasma = this.root.createGuardedComputePipeline(
    plasmaKernel(this.particles.as('mutable'), this.light.as('mutable'), this.view, this.params, this.clock, this.disturbance),
  );
  private readonly field = this.root.createGuardedComputePipeline(fieldKernel(this.light.as('mutable'), this.view, this.params, this.clock, this.disturbance));
  private readonly ripples = this.root.createGuardedComputePipeline(rippleKernel(this.light.as('mutable'), this.view, this.params, this.clock, this.disturbance));
  private readonly structure = this.root.createGuardedComputePipeline(structureKernel(this.light.as('mutable'), this.view));
  private readonly resolve = this.root.createGuardedComputePipeline(resolveKernel(this.light.as('mutable'), this.shown.as('mutable'), this.clock));
  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: coreFragment(this.shown.as('readonly'), this.view, this.clock),
  });

  private seenReset: number | undefined;

  /** Controls this component's frame callback: paused while the reactor is off screen. */
  protected readonly frame: FrameRef;

  constructor() {
    this.frame = injectFrame(({ deltaSeconds, elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.now = elapsedSeconds;
      const dt = Math.min(deltaSeconds, 0.05);

      // The reset button counts clicks: back to the starting view, and the three controls to their defaults.
      if (this.seenReset !== undefined && this.reset() !== this.seenReset) {
        this.state.set(resetState());
        this.setParam()('confinement', DEFAULTS.confinement);
        this.setParam()('energy', DEFAULTS.energy);
        this.setParam()('instability', DEFAULTS.instability);
      }
      this.seenReset = this.reset();

      // Camera inertia, the idle drift, the vortex fading: the state moves on by itself.
      const moved = advance(this.state(), dt, elapsedSeconds, this.reduced());
      if (moved !== this.state()) this.state.set(moved);

      this.clock.write({ time: elapsedSeconds, dt: dt * (this.reduced() ? 0.4 : 1), decay: trailDecay(dt) });
      // Light from the previous frame fades in `resolve`; this frame's is added by the four passes below it.
      this.plasma.dispatchThreads(PARTICLES);
      this.field.dispatchThreads(FIELD_LINES, LINE_SAMPLES);
      this.structure.dispatchThreads(STRANDS, STRAND_SAMPLES);
      this.ripples.dispatchThreads(MAX_EVENTS + 1, RIPPLE_SAMPLES);
      this.resolve.dispatchThreads(GRID_W, GRID_H);
      this.draw.withColorAttachment({ view: context }).draw(3);
    });

    // Nothing to draw while the canvas is scrolled out of view: stop the callback, and start it again when it returns.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) this.frame.resume();
        else this.frame.pause();
      });
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
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
    this.state.update((state) => pointerUp(state, this.now));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.state.update((state) => pointerLeave(state, this.now));
  }

  protected zoom(event: WheelEvent): void {
    event.preventDefault();
    this.state.update((state) => wheel(state, event.deltaY, this.now));
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
      now: this.now,
      dx: last ? (event.clientX - last.x) / rect.height : 0,
      dy: last ? (event.clientY - last.y) / rect.height : 0,
    };
  }
}

@Component({
  selector: 'app-core',
  imports: [CoreScene, TgpuReady],
  template: `
    <app-core-scene
      *tgpuReady="let root; else fallback"
      [confinement]="confinement()" [energy]="energy()" [instability]="instability()" [reset]="reset()" [setParam]="setParam()"
    />
    <ng-template #fallback let-state>
      @switch (state.status) {
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
export class CoreIntegrated {
  readonly confinement = input.required<number>();
  readonly energy = input.required<number>();
  readonly instability = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number) => void>();
  protected readonly gpu = inject(TypeGpu);
}
