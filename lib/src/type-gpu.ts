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
import { reportError } from './report-error';

/** Configuration for {@link provideTypeGpu}. Every field is optional. */
export interface TypeGpuConfig {
  /** Options forwarded to `tgpu.init()`. Ignored when `root` or `createRoot` is given. */
  options?: InitOptions;
  /**
   * An existing root to use. The service never destroys it, whatever happens: it belongs to the
   * caller. The service is `ready` immediately in the browser, which is what unit tests want. On
   * the server it always stays `idle`, so with server-side rendering and hydration prefer
   * `createRoot` (a service that is `ready` at construction renders `*tgpuReady` content during
   * hydration, which the server did not render).
   */
  root?: TgpuRoot;
  /**
   * Custom root factory, e.g. `() => tgpu.initFromDevice({ device })` with your own device,
   * or a controllable promise in tests. The service owns the root it returns and calls
   * `root.destroy()` on it exactly once: when the service is destroyed, or when `retry()` replaces
   * it after the device was lost. (`initFromDevice` roots do not destroy the device itself.)
   */
  createRoot?: () => Promise<TgpuRoot>;
}

/** What the service knows about the GPU right now. */
export type TypeGpuState =
  /** Nothing started yet (also the permanent state on the server, and the state after the service was destroyed). */
  | { readonly status: 'idle' }
  | { readonly status: 'initializing' }
  | { readonly status: 'ready'; readonly root: TgpuRoot }
  /**
   * `navigator.gpu` is missing, or the browser has it but offers no adapter (`requestAdapter()`
   * resolves to `null`). An unsupported environment, not an application error: nothing is reported
   * to `ErrorHandler`.
   */
  | { readonly status: 'unsupported' }
  /**
   * `tgpu.init()` (e.g. the device request) or the custom factory rejected. Also reported to
   * `ErrorHandler`.
   */
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
 * - Ownership: a root the service created itself (`tgpu.init()` or `config.createRoot`) is
 *   destroyed exactly once, by the service: when the injector is destroyed (after every component
 *   and directive of the application, whose resources are destroyed first), or when `retry()`
 *   replaces it after the device was lost. A root given as `config.root` is never destroyed.
 * - A ready root is only exposed through `root()`, `state()`, `whenReady()` and `injectRoot()`.
 *   Do not keep it beyond the application: once the injector is destroyed the service-created
 *   root is destroyed too, `root()` is `undefined` again, and `whenReady()` rejects.
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
  /**
   * Incremented on every start so that a stale init cannot overwrite a newer one. Today at most one
   * start is ever in flight (a start only begins from idle, failed, lost or unsupported and
   * leaves `initializing` by itself), so the checks below only matter together with `#destroyed`;
   * they are kept as the cheap guard for any future way to start twice.
   */
  #generation = 0;
  /** The root this service created (not a `config.root`): the one it must destroy. */
  #ownedRoot: TgpuRoot | undefined;

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
      this.#waiters.splice(0).forEach((w) => w.reject(destroyedError()));
      const owned = this.#ownedRoot;
      if (owned) {
        this.#ownedRoot = undefined;
        // From here on nothing may obtain the destroyed root: frame callbacks and `from` samplers
        // see `root()` go away (their owners are normally destroyed already, this covers the rest).
        const state = this.#state();
        if (state.status === 'ready' && state.root === owned) {
          this.#state.set({ status: 'idle' });
        }
        this.#release(owned);
      }
    });

    if (!this.#isBrowser) {
      return; // Server: the GPU is never touched; the state stays `idle`.
    }
    if (this.#config.root) {
      this.#state.set({ status: 'ready', root: this.#config.root });
      this.#watchDevice(this.#config.root, this.#generation);
    } else {
      afterNextRender(() => {
        if (!this.#destroyed && this.#state().status === 'idle') {
          void this.#start();
        }
      });
    }
  }

  /**
   * Resolves with the root once it is ready. For code outside templates (services, route resolvers).
   *
   * | state when called            | result                                                              |
   * | ---------------------------- | ------------------------------------------------------------------- |
   * | the service was destroyed    | rejects at once (whatever the state was)                            |
   * | `ready`                      | resolves with the root                                              |
   * | `unsupported`                | rejects                                                             |
   * | `failed`                     | rejects with the initialisation error                               |
   * | `idle`, `initializing`       | waits; settles like the start does (browser; the first render starts it) |
   * | `lost`                       | waits for `retry()`: resolves with the NEW root, rejects if the retry ends `unsupported` or `failed` |
   * | server rendering             | rejects at once (nothing ever initialises there)                    |
   *
   * A waiter is also rejected when the service is destroyed while it waits. In `lost` nothing but
   * `retry()` (called by you) ever wakes a waiter: if nobody retries, it stays pending until the
   * service is destroyed.
   */
  whenReady(): Promise<TgpuRoot> {
    if (this.#destroyed) {
      return Promise.reject(destroyedError());
    }
    const state = this.#state();
    switch (state.status) {
      case 'ready':
        return Promise.resolve(state.root);
      case 'unsupported':
        return Promise.reject(unsupportedError());
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
   * Components behind `*tgpuReady` are recreated once the new root is ready. After `lost`, the old
   * root is destroyed first if the service created it (a `config.root` is left alone). Does nothing
   * in other states, after the service was destroyed, and on the server.
   */
  retry(): void {
    const { status } = this.#state();
    if (!this.#destroyed && this.#isBrowser && (status === 'failed' || status === 'lost' || status === 'unsupported')) {
      void this.#start();
    }
  }

  async #start(): Promise<void> {
    const generation = ++this.#generation;
    // A root that is being replaced is a lost one (the only state a root can leave): its device is gone.
    const replaced = this.#ownedRoot;
    this.#ownedRoot = undefined;
    if (replaced) this.#release(replaced);
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
      if (isNoAdapterError(error)) {
        // `navigator.gpu` exists but offers no adapter (blocklisted or absent GPU): the same
        // "nothing to run on" as a missing `navigator.gpu`, not an application error.
        this.#settle({ status: 'unsupported' });
        return;
      }
      this.#settle({ status: 'failed', error });
      reportError(this.#errorHandler, error);
      return;
    }

    if (this.#destroyed || generation !== this.#generation) {
      // Nobody can use this root and no surface was configured with it: release it.
      this.#release(root);
      return;
    }
    this.#ownedRoot = root;
    this.#settle({ status: 'ready', root });
    this.#watchDevice(root, generation);
  }

  /** Destroys a root this service created. A throwing `destroy()` is a genuine error: reported, never fatal. */
  #release(root: TgpuRoot): void {
    try {
      root.destroy();
    } catch (error) {
      reportError(this.#errorHandler, error);
    }
  }

  #settle(state: TypeGpuState): void {
    this.#state.set(state);
    const waiters = this.#waiters.splice(0);
    if (state.status === 'ready') {
      waiters.forEach((w) => w.resolve(state.root));
    } else if (state.status === 'failed') {
      waiters.forEach((w) => w.reject(state.error));
    } else if (state.status === 'unsupported') {
      const error = unsupportedError();
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

function destroyedError(): Error {
  return new Error('[typegpu-angular] TypeGpu was destroyed.');
}

function unsupportedError(): Error {
  return new Error('[typegpu-angular] WebGPU is not supported here.');
}

/**
 * `tgpu.init()` throws a plain `Error('Could not find a compatible GPU')` when `requestAdapter()`
 * resolves to `null` (packages/typegpu/src/core/root/init.ts); it has no error class or code to test.
 * Matching its message is the only way that does not request a second adapter (which has side
 * effects: it would consume a queued fake adapter, count as a second start, ...). If TypeGPU ever
 * rewords it the failure mode is the previous behaviour (`failed` + `ErrorHandler`), and the
 * contract spec `type-gpu.spec.ts` ("adapter is null") fails and says why.
 */
function isNoAdapterError(error: unknown): boolean {
  return error instanceof Error && /compatible GPU/i.test(error.message);
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
