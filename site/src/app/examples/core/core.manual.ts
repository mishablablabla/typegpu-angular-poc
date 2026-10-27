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
import { common, d } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
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
  type CoreState,
  type PointerInput,
} from './core.model';
import { disturbanceData, paramsData, viewData } from './core.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-core-scene-manual',
  imports: [CorePanel],
  template: `
    <app-core-panel [cursor]="cursor()" [used]="used()">
      <canvas role="img" aria-label="THE CORE: a fictional fusion reactor with plasma particles and field lines, drawn on the GPU"
        #canvas
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
  // `data-paused` says whether the render loop is stopped because the reactor is scrolled out of view.
  host: { '[attr.data-paused]': 'paused()' },
})
export class CoreScene {
  readonly confinement = input.required<number>();
  readonly energy = input.required<number>();
  readonly instability = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number) => void>();
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  // Application state: the camera, the pointer and the disturbances it made. The template needs two things from it.
  private state = initialState();
  protected readonly used = signal(false);
  protected readonly paused = signal(false);
  protected readonly cursor = signal('grab');
  private now = 0;
  private lastPointer: { x: number; y: number } | undefined;

  constructor() {
    const gpu = inject(ManualGpu).state();
    if (gpu.status !== 'ready') throw new Error('CoreScene must only exist while the GPU is ready');
    const { root } = gpu;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const reduced = injectReducedMotion();

    // Resources, and their cleanup.
    const particles = root.createBuffer(Particles).$usage('storage');
    const light = root.createBuffer(Accum).$usage('storage');
    const shown = root.createBuffer(Shown).$usage('storage');
    const view = root.createUniform(View);
    const disturbance = root.createUniform(Disturbance);
    const params = root.createUniform(Params);
    const clock = root.createUniform(Clock);
    destroyRef.onDestroy(() => {
      particles.destroy();
      light.destroy();
      shown.destroy();
      view.buffer.destroy();
      disturbance.buffer.destroy();
      params.buffer.destroy();
      clock.buffer.destroy();
    });

    // Five compute passes and a render pass over the same buffers.
    const plasma = root.createGuardedComputePipeline(plasmaKernel(particles.as('mutable'), light.as('mutable'), view, params, clock, disturbance));
    const field = root.createGuardedComputePipeline(fieldKernel(light.as('mutable'), view, params, clock, disturbance));
    const ripples = root.createGuardedComputePipeline(rippleKernel(light.as('mutable'), view, params, clock, disturbance));
    const structure = root.createGuardedComputePipeline(structureKernel(light.as('mutable'), view));
    const resolve = root.createGuardedComputePipeline(resolveKernel(light.as('mutable'), shown.as('mutable'), clock));
    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: coreFragment(shown.as('readonly'), view, clock),
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
    let sent: { camera?: CoreState['camera']; width?: number; height?: number; events?: CoreState['events']; vortex?: CoreState['vortex']; params?: string } = {};
    const frame = (now: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        start ??= now;
        const elapsed = (now - start) / 1000;
        const dt = last === undefined ? 0 : Math.min((now - last) / 1000, 0.05);
        last = now;
        this.now = elapsed;
        if (!context) return;

        // The reset button counts clicks: back to the starting view, and the three controls to their defaults.
        if (seenReset !== undefined && this.reset() !== seenReset) {
          this.commit(resetState());
          this.setParam()('confinement', DEFAULTS.confinement);
          this.setParam()('energy', DEFAULTS.energy);
          this.setParam()('instability', DEFAULTS.instability);
        }
        seenReset = this.reset();

        // Camera inertia, the idle drift, the vortex fading: the state moves on by itself.
        this.commit(advance(this.state, dt, elapsed, reduced()));

        // Mirror the state and the controls into the uniforms, writing only what changed.
        const { camera, events, vortex } = this.state;
        if (camera !== sent.camera || size.width !== sent.width || size.height !== sent.height) {
          view.write(viewData(this.state, size));
          sent = { ...sent, camera, width: size.width, height: size.height };
        }
        if (events !== sent.events || vortex !== sent.vortex) {
          disturbance.write(disturbanceData(this.state));
          sent = { ...sent, events, vortex };
        }
        const key = `${this.confinement()}|${this.energy()}|${this.instability()}|${reduced()}`;
        if (key !== sent.params) {
          params.write(paramsData(this.confinement(), this.energy(), this.instability(), reduced()));
          sent = { ...sent, params: key };
        }
        clock.write({ time: elapsed, dt: dt * (reduced() ? 0.4 : 1), decay: trailDecay(dt) });

        // Light from the previous frame fades in `resolve`; this frame's is added by the four passes before it.
        plasma.dispatchThreads(PARTICLES);
        field.dispatchThreads(FIELD_LINES, LINE_SAMPLES);
        structure.dispatchThreads(STRANDS, STRAND_SAMPLES);
        ripples.dispatchThreads(MAX_EVENTS + 1, RIPPLE_SAMPLES);
        resolve.dispatchThreads(GRID_W, GRID_H);
        draw.withColorAttachment({ view: context }).draw(3);
      } catch (error) {
        stopped = true;
        errors.handleError(error);
      }
    };
    const run = () => {
      if (!stopped && frameId === 0) zone.runOutsideAngular(() => (frameId = requestAnimationFrame(frame)));
    };
    const pause = () => {
      cancelAnimationFrame(frameId);
      frameId = 0;
    };
    run();
    destroyRef.onDestroy(() => {
      stopped = true;
      pause();
    });

    // Nothing to draw while the canvas is scrolled out of view: stop the loop, and start it again when it returns.
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(([entry]) => {
        const visible = entry?.isIntersecting ?? true;
        if (visible) run();
        else pause();
        this.paused.set(!visible);
      });
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Takes a new state, and tells the template about the two things it shows. */
  private commit(next: CoreState): void {
    if (next === this.state) return;
    this.state = next;
    if (next.used !== this.used()) this.used.set(next.used);
    const cursor = next.mode === 'orbit' ? 'grabbing' : next.mode === 'plasma' || next.over ? 'crosshair' : 'grab';
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
    this.commit(pointerUp(this.state, this.now));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.commit(pointerLeave(this.state, this.now));
  }

  protected zoom(event: WheelEvent): void {
    event.preventDefault();
    this.commit(wheel(this.state, event.deltaY, this.now));
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
  selector: 'app-core-manual',
  imports: [CoreScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-core-scene-manual
          [confinement]="confinement()" [energy]="energy()" [instability]="instability()" [reset]="reset()" [setParam]="setParam()"
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
export class CoreManual {
  readonly confinement = input.required<number>();
  readonly energy = input.required<number>();
  readonly instability = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number) => void>();
  protected readonly gpu = inject(ManualGpu);
}
