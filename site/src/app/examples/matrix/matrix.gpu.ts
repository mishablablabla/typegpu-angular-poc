// The shaders of MATRIX MIRROR, shared by both implementations (see life.gpu.ts for how `*.gpu.ts` modules work).
//
// The picture arrives as an external texture: the current video frame, imported again every frame. Who is a person comes from
// a neural network that runs as compute shaders next to this one (see `segmentation/`): its mask is a texture over the whole
// frame, and this file only reads it. One fragment shader draws everything: code rain whose brightness follows the room behind
// the person, and the person as glyphs in other colours, cut out along the mask.
import tgpu, { d, std } from 'typegpu';
import type { TgpuFixedSampler, TgpuUniform } from 'typegpu';
import { MAX_RIPPLES, RIPPLE_HOLD, RIPPLE_LIFETIME } from './matrix.model';

/** The frame of the video, as imported by the example every frame. */
export const frameLayout = tgpu.bindGroupLayout({ frame: { externalTexture: d.textureExternal() } });

/** The person mask: a texture over the whole video frame, 0 (background) to 1 (person) in the red channel. */
export const maskLayout = tgpu.bindGroupLayout({ mask: { texture: d.texture2d() } });

/** The canvas and the video: their sizes, the glyph size, and whether the picture is mirrored. */
export const View = d.struct({ size: d.vec2f, video: d.vec2f, cell: d.f32, mirror: d.f32 });

/** The controls (`reach` is the radius of a click, in canvas heights) and whether the system asked for less motion. */
export const Params = d.struct({ speed: d.f32, cutoff: d.f32, reach: d.f32, palette: d.u32, reduced: d.f32 });

/** Time. */
export const Clock = d.struct({ time: d.f32, dt: d.f32 });

/** The pointer, its recent clicks (where, when, and a seed for their cracks), and the hidden ending: how mad the picture is, how torn, and how much of it a collapsing television still shows (height, width, brightness of the dot). */
export const Ripple = d.struct({ center: d.vec2f, birth: d.f32, seed: d.f32 });
export const Effects = d.struct({ pointer: d.vec2f, hover: d.f32, chaos: d.f32, crt: d.vec3f, glitch: d.f32, ripples: d.arrayOf(Ripple, MAX_RIPPLES) });

type ViewBinding = TgpuUniform<typeof View>;
type ParamsBinding = TgpuUniform<typeof Params>;
type ClockBinding = TgpuUniform<typeof Clock>;
type EffectsBinding = TgpuUniform<typeof Effects>;

const TWO_PI = 6.2831853;
const GREEN = d.vec3f(0.05, 0.95, 0.32);

const pcg = (input: number) => {
  'use gpu';
  const state = d.u32(input) * d.u32(747796405) + d.u32(2891336453);
  const word = ((state >>> ((state >>> d.u32(28)) + d.u32(4))) ^ state) * d.u32(277803737);
  return (word >>> d.u32(22)) ^ word;
};

/** A hash of an integer as a number in 0..1. */
const unit = (input: number) => {
  'use gpu';
  return d.f32(pcg(input)) / 4294967296;
};

const luma = (color: d.v3f) => {
  'use gpu';
  return std.dot(color, d.vec3f(0.299, 0.587, 0.114));
};

/** The frame at a position of the picture. */
const frameSampler = (sampler: TgpuFixedSampler) => (uv: d.v2f) => {
  'use gpu';
  return std.textureSampleBaseClampToEdge(frameLayout.$.frame, sampler.$, uv);
};

/** The mask at a position of the video frame. (`textureSampleLevel` has no uniform-control-flow rule, unlike `textureSample`.) */
const maskSampler = (sampler: TgpuFixedSampler) => (uv: d.v2f) => {
  'use gpu';
  return std.textureSampleLevel(maskLayout.$.mask, sampler.$, uv, 0).r;
};

