// GPU-free fakes for unit tests. Not part of the main entry point (`import ... from '.../testing'`).
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';

/** Bookkeeping handle of a fake buffer (the same state as the buffer object the root returns). */
export interface FakeBuffer {
  readonly destroy: () => void;
  /** A function (kept for compatibility); the buffer object itself has a `destroyed` boolean like TypeGPU's. */
  readonly destroyed: () => boolean;
}

export interface FakeResource {
  readonly kind: 'uniform' | 'buffer' | 'mutable' | 'readonly';
  /**
   * Every value written, `initial` first (when there was one), then each `write()` call, as in earlier
   * versions. Use {@link FakeResource.calls} to assert on `write()` alone.
   */
  readonly writes: unknown[];
  /** The value passed at creation. Real TypeGPU writes it at creation (mapped buffer), not through `write()`. */
  readonly initial: unknown;
  /** Only the `write()` calls (what a `from` signal or the component itself wrote), without `initial`. */
  readonly calls: unknown[];
  /** Usages of the buffer (`uniform`/`storage` implied by the kind, plus those added with `$usage()`), in order. */
  readonly usages: string[];
  readonly buffer: FakeBuffer;
}

export interface FakeTypeGpu {
  /** Pass to `provideTypeGpu({ root })` (ready immediately) or return from `createRoot`. */
  readonly root: TgpuRoot;
  /** Every resource created through the fake root, in creation order. */
  readonly resources: readonly FakeResource[];
  /** Every `configureContext` call: canvas, options and the context it returned (one context per canvas, like `getContext('webgpu')`). */
  readonly contexts: readonly { canvas: HTMLCanvasElement; options: Record<string, unknown>; context: GPUCanvasContext }[];
  /** Every `context.unconfigure()` call, in order. */
  readonly unconfigured: readonly { canvas: HTMLCanvasElement; context: GPUCanvasContext }[];
  /** Number of `root.destroy()` calls. */
  readonly rootDestroyCalls: () => number;
  /**
   * Resolves `device.lost` like a real device loss would. Does nothing after the device was lost
   * or destroyed (a real `lost` promise settles once).
   */
  loseDevice(info?: Partial<GPUDeviceLostInfo>): void;
  /** Resources not yet destroyed: the number a leak check should assert on. */
  liveResources(): number;
}

/**
 * A minimal fake root: enough surface for the library's resource functions and canvas
 * directive. It is a hand-written stand-in, not a GPU emulator; shaders and pipelines are
 * not supported (create pipelines in the component under test only in real-GPU tests).
 *
 * Where it matches TypeGPU 0.12 on purpose: `write()` on a destroyed buffer throws
 * `This buffer has been destroyed`; `destroy()` is idempotent; `root.destroy()` destroys the
 * device, which resolves `device.lost` with reason `'destroyed'`; buffers have `$usage()`,
 * `as()`, `arrayBuffer`, `destroyed`, `dataType`, `initial`; one context per canvas. What it does
 * NOT do: serialise or validate values against the schema, enforce usage rules, run shaders.
 * It is built from closures (no `this`, no private fields) so that it can be wrapped in a Proxy.
 */
