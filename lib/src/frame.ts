import {
  DestroyRef,
  ErrorHandler,
  Injectable,
  NgZone,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { boundToRoot } from './root-binding';
import { TypeGpu } from './type-gpu';

/** Timing passed to frame callbacks. The same object is reused every frame: do not keep it. */
export interface FrameInfo {
  /** Seconds since this callback's previous frame (0 on its first frame). */
  readonly deltaSeconds: number;
  /** Seconds since this callback's first frame. */
  readonly elapsedSeconds: number;
}

/** Controls one `injectFrame` callback. */
export interface FrameRef {
  readonly paused: Signal<boolean>;
  /** Stops calling the callback. Resources are untouched. Idempotent. */
  pause(): void;
  resume(): void;
}

interface FrameEntry {
  readonly callback: (frame: FrameInfo) => unknown;
  readonly active: Signal<boolean>;
  readonly info: { deltaSeconds: number; elapsedSeconds: number };
  start: number | undefined;
  last: number | undefined;
}

/**
 * The application's single animation loop. Internal: use {@link injectFrame} and the `from`
 * option of the `inject*` resource functions.
 */
@Injectable({ providedIn: 'root' })
export class FrameLoop {
  readonly #zone = inject(NgZone);
  readonly #errorHandler = inject(ErrorHandler);
  readonly #isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly #entries = new Set<FrameEntry>();
  readonly #samplers = new Map<() => void, Signal<boolean>>();
  #frameId: number | undefined;

  /**
   * Runs before every frame callback, once per frame, while `active()` is true.
   * Returns a function that removes it.
   */
  addSampler(sample: () => void, active: Signal<boolean>): () => void {
    this.#samplers.set(sample, active);
    this.#schedule();
    return () => {
      this.#samplers.delete(sample);
    };
  }

  addCallback(callback: (frame: FrameInfo) => unknown, active: Signal<boolean>): () => void {
    const entry: FrameEntry = {
      callback,
      active,
      info: { deltaSeconds: 0, elapsedSeconds: 0 },
      start: undefined,
      last: undefined,
    };
    this.#entries.add(entry);
    this.#schedule();
    return () => {
      this.#entries.delete(entry);
    };
  }

  /** Restarts the loop if it had gone idle (a consumer became active again). */
  wake(): void {
    this.#schedule();
  }

  /** Starts the loop if needed. Never on the server. */
  #schedule(): void {
    if (!this.#isBrowser || this.#frameId !== undefined) return;
    this.#zone.runOutsideAngular(() => {
      this.#frameId = requestAnimationFrame((now) => this.#tick(now));
    });
  }

  /** One broken callback must not stop the others: it is stopped and reported, not retried 60x/s. */
  #fail(entry: FrameEntry, error: unknown): void {
    if (this.#entries.delete(entry)) {
      this.#errorHandler.handleError(error);
    }
  }

  #hasActiveTask(): boolean {
    for (const [, active] of this.#samplers) {
      if (untracked(active)) return true;
    }
    for (const entry of this.#entries) {
      if (untracked(entry.active)) return true;
    }
    return false;
  }

  #tick(now: number): void {
    this.#frameId = undefined;

    for (const [sample, active] of this.#samplers) {
      if (!untracked(active)) continue;
      try {
        sample();
      } catch (error) {
        this.#samplers.delete(sample);
        this.#errorHandler.handleError(error);
      }
    }

    for (const entry of this.#entries) {
      if (!untracked(entry.active)) continue;
      entry.start ??= now;
      const info = entry.info;
      info.deltaSeconds = entry.last === undefined ? 0 : (now - entry.last) / 1000;
      info.elapsedSeconds = (now - entry.start) / 1000;
      entry.last = now;
      try {
        const result = entry.callback(info);
        // An async callback is not awaited (frames must not queue behind it), but its failure must not vanish.
        if (isPromiseLike(result)) {
          result.then(undefined, (error: unknown) => this.#fail(entry, error));
        }
      } catch (error) {
        this.#fail(entry, error);
      }
    }

    // Idle (every callback paused or the GPU not ready): stop ticking until something wakes the loop.
    if (this.#hasActiveTask()) {
      this.#schedule();
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/**
 * Calls `callback` once per animation frame, outside the Angular zone, until the surrounding
 * injection context (component, directive, service) is destroyed. All callers share one loop.
 *
 * - The first call happens after the owner's first render, so `viewChild.required()` and signal
 *   inputs are available.
 * - Callbacks only run while the nearest `TypeGpu` is `ready` with the root they were created
 *   under: after device loss they stop at once, before Angular has torn the GPU content down,
 *   and they do NOT resume on a root created by `retry()` (content behind `*tgpuReady` is
 *   recreated for the new root instead).
 * - A callback that throws, or returns a promise that rejects, is stopped and reported through
 *   `ErrorHandler`. Do not `await` inside a frame callback: it is not awaited by the loop.
 * - `resume()` after `pause()` reports a `deltaSeconds` that spans the pause.
 */
export function injectFrame(callback: (frame: FrameInfo) => void): FrameRef {
  const gpu = inject(TypeGpu);
  const loop = inject(FrameLoop);
  const destroyRef = inject(DestroyRef);
  const paused = signal(false);
  const onRoot = boundToRoot(gpu);
  const active = computed(() => !paused() && onRoot());

  let remove: (() => void) | undefined;
  destroyRef.onDestroy(() => remove?.());
  afterNextRender(() => {
    remove = loop.addCallback(callback, active);
  });
  // `from` samplers and callbacks go idle when the GPU is not ready; wake the loop when it is again.
  effect(() => {
    if (active()) loop.wake();
  });

  return {
    paused: paused.asReadonly(),
    pause: () => paused.set(true),
    resume: () => {
      paused.set(false);
      loop.wake();
    },
  };
}
