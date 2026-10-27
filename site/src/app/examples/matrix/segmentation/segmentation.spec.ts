// The plain parts of the person segmenter: the model file, the crop of the frame, the size of the mask. The shaders are covered
// by the shader gate (`testing/examples.shaders.spec.ts`), which resolves every pipeline of the network to WGSL.
import { describe, expect, it } from 'vitest';
import { OpKind, parseSegmenterPlan } from './bundle';
import { letterboxCrop } from './crop';
import { MASK_LONG_SIDE, maskSize } from './mask';

const nodeFs = 'node:fs';
declare const process: { cwd(): string };
async function modelBytes(): Promise<ArrayBuffer> {
  const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: string): Uint8Array };
  const bytes = readFileSync(`${process.cwd()}/public/assets/selfie-segmentation/selfie_segmenter.ssgbin`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('the model file', () => {
  it('lists the layers of the network, ending in the head that writes the mask', async () => {
    const plan = parseSegmenterPlan(await modelBytes());
    expect(plan.dispatches).toHaveLength(92);
    expect(plan.slotSizesVec4).toHaveLength(12);
    // The input of the network is a 256 by 256 picture of 3 channels, and the output a 256 by 256 mask of 1.
    expect(plan.dispatches[0]!.input).toEqual([256, 256, 3]);
    const head = plan.dispatches[plan.dispatches.length - 1]!;
    expect(head.opKind).toBe(OpKind.Head);
    expect(head.output).toEqual([256, 256, 1]);
    // Every layer reads and writes slots that exist, and weights lie inside the weights block.
    for (const layer of plan.dispatches) {
      for (const slot of layer.slots.filter((index) => index >= 0)) expect(slot).toBeLessThan(plan.slotSizesVec4.length);
      if (layer.weights >= 0) expect(layer.weights * 8).toBeLessThan(plan.weights.byteLength);
    }
  });

  it('refuses a file that is not a model', () => {
    expect(() => parseSegmenterPlan(new TextEncoder().encode('not a model at all, just text').buffer as ArrayBuffer)).toThrow(/Unsupported model file/);
  });
});

describe('the crop of the frame', () => {
  it('is the whole frame in a square: a wide frame is padded above and below, a tall one on the sides', () => {
    const wide = letterboxCrop(1280, 720);
    expect(wide.size.x).toBe(1);
    expect(wide.size.y).toBeCloseTo(16 / 9);
    expect(wide.origin.y).toBeCloseTo(0.5 - 16 / 18);
    const tall = letterboxCrop(720, 1280);
    expect(tall.size.y).toBe(1);
    expect(tall.size.x).toBeCloseTo(16 / 9);
    expect(tall.origin.x).toBeCloseTo(0.5 - 16 / 18);
    expect(letterboxCrop(500, 500)).toEqual({ origin: { x: 0, y: 0 }, size: { x: 1, y: 1 } });
  });

  it('is centred on the frame, and covers it, whatever the shape', () => {
    for (const [w, h] of [[1280, 720], [640, 480], [480, 640], [1920, 800], [3, 1000]] as const) {
      const { origin, size } = letterboxCrop(w, h);
      for (const axis of ['x', 'y'] as const) {
        expect(origin[axis]).toBeLessThanOrEqual(0 + 1e-9);
        expect(origin[axis] + size[axis]).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(origin[axis] + size[axis] / 2).toBeCloseTo(0.5);
      }
      // The square in pixels: the crop is as wide as it is tall.
      expect(size.x * w).toBeCloseTo(size.y * h);
    }
  });

  it('survives a size that is not known yet', () => {
    expect(letterboxCrop(0, 0)).toEqual({ origin: { x: 0, y: 0 }, size: { x: 1, y: 1 } });
  });
});

describe('the size of the mask', () => {
  it('keeps the shape of the frame with the long side fixed', () => {
    expect(maskSize(1280, 720)).toEqual([MASK_LONG_SIDE, 270]);
    expect(maskSize(720, 1280)).toEqual([270, MASK_LONG_SIDE]);
    expect(maskSize(640, 640)).toEqual([MASK_LONG_SIDE, MASK_LONG_SIDE]);
    expect(maskSize(0, 0)).toEqual([MASK_LONG_SIDE, MASK_LONG_SIDE]);
    for (const dimension of maskSize(5000, 1)) expect(dimension).toBeGreaterThanOrEqual(1);
  });
});
