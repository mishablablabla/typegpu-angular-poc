import {
  Component,
  DestroyRef,
  ElementRef,
  ErrorHandler,
  NgZone,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { common, d } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
import { Marks, Surface, View, riskFragment } from './risk-field.gpu';
import { RiskFieldPanel } from './risk-field.panel';
import {
  DEFAULTS,
  MAX_PIXEL_RATIO,
  advance,
  effective,
  ease,
  initialState,
  pointerDown,
  pointerLeave,
  pointerMove,
  pointerUp,
  reset as resetState,
  wheel,
  type Effective,
  type PointerInput,
  type RiskState,
} from './risk-field.model';
import { marksData, surfaceData, viewData } from './risk-field.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-risk-field-scene-manual',
  imports: [RiskFieldPanel],
  template: `
    <app-risk-field-panel
      [state]="shown()" [volatility]="volatility()" [correlation]="correlation()" [scenario]="scenario()"
      [aspect]="aspect()" [cursor]="cursor()"
    >
      <canvas role="img" aria-label="Risk field: a three-dimensional value-at-risk landscape of a two-asset portfolio, drawn on the GPU"
        #canvas
        (pointerdown)="down($event)"
        (pointermove)="move($event)"
        (pointerup)="up($event, false)"
        (pointercancel)="up($event, true)"
        (pointerleave)="leave()"
        (wheel)="zoom($event)"
      >Risk field: a three-dimensional value-at-risk landscape of a two-asset portfolio, drawn on the GPU</canvas>
    </app-risk-field-panel>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class RiskFieldScene {
  readonly volatility = input.required<number>();
  readonly correlation = input.required<number>();
  readonly scenario = input.required<string>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number | string) => void>();
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  // Application state: the camera, the selection and the pointer; the template needs to see it, so every change is
  // published to a signal. And the numbers the surface is made of, which ease towards what the controls ask for.
  private state = initialState();
  protected readonly shown = signal<RiskState>(this.state);
  protected readonly aspect = signal(1);
  protected readonly cursor = computed(() => (this.shown().press ? 'grabbing' : this.shown().hover ? 'crosshair' : 'grab'));
  private readonly target = computed(() => effective(this.volatility(), this.correlation(), this.scenario()));
  /** Where the surface is on its way to the target (set on the first frame: the inputs have no value before it). */
  private surfaceNow: Effective | undefined;
  private now = 0;
  private lastPointer: { x: number; y: number } | undefined;

  constructor() {
    const gpu = inject(ManualGpu).state();
    if (gpu.status !== 'ready') throw new Error('RiskFieldScene must only exist while the GPU is ready');
    const { root } = gpu;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);
    const reduced = injectReducedMotion();

    // Resources, and their cleanup.
    const view = root.createUniform(View);
    const surface = root.createUniform(Surface);
    const marks = root.createUniform(Marks);
    const clock = root.createUniform(d.f32);
    destroyRef.onDestroy(() => {
      view.buffer.destroy();
      surface.buffer.destroy();
      marks.buffer.destroy();
      clock.buffer.destroy();
    });

    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: riskFragment(surface, view, marks, clock),
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
        this.aspect.set(size.width / size.height);
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
    let time = 0;
    let sent: { camera?: RiskState['camera']; width?: number; height?: number; selected?: RiskState['selected']; hover?: RiskState['hover']; surface?: Effective } = {};
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

        // The reset button counts clicks: back to the starting view and selection, and the controls to their defaults.
        if (seenReset !== undefined && this.reset() !== seenReset) {
          this.commit(resetState());
          this.setParam()('volatility', DEFAULTS.volatility);
          this.setParam()('correlation', DEFAULTS.correlation);
          this.setParam()('scenario', DEFAULTS.scenario);
        }
        seenReset = this.reset();

        this.commit(advance(this.state, dt, elapsed, reduced()));
        const surfaceNow = (this.surfaceNow = ease(this.surfaceNow ?? this.target(), this.target(), dt));

        // Mirror the state into the uniforms, writing only what changed.
        const { camera, selected, hover } = this.state;
        if (camera !== sent.camera || size.width !== sent.width || size.height !== sent.height) {
          view.write(viewData(this.state, size));
          sent = { ...sent, camera, width: size.width, height: size.height };
        }
        if (selected !== sent.selected || hover !== sent.hover) {
          marks.write(marksData(this.state));
          sent = { ...sent, selected, hover };
        }
        if (surfaceNow !== sent.surface) {
          surface.write(surfaceData(surfaceNow));
          sent = { ...sent, surface: surfaceNow };
        }
        time += dt * (reduced() ? 0.25 : 1);
        clock.write(time);
        draw.withColorAttachment({ view: context }).draw(3);
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

  /** Takes a new state and publishes it to the template. */
  private commit(next: RiskState): void {
    if (next === this.state) return;
    this.state = next;
    this.shown.set(next);
  }

  protected down(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.commit(pointerDown(this.state, this.input(event)));
  }

  protected move(event: PointerEvent): void {
    this.commit(pointerMove(this.state, this.input(event), this.surfaceNow ?? this.target()));
  }

  protected up(event: PointerEvent, cancelled: boolean): void {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    const input = this.input(event);
    this.lastPointer = undefined;
    this.commit(pointerUp(this.state, input, this.surfaceNow ?? this.target(), cancelled));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.commit(pointerLeave(this.state));
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
  selector: 'app-risk-field-manual',
  imports: [RiskFieldScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-risk-field-scene-manual
          [volatility]="volatility()" [correlation]="correlation()" [scenario]="scenario()" [reset]="reset()" [setParam]="setParam()"
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
export class RiskFieldManual {
  readonly volatility = input.required<number>();
  readonly correlation = input.required<number>();
  readonly scenario = input.required<string>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number | string) => void>();
  protected readonly gpu = inject(ManualGpu);
}
