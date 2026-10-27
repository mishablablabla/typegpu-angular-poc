// What happens to the raw output of the network before the picture uses it. The first two kernels are adapted from TypeGPU's
// `selfie-segmentation` example (MIT): a temporal filter in logit space, and a "person core" prior that fades small blobs far
// from the strongest region. The last one is this example's own: it resamples the mask into the space of the *video frame* (not
// of a canvas), and snaps its soft edge to the edges of the picture with a joint bilateral filter, so one mask serves a canvas
// of any shape and any glyph size.
import { tgpu, d, std } from 'typegpu';

const MODEL_WIDTH = 256;
const MODEL_HEIGHT = 256;
const MODEL_COORD_MASK = MODEL_WIDTH - 1;
const MODEL_COORD_SHIFT = 8;

export const MODEL_PIXELS = MODEL_WIDTH * MODEL_HEIGHT;
export const POST_PROCESS_WORKGROUP_SIZE = 64;
export const POST_PROCESS_WORKGROUPS = Math.ceil(MODEL_PIXELS / POST_PROCESS_WORKGROUP_SIZE);
export const REFINE_WORKGROUP_SIZE = 16;

const MODEL_SIZE = d.vec2f(MODEL_WIDTH, MODEL_HEIGHT);
const MAX_MASK_COORD = d.vec2i(MODEL_WIDTH - 1, MODEL_HEIGHT - 1);

const PROBABILITY_EPSILON = 1e-4;

const TEMPORAL_ALPHA_MIN = 0.08;
const TEMPORAL_ALPHA_MAX = 0.85;
const CERTAINTY_EXPONENT = 1.5;
const AGREEMENT_LOW = 0.05;
const AGREEMENT_HIGH = 0.18;
const BACKGROUND_FAST_ALPHA = 0.75;

const CORE_SEED_LOW = 0.75;
const CORE_SEED_HIGH = 0.9;
const CORE_RADIUS = 6;
const CORE_RADIUS_F = 6;
const CORE_SIGMA = 0.42;
const OUTSIDE_CORE_ATTENUATION = 0.2;
const UNCERTAIN_LOW = 0.15;
const UNCERTAIN_HIGH = 0.85;

const REFINE_BAND_LOW = 0.05;
const REFINE_BAND_HIGH = 0.95;
const REFINE_RADIUS = 2;
const REFINE_SPATIAL_SIGMA = 1.6;
const REFINE_COLOR_SIGMA = 0.12;

export const PostProcessParams = d.struct({ initialized: d.u32 });

/** Which part of the video frame the network saw (see `crop.ts`), and whether the edge of the mask follows the picture. */
export const RefineParams = d.struct({ origin: d.vec2f, size: d.vec2f, edgeAware: d.u32 });

export const temporalLayout = tgpu.bindGroupLayout({
  params: { uniform: PostProcessParams },
  raw: { storage: d.arrayOf(d.f32), access: 'readonly' },
  historyLogits: { storage: d.arrayOf(d.f32), access: 'mutable' },
  filtered: { storage: d.arrayOf(d.f32), access: 'mutable' },
});

export const priorLayout = tgpu.bindGroupLayout({
  src: { storage: d.arrayOf(d.f32), access: 'readonly' },
  dst: { storage: d.arrayOf(d.f32), access: 'mutable' },
});

export const refineLayout = tgpu.bindGroupLayout({
  params: { uniform: RefineParams },
  src: { storage: d.arrayOf(d.f32), access: 'readonly' },
  output: { storageTexture: d.textureStorage2d('rgba16float', 'write-only') },
});

export const refineFrameLayout = tgpu.bindGroupLayout({
  frame: { externalTexture: d.textureExternal() },
  sampler: { sampler: 'filtering' },
});

const maskCoord = (i: number) => {
  'use gpu';
  return d.vec2u(i & MODEL_COORD_MASK, i >>> MODEL_COORD_SHIFT);
};

