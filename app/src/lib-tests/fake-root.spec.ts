// The fake root is what every other spec trusts, so it gets its own checks: the behaviours that the real TypeGPU 0.12
// root has and tests depend on (verified against the real library in a browser: write() after destroy throws, destroy
// is idempotent, root.destroy() makes `device.lost` resolve with reason "destroyed").
import { describe, expect, it } from 'vitest';
import { d } from 'typegpu';
import { createFakeTypeGpu, installManualAnimationFrames } from '@typegpu-poc/angular/testing';

describe('createFakeTypeGpu: buffers', () => {
  it('write() on a destroyed buffer throws like TypeGPU, for buffers and for every binding kind', () => {
    const fake = createFakeTypeGpu();
    const buffer = fake.root.createBuffer(d.f32);
    const uniform = fake.root.createUniform(d.f32);
    const mutable = fake.root.createMutable(d.f32);
    const readonly = fake.root.createReadonly(d.f32);
    buffer.write(1);
    buffer.destroy();
    uniform.buffer.destroy();
    mutable.buffer.destroy();
    readonly.buffer.destroy();
    expect(() => buffer.write(2)).toThrow('This buffer has been destroyed');
    expect(() => uniform.write(2)).toThrow('This buffer has been destroyed');
    expect(() => mutable.write(2)).toThrow('This buffer has been destroyed');
    expect(() => readonly.write(2)).toThrow('This buffer has been destroyed');
    expect(buffer.destroyed).toBe(true);
    expect(fake.resources.map((r) => r.calls)).toEqual([[1], [], [], []]); // the failed writes are not recorded
  });

  it('destroy() is idempotent and liveResources() counts only live buffers', () => {
    const fake = createFakeTypeGpu();
    const a = fake.root.createBuffer(d.f32);
    fake.root.createUniform(d.f32);
    expect(fake.liveResources()).toBe(2);
    a.destroy();
    a.destroy();
    expect(fake.liveResources()).toBe(1);
  });

  it('records `initial` separately from write() calls (real TypeGPU writes it at creation), and keeps `writes` as before', () => {
    const fake = createFakeTypeGpu();
    const uniform = fake.root.createUniform(d.f32, 3);
    uniform.write(4);
    const resource = fake.resources[0]!;
    expect(resource.initial).toBe(3);
    expect(resource.calls).toEqual([4]);
    expect(resource.writes).toEqual([3, 4]); // initial first, then the calls: unchanged contract
    expect(fake.root.createUniform(d.f32).buffer).toBeDefined();
    expect(fake.resources[1]!.initial).toBeUndefined();
    expect(fake.resources[1]!.writes).toEqual([]);
  });

  it('buffers have the members the docs tell users to call: $usage, as, arrayBuffer, destroyed, dataType, initial', () => {
    const fake = createFakeTypeGpu();
    const schema = d.arrayOf(d.f32, 4);
    const buffer = fake.root.createBuffer(schema, [1, 2, 3, 4] as never).$usage('storage', 'vertex');
    expect(fake.resources[0]!.usages).toEqual(['storage', 'vertex']);
    expect(buffer.dataType).toBe(schema);
    expect(buffer.initial).toEqual([1, 2, 3, 4]);
    expect(buffer.arrayBuffer.byteLength).toBe(16);
    expect(buffer.arrayBuffer).toBe(buffer.arrayBuffer); // one backing store
    const mutable = buffer.as('mutable');
    expect(mutable).toBe(buffer.as('mutable'));
    expect(mutable.buffer).toBe(buffer);
    mutable.write([5, 6, 7, 8] as never);
    expect(fake.resources[0]!.calls).toEqual([[5, 6, 7, 8]]);
    buffer.destroy();
    expect(() => buffer.arrayBuffer).toThrow('This buffer has been destroyed');
    // a uniform / mutable / readonly wraps a full buffer, like TypeGPU
    const uniform = fake.root.createUniform(d.f32);
    expect(uniform.buffer.destroyed).toBe(false);
    expect(fake.resources[1]!.usages).toEqual(['uniform']);
  });

  it('can be wrapped in a Proxy (the showcase does): getters and methods use closures, not `this`', () => {
    const fake = createFakeTypeGpu();
    const wrapped = new Proxy(fake.root.createBuffer(d.f32) as unknown as Record<string, unknown>, {
      get: (target, property, receiver) => Reflect.get(target, property, receiver) as unknown,
    });
    (wrapped['write'] as (value: unknown) => void)(1);
    expect(wrapped['destroyed']).toBe(false);
    (wrapped['destroy'] as () => void)();
    expect(wrapped['destroyed']).toBe(true);
    expect(() => (wrapped['write'] as (value: unknown) => void)(2)).toThrow(/destroyed/);
  });
});

describe('createFakeTypeGpu: device and root', () => {
  it('root.destroy() resolves device.lost with reason "destroyed", counts the call, and loseDevice() afterwards does nothing', async () => {
    const fake = createFakeTypeGpu();
    const lost = fake.root.device.lost;
    fake.root.destroy();
    await expect(lost).resolves.toMatchObject({ reason: 'destroyed' });
    fake.loseDevice({ message: 'too late' });
    await expect(lost).resolves.toMatchObject({ reason: 'destroyed' }); // a promise settles once
    fake.root.destroy();
    expect(fake.rootDestroyCalls()).toBe(2); // every call is counted, the library must call it once
  });

  it('loseDevice() keeps working as before and wins when it comes first', async () => {
    const fake = createFakeTypeGpu();
    fake.loseDevice({ reason: 'unknown', message: 'GPU hang' });
    fake.root.destroy();
    await expect(fake.root.device.lost).resolves.toMatchObject({ reason: 'unknown', message: 'GPU hang' });
  });

  it('hands out one context per canvas (like getContext("webgpu")), records every configure and every unconfigure', () => {
    const fake = createFakeTypeGpu();
    const a = document.createElement('canvas');
    const b = document.createElement('canvas');
    const first = fake.root.configureContext({ canvas: a, alphaMode: 'opaque' });
    const again = fake.root.configureContext({ canvas: a, alphaMode: 'premultiplied' });
    const other = fake.root.configureContext({ canvas: b });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(fake.contexts.map((c) => c.options)).toEqual([{ alphaMode: 'opaque' }, { alphaMode: 'premultiplied' }, {}]);
    first.unconfigure();
    expect(fake.unconfigured).toEqual([{ canvas: a, context: first }]);
  });
});

describe('installManualAnimationFrames', () => {
  it('reports how many callbacks are queued, runs each flush once, and restores the real functions', () => {
    const real = globalThis.requestAnimationFrame;
    const frames = installManualAnimationFrames();
    try {
      let runs = 0;
      const again = () => {
        runs++;
        requestAnimationFrame(again);
      };
      requestAnimationFrame(again);
      expect(frames.pending()).toBe(1);
      frames.flush();
      frames.flush();
      expect(runs).toBe(2); // re-queued callbacks wait for the next flush
      const id = requestAnimationFrame(() => undefined);
      cancelAnimationFrame(id);
      expect(frames.pending()).toBe(1);
    } finally {
      frames.restore();
    }
    expect(globalThis.requestAnimationFrame).toBe(real);
  });
});
