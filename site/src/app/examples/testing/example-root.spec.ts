import { describe, expect, it } from 'vitest';
import { d } from 'typegpu';
import { createExampleRoot, deepStub } from './example-root';

describe('the example root stub', () => {
  it('tracks buffers, uniforms and their destruction through the library fake', () => {
    const { fake, root } = createExampleRoot();
    const buffer = root.createBuffer(d.arrayOf(d.f32, 8)).$usage('storage');
    const uniform = root.createUniform(d.f32, 1);
    root.createReadonly(d.f32);
    root.createMutable(d.f32);
    expect(fake.resources.map((r) => r.kind)).toEqual(['buffer', 'uniform', 'readonly', 'mutable']);
    expect(fake.liveResources()).toBe(4);
    uniform.write(2);
    expect(fake.resources[1]!.writes).toEqual([1, 2]);
    (buffer as unknown as { destroy(): void }).destroy();
    expect(fake.liveResources()).toBe(3);
  });

  it('gives buffers a real, schema-sized ArrayBuffer and an empty read()', async () => {
    const { root } = createExampleRoot();
    const buffer = root.createBuffer(d.arrayOf(d.f32, 8));
    expect(buffer.arrayBuffer.byteLength).toBe(32);
    expect(buffer.arrayBuffer).toBe(buffer.arrayBuffer);
    const read = (await buffer.read()) as unknown as { spike: number }[];
    expect(read[3]!.spike).toBe(0);
  });

  it('binds with .as() back to the same buffer', () => {
    const { fake, root } = createExampleRoot();
    const buffer = root.createBuffer(d.f32).$usage('storage');
    const mutable = buffer.as('mutable') as unknown as { buffer: { destroy(): void }; $: unknown };
    expect(mutable.$).toBeDefined();
    mutable.buffer.destroy();
    expect(fake.liveResources()).toBe(0);
  });

  it('counts dispatches and draws of the pipelines it hands out, through any `with…` chain', () => {
    const exampleRoot = createExampleRoot();
    const { root, stats } = exampleRoot;
    const compute = root.createGuardedComputePipeline(() => undefined);
    const render = root.createRenderPipeline({} as never);
    (compute as unknown as { dispatchThreads(x: number, y: number): void }).dispatchThreads(8, 8);
    (render as unknown as { withColorAttachment(a: unknown): { with(g: unknown): { draw(n: number): void } } }).withColorAttachment({}).with({}).draw(3);
    expect(stats.pipelines).toEqual({ compute: 1, render: 1 });
    expect([stats.dispatches, stats.draws, exampleRoot.work()]).toEqual([1, 1, 2]);
  });

  it('answers everything else with callable, chainable, non-thenable stubs, and still configures contexts and reports device loss', async () => {
    const { fake, root, stats } = createExampleRoot();
    expect(() => root.createSampler({})).not.toThrow();
    root.createBindGroup({} as never, {} as never);
    expect(stats.created).toEqual({ createSampler: 1, createBindGroup: 1 });
    const imported = (root.device as unknown as { importExternalTexture(o: unknown): unknown }).importExternalTexture({});
    expect(await imported).toBe(imported);
    expect(deepStub('x')['a']!['b']!()['c']).toBeDefined();
    const canvas = document.createElement('canvas');
    root.configureContext({ canvas });
    expect(fake.contexts).toHaveLength(1);
    let lost = false;
    void root.device.lost.then(() => (lost = true));
    fake.loseDevice();
    await Promise.resolve();
    expect(lost).toBe(true);
  });
});
