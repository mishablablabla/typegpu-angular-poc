import { Component, ErrorHandler, NgZone, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import {
  TgpuReady,
  TypeGpu,
  injectFrame,
  injectUniform,
  provideTypeGpu,
  type FrameInfo,
  type FrameOptions,
  type FrameRef,
} from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';

let frames: ManualAnimationFrames;
const handleError = vi.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve));
beforeEach(() => {
  frames = installManualAnimationFrames();
  handleError.mockClear();
  TestBed.configureTestingModule({
    providers: [provideTypeGpu({ root: createFakeTypeGpu().root }), { provide: ErrorHandler, useValue: { handleError } }],
  });
});
afterEach(() => frames.restore());

// One component class for every test (defining a fresh class per call trips Angular's NG0912 id-collision warning).
@Component({ selector: 'app-frame', template: '' })
class Consumer {
  static next: ((frame: FrameInfo) => void) | undefined;
  static options: FrameOptions | undefined;
  readonly ref: FrameRef = injectFrame(Consumer.next!, Consumer.options);
}

function consumer(callback: (frame: FrameInfo) => void, options?: FrameOptions) {
  Consumer.next = callback;
  Consumer.options = options;
  const fixture = TestBed.createComponent(Consumer);
  TestBed.tick(); // the first frame callback happens after the owner's first render
  return { fixture, ref: { current: fixture.componentInstance.ref } };
}

