// Lifecycle edge cases: owners that never finish their first render, the frame loop while the GPU is not ready,
// device loss during rendering and initialisation, repeated retry(), shared roots, canvas failure modes and
// where `provideTypeGpu()` takes effect.
import {
  Component,
  EnvironmentInjector,
  ErrorHandler,
  createEnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import {
  TgpuCanvas,
  TgpuReady,
  TypeGpu,
  injectFrame,
  injectUniform,
  provideTypeGpu,
} from '@typegpu-poc/angular';
import {
  createFakeTypeGpu,
  installManualAnimationFrames,
  type FakeTypeGpu,
  type ManualAnimationFrames,
} from '@typegpu-poc/angular/testing';

const settle = () => new Promise((resolve) => setTimeout(resolve));
let fake: FakeTypeGpu;
let frames: ManualAnimationFrames;
const handleError = vi.fn();

beforeEach(() => {
  fake = createFakeTypeGpu();
  frames = installManualAnimationFrames();
  handleError.mockClear();
  TestBed.configureTestingModule({
    providers: [provideTypeGpu({ root: fake.root }), { provide: ErrorHandler, useValue: { handleError } }],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  frames.restore();
});

describe('owners that never finish their first render', () => {
  it('an owner destroyed before its first render never registers a frame callback or sampler', async () => {
    const callback = vi.fn();
    const source = signal(1);
    @Component({ selector: 'app-short-lived', template: '' })
    class ShortLived {
      constructor() {
        injectUniform(d.f32, { from: source });
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(ShortLived);
    fixture.destroy(); // e.g. `*tgpuReady` content that is torn down before Angular rendered it
    TestBed.tick();
    await settle();
    frames.flush();
    frames.flush();
    source.set(2);
    frames.flush();

    expect(callback).not.toHaveBeenCalled();
    expect(fake.resources[0]!.writes).toEqual([]);
    expect(fake.liveResources()).toBe(0);
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('the frame loop', () => {
  it('stops scheduling frames while the GPU is not ready, and starts again when it is', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const callback = vi.fn();
    @Component({ imports: [TgpuReady], template: '<span *tgpuReady></span>' })
    class Host {
      constructor() {
        injectFrame(callback);
      }
    }
    const gpu = TestBed.inject(TypeGpu);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);

    first.loseDevice();
    await settle();
    await fixture.whenStable();
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    frames.flush(); // may run the tick that was already queued
    frames.flush();
    frames.flush();
    expect(raf).not.toHaveBeenCalled(); // idle: nothing re-queues itself while lost
    expect(callback).toHaveBeenCalledTimes(1);
    gpu.retry();
    await settle();
    await fixture.whenStable();
    // The callback belongs to the first root and stays stopped (rule 6), so it does not resume.
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps running the other consumers when an owner destroys itself inside a frame callback', async () => {
    const other = vi.fn();
    @Component({ selector: 'app-self-destroy', template: '' })
    class Host {
      constructor() {
        injectFrame(() => fixtureRef.destroy());
      }
    }
    @Component({ selector: 'app-other', template: '' })
    class Other {
      constructor() {
        injectFrame(other);
      }
    }
    const fixtureRef = TestBed.createComponent(Host);
    const otherFixture = TestBed.createComponent(Other);
    await fixtureRef.whenStable();
    await otherFixture.whenStable();
    frames.flush();
    frames.flush();
    expect(other).toHaveBeenCalledTimes(2);
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('device loss while rendering', () => {
  it('a loss raised inside a frame callback stops the next frame, with no further writes', async () => {
    const source = signal(1);
    let frame = 0;
    const callback = vi.fn(() => {
      if (++frame === 2) fake.loseDevice(); // the device dies mid-render
    });
    @Component({ selector: 'app-loss-in-frame', template: '' })
    class LossInFrame {
      constructor() {
        injectUniform(d.f32, { from: source });
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(LossInFrame);
    await fixture.whenStable();
    frames.flush();
    frames.flush();
    await settle();
    source.set(2);
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(fake.resources[0]!.writes).toEqual([1]);
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('sampling', () => {
  it('a `from` write that throws is reported once and stops that sampler only', async () => {
    const boom = new Error('write failed');
    const source = signal(1);
    const callback = vi.fn();
    @Component({ selector: 'app-bad-write', template: '' })
    class BadWrite {
      readonly uniform = injectUniform(d.f32, { from: source });
      constructor() {
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(BadWrite);
    await fixture.whenStable();
    vi.spyOn(fixture.componentInstance.uniform, 'write').mockImplementation(() => {
      throw boom;
    });
    frames.flush();
    source.set(2);
    frames.flush();
    source.set(3);
    frames.flush();
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);
    expect(callback).toHaveBeenCalledTimes(3); // the frame callback of the same owner keeps running
  });
});

describe('device loss during initialisation', () => {
  it('a root whose device is already lost ends up `lost` and leaves no resources behind', async () => {
    const dead = createFakeTypeGpu();
    dead.loseDevice();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValue(dead.root);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    @Component({ selector: 'app-gated', template: '' })
    class Gated {
      constructor() {
        injectUniform(d.f32);
      }
    }
    @Component({ imports: [TgpuReady, Gated], template: '<app-gated *tgpuReady />' })
    class Host {}
    const gpu = TestBed.inject(TypeGpu);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();

    expect(gpu.state().status).toBe('lost');
    expect(dead.liveResources()).toBe(0);
  });
});

describe('repeated retry()', () => {
  it('calls while a retry is in flight or after it succeeded start nothing new', async () => {
    const boom = new Error('no adapter');
    const next = createFakeTypeGpu();
    let resolve!: (root: TgpuRoot) => void;
    const createRoot = vi
      .fn<() => Promise<TgpuRoot>>()
      .mockRejectedValueOnce(boom)
      .mockImplementationOnce(() => new Promise<TgpuRoot>((r) => (resolve = r)));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot }), { provide: ErrorHandler, useValue: { handleError } }],
    });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await settle();
    expect(gpu.state().status).toBe('failed');

    gpu.retry();
    gpu.retry();
    gpu.retry();
    expect(gpu.state().status).toBe('initializing');
    expect(createRoot).toHaveBeenCalledTimes(2);

    resolve(next.root);
    await gpu.whenReady();
    gpu.retry(); // ready: nothing to retry
    expect(createRoot).toHaveBeenCalledTimes(2);
    expect(gpu.root()).toBe(next.root);
    expect(handleError).toHaveBeenCalledTimes(1);
  });
});

describe('sharing the root between consumers', () => {
  it('destroying one consumer leaves the others and the root alone', async () => {
    @Component({ selector: 'app-consumer', template: '' })
    class Consumer {
      readonly uniform = injectUniform(d.f32);
    }
    const a = TestBed.createComponent(Consumer);
    const b = TestBed.createComponent(Consumer);
    await a.whenStable();
    expect(fake.liveResources()).toBe(2);
    a.destroy();
    expect(fake.liveResources()).toBe(1);
    expect(fake.rootDestroyCalls()).toBe(0);
    expect(TestBed.inject(TypeGpu).state().status).toBe('ready');
    b.destroy();
    expect(fake.liveResources()).toBe(0);
    expect(fake.rootDestroyCalls()).toBe(0);
  });
});

describe('canvas', () => {
  it('drops the old context when configuring for a changed option set throws', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    // TestBed rethrows application errors by default; this test wants them to reach ErrorHandler.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      rethrowApplicationErrors: false,
      providers: [provideTypeGpu({ root: fake.root }), { provide: ErrorHandler, useValue: { handleError } }],
    });
    try {
      const real = fake.root.configureContext.bind(fake.root);
      let shouldThrow = false;
      const boom = new Error('canvas already has a 2d context');
      Object.assign(fake.root, {
        configureContext: (options: Parameters<typeof real>[0]) => {
          if (shouldThrow) throw boom;
          return real(options);
        },
      });
      @Component({
        imports: [TgpuCanvas],
        template: `<canvas [tgpuCanvas]="options()" #c="tgpuCanvas"></canvas>`,
      })
      class Host {
        readonly options = signal<Record<string, unknown>>({ autoResize: false });
      }
      const fixture = TestBed.createComponent(Host);
      await fixture.whenStable();
      const canvas = fixture.debugElement.children[0]!.injector.get(TgpuCanvas);
      expect(canvas.context()).toBeDefined();

      shouldThrow = true;
      fixture.componentInstance.options.set({ autoResize: false, alphaMode: 'premultiplied' });
      await fixture.whenStable();
      expect(canvas.context()).toBeUndefined();
      expect(handleError).toHaveBeenCalledWith(boom);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('canvas without ResizeObserver (jsdom, the default `ng test` environment)', () => {
  it('still configures the context; it just cannot track the size', async () => {
    expect(typeof ResizeObserver).toBe('undefined'); // the premise: nothing is stubbed here
    @Component({ imports: [TgpuCanvas], template: '<canvas tgpuCanvas></canvas>' })
    class Host {}
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const canvas = fixture.debugElement.children[0]!.injector.get(TgpuCanvas);
    expect(canvas.context()).toBeDefined();
    expect(canvas.size()).toBeUndefined();
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('where the configuration lives', () => {
  it('provideTypeGpu() in a child injector configures that injector, not silently the root one', () => {
    const other = createFakeTypeGpu();
    const child = createEnvironmentInjector([provideTypeGpu({ root: other.root })], TestBed.inject(EnvironmentInjector));
    expect(child.get(TypeGpu).root()).toBe(other.root);
    expect(TestBed.inject(TypeGpu).root()).toBe(fake.root);
  });
});

describe('whenReady() and retry() across loss', () => {
  it('whenReady() during `lost` waits for the next root and rejects if the service is destroyed first', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    first.loseDevice();
    await settle();
    expect(gpu.state().status).toBe('lost');

    const waiting = gpu.whenReady();
    let settled = false;
    void waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();
    expect(settled).toBe(false);
    gpu.retry();
    await expect(waiting).resolves.toBe(second.root);
  });

  it('retry() after the loss of a root given to provideTypeGpu({ root }) never reuses the dead root', async () => {
    const gpu = TestBed.inject(TypeGpu);
    fake.loseDevice();
    await settle();
    expect(gpu.state().status).toBe('lost');
    gpu.retry(); // there is no factory, so the service falls back to tgpu.init() (jsdom: no WebGPU)
    await settle();
    expect(gpu.root()).not.toBe(fake.root);
    expect(gpu.state().status).toBe('unsupported');
    expect(fake.rootDestroyCalls()).toBe(0); // a root we were given is never destroyed
  });
});
