import {
  DOCUMENT,
  DestroyRef,
  ErrorHandler,
  InjectionToken,
  PLATFORM_ID,
  Injectable,
  afterNextRender,
  computed,
  inject,
  makeEnvironmentProviders,
  signal,
  type EnvironmentProviders,
  type Signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { tgpu, type InitOptions, type TgpuRoot } from 'typegpu';

/** Configuration for {@link provideTypeGpu}. Every field is optional. */
export interface TypeGpuConfig {
  /** Options forwarded to `tgpu.init()`. Ignored when `root` or `createRoot` is given. */
  options?: InitOptions;
  /**
   * An existing root to use. The service never destroys it and is `ready` immediately in the
   * browser, which is what unit tests want. On the server the service always stays `idle`.
   */
  root?: TgpuRoot;
  /**
   * Custom root factory, e.g. `() => tgpu.initFromDevice({ device })` with your own device,
   * or a controllable promise in tests. The service owns the root it returns.
   */
  createRoot?: () => Promise<TgpuRoot>;
}

/** What the service knows about the GPU right now. */
export type TypeGpuState =
  /** Nothing started yet (also the permanent state on the server). */
  | { readonly status: 'idle' }
  | { readonly status: 'initializing' }
  | { readonly status: 'ready'; readonly root: TgpuRoot }
  /** `navigator.gpu` is missing. Not an application error. */
  | { readonly status: 'unsupported' }
  /** `tgpu.init()` (or the custom factory) rejected. Also reported to `ErrorHandler`. */
  | { readonly status: 'failed'; readonly error: unknown }
  /** The device was lost after it had been ready. Call {@link TypeGpu.retry} to create a new root. */
  | { readonly status: 'lost'; readonly info: GPUDeviceLostInfo };

export const TYPEGPU_CONFIG = new InjectionToken<TypeGpuConfig>('TYPEGPU_CONFIG', {
  factory: () => ({}),
});

/**
 * Optional configuration. The library works without it (`tgpu.init()` with defaults).
 *
 * The configuration applies to the injector it is provided in: `TypeGpu` is listed here as well,
 * because a `providedIn: 'root'` service would otherwise be created in the root injector and
 * never see a configuration that was provided in a route or a child injector. Providing it
 * below the root therefore creates a separate service (and a separate GPU device) for that
 * injector.
 */
export function provideTypeGpu(config: TypeGpuConfig = {}): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: TYPEGPU_CONFIG, useValue: config }, TypeGpu]);
}

/**
 * Owns the TypeGPU root (and its GPU device) for the injector it lives in.
 *
 * - Starts initialising after the first render, in the browser only. It never blocks bootstrap.
 * - Does not destroy a ready root when it is destroyed (surfaces may still reference the device).
 */
@Injectable({ providedIn: 'root' })
export class TypeGpu {
  readonly #config = inject(TYPEGPU_CONFIG);
  readonly #errorHandler = inject(ErrorHandler);
  readonly #document = inject(DOCUMENT);
  readonly #isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly #state = signal<TypeGpuState>({ status: 'idle' });
  readonly #waiters: { resolve(root: TgpuRoot): void; reject(reason: unknown): void }[] = [];
  #destroyed = false;
  /** Incremented on every start so that a stale init cannot overwrite a newer one. */
  #generation = 0;

  /** Current state. Read it in templates, `computed` and `effect`. */
  readonly state: Signal<TypeGpuState> = this.#state.asReadonly();
  /** The root while `ready`, otherwise `undefined`. */
  readonly root: Signal<TgpuRoot | undefined> = computed(() => {
    const state = this.#state();
    return state.status === 'ready' ? state.root : undefined;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#destroyed = true;
      const error = new Error('[typegpu-angular] TypeGpu was destroyed.');
      this.#waiters.splice(0).forEach((w) => w.reject(error));
    });

    if (!this.#isBrowser) {
      return; // Server: the GPU is never touched; the state stays `idle`.
    }
    if (this.#config.root) {
      this.#state.set({ status: 'ready', root: this.#config.root });
      this.#watchDevice(this.#config.root, this.#generation);
    } else {
      afterNextRender(() => {
        if (this.#state().status === 'idle') {
          void this.#start();
        }
      });
    }
  }

  /**
   * Resolves with the root once it is ready; rejects when the GPU is unsupported or
   * initialisation failed. For code outside templates (services, route resolvers).
   */
  whenReady(): Promise<TgpuRoot> {
    const state = this.#state();
    switch (state.status) {
      case 'ready':
        return Promise.resolve(state.root);
      case 'unsupported':
        return Promise.reject(new Error('[typegpu-angular] WebGPU is not supported here.'));
      case 'failed':
        return Promise.reject(state.error);
      default:
        if (!this.#isBrowser) {
          // Nothing ever initialises on the server; waiting would hang server rendering.
          return Promise.reject(new Error('[typegpu-angular] The GPU is not available during server rendering.'));
        }
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }
  }

  /**
   * Creates a fresh root after `failed` or `lost` (or `unsupported`, if the environment changed).
   * Components behind `*tgpuReady` are recreated once the new root is ready. Does nothing in
   * other states and on the server.
   */
  retry(): void {
    const { status } = this.#state();
    if (!this.#destroyed && this.#isBrowser && (status === 'failed' || status === 'lost' || status === 'unsupported')) {
      void this.#start();
    }
  }

  async #start(): Promise<void> {
    const generation = ++this.#generation;
    this.#state.set({ status: 'initializing' });

    const { createRoot, options } = this.#config;
    if (!createRoot && !this.#document.defaultView?.navigator.gpu) {
      this.#settle({ status: 'unsupported' });
      return;
    }

    let root: TgpuRoot;
    try {
      root = await (createRoot ? createRoot() : tgpu.init(options));
    } catch (error) {
      if (this.#destroyed || generation !== this.#generation) return;
      this.#settle({ status: 'failed', error });
      this.#errorHandler.handleError(error);
      return;
    }

    if (this.#destroyed || generation !== this.#generation) {
      // Nobody can use this root and no surface was configured with it: release it.
      root.destroy();
      return;
    }
    this.#settle({ status: 'ready', root });
    this.#watchDevice(root, generation);
  }

  #settle(state: TypeGpuState): void {
    this.#state.set(state);
    const waiters = this.#waiters.splice(0);
    if (state.status === 'ready') {
      waiters.forEach((w) => w.resolve(state.root));
    } else if (state.status === 'failed') {
      waiters.forEach((w) => w.reject(state.error));
    } else if (state.status === 'unsupported') {
      const error = new Error('[typegpu-angular] WebGPU is not supported here.');
      waiters.forEach((w) => w.reject(error));
    }
  }

  #watchDevice(root: TgpuRoot, generation: number): void {
    void root.device.lost.then((info) => {
      const current = this.#state();
      if (this.#destroyed || generation !== this.#generation) return;
      if (current.status === 'ready' && current.root === root) {
        this.#state.set({ status: 'lost', info });
      }
    });
  }
}

/**
 * The root, synchronously. Only valid where a root exists: inside `*tgpuReady` content, or
 * anywhere when you gate it yourself (`@if (gpu.root())`). Throws with guidance otherwise.
 */
export function injectRoot(): TgpuRoot {
  const state = inject(TypeGpu).state();
  if (state.status === 'ready') {
    return state.root;
  }
  throw new Error(
    `[typegpu-angular] injectRoot() was called while the GPU is "${state.status}". ` +
      `Create GPU components behind *tgpuReady (or @if (gpu.root())) so that they only exist once the root is ready.`,
  );
}
