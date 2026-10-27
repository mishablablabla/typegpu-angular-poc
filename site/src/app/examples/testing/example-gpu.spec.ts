import { afterEach, describe, expect, it } from 'vitest';
import { d, tgpu } from 'typegpu';
import { installFakeGpu, type FakeGpu } from './example-gpu';
import { createExampleRoot } from './example-root';

let gpu: FakeGpu | undefined;
afterEach(() => gpu?.restore());

describe('the fake GPU', () => {
  it('makes the real tgpu.init() hand out a root whose resources the example root tracks', async () => {
    const exampleRoot = createExampleRoot();
    gpu = installFakeGpu(true);
    gpu.queue.push(exampleRoot);
    const root = await tgpu.init();
    root.createBuffer(d.arrayOf(d.f32, 4)).$usage('storage');
    root.createUniform(d.f32, 1);
    expect(exampleRoot.fake.resources.map((resource) => resource.kind)).toEqual(['buffer', 'uniform']);
    expect(exampleRoot.fake.liveResources()).toBe(2);
    root.destroy();
    expect(exampleRoot.fake.rootDestroyCalls()).toBe(1);
    expect(gpu.starts()).toBe(1);
  });

  it('fails a start with the queued error, finds no adapter when nothing is queued, and reports no WebGPU without navigator.gpu', async () => {
    gpu = installFakeGpu(true);
    gpu.queue.push(new Error('boom'));
    await expect(tgpu.init()).rejects.toThrow('boom');
    await expect(tgpu.init()).rejects.toThrow(/compatible GPU/);
    gpu.restore();
    gpu = installFakeGpu(false);
    await expect(tgpu.init()).rejects.toThrow(/not supported/);
  });

  it('leaves roots that it does not know alone, and puts the real methods back on restore', () => {
    gpu = installFakeGpu(true);
    const patched = tgpu.initFromDevice({ device: {} as GPUDevice }).createBuffer;
    gpu.restore();
    expect(tgpu.initFromDevice({ device: {} as GPUDevice }).createBuffer).not.toBe(patched);
    expect(navigator.gpu).toBeUndefined();
  });
});