const maskIndex = (coord: d.v2i) => {
  'use gpu';
  const clamped = std.clamp(coord, d.vec2i(0), MAX_MASK_COORD);
  return d.u32(clamped.y) * MODEL_WIDTH + d.u32(clamped.x);
};

const prevCoord = (value: number) => {
  'use gpu';
  if (value === 0) {
    return 0;
  }
  return value - 1;
};

const nextCoord = (value: number, maxValue: number) => {
  'use gpu';
  return std.min(value + 1, d.u32(maxValue));
};

const clampProbability = (p: number) => {
  'use gpu';
  return std.clamp(p, PROBABILITY_EPSILON, 1 - PROBABILITY_EPSILON);
};

const logitProbability = (p: number) => {
  'use gpu';
  const clamped = clampProbability(p);
  return std.log(clamped / (1 - clamped));
};

const sigmoidLogit = (z: number) => {
  'use gpu';
  return 1 / (1 + std.exp(0 - z));
};

const rawAt = (x: number, y: number) => {
  'use gpu';
  return clampProbability(temporalLayout.$.raw[y * MODEL_WIDTH + x]);
};

const priorSourceAt = (coord: d.v2i) => {
  'use gpu';
  return clampProbability(priorLayout.$.src[maskIndex(coord)]);
};

const refineSourceAt = (coord: d.v2i) => {
  'use gpu';
  return clampProbability(refineLayout.$.src[maskIndex(coord)]);
};

const modelUvAt = (coord: d.v2i) => {
  'use gpu';
  return std.div(d.vec2f(std.clamp(coord, d.vec2i(0), MAX_MASK_COORD)).add(0.5), MODEL_SIZE);
};

const gaussianWeight = (distanceSquared: number, sigma: number) => {
  'use gpu';
  return std.exp((0 - distanceSquared) / (2 * sigma * sigma));
};

const centerPrior = (uv: d.v2f) => {
  'use gpu';
  const centered = std.div(std.sub(uv, d.vec2f(0.5)), CORE_SIGMA);
  return std.exp((0 - std.dot(centered, centered)) * 0.5);
};

const uncertaintyBand = (p: number) => {
  'use gpu';
  return (
    std.smoothstep(UNCERTAIN_LOW, UNCERTAIN_LOW + 0.1, p) *
    (1 - std.smoothstep(UNCERTAIN_HIGH - 0.1, UNCERTAIN_HIGH, p))
  );
};

/** The picture at a position of the network's input (0..1 across the square it saw), looked up in the video frame. */
const cameraAtModelUv = (uv: d.v2f) => {
  'use gpu';
  const videoUv = refineLayout.$.params.origin.add(uv.mul(refineLayout.$.params.size));
  return std.textureSampleBaseClampToEdge(refineFrameLayout.$.frame, refineFrameLayout.$.sampler, videoUv).rgb;
};

/** The mask at a position of the network's output: bilinear. */
const sampleMaskBilinear = (uv: d.v2f) => {
  'use gpu';
  const pixel = std.sub(uv.mul(MODEL_SIZE), 0.5);
  const base = d.vec2i(std.floor(pixel));
  const frac = pixel.sub(d.vec2f(base));

  const topLeft = refineSourceAt(base);
  const topRight = refineSourceAt(base.add(d.vec2i(1, 0)));
  const bottomLeft = refineSourceAt(base.add(d.vec2i(0, 1)));
  const bottomRight = refineSourceAt(base.add(d.vec2i(1, 1)));

  const top = std.mix(topLeft, topRight, frac.x);
  const bottom = std.mix(bottomLeft, bottomRight, frac.x);
  return std.mix(top, bottom, frac.y);
};