export function createFakeTypeGpu(): FakeTypeGpu {
  const resources: FakeResource[] = [];
  const contexts: FakeTypeGpu['contexts'][number][] = [];
  const unconfigured: FakeTypeGpu['unconfigured'][number][] = [];
  const contextOf = new WeakMap<object, GPUCanvasContext>();
  let rootDestroyCalls = 0;
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  let isLost = false;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => (resolveLost = resolve));
  const loseDevice = (info: GPUDeviceLostInfo) => {
    if (isLost) return;
    isLost = true;
    resolveLost(info);
  };
  const destroyDevice = () => loseDevice({ reason: 'destroyed', message: '' } as GPUDeviceLostInfo);

  const create = (kind: FakeResource['kind']) => (schema: unknown, initial?: unknown) => {
    let destroyed = false;
    let arrayBuffer: ArrayBuffer | undefined;
    const calls: unknown[] = [];
    const writes: unknown[] = initial === undefined ? [] : [initial];
    const usages: string[] = kind === 'uniform' ? ['uniform'] : kind === 'buffer' ? [] : ['storage'];
    const handle: FakeBuffer = {
      destroy: () => {
        destroyed = true;
      },
      destroyed: () => destroyed,
    };
    resources.push({ kind, writes, initial, calls, usages, buffer: handle });

    const write = (value: unknown) => {
      if (destroyed) throw new Error('This buffer has been destroyed');
      calls.push(value);
      writes.push(value);
    };
    const bindings = new Map<string, Record<string, unknown>>();
    const buffer: Record<string, unknown> = {
      resourceType: 'buffer',
      dataType: schema,
      initial,
      write,
      destroy: handle.destroy,
      get destroyed() {
        return destroyed;
      },
      get arrayBuffer() {
        if (destroyed) throw new Error('This buffer has been destroyed');
        return (arrayBuffer ??= new ArrayBuffer(sizeOf(schema)));
      },
      $usage: (...added: string[]) => {
        for (const usage of added) if (!usages.includes(usage)) usages.push(usage);
        return buffer;
      },
      $addFlags: () => buffer,
      $name: () => buffer,
      as: (usage: string) => {
        let binding = bindings.get(usage);
        if (!binding) {
          const created: Record<string, unknown> = { resourceType: usage, buffer, write, $name: () => created };
          bindings.set(usage, (binding = created));
        }
        return binding;
      },
    };
    // A TgpuBuffer is the buffer itself; the binding kinds (uniform, mutable, readonly) wrap one in `.buffer`.
    if (kind === 'buffer') return buffer;
    const binding: Record<string, unknown> = { resourceType: kind, buffer, write, $name: () => binding };
    return binding;
  };

  const fakeRoot = {
    device: { lost, destroy: destroyDevice },
    createUniform: create('uniform'),
    createBuffer: create('buffer'),
    createMutable: create('mutable'),
    createReadonly: create('readonly'),
    configureContext(options: { canvas: HTMLCanvasElement } & Record<string, unknown>) {
      const { canvas, ...rest } = options;
      let context = contextOf.get(canvas);
      if (!context) {
        const created = {
          canvas,
          configure: () => undefined,
          unconfigure: () => {
            unconfigured.push({ canvas, context: created });
          },
        } as unknown as GPUCanvasContext;
        contextOf.set(canvas, (context = created));
      }
      contexts.push({ canvas, options: rest, context });
      return context;
    },
    destroy: () => {
      rootDestroyCalls++;
      destroyDevice();
    },
  };

  return {
    // The one cast of the fake: the fake only implements what this library calls.
    root: fakeRoot as unknown as TgpuRoot,
    resources,
    contexts,
    unconfigured,
    rootDestroyCalls: () => rootDestroyCalls,
    loseDevice: (info = {}) => loseDevice({ reason: 'unknown', message: 'fake device lost', ...info } as GPUDeviceLostInfo),
    liveResources: () => resources.filter((r) => !r.buffer.destroyed()).length,
  };
}

/** Byte size of a schema; a small default for schemas that have none (or are not schemas at all). */
function sizeOf(schema: unknown): number {
  try {
    return Math.max(4, d.sizeOf(schema as Parameters<typeof d.sizeOf>[0]));
  } catch {
    return 16;
  }
}

export interface ManualAnimationFrames {
  /**
   * Runs every callback that is queued right now, once, then advances the fake clock.
   * Callbacks queued while flushing run on the next `flush()`, like in a browser.
   */
  flush(stepMs?: number): void;
  /** Callbacks queued right now (including Angular's own scheduler: prefer asserting on your callbacks). */
  pending(): number;
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
    pending: () => queue.size,
    restore() {
      globalThis.requestAnimationFrame = original.raf;
      globalThis.cancelAnimationFrame = original.caf;
    },
  };
}
