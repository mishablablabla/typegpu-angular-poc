import {
  DestroyRef,
  Directive,
  ElementRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  isDevMode,
  output,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { TypeGpu } from './type-gpu';

export type TgpuCanvasOptions = Omit<GPUCanvasConfiguration, 'device' | 'format'> & {
  /** Defaults to `navigator.gpu.getPreferredCanvasFormat()`. */
  format?: GPUTextureFormat;
  /** Keep the canvas pixel size in sync with its CSS size (device pixels). Default `true`. */
  autoResize?: boolean;
};

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Owns one WebGPU context on the host `<canvas>` and its pixel size. Nothing else: no frame
 * loop, no resources. Safe on the server (plain `<canvas>`; configuration waits for a root).
 *
 * ```html
 * <canvas [tgpuCanvas]="{ alphaMode: 'premultiplied' }" #c="tgpuCanvas"></canvas>
 * ```
 */
@Directive({ selector: 'canvas[tgpuCanvas]', exportAs: 'tgpuCanvas' })
export class TgpuCanvas {
  readonly #canvas = inject<ElementRef<HTMLCanvasElement>>(ElementRef).nativeElement;
  readonly #gpu = inject(TypeGpu);
  readonly #isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly #context = signal<GPUCanvasContext | undefined>(undefined);
  readonly #size = signal<CanvasSize | undefined>(undefined);
  /** Set when writing the bitmap size changed the layout size: nothing but the bitmap sizes this canvas. */
  #layoutFollowsBitmap = false;

  /** Context configuration. Applied again whenever it (or the root) changes. */
  readonly options = input<TgpuCanvasOptions, TgpuCanvasOptions | '' | undefined>(
    {},
    // A bare `<canvas tgpuCanvas>` binds the empty string.
    { alias: 'tgpuCanvas', transform: (value) => value || {} },
  );
  /** Emits the new pixel size after the canvas was resized. Also emits its initial size. */
  readonly resized = output<CanvasSize>();

  /** The configured context, or `undefined` until a root is ready (and after it is lost). */
  readonly context = this.#context.asReadonly();
  readonly #autoResize = computed(() => this.options().autoResize ?? true);
  /** Last pixel size applied by `autoResize`. */
  readonly size = this.#size.asReadonly();

  constructor() {
    effect(() => {
      const root = this.#gpu.root();
      const { autoResize: _autoResize, ...config } = this.options();
      untracked(() => {
        // Drop the old context first: if configuring throws (e.g. the canvas already has a 2d
        // context) the error reaches ErrorHandler and nobody keeps drawing into a stale context.
        this.#context.set(undefined);
        if (root) {
          this.#context.set(root.configureContext({ canvas: this.#canvas, ...config }));
        }
      });
    });

    effect((onCleanup) => {
      // No ResizeObserver (jsdom in unit tests, very old browsers): the canvas keeps the size it has.
      if (!this.#autoResize() || !this.#isBrowser || typeof ResizeObserver === 'undefined') return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        // `devicePixelContentBoxSize` is exact where available (not in Safari).
        const exact = entry.devicePixelContentBoxSize?.[0];
        const box = exact ?? entry.contentBoxSize[0];
        if (!box) return;
        const scale = exact ? 1 : (this.#canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
        this.#apply(Math.max(1, Math.round(box.inlineSize * scale)), Math.max(1, Math.round(box.blockSize * scale)));
      });
      this.#layoutFollowsBitmap = false;
      observer.observe(this.#canvas);
      onCleanup(() => observer.disconnect());
    });

    inject(DestroyRef).onDestroy(() => this.#context.set(undefined));
  }

  #apply(width: number, height: number): void {
    const canvas = this.#canvas;
    if (this.#layoutFollowsBitmap) return;
    // Compare with the real canvas: something else may have resized it (which also clears it).
    if (canvas.width !== width || canvas.height !== height) {
      const previous = { width: canvas.width, height: canvas.height };
      const layout = { width: canvas.clientWidth, height: canvas.clientHeight };
      canvas.width = width;
      canvas.height = height;
      // A canvas without a CSS size is as large as its bitmap (in CSS pixels), so on a screen with a
      // pixel ratio above 1 every resize would be measured larger than the last one, without end.
      if (canvas.clientWidth !== layout.width || canvas.clientHeight !== layout.height) {
        canvas.width = previous.width;
        canvas.height = previous.height;
        this.#layoutFollowsBitmap = true;
        if (isDevMode()) {
          console.warn(
            '[tgpuCanvas] This canvas has no CSS size, so its bitmap decides how large it is and autoResize cannot work. ' +
              'Give it a CSS width and height (for example `canvas { display: block; width: 100%; height: 240px }`) or set `autoResize: false`. ' +
              'Automatic resizing is switched off for this canvas.',
          );
        }
        return;
      }
    }
    const previous = this.#size();
    if (!previous || previous.width !== width || previous.height !== height) {
      this.#size.set({ width, height });
      this.resized.emit({ width, height });
    }
  }
}