describe('injectFrame', () => {
  it('shares one loop: every consumer runs exactly once per frame', () => {
    const a = vi.fn();
    const b = vi.fn();
    consumer(a);
    consumer(b);
    frames.flush();
    frames.flush();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('reports delta and elapsed time per callback and reuses the info object', () => {
    const seen: { delta: number; elapsed: number; info: FrameInfo }[] = [];
    consumer((info) => seen.push({ delta: info.deltaSeconds, elapsed: info.elapsedSeconds, info }));
    frames.flush(16);
    frames.flush(16);
    frames.flush(16);
    expect(seen.map((s) => s.delta)).toEqual([0, 0.016, 0.016]);
    expect(seen.map((s) => s.elapsed)).toEqual([0, 0.016, 0.032]);
    expect(new Set(seen.map((s) => s.info)).size).toBe(1);
  });

  it('stops when the owner is destroyed', () => {
    const callback = vi.fn();
    const { fixture } = consumer(callback);
    frames.flush();
    fixture.destroy();
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('can be paused and resumed without touching other consumers', () => {
    const paused = vi.fn();
    const other = vi.fn();
    const { ref } = consumer(paused);
    consumer(other);
    frames.flush();
    ref.current!.pause();
    expect(ref.current!.paused()).toBe(true);
    frames.flush();
    frames.flush();
    ref.current!.resume();
    frames.flush();
    expect(paused).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(4);
  });

  it('goes idle while every consumer is paused and wakes up on resume', () => {
    const callback = vi.fn();
    const { ref } = consumer(callback);
    frames.flush();
    ref.current!.pause();
    frames.flush(); // the pause is noticed, nothing runs, nothing is rescheduled
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    ref.current!.resume();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('stops a callback that throws, reports it once, and keeps other consumers running', () => {
    const boom = new Error('shader setup failed');
    const broken = vi.fn(() => {
      throw boom;
    });
    const healthy = vi.fn();
    consumer(broken);
    consumer(healthy);
    frames.flush();
    frames.flush();
    frames.flush();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);
    expect(healthy).toHaveBeenCalledTimes(3);
  });

  it('never runs on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }, { provide: ErrorHandler, useValue: { handleError } }] });
    const callback = vi.fn();
    consumer(callback);
    frames.flush();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('deltaSeconds after a long gap', () => {
  const record = (options?: FrameOptions) => {
    const seen: { delta: number; elapsed: number }[] = [];
    const result = consumer((info) => seen.push({ delta: info.deltaSeconds, elapsed: info.elapsedSeconds }), options);
    return { seen, ...result };
  };

  it('is 0 on the first frame, untouched for normal frames, clamped to 0.25 s after a gap; elapsedSeconds stays real time', () => {
    const { seen } = record();
    frames.flush(16); // first frame
    frames.flush(60_000); // second frame; then the tab is hidden for a minute
    frames.flush(16); // the first frame after the gap
    frames.flush(16);
    expect(seen.map((s) => s.delta)).toEqual([0, 0.016, 0.25, 0.016]);
    expect(seen[2]!.elapsed).toBeCloseTo(60.016, 6); // real wall time, not the sum of the clamped deltas
    expect(seen[3]!.elapsed).toBeCloseTo(60.032, 6);
  });

  it('a gap longer than the first frame cannot make the first delta anything but 0', () => {
    const { seen } = record();
    frames.flush(60_000);
    frames.flush();
    expect(seen.map((s) => s.delta)).toEqual([0, 0.25]);
  });

  it('resume() after a long pause reports the clamped step, not the whole pause', () => {
    const { seen, ref } = record();
    frames.flush(16);
    frames.flush(16);
    ref.current!.pause();
    frames.flush(10_000); // noticed: nothing runs
    ref.current!.resume();
    frames.flush();
    expect(seen.map((s) => s.delta)).toEqual([0, 0.016, 0.25]);
  });

  it('maxDeltaSeconds overrides the limit, and Infinity turns the clamp off', () => {
    const custom = record({ maxDeltaSeconds: 1 });
    const off = record({ maxDeltaSeconds: Infinity });
    frames.flush(16);
    frames.flush(5_000);
    frames.flush();
    expect(custom.seen.map((s) => s.delta)).toEqual([0, 0.016, 1]);
    expect(off.seen.map((s) => s.delta)).toEqual([0, 0.016, 5]);
  });

  it.each([0, -1, NaN])('rejects maxDeltaSeconds %s (a limit that freezes time is a bug)', (value) => {
    expect(() => consumer(() => undefined, { maxDeltaSeconds: value })).toThrow(/maxDeltaSeconds must be greater than 0/);
  });
});

describe('a failing ErrorHandler cannot stop the loop', () => {
  it('a bad callback + an ErrorHandler that rethrows: the other consumers keep running, the failure is logged', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('callback failed');
    const handlerBoom = new Error('handler failed');
    handleError.mockImplementation(() => {
      throw handlerBoom;
    });
    const bad = vi.fn(() => {
      throw boom;
    });
    const before = vi.fn();
    const after = vi.fn();
    consumer(before);
    consumer(bad);
    consumer(after);
    frames.flush();
    frames.flush();
    frames.flush();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledTimes(3);
    expect(after).toHaveBeenCalledTimes(3); // not skipped in the frame where the handler threw
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]![1]).toMatchObject({ reported: boom, thrownByHandler: handlerBoom });
    handleError.mockReset();
    consoleError.mockRestore();
  });

  it('a `from` write that throws with an ErrorHandler that rethrows does not stop the frame callbacks', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handleError.mockImplementation(() => {
      throw new Error('handler failed');
    });
    const source = signal(1);
    const callback = vi.fn();
    @Component({ selector: 'app-bad-sampler', template: '' })
    class BadSampler {
      readonly uniform = injectUniform(d.f32, { from: source });
      constructor() {
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(BadSampler);
    await fixture.whenStable();
    vi.spyOn(fixture.componentInstance.uniform, 'write').mockImplementation(() => {
      throw new Error('write failed');
    });
    frames.flush();
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalledTimes(1);
    handleError.mockReset();
    consoleError.mockRestore();
  });
});

describe('the loop', () => {
  /** Frames requested through the global (Angular's own scheduler may use it too: nothing here triggers change detection). */
  const requested = () => vi.spyOn(globalThis, 'requestAnimationFrame');

  it('stops requesting frames when nothing is left to run (owner destroyed), and asks again for a new consumer', () => {
    const callback = vi.fn();
    const { fixture } = consumer(callback);
    frames.flush();
    fixture.destroy();
    frames.flush(); // the already queued tick finds no active task
    const raf = requested();
    frames.flush();
    frames.flush();
    frames.flush();
    expect(raf).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
    raf.mockRestore();

    const again = vi.fn();
    consumer(again);
    frames.flush();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('does not idle while a `from` resource exists, even when nothing changes (documented cost: one Object.is per frame)', async () => {
    const source = signal(1);
    @Component({ selector: 'app-from-only', template: '' })
    class FromOnly {
      constructor() {
        injectUniform(d.f32, { from: source });
      }
    }
    const fixture = TestBed.createComponent(FromOnly);
    await fixture.whenStable();
    frames.flush();
    const raf = requested();
    for (let i = 0; i < 5; i++) frames.flush();
    expect(raf).toHaveBeenCalledTimes(5); // one request per frame, forever
    raf.mockRestore();
    fixture.destroy();
    frames.flush(); // the queued tick sees no sampler left
    const afterDestroy = requested();
    frames.flush();
    frames.flush();
    expect(afterDestroy).not.toHaveBeenCalled();
    afterDestroy.mockRestore();
  });

  it('schedules frames outside the Angular zone (NgZone.runOutsideAngular is used for every rAF request)', () => {
    // Real zone behaviour needs zone.js, which this app does not install: this pins that the loop asks for the zone escape.
    let outside = 0;
    let requestedOutside = 0;
    let requestedInside = 0;
    const zone = TestBed.inject(NgZone); // NoopNgZone in a zoneless app: the same method, no real escape
    const runOutsideAngular = zone.runOutsideAngular.bind(zone);
    zone.runOutsideAngular = <T>(fn: (...args: unknown[]) => T) => {
      outside++;
      try {
        return runOutsideAngular(fn);
      } finally {
        outside--;
      }
    };
    const callback = vi.fn();
    consumer(callback); // (its first request is made while Angular's own scheduler may also be asking: not counted)
    const real = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (frame) => {
      if (outside > 0) requestedOutside++;
      else requestedInside++;
      return real(frame);
    };
    try {
      frames.flush();
      frames.flush();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(requestedOutside).toBe(2); // one re-request per tick, nothing else asks for frames in these flushes
      expect(requestedInside).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = real;
      zone.runOutsideAngular = runOutsideAngular;
    }
  });
});

describe('callbacks that fail late', () => {
  it('an async callback that rejects after its owner was destroyed is still reported (once), not dropped', async () => {
    const boom = new Error('late rejection');
    let reject!: (error: unknown) => void;
    const callback = vi.fn(() => new Promise<void>((_resolve, rej) => (reject = rej)) as unknown as void);
    const { fixture } = consumer(callback);
    frames.flush();
    fixture.destroy();
    reject(boom);
    await settle();
    expect(handleError).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it('several rejections from one callback are reported once (the callback was stopped by the first)', async () => {
    const rejects: ((error: unknown) => void)[] = [];
    const callback = vi.fn(() => new Promise<void>((_resolve, rej) => rejects.push(rej)) as unknown as void);
    consumer(callback);
    frames.flush();
    frames.flush(); // second frame, before the first promise settled
    rejects[0]!(new Error('first'));
    rejects[1]!(new Error('second'));
    await settle();
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError.mock.calls[0]![0]).toMatchObject({ message: 'first' });
  });
});

describe('a callback created before the GPU is ready', () => {
  it('starts once the root is ready, even though the loop had gone idle in the meantime (once, no catch-up)', async () => {
    const fake = createFakeTypeGpu();
    let resolve!: (root: TgpuRoot) => void;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>((r) => (resolve = r)) }),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    const callback = vi.fn();
    @Component({ selector: 'app-early', template: '' })
    class Early {
      constructor() {
        injectFrame(callback);
      }
    }
    const fixture = TestBed.createComponent(Early);
    await fixture.whenStable();
    frames.flush();
    frames.flush();
    frames.flush(); // not ready: the loop noticed that and went idle
    expect(callback).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);

    resolve(fake.root);
    await settle();
    await fixture.whenStable(); // the wake-up effect runs with change detection
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(TestBed.inject(TypeGpu).state().status).toBe('ready');
  });

  it('does not start before an owner behind *tgpuReady exists, and then runs once per frame', async () => {
    const fake = createFakeTypeGpu();
    let resolve!: (root: TgpuRoot) => void;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>((r) => (resolve = r)) }),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    const callback = vi.fn();
    @Component({ selector: 'app-gated-frame', template: '' })
    class GatedFrame {
      constructor() {
        injectFrame(callback);
      }
    }
    @Component({ imports: [TgpuReady, GatedFrame], template: '<app-gated-frame *tgpuReady />' })
    class Host {}
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    frames.flush();
    expect(callback).not.toHaveBeenCalled();
    resolve(fake.root);
    await settle();
    await fixture.whenStable();
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