/** A pixel of the filtered mask is blended from its own history in logit space, faster where the network is sure. */
export const temporalAccumulatorKernel = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [POST_PROCESS_WORKGROUP_SIZE],
})(({ gid }) => {
  'use gpu';
  const i = gid.x;
  if (i >= MODEL_PIXELS) {
    return;
  }

  const raw = clampProbability(temporalLayout.$.raw[i]);
  const rawLogit = logitProbability(raw);
  if (temporalLayout.$.params.initialized === 0) {
    temporalLayout.$.historyLogits[i] = rawLogit;
    temporalLayout.$.filtered[i] = raw;
    return;
  }

  const coord = maskCoord(i);
  const left = prevCoord(coord.x);
  const right = nextCoord(coord.x, MODEL_WIDTH - 1);
  const top = prevCoord(coord.y);
  const bottom = nextCoord(coord.y, MODEL_HEIGHT - 1);
  const horizontal = rawAt(left, coord.y) + rawAt(right, coord.y);
  const vertical = rawAt(coord.x, top) + rawAt(coord.x, bottom);
  const localMean = (raw + horizontal + vertical) * 0.2;

  const certainty = std.abs(raw - 0.5) * 2;
  const certaintyBlend = std.mix(TEMPORAL_ALPHA_MIN, TEMPORAL_ALPHA_MAX, std.pow(certainty, CERTAINTY_EXPONENT));
  const agreement = 1 - std.smoothstep(AGREEMENT_LOW, AGREEMENT_HIGH, std.abs(raw - localMean));
  const supportScale = std.mix(0.55, 1, agreement);
  const confidentBackground = 1 - std.smoothstep(0.08, 0.2, raw);
  const alpha = std.max(certaintyBlend * supportScale, confidentBackground * BACKGROUND_FAST_ALPHA);
  const filteredLogit = std.mix(temporalLayout.$.historyLogits[i], rawLogit, alpha);

  temporalLayout.$.historyLogits[i] = filteredLogit;
  temporalLayout.$.filtered[i] = sigmoidLogit(filteredLogit);
});

/** Weak regions with no confident person nearby (and far from the middle) are attenuated: this removes stray blobs. */
export const personCorePriorKernel = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [POST_PROCESS_WORKGROUP_SIZE],
})(({ gid }) => {
  'use gpu';
  const i = gid.x;
  if (i >= MODEL_PIXELS) {
    return;
  }

  const coord = d.vec2i(maskCoord(i));
  const probability = clampProbability(priorLayout.$.src[i]);
  const uv = std.div(d.vec2f(coord).add(0.5), MODEL_SIZE);
  const centerWeight = centerPrior(uv);
  let support = d.f32(0);
  let totalWeight = d.f32(0);

  for (let dy = -CORE_RADIUS; dy <= CORE_RADIUS; dy++) {
    for (let dx = -CORE_RADIUS; dx <= CORE_RADIUS; dx++) {
      const offset = d.vec2i(dx, dy);
      const dist2 = d.f32(dx * dx + dy * dy);
      if (dist2 <= CORE_RADIUS_F * CORE_RADIUS_F) {
        const sampleCoord = coord.add(offset);
        const sampleValue = priorSourceAt(sampleCoord);
        const sampleUv = modelUvAt(sampleCoord);
        const seed = std.smoothstep(CORE_SEED_LOW, CORE_SEED_HIGH, sampleValue);
        const spatialWeight = gaussianWeight(dist2, CORE_RADIUS_F);
        const weightedSeed = seed * std.mix(0.4, 1, centerPrior(sampleUv));
        support += weightedSeed * spatialWeight;
        totalWeight += spatialWeight;
      }
    }
  }

  const normalizedSupport = support / std.max(totalWeight, 1e-4);
  const protection = normalizedSupport * std.mix(0.45, 1, centerWeight);
  const outside = 1 - std.smoothstep(0.035, 0.12, protection);
  const uncertaintyProtection = uncertaintyBand(probability) * 0.35;
  const attenuation = std.mix(1, OUTSIDE_CORE_ATTENUATION, outside * (1 - uncertaintyProtection));
  priorLayout.$.dst[i] = probability * attenuation;
});

