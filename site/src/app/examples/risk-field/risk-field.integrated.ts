import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectFrame, injectRoot, injectUniform, type CanvasSize } from '@typegpu-poc/angular';
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
} from './risk-field.model';
import { marksData, surfaceData, viewData } from './risk-field.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-risk-field-scene',
  imports: [TgpuCanvas, RiskFieldPanel],
  template: `
    <app-risk-field-panel
      [state]="state()" [volatility]="volatility()" [correlation]="correlation()" [scenario]="scenario()"
      [aspect]="aspect()" [cursor]="cursor()"
    >
      <canvas role="img" aria-label="Risk field: a three-dimensional value-at-risk landscape of a two-asset portfolio, drawn on the GPU"
        [tgpuCanvas]="canvasOptions"
        (resized)="onResize($event)"
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

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly reduced = injectReducedMotion();
  /** The canvas follows its CSS size, with a limit on the pixel ratio. */
  protected readonly canvasOptions = { maxPixelRatio: MAX_PIXEL_RATIO };

  // Application state: the camera, the selection and the pointer as one signal of immutable state; and the numbers the
  // surface is made of, which ease towards what the controls ask for.
  protected readonly state = signal(initialState());
  private readonly target = computed(() => effective(this.volatility(), this.correlation(), this.scenario()));
  /** Where the surface is on its way to the target (nothing until the first frame: the inputs have no value before it). */
  private readonly eased = signal<Effective | undefined>(undefined);
  private readonly shown = computed(() => this.eased() ?? this.target());
  /**
   * The canvas pixel size, from the `(resized)` output: it fires with the initial size and after every real resize, so the
   * size is plain state that the view uniform and the panel's labels are derived from.
   */
  private readonly size = signal<CanvasSize | undefined>(undefined);
  protected readonly aspect = computed(() => {
    const size = this.size();
    return size ? size.width / size.height : 1;
  });
  protected onResize(size: CanvasSize): void {
    this.size.set(size);
  }

  protected readonly cursor = computed(() => (this.state().press ? 'grabbing' : this.state().hover ? 'crosshair' : 'grab'));
  private now = 0;
  private time = 0;
  private lastPointer: { x: number; y: number } | undefined;

  // GPU resources, owned by this component and mirrored from signals. Only the clock is written by hand, every frame.
  private readonly view = injectUniform(View, { from: computed(() => viewData(this.state(), this.size())) });
  private readonly surface = injectUniform(Surface, { from: computed(() => surfaceData(this.shown())) });
  private readonly marks = injectUniform(Marks, { from: computed(() => marksData(this.state())) });
  private readonly clock = injectUniform(d.f32);

  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: riskFragment(this.surface, this.view, this.marks, this.clock),
  });

  private seenReset: number | undefined;

  constructor() {
    injectFrame(({ deltaSeconds, elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.now = elapsedSeconds;
      const dt = Math.min(deltaSeconds, 0.05);

      // The reset button counts clicks: back to the starting view and selection, and the controls to their defaults.
      if (this.seenReset !== undefined && this.reset() !== this.seenReset) {
        this.state.set(resetState());
        this.setParam()('volatility', DEFAULTS.volatility);
        this.setParam()('correlation', DEFAULTS.correlation);
        this.setParam()('scenario', DEFAULTS.scenario);
      }
      this.seenReset = this.reset();

      const moved = advance(this.state(), dt, elapsedSeconds, this.reduced());
      if (moved !== this.state()) this.state.set(moved);
      // The surface starts where the controls are and follows them from there. Until `eased` has a value `shown()` is the target itself,
      // and easing from the target to the target moves nothing, so a change of a control would jump instead of flowing.
      this.eased.update((current) => current ?? this.target());
      const eased = ease(this.shown(), this.target(), dt);
      if (eased !== this.shown()) this.eased.set(eased);

      this.time += dt * (this.reduced() ? 0.25 : 1);
      this.clock.write(this.time);
      this.draw.withColorAttachment({ view: context }).draw(3);
    });
  }

  protected down(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.state.update((state) => pointerDown(state, this.input(event)));
  }

  protected move(event: PointerEvent): void {
    this.state.update((state) => pointerMove(state, this.input(event), this.shown()));
  }

  protected up(event: PointerEvent, cancelled: boolean): void {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    const input = this.input(event);
    this.lastPointer = undefined;
    this.state.update((state) => pointerUp(state, input, this.shown(), cancelled));
  }

  protected leave(): void {
    this.lastPointer = undefined;
    this.state.update(pointerLeave);
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
  selector: 'app-risk-field',
  imports: [RiskFieldScene, TgpuReady],
  template: `
    <app-risk-field-scene
      *tgpuReady="let root; else fallback"
      [volatility]="volatility()" [correlation]="correlation()" [scenario]="scenario()" [reset]="reset()" [setParam]="setParam()"
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
export class RiskFieldIntegrated {
  readonly volatility = input.required<number>();
  readonly correlation = input.required<number>();
  readonly scenario = input.required<string>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: number | string) => void>();
  protected readonly gpu = inject(TypeGpu);
}
