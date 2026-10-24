// GPU-free fakes for unit tests. Not part of the main entry point (`import ... from '.../testing'`).
import type { TgpuRoot } from 'typegpu';

export interface FakeBuffer {
  readonly destroy: () => void;
  readonly destroyed: () => boolean;
}

export interface FakeResource {
  readonly kind: 'uniform' | 'buffer' | 'mutable' | 'readonly';
  readonly writes: unknown[];
  readonly buffer: FakeBuffer;
}

export interface FakeTypeGpu {
  /** Pass to `provideTypeGpu({ root })` (ready immediately) or return from `createRoot`. */
  readonly root: TgpuRoot;
  /** Every resource created through the fake root, in creation order. */
  readonly resources: readonly FakeResource[];
  /** Every `configureContext` call: canvas, options and the context it returned. */
  readonly contexts: readonly { canvas: HTMLCanvasElement; options: Record<string, unknown>; context: GPUCanvasContext }[];
  /** Number of `root.destroy()` calls. */
  readonly rootDestroyCalls: () => number;
  /** Resolves `device.lost` like a real device loss would. */
  loseDevice(info?: Partial<GPUDeviceLostInfo>): void;
  /** Resources not yet destroyed: the number a leak check should assert on. */
  liveResources(): number;
}

/**
 * A minimal fake root: enough surface for the library's resource functions and canvas
 * directive. It is a hand-written stand-in, not a GPU emulator; shaders and pipelines are
 * not supported (create pipelines in the component under test only in real-GPU tests).
 */
export function createFakeTypeGpu(): FakeTypeGpu {
  const resources: FakeResource[] = [];
  const contexts: FakeTypeGpu['contexts'][number][] = [];
  let rootDestroyCalls = 0;
  let loseDevice!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => (loseDevice = resolve));

  const create = (kind: FakeResource['kind']) => (_schema: unknown, initial?: unknown) => {
    let destroyed = false;
    const writes: unknown[] = initial === undefined ? [] : [initial];
    const buffer: FakeBuffer = {
      destroy: () => {
        destroyed = true;
      },
      destroyed: () => destroyed,
    };
    resources.push({ kind, writes, buffer });
    const write = (value: unknown) => writes.push(value);
    // A TgpuBuffer is the buffer itself; the binding kinds (uniform, mutable, readonly) wrap one in `.buffer`.
    return kind === 'buffer' ? { ...buffer, write } : { buffer, write };
  };

  const fakeRoot = {
    device: { lost },
    createUniform: create('uniform'),
    createBuffer: create('buffer'),
    createMutable: create('mutable'),
    createReadonly: create('readonly'),
    configureContext(options: { canvas: HTMLCanvasElement } & Record<string, unknown>) {
      const { canvas, ...rest } = options;
      const context = { canvas, configure: () => undefined } as unknown as GPUCanvasContext;
      contexts.push({ canvas, options: rest, context });
      return context;
    },
    destroy: () => {
      rootDestroyCalls++;
    },
  };

  return {
    // The one cast of the fake: the fake only implements what this library calls.
    root: fakeRoot as unknown as TgpuRoot,
    resources,
    contexts,
    rootDestroyCalls: () => rootDestroyCalls,
    loseDevice: (info = {}) => loseDevice({ reason: 'unknown', message: 'fake device lost', ...info } as GPUDeviceLostInfo),
    liveResources: () => resources.filter((r) => !r.buffer.destroyed()).length,
  };
}

export interface ManualAnimationFrames {
  /**
   * Runs every callback that is queued right now, once, then advances the fake clock.
   * Callbacks queued while flushing run on the next `flush()`, like in a browser.
   */
  flush(stepMs?: number): void;
  /** Restores the real `requestAnimationFrame` / `cancelAnimationFrame`. */
  restore(): void;
}

/**
 * Replaces `requestAnimationFrame` with a queue you flush by hand. Angular's own scheduler uses
 * the same global, so assert on what *your* callbacks did per flush, not on how often rAF was called.
 */
export function installManualAnimationFrames(): ManualAnimationFrames {
  const original = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = 1000;

  globalThis.requestAnimationFrame = (callback) => {
    queue.set(nextId, callback);
    return nextId++;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queue.delete(id);
  };

  return {
    flush(stepMs = 16) {
      const due = queue;
      queue = new Map();
      for (const callback of due.values()) callback(now);
      now += stepMs;
    },
    restore() {
      globalThis.requestAnimationFrame = original.raf;
      globalThis.cancelAnimationFrame = original.caf;
    },
  };
}
