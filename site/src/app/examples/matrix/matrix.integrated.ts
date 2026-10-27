import { Component, DestroyRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectFrame, injectRoot, injectUniform } from '@typegpu-poc/angular';
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

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-matrix-scene',
  imports: [TgpuCanvas, MatrixPanel],
  template: `
    <app-matrix-panel [status]="statusLine()" [used]="fx().used" [phase]="phase()" [face]="face()" [typed]="typed()" (answered)="answer()">
      <canvas role="img" aria-label="Matrix mirror: the camera picture rewritten as falling green code, drawn on the GPU" [tgpuCanvas]="canvasOptions" (pointermove)="move($event)" (pointerdown)="down($event)" (pointerleave)="leave()">Matrix mirror: the camera picture rewritten as falling green code, drawn on the GPU</canvas>
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

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly reduced = injectReducedMotion();
  /** The canvas follows its CSS size, with a limit on the pixel ratio. */
  protected readonly canvasOptions = { maxPixelRatio: MAX_PIXEL_RATIO };

  // Application state: the picture source, the person model, the pointer and its ripples.
  private readonly status = signal<SourceStatus>('idle');
  private readonly modelStatus = signal<ModelStatus>('loading');
  private readonly videoSize = signal({ width: 640, height: 360 });
  protected readonly fx = signal(initialFx());
  private startedKind: SourceKind | undefined;
  // The hidden ending (a click on the head): its state, and what the page shows of it.
  private readonly ending = new Ending();
  private readonly look = signal<SequenceLook>({ chaos: 0, glitch: 0, openY: 1, openX: 1, dot: 0 });
  protected readonly phase = signal<Phase>('idle');
  protected readonly face = signal<FaceBox | undefined>(undefined);
  protected readonly typed = signal('');
  private readyAt: number | undefined;
  /** The time of the last frame: a click's ripple is born then. */
  private now = 0;
  protected readonly statusLine = computed(() => statusText(this.status(), this.source() === 'Demo' ? 'Demo' : 'Camera', this.modelStatus()));

  /** The camera or the demo; the stream is released with the component. */
  private readonly video = new VideoSource(() => {
    this.status.set(this.video.status);
    if (this.video.status === 'live') this.videoSize.set(this.video.size);
    // No camera: the example shows the demo instead, and the control says so.
    if (this.startedKind && needsFallback(this.video.status, this.startedKind)) this.setParam()('source', 'Demo');
  });

  // Who is a person: a neural network on the GPU. It owns its buffers and its mask texture, and gives them back with the component.
  private readonly person = new PersonMask(this.root, () => this.modelStatus.set(this.person.status));

  // GPU resources, each owned by this component and mirrored from signals where something outside drives them.
  private readonly view = injectUniform(View, { from: computed(() => viewData(this.canvas().size(), this.videoSize(), this.mirror(), this.glyph())) });
  private readonly params = injectUniform(Params, { from: computed(() => paramsData(this.speed(), this.cutoff(), this.reach(), this.palette(), this.reduced())) });
  private readonly effects = injectUniform(Effects, { from: computed(() => effectsData(this.fx(), this.look())) });
  private readonly clock = injectUniform(Clock);
  private readonly sampler = this.root.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  // One render pass draws the code from the video frame and the mask.
  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: matrixFragment(this.sampler, this.view, this.params, this.clock, this.effects),
  });

  private seenReset: number | undefined;

  constructor() {
    injectFrame(({ deltaSeconds, elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      const dt = Math.min(deltaSeconds, 0.05);
      this.now = elapsedSeconds;

      // Whatever the Source control says is what plays; a change starts the new picture, and the mask starts from nothing.
      const kind: SourceKind = this.source() === 'Demo' ? 'Demo' : 'Camera';
      if (kind !== this.startedKind) {
        this.startedKind = kind;
        this.readyAt = undefined;
        this.person.restart();
        void this.video.start(kind);
      }

      // The Reset button counts clicks.
      const resets = this.reset();
      if (this.seenReset !== undefined && resets !== this.seenReset) {
        this.fx.set(initialFx());
        const setParam = this.setParam();
        setParam('palette', DEFAULTS.palette);
        setParam('speed', DEFAULTS.speed);
        setParam('cutoff', DEFAULTS.cutoff);
        setParam('reach', DEFAULTS.reach);
        setParam('glyph', DEFAULTS.glyph);
        setParam('mirror', DEFAULTS.mirror);
      }
      this.seenReset = resets;

      // A ripple or the pointer fades by itself; the demo person walks in from the moment the picture starts.
      const fx = advanceFx(this.fx(), dt, elapsedSeconds);
      if (fx !== this.fx()) this.fx.set(fx);
      this.syncEnding(this.ending.frame(elapsedSeconds, this.video.ready, { cameraOff: () => this.video.stop(), cameraOn: () => this.restartPicture(kind) }), elapsedSeconds);
      // Asked after the ending moved on: it may have just switched the camera off, and a stopped video cannot be imported.
      const ready = this.video.ready;
      if (ready && !this.ending.dark) this.readyAt ??= elapsedSeconds;
      this.video.frame(elapsedSeconds, demoPresence(this.readyAt === undefined ? 0 : elapsedSeconds - this.readyAt));
      if (!ready) return;

      // The frame is imported again every frame: a texture that is only valid for it. The network runs on it when it is a new
      // picture, and the render pass reads it together with the mask.
      this.clock.write(clockData(elapsedSeconds, deltaSeconds));
      const external = this.root.device.importExternalTexture({ source: this.video.video });
      this.person.update(external, this.video.size, this.video.frameId);
      const frame = this.root.createBindGroup(frameLayout, { frame: external });
      const mask = this.root.createBindGroup(maskLayout, { mask: this.person.view });
      this.draw.withColorAttachment({ view: context }).with(frame).with(mask).draw(3);
    });
    // The camera, the network and its buffers are released with the component.
    inject(DestroyRef).onDestroy(() => {
      this.video.stop();
      this.person.destroy();
    });
  }

  /** A click on the head starts the ending, a click anywhere else opens the picture around it. */
  protected down(event: PointerEvent): void {
    const point = this.position(event);
    if (this.ending.busy) return;
    const size = this.canvas().size();
    const view = { canvasAspect: size ? size.width / size.height : 1, videoAspect: this.videoSize().width / this.videoSize().height, mirror: this.mirror() };
    if (!this.ending.click(this.now, point, view, this.person)) this.fx.update((fx) => pointerDown(fx, point.x, point.y, this.now));
  }

  /** The button of the question was pressed. */
  protected answer(): void {
    this.ending.answer(this.now);
  }

  /** The camera and the network start from nothing (the screen is black meanwhile). */
  private restartPicture(kind: SourceKind): void {
    this.person.restart();
    this.readyAt = undefined;
    void this.video.start(kind);
  }

  /** Tells the template and the shader what the ending is doing, when it changed. */
  private syncEnding(look: SequenceLook, now: number): void {
    const { phase, face } = this.ending.sequence;
    if (phase !== this.phase()) this.phase.set(phase);
    if (face !== this.face()) this.face.set(face);
    const typed = this.ending.typed(now);
    if (typed !== this.typed()) this.typed.set(typed);
    if (phase !== 'idle' || this.look().chaos !== 0 || this.look().openY !== 1) this.look.set(look);
  }

  protected move(event: PointerEvent): void {
    const { x, y } = this.position(event);
    this.fx.update((fx) => pointerMove(fx, x, y));
  }

  protected leave(): void {
    this.fx.update((fx) => pointerLeave(fx));
  }

  /** A pointer event as a position on the canvas, 0..1 across and down. */
  private position(event: PointerEvent): { x: number; y: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }
}

@Component({
  selector: 'app-matrix',
  imports: [MatrixScene, TgpuReady],
  template: `
    <app-matrix-scene
      *tgpuReady="let root; else fallback"
      [source]="source()" [palette]="palette()" [speed]="speed()" [cutoff]="cutoff()" [reach]="reach()" [glyph]="glyph()" [mirror]="mirror()"
      [reset]="reset()" [setParam]="setParam()"
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
export class MatrixIntegrated {
  readonly source = input.required<string>();
  readonly palette = input.required<string>();
  readonly speed = input.required<number>();
  readonly cutoff = input.required<number>();
  readonly reach = input.required<number>();
  readonly glyph = input.required<number>();
  readonly mirror = input.required<boolean>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number | boolean) => void>();
  protected readonly gpu = inject(TypeGpu);
}