/** Where the canvas position falls in the video: the video covers the canvas, and may be mirrored. */
const videoUv = (uv: d.v2f, canvasAspect: number, videoAspect: number, mirror: number) => {
  'use gpu';
  const wide = canvasAspect <= videoAspect;
  const x = std.select(uv.x, (uv.x - 0.5) * (canvasAspect / videoAspect) + 0.5, wide);
  const y = std.select((uv.y - 0.5) * (videoAspect / canvasAspect) + 0.5, uv.y, wide);
  return d.vec2f(std.select(x, 1 - x, mirror > 0.5), y);
};

/** A pseudo-katakana glyph: a few horizontal and vertical strokes and sometimes a diagonal, on a 5 by 7 grid. */
const glyphOn = (id: number, local: d.v2f) => {
  'use gpu';
  const gx = std.floor(((local.x - 0.14) / 0.72) * 5);
  const gy = std.floor(((local.y - 0.08) / 0.84) * 7);
  let on = d.f32(0);
  if (gx >= 0 && gx < 5 && gy >= 0 && gy < 7) {
    const k = d.u32(id) * d.u32(16);
    const row1 = std.floor(unit(k + d.u32(1)) * 7);
    const row2 = std.floor(unit(k + d.u32(2)) * 7);
    const left = std.floor(unit(k + d.u32(3)) * 2.2);
    const right = std.min(4, left + 2 + std.floor(unit(k + d.u32(4)) * 3));
    const col1 = std.floor(unit(k + d.u32(5)) * 5);
    const col2 = std.floor(unit(k + d.u32(8)) * 5);
    const top = std.floor(unit(k + d.u32(6)) * 3);
    const bottom = std.min(6, top + 3 + std.floor(unit(k + d.u32(7)) * 3));
    const slope = std.floor(gy * 0.7 + unit(k + d.u32(10)) * 2.5);
    const strokeA = gy === row1 && gx >= left && gx <= right;
    const strokeB = unit(k + d.u32(11)) > 0.4 && gy === row2 && gx >= left && gx <= right - 1;
    const strokeC = gx === col1 && gy >= top && gy <= bottom;
    const strokeD = unit(k + d.u32(12)) > 0.5 && gx === col2 && gy >= top + 1 && gy <= bottom - 1;
    const strokeE = unit(k + d.u32(9)) > 0.55 && gx === slope && gy >= 1;
    if (strokeA || strokeB || strokeC || strokeD || strokeE) {
      on = 1;
    }
  }
  return on;
};

/** Falling code in column `col`: the strength of the trail at `row` (x), and whether this row is a bright head (y). */
const rainAt = (col: number, row: number, rows: number, time: number, speed: number) => {
  'use gpu';
  let best = d.f32(0);
  let head = d.f32(0);
  for (let layer = 0; layer < 2; layer++) {
    const seed = d.u32(col) * d.u32(131) + d.u32(layer) * d.u32(7919) + d.u32(17);
    const rate = (3.5 + 9 * unit(seed)) * speed;
    const length = 7 + 24 * unit(seed + d.u32(1));
    const cycle = rows + length * 1.5;
    const front = std.fract((time * rate) / cycle + unit(seed + d.u32(2))) * cycle;
    const behind = front - row;
    if (behind >= 0 && behind < length) {
      const strength = std.pow(1 - behind / length, 1.7) * std.select(d.f32(0.8), d.f32(1), layer === 0);
      best = std.max(best, strength);
      head = std.max(head, std.select(d.f32(0), d.f32(1), behind < 1));
    }
  }
  return d.vec2f(best, head);
};

