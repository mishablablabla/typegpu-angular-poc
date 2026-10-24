import { ErrorHandler, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TypeGpu, injectRoot, provideTypeGpu } from '@typegpu-poc/angular';
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
