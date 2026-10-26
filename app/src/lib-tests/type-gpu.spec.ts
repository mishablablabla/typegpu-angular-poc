import { Component, EnvironmentInjector, ErrorHandler, PLATFORM_ID, createEnvironmentInjector } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import { TgpuReady, TypeGpu, injectRoot, injectUniform, provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu } from '@typegpu-poc/angular/testing';
import type { TgpuRoot } from 'typegpu';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('TypeGpu root lifecycle', () => {
  it('is ready immediately with a provided root and never destroys it', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const gpu = TestBed.inject(TypeGpu);

    expect(gpu.state()).toEqual({ status: 'ready', root: fake.root });
    expect(gpu.root()).toBe(fake.root);
    await expect(gpu.whenReady()).resolves.toBe(fake.root);

    TestBed.resetTestingModule();
    expect(fake.rootDestroyCalls()).toBe(0);
  });

  it('initialises after the first render, once, and shares the root between consumers', async () => {
    const fake = createFakeTypeGpu();
    const createRoot = vi.fn(async () => fake.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });

    const a = TestBed.inject(TypeGpu);
    const b = TestBed.inject(TypeGpu);
    expect(a).toBe(b);
    expect(a.state().status).toBe('idle');
    expect(createRoot).not.toHaveBeenCalled(); // nothing starts before a render

    TestBed.tick();
    expect(a.state().status).toBe('initializing');
    await expect(a.whenReady()).resolves.toBe(fake.root);
    expect(a.state()).toEqual({ status: 'ready', root: fake.root });
    expect(createRoot).toHaveBeenCalledTimes(1);
  });

  it('reports "unsupported" without WebGPU, rejects whenReady and does not call ErrorHandler', async () => {
    const handleError = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu); // jsdom has no navigator.gpu
    TestBed.tick();

    expect(gpu.state()).toEqual({ status: 'unsupported' });
    await expect(gpu.whenReady()).rejects.toThrow(/not supported/);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('reports "failed", surfaces the error once through ErrorHandler, and retry recovers', async () => {
    const fake = createFakeTypeGpu();
    const boom = new Error('adapter request failed');
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockRejectedValueOnce(boom).mockResolvedValueOnce(fake.root);
    const handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot }), { provide: ErrorHandler, useValue: { handleError } }],
    });
    const gpu = TestBed.inject(TypeGpu);
    const pending = gpu.whenReady();
    const rejected = expect(pending).rejects.toBe(boom);
    TestBed.tick();
    await rejected;

    expect(gpu.state()).toEqual({ status: 'failed', error: boom });
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);

    gpu.retry();
    await expect(gpu.whenReady()).resolves.toBe(fake.root);
    expect(gpu.state().status).toBe('ready');
    expect(createRoot).toHaveBeenCalledTimes(2);
  });

  it('releases a root that resolves after the service was destroyed, without unhandled rejections', async () => {
    const fake = createFakeTypeGpu();
    const init = deferred<TgpuRoot>();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: () => init.promise })] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    const waiter = expect(gpu.whenReady()).rejects.toThrow(/destroyed/);

    TestBed.resetTestingModule(); // destroys the injector while init is pending
    await waiter;
    init.resolve(fake.root);
    await settle();

    expect(fake.rootDestroyCalls()).toBe(1); // nobody can use it, so it is released
    expect(gpu.state().status).toBe('initializing'); // a destroyed service does not publish a root
  });

  it('does not publish a failure that arrives after destruction', async () => {
    const init = deferred<TgpuRoot>();
    const handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot: () => init.promise }), { provide: ErrorHandler, useValue: { handleError } }],
    });
    TestBed.inject(TypeGpu);
    TestBed.tick();
    TestBed.resetTestingModule();
    init.reject(new Error('late'));
    await settle();
    expect(handleError).not.toHaveBeenCalled();
  });

  it('becomes "lost" when the device is lost; retry creates a new root', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();

    first.loseDevice({ reason: 'unknown', message: 'GPU hang' });
    await settle();
    const state = gpu.state();
    expect(state.status).toBe('lost');
    expect(state.status === 'lost' && state.info.message).toBe('GPU hang');
    expect(gpu.root()).toBeUndefined();

    gpu.retry();
    await expect(gpu.whenReady()).resolves.toBe(second.root);
  });

  it('stays idle on the server and never creates a root', () => {
    const createRoot = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }, provideTypeGpu({ createRoot })],
    });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    gpu.retry();
    expect(gpu.state()).toEqual({ status: 'idle' });
    expect(createRoot).not.toHaveBeenCalled();
  });

  it('stays idle on the server even when a root is provided', () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }, provideTypeGpu({ root: fake.root })],
    });
    expect(TestBed.inject(TypeGpu).state()).toEqual({ status: 'idle' });
  });

  it('retry() after the service was destroyed does nothing, even from `lost`', async () => {
    const first = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValue(first.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    expect(gpu.state().status).toBe('lost'); // the only state (besides failed) in which retry() would act
    TestBed.resetTestingModule();
    gpu.retry();
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(gpu.state().status).toBe('lost');
  });

  it('injectRoot() explains itself when the root is not ready', () => {
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: () => new Promise(() => undefined) })] });
    expect(() => TestBed.runInInjectionContext(() => injectRoot())).toThrow(/"idle".*\*tgpuReady/s);
  });

  it('injectRoot() returns the root when ready', () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    expect(TestBed.runInInjectionContext(() => injectRoot())).toBe(fake.root);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// whenReady(): every state, in the browser and on the server

/** A promise's fate after the microtask queue and timers had their turn. */
async function fate(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  let result: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => (result = 'resolved'),
    () => (result = 'rejected'),
  );
  await settle();
  return result;
}

