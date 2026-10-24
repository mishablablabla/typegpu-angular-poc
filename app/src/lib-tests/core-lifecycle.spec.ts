// Lifecycle regression tests: server behaviour, first render, device loss, failing callbacks, destroyed owners.
// Each test name states the behaviour it protects.
import {
  Component,
  EnvironmentInjector,
  ErrorHandler,
  PLATFORM_ID,
  createEnvironmentInjector,
  input,
  runInInjectionContext,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import { TgpuReady, TypeGpu, injectFrame, injectUniform, provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type FakeTypeGpu, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';

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
afterEach(() => frames.restore());

describe('server', () => {
  it('whenReady() rejects on the server instead of hanging', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }] });
    await expect(TestBed.inject(TypeGpu).whenReady()).rejects.toThrow(/server/i);
  });
});

describe('inputs and first render', () => {
  it('a `from` signal that reads a required input is not sampled before the first render', async () => {
    @Component({ selector: 'app-late-input', template: '' })
    class LateInput {
      readonly value = input.required<number>();
      constructor() {
        injectUniform(d.f32, { from: this.value });
      }
    }
    const fixture = TestBed.createComponent(LateInput);
    frames.flush(); // a frame before the component has rendered or received its input
    frames.flush();
    fixture.componentRef.setInput('value', 7);
    await fixture.whenStable();
    frames.flush();
    expect(fake.resources[0]!.writes).toEqual([7]);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('a frame callback does not run before its owner rendered (viewChild.required is safe)', async () => {
    @Component({ selector: 'app-view-child', template: '<span #el></span>' })
    class ViewChild {
      readonly el = viewChild.required<ElementRef<HTMLElement>>('el');
      readonly seen: HTMLElement[] = [];
      constructor() {
        injectFrame(() => this.seen.push(this.el().nativeElement));
      }
    }
    const fixture = TestBed.createComponent(ViewChild);
    frames.flush();
    expect(fixture.componentInstance.seen.length).toBe(0);
    await fixture.whenStable();
    frames.flush();
    expect(fixture.componentInstance.seen.length).toBe(1);
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe('device loss', () => {
  it('stops frame callbacks and `from` writes as soon as the device is lost, before any change detection', async () => {
    const source = signal(1);
    const callback = vi.fn();
    @Component({ selector: 'app-loss', template: '' })
    class Loss {
      constructor() {
        injectUniform(d.f32, { from: source });
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(Loss);
    await fixture.whenStable();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);

    fake.loseDevice();
    await settle(); // the lost state is published; Angular has not rerendered
    source.set(2);
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fake.resources[0]!.writes).toEqual([1]);
    fixture.destroy();
  });

  it('work created for a lost root never resumes on the root made by retry()', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const callback = vi.fn();
    const source = signal(1);
    @Component({ selector: 'app-stale-after-retry', template: '' })
    class StaleAfterRetry {
      constructor() {
        injectUniform(d.f32, { from: source });
        injectFrame(callback);
      }
    }
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await gpu.whenReady();
    const fixture = TestBed.createComponent(StaleAfterRetry); // NOT behind *tgpuReady
    await fixture.whenStable();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(first.resources[0]!.writes).toEqual([1]);

    first.loseDevice();
    await settle();
    gpu.retry();
    await gpu.whenReady();
    source.set(2);
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1); // still the old root's work: stays stopped
    expect(first.resources[0]!.writes).toEqual([1]);
  });

  it('behind *tgpuReady, a retry recreates the work for the new root', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const callback = vi.fn();
    @Component({ selector: 'app-gated-child', template: '' })
    class GatedChild {
      constructor() {
        injectUniform(d.f32);
        injectFrame(callback);
      }
    }
    @Component({ imports: [TgpuReady, GatedChild], template: '<app-gated-child *tgpuReady />' })
    class GatedHost {}
    const fixture = TestBed.createComponent(GatedHost);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);

    first.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(first.liveResources()).toBe(0);
    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(second.liveResources()).toBe(1);
  });

  it('an old root that is lost after a retry does not affect the new root', async () => {
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
    gpu.retry();
    await gpu.whenReady();
    expect(gpu.root()).toBe(second.root);

    first.loseDevice({ message: 'second notification' }); // already resolved: no effect, but must not throw
    second.loseDevice();
    await settle();
    expect(gpu.state().status).toBe('lost');
    expect(gpu.state().status === 'lost' && gpu.state()).toMatchObject({ info: { message: 'fake device lost' } });
  });
});

describe('callbacks that fail', () => {
  it('an async frame callback that rejects is reported once and stopped (no unhandled rejection)', async () => {
    const boom = new Error('async failure');
    const callback = vi.fn(async () => {
      throw boom;
    });
    @Component({ selector: 'app-async-frame', template: '' })
    class AsyncFrame {
      constructor() {
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(AsyncFrame);
    await fixture.whenStable();
    frames.flush();
    await settle();
    frames.flush();
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);
  });
});

describe('owners that are already destroyed', () => {
  it('creating a resource in a destroyed injector fails loudly instead of leaking a buffer', () => {
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    injector.destroy();
    expect(() => runInInjectionContext(injector, () => injectUniform(d.f32))).toThrow();
    expect(fake.liveResources()).toBe(0);
  });
});