/** The person's colours: a ramp from dark to bright, by how bright the picture is (and for Rainbow, by height). */
const palette = (kind: number, t: number, height: number, time: number) => {
  'use gpu';
  let a = d.vec3f(0, 0.12, 0.45);
  let b = d.vec3f(0.1, 0.8, 1);
  let c = d.vec3f(0.9, 1, 1);
  if (kind === 1) {
    a = d.vec3f(0.28, 0, 0.35);
    b = d.vec3f(1, 0.1, 0.75);
    c = d.vec3f(1, 0.85, 1);
  }
  if (kind === 2) {
    a = d.vec3f(0.3, 0.07, 0);
    b = d.vec3f(1, 0.5, 0.03);
    c = d.vec3f(1, 0.95, 0.65);
  }
  let color = std.mix(std.mix(a, b, std.smoothstep(0, 0.55, t)), c, std.smoothstep(0.5, 1, t));
  if (kind === 3) {
    const hue = height * 1.1 + t * 0.25 + time * 0.05;
    const wave = std.cos(d.vec3f(TWO_PI * hue, TWO_PI * (hue + 0.33), TWO_PI * (hue + 0.67)));
    color = d.vec3f(0.5).add(wave.mul(0.5)).mul(0.4 + 0.6 * t);
  }
  return color;
};

const TEAL = d.vec3f(0.1, 0.85, 0.8);
const VIOLET = d.vec3f(0.5, 0.38, 1);
const ROSE = d.vec3f(1, 0.4, 0.68);
const PEACH = d.vec3f(1, 0.74, 0.46);

/** A loop through four chosen colours (teal, violet, rose, peach), `at` going once around per unit. */
const loopColor = (at: number) => {
  'use gpu';
  const k = std.fract(at) * 4;
  const f = std.smoothstep(0, 1, std.fract(k));
  let color = std.mix(TEAL, VIOLET, f);
  if (k >= 1) {
    color = std.mix(VIOLET, ROSE, f);
  }
  if (k >= 2) {
    color = std.mix(ROSE, PEACH, f);
  }
  if (k >= 3) {
    color = std.mix(PEACH, TEAL, f);
  }
  return color;
};

/** Colour waves: the loop of colours runs across the picture and ripples with time. */
const waves = (uv: d.v2f, time: number) => {
  'use gpu';
  return loopColor(uv.x * 0.45 + uv.y * 0.3 + 0.12 * std.sin(uv.y * 7 + time * 1.4) + 0.1 * std.sin(uv.x * 5 - time * 1.1) + time * 0.07);
};

/**
 * Shards: a jittered grid of points. x is the distance to the nearest point, y to the second nearest (the cell borders are
 * where they are nearly equal: cracks), z is a number in 0..1 that belongs to the nearest cell.
 */
const shards = (p: d.v2f, seed: number) => {
  'use gpu';
  const cell = std.floor(p);
  const at = std.fract(p);
  let nearest = d.f32(8);
  let second = d.f32(8);
  let id = d.f32(0);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const key = d.u32(cell.x + d.f32(i) + 1024) * d.u32(1597) + d.u32(cell.y + d.f32(j) + 1024) * d.u32(6791) + d.u32(seed) * d.u32(131);
      const point = d.vec2f(d.f32(i) + unit(key), d.f32(j) + unit(key + d.u32(1)));
      const dist = std.length(point.sub(at));
      if (dist < nearest) {
        second = nearest;
        nearest = dist;
        id = unit(key + d.u32(2));
      } else {
        second = std.min(second, dist);
      }
    }
  }
  return d.vec3f(nearest, second, id);
};

/**
 * What one click does at a pixel `away` from it: x is how open the picture is here (1: fully), y is a crack (1: on a crack).
 * The middle is a clean opening. Towards the edge the opening breaks into shards of different reach, so its outline is uneven,
 * and cracks run between the shards and a little beyond them. It grows at once, holds, and then closes shard by shard.
 */
