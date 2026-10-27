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
  /**
   * Never use more than this many canvas pixels per CSS pixel (the browser scales the picture up). On a screen with a pixel
   * ratio of 2 or 3 this bounds the cost of a heavy fragment shader. Default: no limit.
   */
  maxPixelRatio?: number;
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

  /**
   * Context configuration. The context is configured again only when the root changes or a field
   * that reaches WebGPU changes (compared by value). `autoResize` and `maxPixelRatio` are ours:
   * changing only those never reconfigures the context, so the canvas is not cleared.
   */
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
  readonly #maxPixelRatio = computed(() => this.options().maxPixelRatio);
  /** What goes to `configureContext`: the options without ours, equal by value so a new object with the same content changes nothing. */
  readonly #config = computed(
    () => {
      const { autoResize: _autoResize, maxPixelRatio: _maxPixelRatio, ...config } = this.options();
      return config;
    },
    { equal: plainDataEqual },
  );
  /** Last pixel size applied by `autoResize`. */
  readonly size = this.#size.asReadonly();

  constructor() {
    effect(() => {
      const root = this.#gpu.root();
      const config = this.#config();
      untracked(() => {
        // Drop the old context first: if configuring throws (e.g. the canvas already has a 2d
        // context) the error reaches ErrorHandler and nobody keeps drawing into a stale context.
        const previous = this.#context();
        this.#context.set(undefined);
        if (root) {
          try {
            this.#context.set(root.configureContext({ canvas: this.#canvas, ...config }));
          } catch (error) {
            // Not configured any more as far as this directive is concerned: do not leave the old setup running.
            if (previous) unconfigure(previous);
            throw error;
          }
        } else if (previous) {
          // The root is gone (device lost): release the canvas' swap chain explicitly.
          unconfigure(previous);
        }
      });
    });

    effect((onCleanup) => {
      // No ResizeObserver (jsdom in unit tests, very old browsers): the canvas keeps the size it has.
      if (!this.#autoResize() || !this.#isBrowser || typeof ResizeObserver === 'undefined') return;
      const cap = this.#maxPixelRatio();

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const ratio = this.#canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const capped = cap !== undefined && cap > 0 && cap < ratio;
        // `devicePixelContentBoxSize` is exact where available (not in Safari); a capped canvas is measured in CSS pixels.
        const exact = capped ? undefined : entry.devicePixelContentBoxSize?.[0];
        const box = exact ?? entry.contentBoxSize[0];
        if (!box) return;
        const scale = exact ? 1 : capped ? cap : ratio;
        this.#apply(Math.max(1, Math.round(box.inlineSize * scale)), Math.max(1, Math.round(box.blockSize * scale)));
      });
      this.#layoutFollowsBitmap = false;
      try {
        // Observing the device-pixel box also reports a change of `devicePixelRatio` alone (the window moves to
        // another monitor, browser zoom) when the CSS size stays the same. Not supported everywhere (Safari
        // throws a TypeError for the unknown box): fall back to the default content box.
        observer.observe(this.#canvas, { box: 'device-pixel-content-box' });
      } catch {
        observer.observe(this.#canvas);
      }
      onCleanup(() => observer.disconnect());
    });

    inject(DestroyRef).onDestroy(() => {
      const context = untracked(this.#context);
      this.#context.set(undefined);
      if (context) unconfigure(context);
    });
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

/** `GPUCanvasContext.unconfigure()` (WebGPU spec; Chrome verified, a no-op when called twice or after `device.destroy()`). Never throws. */
function unconfigure(context: GPUCanvasContext): void {
  try {
    if (typeof context.unconfigure === 'function') context.unconfigure();
  } catch {
    // The context is being thrown away anyway.
  }
}

/** Structural equality for configuration data: primitives, arrays and plain objects. Anything else is compared by identity. */
function plainDataEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => plainDataEqual(value, b[index]));
  }
  const prototype = Object.getPrototypeOf(a) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getPrototypeOf(b) !== prototype) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => key in b && plainDataEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}