describe('whenReady() in every state', () => {
  const handleError = vi.fn();
  const providers = (...more: unknown[]) => [{ provide: ErrorHandler, useValue: { handleError } }, ...more] as never[];

  it('idle and initializing: pending until the start settles (browser)', async () => {
    const fake = createFakeTypeGpu();
    const init = deferred<TgpuRoot>();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ createRoot: () => init.promise })) });
    const gpu = TestBed.inject(TypeGpu);
    expect(gpu.state().status).toBe('idle');
    const whileIdle = gpu.whenReady();
    expect(await fate(whileIdle)).toBe('pending');
    TestBed.tick();
    expect(gpu.state().status).toBe('initializing');
    const whileInitializing = gpu.whenReady();
    expect(await fate(whileInitializing)).toBe('pending');
    init.resolve(fake.root);
    await expect(whileIdle).resolves.toBe(fake.root);
    await expect(whileInitializing).resolves.toBe(fake.root);
  });

  it('ready: resolves with the current root', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ root: fake.root })) });
    await expect(TestBed.inject(TypeGpu).whenReady()).resolves.toBe(fake.root);
  });

  it('unsupported: rejects, and waiters that were pending when it became unsupported reject too', async () => {
    TestBed.configureTestingModule({ providers: providers() });
    const gpu = TestBed.inject(TypeGpu);
    const waiting = gpu.whenReady(); // pending: nothing has started
    const rejected = expect(waiting).rejects.toThrow(/not supported/);
    TestBed.tick(); // no navigator.gpu in jsdom
    await rejected;
    expect(gpu.state().status).toBe('unsupported');
    await expect(gpu.whenReady()).rejects.toThrow(/not supported/);
  });

  it('failed: rejects with the initialisation error, for waiters pending at the time and for later callers', async () => {
    const boom = new Error('device request failed');
    const init = deferred<TgpuRoot>();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ createRoot: () => init.promise })) });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    const waiting = expect(gpu.whenReady()).rejects.toBe(boom);
    init.reject(boom);
    await waiting;
    await expect(gpu.whenReady()).rejects.toBe(boom);
  });

  it('lost: waits for retry() and resolves with the NEW root; a retry that ends unsupported rejects it', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ createRoot })) });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    const waiting = gpu.whenReady();
    expect(await fate(waiting)).toBe('pending'); // nothing but retry() wakes it
    gpu.retry();
    await expect(waiting).resolves.toBe(second.root);

    // Second scenario: the retry ends `unsupported` (a provided root lost, then no WebGPU on retry).
    TestBed.resetTestingModule();
    const provided = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ root: provided.root })) });
    const other = TestBed.inject(TypeGpu);
    provided.loseDevice();
    await settle();
    const pending = other.whenReady();
    const rejected = expect(pending).rejects.toThrow(/not supported/);
    other.retry(); // no factory: tgpu.init(), jsdom has no navigator.gpu
    await rejected;
    expect(other.state().status).toBe('unsupported');
  });

  it('lost: a waiter is rejected when the service is destroyed before anybody retries', async () => {
    const first = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ root: first.root })) });
    const gpu = TestBed.inject(TypeGpu);
    first.loseDevice();
    await settle();
    const waiting = gpu.whenReady();
    const rejected = expect(waiting).rejects.toThrow(/destroyed/);
    TestBed.resetTestingModule();
    await rejected;
  });

  it.each([
    ['ready', () => ({ providers: [provideTypeGpu({ root: createFakeTypeGpu().root })] })],
    ['idle', () => ({ providers: [provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>(() => undefined) })] })],
    ['unsupported', () => ({ providers: [] })],
  ])('after the service was destroyed, a call made in `%s` rejects at once instead of hanging', async (_name, setup) => {
    TestBed.configureTestingModule({ providers: [...setup().providers, { provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    if (_name === 'unsupported') TestBed.tick();
    TestBed.resetTestingModule();
    const late = gpu.whenReady();
    await expect(late).rejects.toThrow(/destroyed/);
  });

  it('after the service was destroyed in `failed` and in `lost`, a call rejects with "destroyed" (not the old error, not a hang)', async () => {
    const boom = new Error('init failed');
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ createRoot: () => Promise.reject(boom) })) });
    const failed = TestBed.inject(TypeGpu);
    TestBed.tick();
    await settle();
    expect(failed.state().status).toBe('failed');
    TestBed.resetTestingModule();
    await expect(failed.whenReady()).rejects.toThrow(/destroyed/);

    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: providers(provideTypeGpu({ root: fake.root })) });
    const lost = TestBed.inject(TypeGpu);
    fake.loseDevice();
    await settle();
    expect(lost.state().status).toBe('lost');
    TestBed.resetTestingModule();
    await expect(lost.whenReady()).rejects.toThrow(/destroyed/);
  });

  it('server: rejects at once in every state it can be in', async () => {
    TestBed.configureTestingModule({
      providers: providers({ provide: PLATFORM_ID, useValue: 'server' }, provideTypeGpu({ root: createFakeTypeGpu().root })),
    });
    const gpu = TestBed.inject(TypeGpu);
    await expect(gpu.whenReady()).rejects.toThrow(/server/i);
    TestBed.tick();
    await expect(gpu.whenReady()).rejects.toThrow(/server/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// `navigator.gpu` exists, but there is no adapter / the device request fails

describe('unsupported environments and real init failures (through the real tgpu.init)', () => {
  const handleError = vi.fn();
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['gpu'];
    handleError.mockClear();
  });
  const stubGpu = (gpu: unknown) => Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });

  it('requestAdapter() -> null is `unsupported`: no ErrorHandler call (contract with tgpu.init\'s "Could not find a compatible GPU")', async () => {
    const requestAdapter = vi.fn(async () => null);
    stubGpu({ requestAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' });
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    const waiting = expect(gpu.whenReady()).rejects.toThrow(/not supported/);
    TestBed.tick();
    await waiting;
    expect(requestAdapter).toHaveBeenCalledTimes(1); // no second adapter request to decide this
    expect(gpu.state()).toEqual({ status: 'unsupported' });
    expect(handleError).not.toHaveBeenCalled();
  });

  it('a device request that rejects stays `failed` and is reported once', async () => {
    const boom = new Error('requestDevice failed');
    stubGpu({ requestAdapter: async () => ({ features: new Set(), requestDevice: async () => Promise.reject(boom) }) });
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await settle();
    expect(gpu.state()).toEqual({ status: 'failed', error: boom });
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);
  });

  it('an adapter request that throws stays `failed` and is reported once', async () => {
    const boom = new Error('requestAdapter blew up');
    stubGpu({ requestAdapter: async () => Promise.reject(boom) });
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await settle();
    expect(gpu.state().status).toBe('failed');
    expect(handleError).toHaveBeenCalledWith(boom);
  });

  it('retry() works from `unsupported` once an adapter exists, and a later retry with none is `unsupported` again', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    expect(gpu.state().status).toBe('unsupported'); // no navigator.gpu at all

    gpu.retry(); // still nothing: unsupported again, and not stuck in `initializing`
    expect(gpu.state().status).toBe('unsupported');

    stubGpu({ requestAdapter: async () => ({ features: new Set(), requestDevice: async () => fake.root.device }) });
    await expect(gpu.whenReady()).rejects.toThrow(/not supported/); // asking does not start anything
    const waiting = gpu.whenReady().catch(() => 'rejected');
    gpu.retry();
    expect(gpu.state().status).toBe('initializing');
    const root = await gpu.whenReady();
    expect(root.device).toBe(fake.root.device);
    expect(gpu.state().status).toBe('ready');
    expect(handleError).not.toHaveBeenCalled();
    expect(await waiting).toBe('rejected'); // it was asked in `unsupported`: settled then
  });

  it('retry() from `unsupported` that finds a null adapter ends `unsupported` again, not `failed`', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    stubGpu({ requestAdapter: async () => null });
    gpu.retry();
    await settle();
    expect(gpu.state().status).toBe('unsupported');
    expect(handleError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// who destroys the root

describe('root ownership', () => {
  const handleError = vi.fn();
  const withHandler = () => ({ provide: ErrorHandler, useValue: { handleError } });
  afterEach(() => handleError.mockClear());

  it('a root made by createRoot is destroyed exactly once, when the service is destroyed', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: async () => fake.root }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    expect(fake.rootDestroyCalls()).toBe(0);
    TestBed.resetTestingModule();
    expect(fake.rootDestroyCalls()).toBe(1);
    expect(gpu.root()).toBeUndefined(); // nothing can obtain the destroyed root any more
    await settle();
    expect(fake.rootDestroyCalls()).toBe(1);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('a root made by tgpu.init is destroyed too (device destroyed through the real root)', async () => {
    const fake = createFakeTypeGpu();
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({ features: new Set(), requestDevice: async () => fake.root.device }) },
    });
    try {
      TestBed.configureTestingModule({ providers: [withHandler()] });
      const gpu = TestBed.inject(TypeGpu);
      TestBed.tick();
      const root = await gpu.whenReady();
      const lost = root.device.lost;
      TestBed.resetTestingModule();
      await expect(lost).resolves.toMatchObject({ reason: 'destroyed' }); // real root.destroy() destroyed the (own) device
    } finally {
      delete (navigator as unknown as Record<string, unknown>)['gpu'];
    }
  });

  it('a root passed as `root` is never destroyed: not on destroy, not when it is lost and replaced', async () => {
    const provided = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: provided.root }), withHandler()] });
    TestBed.inject(TypeGpu);
    TestBed.resetTestingModule();
    expect(provided.rootDestroyCalls()).toBe(0);

    // lost -> retry with a factory-less service falls back to tgpu.init (no WebGPU here): the provided root is simply dropped.
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: provided.root }), withHandler()] });
    const second = TestBed.inject(TypeGpu);
    provided.loseDevice();
    await settle();
    second.retry();
    await settle();
    expect(provided.rootDestroyCalls()).toBe(0);
    TestBed.resetTestingModule();
    expect(provided.rootDestroyCalls()).toBe(0);
  });

  it('lost -> retry destroys the lost root once, the new one lives, and destroy releases only the new one', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    expect(first.rootDestroyCalls()).toBe(0); // nothing is destroyed until the service replaces it

    gpu.retry();
    expect(first.rootDestroyCalls()).toBe(1);
    await gpu.whenReady();
    expect(second.rootDestroyCalls()).toBe(0);
    TestBed.resetTestingModule();
    expect(first.rootDestroyCalls()).toBe(1);
    expect(second.rootDestroyCalls()).toBe(1);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('a failed retry after `lost` does not keep (or destroy twice) the lost root', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const boom = new Error('no device');
    const createRoot = vi
      .fn<() => Promise<TgpuRoot>>()
      .mockResolvedValueOnce(first.root)
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    gpu.retry();
    await settle();
    expect(gpu.state().status).toBe('failed');
    gpu.retry();
    await gpu.whenReady();
    TestBed.resetTestingModule();
    expect([first.rootDestroyCalls(), second.rootDestroyCalls()]).toEqual([1, 1]);
  });

  it('a root.destroy() that throws is reported through ErrorHandler and does not break the retry or the teardown', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const boom = new Error('destroy failed');
    (first.root as unknown as { destroy: () => void }).destroy = () => {
      throw boom;
    };
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    gpu.retry();
    await expect(gpu.whenReady()).resolves.toBe(second.root);
    expect(handleError).toHaveBeenCalledExactlyOnceWith(boom);
    TestBed.resetTestingModule();
    expect(second.rootDestroyCalls()).toBe(1);
  });

  it('destroying the service does not publish `lost` for the device it just destroyed (and ignores a provided root that is lost later)', async () => {
    const created = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: async () => created.root }), withHandler()] });
    const owned = TestBed.inject(TypeGpu);
    TestBed.tick();
    await owned.whenReady();
    TestBed.resetTestingModule();
    await settle(); // root.destroy() resolved `device.lost` with reason "destroyed"
    expect(owned.state().status).toBe('idle');

    const provided = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: provided.root }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.resetTestingModule();
    provided.loseDevice();
    await settle();
    expect(gpu.state().status).toBe('ready'); // a destroyed service no longer follows the device
  });

  it('a service destroyed before the first render never starts the GPU afterwards', () => {
    const createRoot = vi.fn(async () => createFakeTypeGpu().root);
    const child = createEnvironmentInjector([provideTypeGpu({ createRoot })], TestBed.inject(EnvironmentInjector));
    const gpu = child.get(TypeGpu);
    child.destroy();
    TestBed.tick();
    expect(createRoot).not.toHaveBeenCalled();
    expect(gpu.state().status).toBe('idle');
  });

  it('a user who destroys the service-owned root itself turns the service `lost` (a real device reports "destroyed")', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: async () => fake.root }), withHandler()] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    const root = await gpu.whenReady();
    root.destroy();
    await settle();
    expect(gpu.state()).toMatchObject({ status: 'lost', info: { reason: 'destroyed' } });
  });

  it('on application destroy every component resource is destroyed BEFORE the root', async () => {
    const fake = createFakeTypeGpu();
    const liveWhenRootDestroyed: number[] = [];
    const destroyRoot = fake.root.destroy.bind(fake.root);
    (fake.root as unknown as { destroy: () => void }).destroy = () => {
      liveWhenRootDestroyed.push(fake.liveResources());
      destroyRoot();
    };
    @Component({ selector: 'app-order-child', template: '' })
    class OrderChild {
      constructor() {
        injectUniform(d.f32);
        injectUniform(d.f32);
      }
    }
    @Component({ selector: 'app-order-root', imports: [TgpuReady, OrderChild], template: '<app-order-child *tgpuReady />' })
    class OrderRoot {}

    const host = document.createElement('app-order-root');
    document.body.append(host);
    const app = await createApplication({ providers: [provideTypeGpu({ createRoot: async () => fake.root })] });
    try {
      app.bootstrap(OrderRoot, host);
      for (let i = 0; i < 10 && fake.liveResources() === 0; i++) {
        await settle();
        app.tick();
      }
      expect(fake.liveResources()).toBe(2);
      app.destroy();
      expect(liveWhenRootDestroyed).toEqual([0]);
      expect(fake.rootDestroyCalls()).toBe(1);
    } finally {
      host.remove();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// a throwing ErrorHandler must not leave an unhandled rejection or a half-published state

describe('ErrorHandler that throws while the service reports a failed start', () => {
  it('still ends `failed`, rejects waiters, and logs the handler failure instead of rejecting a floating promise', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('init failed');
    const handlerBoom = new Error('handler broke');
    TestBed.configureTestingModule({
      providers: [
        provideTypeGpu({ createRoot: () => Promise.reject(boom) }),
        {
          provide: ErrorHandler,
          useValue: {
            handleError: () => {
              throw handlerBoom;
            },
          },
        },
      ],
    });
    const gpu = TestBed.inject(TypeGpu);
    const waiting = expect(gpu.whenReady()).rejects.toBe(boom);
    TestBed.tick();
    await waiting;
    await settle(); // an unhandled rejection would fail the run here
    expect(gpu.state()).toEqual({ status: 'failed', error: boom });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]![0]).toMatch(/ErrorHandler.handleError threw/);
    expect(consoleError.mock.calls[0]![1]).toMatchObject({ reported: boom, thrownByHandler: handlerBoom });
    consoleError.mockRestore();
  });
});