const opening = (away: d.v2f, age: number, seed: number, radius: number) => {
  'use gpu';
  const grown = 1 - std.pow(1 - std.min(age / 0.4, 1), 3);
  const closing = std.max(1 - std.smoothstep(RIPPLE_HOLD, RIPPLE_LIFETIME, age), 0.001);
  const angle = std.atan2(away.y, away.x);
  const wobble = 1 + 0.07 * std.sin(angle * 3 + seed) + 0.05 * std.sin(angle * 7 + seed * 2.3) + 0.03 * std.sin(angle * 13 + seed * 0.7);
  const r = std.length(away) / (std.max(radius * grown, 1) * wobble * closing);
  let open = d.f32(0);
  let crack = d.f32(0);
  if (r < 1.3) {
    const s = shards(away.div(std.max(radius, 1) * 0.24).add(d.vec2f(seed * 0.37, seed * 0.21)), seed);
    const reachOfShard = 0.55 + 0.6 * s.z;
    const core = 1 - std.smoothstep(0.42, 0.54, r);
    open = std.max(core, std.select(d.f32(0), d.f32(1), r < reachOfShard));
    const line = 1 - std.smoothstep(0.0, 0.07, s.y - s.x);
    crack = line * std.smoothstep(0.5, 0.85, r) * (1 - std.smoothstep(1.0, 1.25, r));
  }
  return d.vec2f(open, crack);
};

