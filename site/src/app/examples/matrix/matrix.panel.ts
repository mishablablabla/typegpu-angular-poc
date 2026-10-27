// The little interface around the canvas in MATRIX MIRROR: the title, what the camera and the person model are doing, the
// hints, and the honest print, and the parts of the hidden ending that are text (the ERROR on the eyes, the question on the black
// screen with its button, the sentence being typed). It is plain Angular with no GPU in it, and both implementations use it; the
// canvas is projected behind it.
import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import type { FaceBox } from './matrix.face';
import { PROMISE, QUESTION, QUESTION_DETAIL, type Phase } from './matrix.sequence';

@Component({
  selector: 'app-matrix-panel',
  template: `
    <div class="stage">
      <ng-content />
      <header>
        <h2>MATRIX MIRROR</h2>
        <p class="status">{{ status() }}</p>
      </header>
      @if (phase() === 'idle' || phase() === 'boot') {
        <div class="footer">
          <p class="hints" [class.quiet]="used()">
            <span>Click: the code cracks open around the pointer</span>
            <span>Try clicking the face</span>
          </p>
          <p class="print">Processed on your GPU, never uploaded. Who is a person comes from a neural network (MediaPipe selfie segmentation, Google, Apache 2.0) that runs as TypeGPU compute shaders: no background to capture, and it keeps working while you move.</p>
        </div>
      }
      @if ((phase() === 'error' || phase() === 'chaos') && face(); as box) {
        <div class="error" role="alert" [style.left.%]="box.eyes.x * 100" [style.top.%]="box.eyes.y * 100" [style.--w]="errorWidth(box)">
          <span class="word" data-text="ERROR">ERROR</span>
        </div>
      }
      @if (phase() === 'confirm') {
        <div class="dark" role="dialog" aria-modal="true" aria-labelledby="matrix-question" aria-describedby="matrix-detail">
          <h3 id="matrix-question">{{ question }}</h3>
          <p id="matrix-detail" class="detail">{{ detail }}</p>
          <button #pill type="button" class="pill" (click)="answered.emit()"><span class="label">Take the blue pill</span></button>
        </div>
      }
      @if (phase() === 'typing') {
        <div class="dark" role="status">
          <p class="typed" [attr.aria-label]="promise"><span aria-hidden="true">{{ typed() }}</span><i class="cursor" aria-hidden="true"></i></p>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; background: #000402; color: #c9ffd9; container-type: size; container-name: matrix; }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; cursor: crosshair; }
    .stage ::ng-deep canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: inherit; touch-action: none; }
    header { position: absolute; top: 1.1rem; left: 1.25rem; right: 1.25rem; pointer-events: none; }
    h2 { margin: 0; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.42em; color: #e6fff0; text-shadow: 0 0 16px rgb(40 255 120 / 0.7); }
    .status { margin: 0.35rem 0 0; font-family: var(--sl-font-mono); font-size: 0.6875rem; letter-spacing: 0.04em; color: rgb(150 255 190 / 0.75); text-shadow: 0 0 8px #000; }
    /* The hints sit above the print in one column, so a wrapped print (narrow screens) pushes them up instead of overlapping them. */
    .footer { position: absolute; left: 1.25rem; right: 1.25rem; bottom: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; pointer-events: none; }
    .hints { margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-size: 0.6875rem; letter-spacing: 0.06em; color: rgb(170 255 205 / 0.85); text-shadow: 0 0 8px #000; pointer-events: none; transition: opacity 1.4s ease; }
    .hints span::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 0.5rem; border-radius: 50%; background: #5cff9d; vertical-align: middle; box-shadow: 0 0 6px #5cff9d; }
    .hints.quiet { opacity: 0.25; }
    .print { margin: 0; font-size: 0.625rem; line-height: 1.4; color: rgb(150 230 180 / 0.55); text-shadow: 0 0 6px #000; pointer-events: none; }

    /* ERROR on the eyes: a red box, centred on them, that tears and splits into colours. --w is its width in percent of the picture. */
    .error { position: absolute; width: calc(var(--w) * 1cqw); aspect-ratio: 2.6 / 1; transform: translate(-50%, -50%); display: grid; place-items: center; background: #d4121f; box-shadow: 0 0 0 1px #ff6a72 inset, 0 0 24px rgb(255 20 40 / 0.8); pointer-events: none; animation: box-jitter 0.9s steps(1) infinite, appear 0.25s steps(4) 1; }
    .error .word { position: relative; font-family: var(--sl-font-mono); font-weight: 800; font-size: calc(var(--w) * 0.2cqw); letter-spacing: 0.12em; color: #fff; text-shadow: 2px 0 #00f0ff, -2px 0 #ff00c8; animation: word-split 0.7s steps(1) infinite; }
    .error .word::before, .error .word::after { content: attr(data-text); position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; }
    .error .word::before { color: #00f0ff; mix-blend-mode: screen; animation: slice-a 1.1s steps(1) infinite; }
    .error .word::after { color: #ff2fd0; mix-blend-mode: screen; animation: slice-b 0.8s steps(1) infinite; }
    @keyframes appear { 0% { opacity: 0; } 50% { opacity: 1; } 75% { opacity: 0.2; } 100% { opacity: 1; } }
    @keyframes box-jitter { 0%, 100% { transform: translate(-50%, -50%); } 14% { transform: translate(calc(-50% + 6px), -50%); } 29% { transform: translate(calc(-50% - 4px), calc(-50% + 2px)) skewX(8deg); } 44% { transform: translate(-50%, -50%); } 71% { transform: translate(calc(-50% + 3px), calc(-50% - 3px)); clip-path: inset(0 0 40% 0); } 72% { clip-path: none; } 86% { transform: translate(calc(-50% - 7px), -50%) scaleY(0.92); } }
    @keyframes word-split { 0%, 100% { text-shadow: 2px 0 #00f0ff, -2px 0 #ff00c8; } 33% { text-shadow: -5px 0 #00f0ff, 5px 0 #ff00c8; } 66% { text-shadow: 0 0 #00f0ff, 0 0 #ff00c8; } }
    @keyframes slice-a { 0%, 100% { clip-path: inset(0 0 100% 0); } 20% { clip-path: inset(10% 0 55% 0); transform: translateX(-6px); } 55% { clip-path: inset(60% 0 8% 0); transform: translateX(5px); } 80% { clip-path: inset(30% 0 40% 0); transform: translateX(-3px); } }
    @keyframes slice-b { 0%, 100% { clip-path: inset(100% 0 0 0); } 30% { clip-path: inset(45% 0 20% 0); transform: translateX(6px); } 65% { clip-path: inset(5% 0 70% 0); transform: translateX(-5px); } }

    /* The black screen after the collapse. */
    .dark { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.1rem; padding: 1.5rem; text-align: center; background: #000; font-family: var(--sl-font-mono); }
    h3 { margin: 0; max-width: 28rem; font-size: clamp(1.1rem, 4.2cqw, 1.9rem); font-weight: 500; letter-spacing: 0.05em; color: #d8ffe6; text-shadow: 0 0 18px rgb(40 255 120 / 0.8); animation: flicker 5s steps(1) infinite; }
    .detail { margin: 0 0 0.6rem; max-width: 24rem; font-size: clamp(0.7rem, 2.1cqw, 0.9rem); line-height: 1.5; letter-spacing: 0.03em; color: rgb(150 230 180 / 0.7); }
    @keyframes flicker { 0%, 100% { opacity: 1; } 91% { opacity: 0.55; } 92% { opacity: 1; } 95% { opacity: 0.7; } 96% { opacity: 1; } }

    /* The button: a blue pill, glassy and glowing, that glitches when it is looked at. */
    .pill { position: relative; cursor: pointer; border: 0; padding: 0.95rem 2.4rem; border-radius: 999px; font: inherit; font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: #eaf4ff; background: linear-gradient(180deg, #5d9bff 0%, #1f4fe0 55%, #123aa8 100%); box-shadow: 0 0 0 1px rgb(160 200 255 / 0.55) inset, 0 -6px 12px rgb(10 30 120 / 0.7) inset, 0 0 28px rgb(60 120 255 / 0.75), 0 0 80px rgb(40 90 255 / 0.35); animation: pulse 2.4s ease-in-out infinite; transition: transform 0.15s ease; }
    .pill::before { content: ''; position: absolute; left: 12%; right: 12%; top: 7%; height: 36%; border-radius: 999px; background: linear-gradient(180deg, rgb(255 255 255 / 0.55), rgb(255 255 255 / 0)); pointer-events: none; }
    .pill .label { position: relative; text-shadow: 0 0 10px rgb(180 215 255 / 0.9); }
    .pill:hover, .pill:focus-visible { transform: scale(1.06); outline: none; animation: pulse 2.4s ease-in-out infinite, pill-glitch 0.5s steps(1) infinite; }
    .pill:focus-visible { box-shadow: 0 0 0 3px #fff, 0 0 28px rgb(60 120 255 / 0.9); }
    .pill:active { transform: scale(0.97); }
    @keyframes pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.18); } }
    @keyframes pill-glitch { 0%, 100% { translate: 0 0; } 20% { translate: 3px 0; } 40% { translate: -3px 1px; } 60% { translate: 2px -1px; } 80% { translate: -1px 0; } }

    /* The sentence being typed. */
    .typed { margin: 0; max-width: 30rem; min-height: 2em; font-size: clamp(1rem, 3.4cqw, 1.5rem); letter-spacing: 0.06em; color: #3dff7e; text-shadow: 0 0 12px rgb(40 255 120 / 0.85); }
    .cursor { display: inline-block; width: 0.55em; height: 1.05em; margin-left: 0.1em; vertical-align: text-bottom; background: #3dff7e; box-shadow: 0 0 10px #3dff7e; animation: blink 0.9s steps(1) infinite; }
    @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }

    @media (prefers-reduced-motion: reduce) {
      .hints { transition: none; }
      .error, .error .word, .error .word::before, .error .word::after, h3, .pill, .pill:hover, .pill:focus-visible, .cursor { animation: none; }
      .error .word::before, .error .word::after { display: none; }
    }
    @container matrix (max-width: 34rem) {
      .hints span:nth-child(2) { display: none; }
    }
  `,
})
export class MatrixPanel {
  /** What the camera (or the demo) is doing. */
  readonly status = input.required<string>();
  /** Has the user touched the picture? The hints fade. */
  readonly used = input.required<boolean>();
  /** Where the hidden ending is, and what it needs shown. */
  readonly phase = input<Phase>('idle');
  readonly face = input<FaceBox | undefined>(undefined);
  readonly typed = input('');
  /** The button on the black screen was pressed. */
  readonly answered = output<void>();

  protected readonly question = QUESTION;
  protected readonly detail = QUESTION_DETAIL;
  protected readonly promise = PROMISE;
  private readonly pill = viewChild<ElementRef<HTMLButtonElement>>('pill');

  constructor() {
    // The button gets the keyboard focus when the question appears, so Enter answers it.
    effect(() => this.pill()?.nativeElement.focus());
  }

  /** The width of the ERROR box in percent of the picture: a little wider than the head, never tiny. */
  protected errorWidth(box: FaceBox): number {
    return Math.min(60, Math.max(14, box.width * 115));
  }
}
