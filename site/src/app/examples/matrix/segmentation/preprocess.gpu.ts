// The first kernel of the segmenter: it turns the current video frame (an external texture) into the network's input. It is a
// `*.gpu.ts` file, which is what makes the build transform its `'use gpu'` functions into shaders.
import { tgpu, d, std } from 'typegpu';
import { FrameCrop } from './crop';
import { WORKGROUP_SIZE } from './kernels/types';

const MODEL_WIDTH = 256;
const MODEL_HEIGHT = 256;
export const MODEL_PIXELS = MODEL_WIDTH * MODEL_HEIGHT;
const MODEL_SIZE = d.vec2f(MODEL_WIDTH, MODEL_HEIGHT);

export const cropLayout = tgpu.bindGroupLayout({ crop: { uniform: FrameCrop } });
export const frameLayout = tgpu.bindGroupLayout({ frame: { externalTexture: d.textureExternal() }, sampler: { sampler: 'filtering' } });
export const inputLayout = tgpu.bindGroupLayout({ dst: { storage: d.arrayOf(d.vec4f), access: 'mutable' } });

/** The picture inside the crop at a position of the network's input; black where the crop lies outside the frame. */
const frameInside = (uv: d.v2f) => {
  'use gpu';
  const inside = uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;
  const color = std.textureSampleBaseClampToEdge(frameLayout.$.frame, frameLayout.$.sampler, uv).rgb;
  return std.select(d.vec3f(0), color, inside);
};

/**
 * One thread per pixel of the input. A frame is several times larger than the input, so each pixel averages four taps (each
 * a bilinear tap itself): a plain single tap would alias thin things, and the network would see flicker where there is none.
 */
export const preprocessKernel = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [WORKGROUP_SIZE],
})(({ gid }) => {
  'use gpu';
  const i = gid.x;
  if (i >= MODEL_PIXELS) {
    return;
  }

  const pixel = d.vec2f(d.f32(i & (MODEL_WIDTH - 1)) + 0.5, d.f32(i >>> 8) + 0.5);
  const crop = cropLayout.$.crop;
  const uv = crop.origin.add(std.div(pixel, MODEL_SIZE).mul(crop.size));
  const quarter = std.div(crop.size, MODEL_SIZE).mul(0.25);
  const color = frameInside(uv.add(d.vec2f(quarter.x, quarter.y)))
    .add(frameInside(uv.add(d.vec2f(quarter.x, -quarter.y))))
    .add(frameInside(uv.add(d.vec2f(-quarter.x, quarter.y))))
    .add(frameInside(uv.add(d.vec2f(-quarter.x, -quarter.y))))
    .mul(0.25);
  inputLayout.$.dst[i] = d.vec4f(color, 0);
});