export function matrixFragment(
  sampler: TgpuFixedSampler,
  view: ViewBinding,
  params: ParamsBinding,
  clock: ClockBinding,
  effects: EffectsBinding,
) {
  const sample = frameSampler(sampler);
  const maskAt = maskSampler(sampler);
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const v = view.$;
    const fx = effects.$;
    const time = clock.$.time;
    const size = v.size;
    const calm = 1 - params.$.reduced * 0.7;
    const chaos = fx.chaos * calm;

    // The ending: the picture is torn in bands when it is glitching or mad (and shakes), and when a television collapses it is
    // squeezed into what is still on (the height first, then the width), with nothing outside it.
    const around = input.uv.sub(0.5);
    let uv = d.vec2f(input.uv);
    const band = d.u32(std.floor(uv.y * 48)) * d.u32(7) + d.u32(std.floor(time * 14)) * d.u32(131);
    const torn = std.select(d.f32(0), d.f32(1), unit(band) > 1 - 0.3 * std.max(fx.glitch, chaos));
    uv = d.vec2f(uv.x + (unit(band + d.u32(1)) - 0.5) * 0.16 * std.max(fx.glitch, chaos) * torn + (unit(d.u32(std.floor(time * 30))) - 0.5) * 0.01 * chaos, uv.y);
    uv = d.vec2f(around.x / std.max(fx.crt.y, 0.0001) + 0.5 + (uv.x - input.uv.x), around.y / std.max(fx.crt.x, 0.0001) + 0.5);
    const onScreen = uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;

    const pixel = d.vec2f(uv.x * size.x, uv.y * size.y);
    const pointer = d.vec2f(fx.pointer.x * size.x, fx.pointer.y * size.y);

    // The pointer lights the glyphs near it.
    const toPointer = pixel.sub(pointer);
    const reach = size.y * 0.18;
    const near = std.exp(-std.dot(toPointer, toPointer) / (reach * reach)) * fx.hover * calm;

    // Every click opens the picture around it: where it is open the room shows instead of the code, and the person is colour.
    let open = d.f32(0);
    let crack = d.f32(0);
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const ripple = fx.ripples[i];
      const age = time - ripple.birth;
      if (age > 0 && age < RIPPLE_LIFETIME) {
        const away = pixel.sub(d.vec2f(ripple.center.x * size.x, ripple.center.y * size.y));
        const one = opening(away, age, ripple.seed, params.$.reach * size.y);
        open = std.max(open, one.x);
        crack = std.max(crack, one.y);
      }
    }

    // The glyph cell this pixel is in, and where the cell is in the video.
    const cellAt = std.floor(pixel.div(v.cell));
    const local = std.fract(pixel.div(v.cell));
    const col = std.max(cellAt.x, 0);
    const row = std.max(cellAt.y, 0);
    const centerUv = d.vec2f(((cellAt.x + 0.5) * v.cell) / size.x, ((cellAt.y + 0.5) * v.cell) / size.y);
    const vuv = videoUv(centerUv, size.x / size.y, v.video.x / v.video.y, v.mirror);

    // What the camera sees there: its colour and brightness (a little averaged), and the edges around.
    const step = d.vec2f(v.cell / size.x, v.cell / size.y);
    const here = sample(vuv).rgb.mul(0.5).add(sample(vuv.add(d.vec2f(step.x * 0.35, 0))).rgb.mul(0.25)).add(sample(vuv.sub(d.vec2f(step.x * 0.35, 0))).rgb.mul(0.25));
    const light = std.min(luma(here), 1);
    const edge = std.min((std.abs(light - luma(sample(vuv.add(d.vec2f(step.x, 0))).rgb)) + std.abs(light - luma(sample(vuv.add(d.vec2f(0, step.y))).rgb))) * 2.5, 1);

    // Who is a person: the mask at this very pixel (not at the cell's centre, so the silhouette is not limited to whole glyphs),
    // cut at the chosen level. Its steepness is a thin bright rim along the outline.
    const pixelVideoUv = videoUv(pixel.div(size), size.x / size.y, v.video.x / v.video.y, v.mirror);
    const reach2 = step.div(v.cell).mul(2);
    const soft = maskAt(pixelVideoUv);
    const slope = std.abs(maskAt(pixelVideoUv.add(d.vec2f(reach2.x, 0))) - maskAt(pixelVideoUv.sub(d.vec2f(reach2.x, 0)))) + std.abs(maskAt(pixelVideoUv.add(d.vec2f(0, reach2.y))) - maskAt(pixelVideoUv.sub(d.vec2f(0, reach2.y))));
    const person = std.smoothstep(params.$.cutoff - 0.12, params.$.cutoff + 0.12, soft);
    const rim = std.min(slope * 1.6, 1) * person;

    // The rain, and which glyph this cell shows now (glyphs change faster in heads, under the pointer, and when the picture is mad).
    const rain = rainAt(col, row, size.y / v.cell, time, params.$.speed * (1 - params.$.reduced * 0.7) * (1 + chaos * 7));
    const seed = unit(d.u32(col) * d.u32(3517) + d.u32(row) * d.u32(9091) + d.u32(5));
    const tick = std.floor(time * (1.5 + 12 * rain.y + 25 * near + 45 * chaos) + seed * 9);
    const glyph = glyphOn(d.u32(col) * d.u32(2909) + d.u32(row) * d.u32(7919) + d.u32(tick) * d.u32(104729), local);

    // Behind the person: green rain whose brightness is the room (bright places and edges show through as code).
    const roomShape = 0.2 + 1.3 * light + 2 * edge;
    const roomGlyph = std.select(d.f32(0), d.f32(1), seed < light * 0.8 + edge) * (0.08 + 0.22 * light + 0.6 * edge);
    const behind = rain.x * roomShape + roomGlyph;
    const behindColor = std.mix(GREEN.mul(behind), d.vec3f(0.8, 1, 0.85).mul(behind * 1.1), rain.y * rain.x);

    // The person: glyphs as dense and bright as the picture is, in the person's colours, with the rain falling through. Where a
    // click has opened the picture the colours turn into waves (the glyphs stay, their colour flows).
    const body = std.pow(light, 0.7);
    const dense = std.select(d.f32(0), d.f32(1), seed < std.smoothstep(0.02, 0.8, body) * 1.6);
    const personLight = dense * (0.5 + 1.2 * body) + rain.x * (0.6 + 0.9 * body);
    const tint = palette(params.$.palette, body, 1 - centerUv.y, time);
    const ownColor = std.mix(tint.mul(personLight), d.vec3f(1).mul(personLight), rain.y * rain.x * 0.8);
    const flowing = waves(uv, time * calm).mul(0.5 + personLight * 1.0);
    const personColor = std.mix(ownColor, flowing, open);

    let color = std.mix(behindColor, personColor, person).mul(0.1 + 0.9 * glyph).mul(1 + near * 1.2);
    color = color.add(tint.mul(rim * 0.55));

    // A mad picture flickers red in bands, flashes to its negative now and then, and is full of sparks that fly everywhere.
    const flicker = chaos * std.select(d.f32(0), d.f32(1), unit(d.u32(std.floor(uv.y * 30)) * d.u32(17) + d.u32(std.floor(time * 9))) > 0.55);
    color = std.mix(color, d.vec3f(color.x * 1.6 + 0.25, color.y * 0.3, color.z * 0.3), flicker * 0.7);

    // Scanlines, a vignette, and a soft shoulder so bright glyphs go white instead of clipping.
    const scan = 0.93 + 0.07 * std.sin(pixel.y * 3.14159);
    const far = std.dot(uv.sub(0.5), uv.sub(0.5));
    color = color.mul(scan * (1 - 0.7 * far));
    color = d.vec3f(1).sub(std.exp(color.mul(-1.6)));

    // Where a click has opened the picture, the real picture shows behind the person, and cracks glow along the shards.
    color = std.mix(color, sample(pixelVideoUv).rgb, open * (1 - person));
    color = color.add(d.vec3f(0.55, 0.95, 1).mul(crack * 0.85));

    let sparks = d.vec3f(0);
    for (let j = 0; j < 40; j++) {
      const k = d.u32(j) * d.u32(37);
      const direction = d.vec2f(unit(k + d.u32(1)) - 0.5, unit(k + d.u32(2)) - 0.5).mul(2);
      const spot = std.fract(d.vec2f(unit(k + d.u32(3)), unit(k + d.u32(4))).add(direction.mul(time * (0.1 + 0.9 * chaos) * (0.4 + unit(k + d.u32(5))))));
      const gap = uv.sub(spot).mul(size);
      const radius = 2 + 6 * unit(k + d.u32(6));
      const spark = std.exp(-std.dot(gap, gap) / (radius * radius));
      sparks = sparks.add(std.mix(d.vec3f(1, 0.95, 0.9), d.vec3f(1, 0.15, 0.2), std.select(d.f32(0), d.f32(1), unit(k + d.u32(7)) > 0.55)).mul(spark));
    }
    color = color.add(sparks.mul(chaos * 1.3));
    const grain = (unit(d.u32(pixel.x) * d.u32(1973) + d.u32(pixel.y) * d.u32(9277) + d.u32(std.floor(time * 60)) * d.u32(26699)) - 0.5) * fx.glitch * 0.25;
    color = color.add(d.vec3f(grain));
    const negative = std.select(d.f32(0), d.f32(1), chaos > 0.6 && unit(d.u32(std.floor(time * 18)) * d.u32(41)) > 0.93);
    color = std.mix(color, d.vec3f(1).sub(color), negative);

    // The television: outside what is still on there is black, and the collapsed picture is a bright line and then a dot.
    let shown = std.select(d.vec3f(0), color, onScreen);
    const dy = std.abs(around.y) * size.y;
    const halfX = 0.5 * fx.crt.y;
    const lineAmount = 1 - std.smoothstep(0.03, 0.3, fx.crt.x);
    const edgeX = 1 - std.smoothstep(halfX, halfX + 8 / size.x, std.abs(around.x));
    const glow = (std.exp(-(dy * dy) / 9.68) * 0.9 + std.exp(-(dy * dy) / 162) * 0.25) * edgeX * lineAmount * fx.crt.z;
    shown = shown.add(d.vec3f(0.85, 1, 0.9).mul(glow));
    return d.vec4f(shown, 1);
  });
}
