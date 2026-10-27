import { Component, DestroyRef, ElementRef, ErrorHandler, NgZone, afterNextRender, inject, input, signal, viewChild } from '@angular/core';
import { common } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
import { Clock, Effects, Params, View, frameLayout, maskLayout, matrixFragment } from './matrix.gpu';
import { MatrixPanel } from './matrix.panel';
import {
  DEFAULTS,
  MAX_PIXEL_RATIO,
  advanceFx,
  demoPresence,
  initialFx,
  needsFallback,
  pointerDown,
  pointerLeave,
  pointerMove,
  statusText,
  type Fx,
  type ModelStatus,
  type SourceKind,
  type SourceStatus,
} from './matrix.model';
import { Ending } from './matrix.ending';
import type { FaceBox } from './matrix.face';
import { PersonMask } from './matrix.person';
import type { Phase, SequenceLook } from './matrix.sequence';
import { VideoSource } from './matrix.source';
import { clockData, effectsData, paramsData, viewData } from './matrix.uniforms';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-matrix-scene-manual',
  imports: [MatrixPanel],
  template: `
    <app-matrix-panel [status]="statusLine()" [used]="used()" [phase]="phase()" [face]="face()" [typed]="typed()" (answered)="answer()">
      <canvas role="img" aria-label="Matrix mirror: the camera picture rewritten as falling green code, drawn on the GPU" #canvas (pointermove)="move($event)" (pointerdown)="down($event)" (pointerleave)="leave()">Matrix mirror: the camera picture rewritten as falling green code, drawn on the GPU</canvas>
    </app-matrix-panel>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class MatrixScene {
  readonly source = input.required<string>();
  readonly palette = input.required<string>();
  readonly speed = input.required<number>();
  readonly cutoff = input.required<number>();
  readonly reach = input.required<number>();
  readonly glyph = input.required<number>();
  readonly mirror = input.required<boolean>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number | boolean) => void>();
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  // Application state: the source, the person model, the pointer and its ripples. The template needs two things.
  private fx = initialFx();
  private now = 0;
  protected readonly statusLine = signal('');
  protected readonly used = signal(false);
  // The hidden ending (a click on the head): its state, and what the template shows of it.
  private readonly ending = new Ending();
  private look: SequenceLook = { chaos: 0, glitch: 0, openY: 1, openX: 1, dot: 0 };
  protected readonly phase = signal<Phase>('idle');
  protected readonly face = signal<FaceBox | undefined>(undefined);
  protected readonly typed = signal('');
  private person: PersonMask | undefined;
  private videoSize = { width: 640, height: 360 };
  private canvasSize = { width: 1, height: 1 };

  constructor() {
    const gpu = inject(ManualGpu).state();
    if (gpu.status !== 'ready') throw new Error('MatrixScene must only exist while the GPU is ready');
    const { root } = gpu;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);
    const reduced = injectReducedMotion();

    // The camera or the demo; the stream is released with the component. No camera: the example shows the demo instead.
    let status: SourceStatus = 'idle';
    let modelStatus: ModelStatus = 'loading';
    let videoSize = { width: 640, height: 360 };
    let startedKind: SourceKind | undefined;
    const video = new VideoSource(() => {
      status = video.status;
      if (status === 'live') this.videoSize = videoSize = video.size;
      if (startedKind && needsFallback(status, startedKind)) this.setParam()('source', 'Demo');
    });
    destroyRef.onDestroy(() => video.stop());

    // Who is a person: a neural network on the GPU. It owns its buffers and its mask texture; this component gives them back.
    const person = new PersonMask(root, () => (modelStatus = person.status));
    destroyRef.onDestroy(() => person.destroy());
    this.person = person;

    // Resources, and their cleanup.
    const view = root.createUniform(View);
    const params = root.createUniform(Params);
    const effects = root.createUniform(Effects);
    const clock = root.createUniform(Clock);
    const sampler = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    destroyRef.onDestroy(() => {
      view.buffer.destroy();
      params.buffer.destroy();
      effects.buffer.destroy();
      clock.buffer.destroy();
    });

    // One render pass draws the code from the video frame and the mask.
    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: matrixFragment(sampler, view, params, clock, effects),
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
        size = this.canvasSize = { width: canvas.width, height: canvas.height };
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
    let readyAt: number | undefined;
    let sent: { view?: string; params?: string } = {};
    const frame = (timestamp: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        start ??= timestamp;
        const elapsed = (timestamp - start) / 1000;
        const rawDt = last === undefined ? 0 : (timestamp - last) / 1000;
        const dt = Math.min(rawDt, 0.05);
        last = timestamp;
        this.now = elapsed;
        if (!context) return;

        // Whatever the Source control says is what plays; a change starts the new picture, and the mask starts from nothing.
        const kind: SourceKind = this.source() === 'Demo' ? 'Demo' : 'Camera';
        if (kind !== startedKind) {
          startedKind = kind;
          readyAt = undefined;
          person.restart();
          void video.start(kind);
        }

        // The Reset button counts clicks.
        const resets = this.reset();
        if (seenReset !== undefined && resets !== seenReset) {
          this.fx = initialFx();
          const setParam = this.setParam();
          setParam('palette', DEFAULTS.palette);
          setParam('speed', DEFAULTS.speed);
          setParam('cutoff', DEFAULTS.cutoff);
          setParam('reach', DEFAULTS.reach);
          setParam('glyph', DEFAULTS.glyph);
          setParam('mirror', DEFAULTS.mirror);
        }
        seenReset = resets;

        // A ripple or the pointer fades by itself; the demo person walks in from the moment the picture starts.
        this.fx = advanceFx(this.fx, dt, elapsed);
        this.sync(status, modelStatus);
        this.look = this.ending.frame(elapsed, video.ready, {
          cameraOff: () => video.stop(),
          cameraOn: () => {
            person.restart();
            readyAt = undefined;
            void video.start(kind);
          },
        });
        this.syncEnding(elapsed);
        // Asked after the ending moved on: it may have just switched the camera off, and a stopped video cannot be imported.
        const ready = video.ready;
        if (ready && !this.ending.dark) readyAt ??= elapsed;
        video.frame(elapsed, demoPresence(readyAt === undefined ? 0 : elapsed - readyAt));
        if (!ready) return;

        // Mirror the state and the controls into the uniforms, writing only what changed.
        const viewKey = `${size.width}x${size.height}|${videoSize.width}x${videoSize.height}|${this.mirror()}|${this.glyph()}`;
        if (viewKey !== sent.view) {
          sent = { ...sent, view: viewKey };
          view.write(viewData(size, videoSize, this.mirror(), this.glyph()));
        }
        const paramsKey = `${this.speed()}|${this.cutoff()}|${this.reach()}|${this.palette()}|${reduced()}`;
        if (paramsKey !== sent.params) {
          sent = { ...sent, params: paramsKey };
          params.write(paramsData(this.speed(), this.cutoff(), this.reach(), this.palette(), reduced()));
        }
        effects.write(effectsData(this.fx, this.look));
        clock.write(clockData(elapsed, rawDt));

        // The frame is imported again every frame: a texture that is only valid for it. The network runs on it when it is a new
        // picture, and the render pass reads it together with the mask.
        const external = root.device.importExternalTexture({ source: video.video });
        person.update(external, videoSize, video.frameId);
        const frameGroup = root.createBindGroup(frameLayout, { frame: external });
        const maskGroup = root.createBindGroup(maskLayout, { mask: person.view });
        draw.withColorAttachment({ view: context }).with(frameGroup).with(maskGroup).draw(3);
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

  /** Tells the template about the two things it shows, when they changed. */
  private sync(status: SourceStatus, model: ModelStatus): void {
    const line = statusText(status, this.source() === 'Demo' ? 'Demo' : 'Camera', model);
    if (line !== this.statusLine()) this.statusLine.set(line);
    if (this.fx.used !== this.used()) this.used.set(this.fx.used);
  }

  /** A click on the head starts the ending, a click anywhere else opens the picture around it. */
  protected down(event: PointerEvent): void {
    const point = this.position(event);
    if (this.ending.busy || !this.person) return;
    const view = { canvasAspect: this.canvasSize.width / this.canvasSize.height, videoAspect: this.videoSize.width / this.videoSize.height, mirror: this.mirror() };
    if (!this.ending.click(this.now, point, view, this.person)) this.fx = pointerDown(this.fx, point.x, point.y, this.now);
  }

  /** The button of the question was pressed. */
  protected answer(): void {
    this.ending.answer(this.now);
  }

  /** Tells the template what the ending is doing, when it changed. */
  private syncEnding(now: number): void {
    const { phase, face } = this.ending.sequence;
    if (phase !== this.phase()) this.phase.set(phase);
    if (face !== this.face()) this.face.set(face);
    const typed = this.ending.typed(now);
    if (typed !== this.typed()) this.typed.set(typed);
  }

  protected move(event: PointerEvent): void {
    const { x, y } = this.position(event);
    this.fx = pointerMove(this.fx, x, y);
  }

  protected leave(): void {
    this.fx = pointerLeave(this.fx);
  }

  /** A pointer event as a position on the canvas, 0..1 across and down. */
  private position(event: PointerEvent): { x: number; y: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }
}

@Component({
  selector: 'app-matrix-manual',
  imports: [MatrixScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-matrix-scene-manual
          [source]="source()" [palette]="palette()" [speed]="speed()" [cutoff]="cutoff()" [reach]="reach()" [glyph]="glyph()" [mirror]="mirror()"
          [reset]="reset()" [setParam]="setParam()"
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
export class MatrixManual {
  readonly source = input.required<string>();
  readonly palette = input.required<string>();
  readonly speed = input.required<number>();
  readonly cutoff = input.required<number>();
  readonly reach = input.required<number>();
  readonly glyph = input.required<number>();
  readonly mirror = input.required<boolean>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number | boolean) => void>();
  protected readonly gpu = inject(ManualGpu);
}
