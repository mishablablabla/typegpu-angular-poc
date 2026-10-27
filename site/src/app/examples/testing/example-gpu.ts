// Makes the real `tgpu.init()` (which both the library's `TypeGpu` service and the hand-written `ManualGpu` call) hand out a
// root that works without a GPU, so the examples run their normal start-up path in tests.
//
// How: a fake `navigator.gpu` whose adapter returns the fake device of an `ExampleRoot` (see example-root.ts); `tgpu.init()`
// wraps that device in a real root object, and the methods of that root's class that create resources, pipelines and canvas
// contexts are replaced, for roots whose device belongs to an `ExampleRoot`, by the stub's. Nothing else of TypeGPU is touched.
// It is not a GPU emulator, and it is installed for the duration of one test.
import { vi } from 'vitest';
import { tgpu } from 'typegpu';
import type { RecordingDevice } from './example-device';
import type { ExampleRoot } from './example-root';

/**
 * What the next `requestAdapter()` does: hand out this root's device (a stand-in root), hand out a recording device (the real
 * root runs on it), fail with this error, or find no adapter.
 */
export type Start = ExampleRoot | RecordingDevice | Error | null;

export interface FakeGpu {
  /** Starts of the GPU, in order. A start with nothing queued finds no adapter (`tgpu.init()` throws). */
  readonly queue: Start[];
  /** How many starts were attempted. */
  starts(): number;
  restore(): void;
}

const OVERRIDDEN = [
  'createBuffer',
  'createUniform',
  'createMutable',
  'createReadonly',
  'createGuardedComputePipeline',
  'createComputePipeline',
  'createRenderPipeline',
  'createTexture',
  'with',
  'configureContext',
  'destroy',
] as const;

const owners = new WeakMap<object, ExampleRoot>();

/** The class of the roots `tgpu.init()` returns (it is not exported), found through a root made from a throwaway device. */
function rootPrototype(): Record<string, unknown> {
  return Object.getPrototypeOf(tgpu.initFromDevice({ device: {} as GPUDevice })) as Record<string, unknown>;
}

/**
 * @param available `navigator.gpu` exists. Without it the library reports `unsupported` and `ManualGpu` does the same.
 */
export function installFakeGpu(available: boolean): FakeGpu {
  const queue: Start[] = [];
  let starts = 0;

  const prototype = rootPrototype();
  const originals = new Map<string, unknown>();
  for (const name of OVERRIDDEN) {
    const original = prototype[name] as (...args: unknown[]) => unknown;
    originals.set(name, original);
    prototype[name] = function (this: { device: object }, ...args: unknown[]) {
      const owner = owners.get(this.device);
      if (!owner) return original.apply(this, args);
      const method = (owner.root as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
      return method.apply(owner.root, args);
    };
  }

  if (available) {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: vi.fn(async () => {
          starts++;
          const next = queue.shift();
          if (next instanceof Error) throw next;
          if (!next) return null;
          if ('shaders' in next) return { features: new Set<string>(), requestDevice: async () => next.device };
          const device = next.root.device;
          owners.set(device, next);
          return { features: new Set<string>(), requestDevice: async () => device };
        }),
      },
    });
  }

  return {
    queue,
    starts: () => starts,
    restore() {
      for (const [name, original] of originals) prototype[name] = original;
      delete (navigator as unknown as Record<string, unknown>)['gpu'];
    },
  };
}