/**
 * One thread per pixel of the mask texture, which covers the whole video frame. Where the network saw the pixel, the mask is
 * its bilinear value; in the soft band between "no" and "yes" it is averaged over the neighbours that look like the pixel (a
 * joint bilateral filter over the camera colours), so the edge of the person lands on the edge in the picture. Outside what
 * the network saw (the padding of a letterboxed frame) there is no person.
 */
export const refineKernel = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [REFINE_WORKGROUP_SIZE, REFINE_WORKGROUP_SIZE],
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(refineLayout.$.output);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  const outputCoord = d.vec2u(gid.xy);
  const videoUv = std.div(d.vec2f(outputCoord).add(0.5), d.vec2f(dims));
  const uv = std.div(videoUv.sub(refineLayout.$.params.origin), refineLayout.$.params.size);
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) {
    std.textureStore(refineLayout.$.output, outputCoord, d.vec4f(0, 0, 0, 1));
    return;
  }

  const baseMask = sampleMaskBilinear(uv);
  if (refineLayout.$.params.edgeAware === 0 || baseMask <= REFINE_BAND_LOW || baseMask >= REFINE_BAND_HIGH) {
    std.textureStore(refineLayout.$.output, outputCoord, d.vec4f(baseMask, 0, 0, 1));
    return;
  }

  const centerColor = cameraAtModelUv(uv);
  const modelPixel = std.sub(uv.mul(MODEL_SIZE), 0.5);
  const baseCoord = d.vec2i(std.floor(modelPixel));
  let weightedMask = d.f32(0);
  let totalWeight = d.f32(0);

  for (let dy = -REFINE_RADIUS; dy <= REFINE_RADIUS; dy++) {
    for (let dx = -REFINE_RADIUS; dx <= REFINE_RADIUS; dx++) {
      const sampleCoord = baseCoord.add(d.vec2i(dx, dy));
      const clampedCoord = std.clamp(sampleCoord, d.vec2i(0), MAX_MASK_COORD);
      const sampleColor = cameraAtModelUv(modelUvAt(clampedCoord));
      const colorDelta = centerColor.sub(sampleColor);
      const colorDist2 = std.dot(colorDelta, colorDelta);
      const spatialDist2 = d.f32(dx * dx + dy * dy);
      const weight = gaussianWeight(spatialDist2, REFINE_SPATIAL_SIGMA) * gaussianWeight(colorDist2, REFINE_COLOR_SIGMA);
      weightedMask += refineSourceAt(clampedCoord) * weight;
      totalWeight += weight;
    }
  }

  std.textureStore(refineLayout.$.output, outputCoord, d.vec4f(weightedMask / std.max(totalWeight, 1e-4), 0, 0, 1));
});

export const rowsLayout = tgpu.bindGroupLayout({
  src: { storage: d.arrayOf(d.f32), access: 'readonly' },
  rows: { storage: d.arrayOf(d.vec2f, MODEL_HEIGHT), access: 'mutable' },
});

/**
 * One thread per row of the mask: how many of its pixels are person, and the sum of their columns. 256 rows are a few
 * kilobytes, which is all the page ever reads back from the GPU: enough to find a head (see `matrix.face.ts`).
 */
export const rowProfileKernel = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [MODEL_HEIGHT],
})(({ gid }) => {
  'use gpu';
  const y = gid.x;
  let count = d.f32(0);
  let sum = d.f32(0);
  for (let x = 0; x < MODEL_WIDTH; x++) {
    if (rowsLayout.$.src[y * MODEL_WIDTH + d.u32(x)] > 0.5) {
      count += 1;
      sum += d.f32(x);
    }
  }
  rowsLayout.$.rows[y] = d.vec2f(count, sum);
});
