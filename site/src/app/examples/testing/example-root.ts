// A permissive stand-in for a TypeGPU root, for lifecycle tests of the showcase examples. It is NOT a GPU emulator.
//
// What it does: buffers and uniforms still go through the library's fake root (`createFakeTypeGpu`), so creation, writes and
// `destroy()` are tracked exactly like in the library's own tests. Everything an example does with a root beyond that
// (pipelines, samplers, bind groups, textures, `device.importExternalTexture`, `root['~unstable']`, ...) returns a harmless,
// callable, chainable stub. Pipelines additionally count their `dispatch*` and `draw*` calls, so a test can tell whether a
// frame did any GPU work. Nothing here runs a shader.
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import { createFakeTypeGpu, type FakeTypeGpu } from '@typegpu-poc/angular/testing';

/** A callable object that answers every property and call with another stub. */
export interface Stub {
  (...args: unknown[]): Stub;
  readonly [property: string]: Stub;
}

export function deepStub(name: string): Stub {
  const children = new Map<string, Stub>();
  const target = function () {} as unknown as Stub;
  return new Proxy(target, {
    get(_target, property) {
      // Never thenable (so `await stub` resolves to the stub), never iterable.
      if (typeof property === 'symbol') return property === Symbol.toPrimitive ? () => 0 : undefined;
      if (property === 'then') return undefined;
      let child = children.get(property);
      if (!child) children.set(property, (child = deepStub(`${name}.${property}`)));
      return child;
    },
    apply: () => deepStub(`${name}()`),
  });
}

/** What the example asked the GPU to do, counted. */
export interface WorkStats {
  dispatches: number;
  draws: number;
  /** Pipelines created, by kind. */
  pipelines: { compute: number; render: number };
  /** How many times `createSampler`, `createBindGroup`, `createTexture` and friends were called, by method name. */
  created: Record<string, number>;
}

export interface ExampleRoot {
  /** The library's fake: resources, contexts, `loseDevice()`, `liveResources()`. */
  readonly fake: FakeTypeGpu;
  /** Pass to `provideTypeGpu`, or resolve `tgpu.init` with it. */
  readonly root: TgpuRoot;
  readonly stats: WorkStats;
  /** Dispatches plus draws so far: it grows while an example renders. */
  work(): number;
}

const zeros = new Proxy({}, { get: (_target, property) => (property === 'then' || typeof property === 'symbol' ? undefined : 0) });

/** Bytes of a schema (a real `ArrayBuffer` of this size backs `buffer.arrayBuffer`); a small default when it has no size. */
function sizeOf(schema: unknown): number {
  try {
    return Math.max(16, d.sizeOf(schema as Parameters<typeof d.sizeOf>[0]));
  } catch {
    return 1024;
  }
}

/**
 * Gives the library fake's resource the rest of the `TgpuBuffer` / binding surface the examples use. `extra` are members that
 * win over the resource's own (a binding's `buffer`, which must itself be a full buffer).
 */
function augment<T extends object>(resource: T, schema: unknown, extra: Record<string, unknown> = {}): T {
  let arrayBuffer: ArrayBuffer | undefined;
  const self: T = new Proxy(resource, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in extra) return extra[property];
      if (property === '$usage' || property === '$addFlags') return () => self;
      if (property === 'as') return () => binding();
      if (property === 'arrayBuffer') return (arrayBuffer ??= new ArrayBuffer(sizeOf(schema)));
      if (property === 'read') return () => Promise.resolve(new Proxy([], { get: (_a, index) => (typeof index === 'string' && /^\d+$/.test(index) ? zeros : index === 'length' ? 1 << 20 : undefined) }));
      if (property in target) return Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return deepStub(String(property));
    },
  });
  /** What `.as('mutable' | 'readonly' | 'uniform')` returns: a binding that points back at the buffer. */
  const binding = () =>
    new Proxy({ buffer: self, write: (value: unknown, options?: unknown) => (self as unknown as { write(v: unknown, o?: unknown): void }).write(value, options) } as Record<string, unknown>, {
      get(target, property) {
        if (property in target) return target[property as string];
        if (typeof property === 'symbol' || property === 'then') return undefined;
        return deepStub(String(property));
      },
    });
  return self;
}

/** A uniform, mutable or readonly: the library's fake binding, whose `.buffer` is a full buffer like in TypeGPU. */
function augmentBinding<T extends { buffer: object; write(value: unknown): void }>(resource: T, schema: unknown): T {
  const buffer = augment(resource.buffer, schema, { write: (value: unknown) => resource.write(value) });
  return new Proxy(resource, {
    get(target, property, receiver) {
      if (property === 'buffer') return buffer;
      if (property in target) return Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return deepStub(String(property));
    },
  });
}

function pipeline(stats: WorkStats, kind: 'compute' | 'render'): unknown {
  stats.pipelines[kind]++;
  const self: object = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol' || property === 'then') return undefined;
        if (property.startsWith('dispatch')) return () => void stats.dispatches++;
        if (property.startsWith('draw')) return () => void stats.draws++;
        // `with`, `withColorAttachment`, `withDepthStencilAttachment`, ...: the same pipeline again.
        if (property.startsWith('with')) return () => self;
        return deepStub(`pipeline.${property}`);
      },
    },
  );
  return self;
}

export function createExampleRoot(): ExampleRoot {
  const fake = createFakeTypeGpu();
  const base = fake.root as unknown as Record<string, unknown>;
  const stats: WorkStats = { dispatches: 0, draws: 0, pipelines: { compute: 0, render: 0 }, created: {} };

  const tracked = (method: string) => (schema?: unknown, initial?: unknown) => {
    const create = base[method] as (schema?: unknown, initial?: unknown) => { buffer: object; write(value: unknown): void };
    const resource = create(schema, initial);
    return method === 'createBuffer' ? augment(resource, schema) : augmentBinding(resource, schema);
  };
  const counted = (method: string) => (): Stub => {
    stats.created[method] = (stats.created[method] ?? 0) + 1;
    return deepStub(method);
  };
  // `root.with(slot, value)` gives something that builds specialised pipelines; it answers like the root does.
  const withBinding: object = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol' || property === 'then') return undefined;
        if (property === 'with') return () => withBinding;
        if (property === 'createRenderPipeline') return () => pipeline(stats, 'render');
        if (property.startsWith('create') && property.endsWith('Pipeline')) return () => pipeline(stats, 'compute');
        return deepStub(`with.${property}`);
      },
    },
  );
  const overrides: Record<string, unknown> = {
    with: () => withBinding,
    createUniform: tracked('createUniform'),
    createBuffer: tracked('createBuffer'),
    createMutable: tracked('createMutable'),
    createReadonly: tracked('createReadonly'),
    createGuardedComputePipeline: () => pipeline(stats, 'compute'),
    createComputePipeline: () => pipeline(stats, 'compute'),
    createRenderPipeline: () => pipeline(stats, 'render'),
    createSampler: counted('createSampler'),
    createBindGroup: counted('createBindGroup'),
    createTexture: counted('createTexture'),
    device: new Proxy(base['device'] as object, {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver) as unknown;
        // TypeGPU reads the features of a device when it builds a pipeline (the network's pipelines are built for real).
        if (property === 'features') return new Set<string>();
        if (typeof property === 'symbol' || property === 'then') return undefined;
        return deepStub(`device.${String(property)}`);
      },
    }),
  };

  const root = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      if (property in target) return target[property as string];
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return deepStub(String(property));
    },
  }) as unknown as TgpuRoot;

  return { fake, root, stats, work: () => stats.dispatches + stats.draws };
}
