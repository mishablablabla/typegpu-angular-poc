// The shaders of NEURAL FLOW, shared by both implementations (see life.gpu.ts for how `*.gpu.ts` modules work).
//
// The brain and its network live on the GPU. One compute pass looks at every connection and delivers the pulses that arrive this frame
// (integer atomics add the weights up at the target); a second one lets every neuron integrate what it received, take
// its drive, fire, and rest. Three more pass the brain's surface, the neurons and the connections through the camera and splat light into a grid
// with atomics (the traveling pulses are drawn from nothing but the time of the source's last spike). A last kernel moves
// the grid out as floats and fades it into trails, and one fragment shader adds the bloom. The topology is uploaded once.
import tgpu, { d, std } from 'typegpu';
import type { TgpuMutable, TgpuReadonly, TgpuUniform } from 'typegpu';
import {
  EDGE_COUNT,
  EDGE_SAMPLES,
  GRID_H,
  GRID_HALF_WIDTH,
  GRID_TEXELS_PER_UNIT,
  GRID_W,
  BURST_SPEED,
  KICK,
  MAX_BURSTS,
  NEURONS,
  PROBE,
  PROBE_RADIUS,
  REFRACTORY,
  SHELL_COUNT,
  STIMULUS_DRIVE,
  STIMULUS_REACH,
  TAU,
  WEIGHT_SCALE,
  BURST_REACH_BASE,
  BURST_REACH_GAIN,
} from './neural-flow.model';

const TWO_PI = 6.2831853;
/** How many light samples a unit of brightness is: light is counted in fixed point so atomics can add it up. */
const FIXED = 1024;
const PROBE_AT = d.vec3f(PROBE[0], PROBE[1], PROBE[2]);

/** A neuron: its potential, when it last fired (-1000: never), and how strongly it was driven from outside. */
export const Neuron = d.struct({ v: d.f32, spike: d.f32, heat: d.f32, pad: d.f32 });
export const Neurons = d.arrayOf(Neuron, NEURONS);
/** What a neuron receives this frame, in thousandths (the weights of the pulses that arrived). */
export const Inputs = d.arrayOf(d.atomic(d.i32), NEURONS);

/** Uploaded once: where the neurons are (and the phase of their pacemaker group, or -1) and how they are connected. */
export const Sites = d.arrayOf(d.vec4f, NEURONS);
export const Edge = d.struct({ src: d.u32, dst: d.u32, delay: d.f32, weight: d.f32, mid: d.vec3f, rank: d.f32, mid2: d.vec3f, kind: d.f32 });
export const Edges = d.arrayOf(Edge, EDGE_COUNT);

/** A point of the brain's surface: where, how deep the fold is there, and which way it faces. */
export const ShellPoint = d.struct({ pos: d.vec3f, fold: d.f32, normal: d.vec3f, pad: d.f32 });
export const Shell = d.arrayOf(ShellPoint, SHELL_COUNT);

/**
 * Light, six channels per cell: neurons (fades into trails), heat (the same; also the pulses of inhibitory fibres), the brain's surface and
 * its short fibres, then the long fibres and their pulses in a colour of their own for each kind: association tracts (ice), the corpus
 * callosum (violet), the thalamic radiations (gold). The fibres are redrawn every frame.
 */
export const CHANNELS = 6;
export const Accum = d.arrayOf(d.atomic(d.u32), GRID_W * GRID_H * CHANNELS);
/** The same light as floats, two vec4 per cell: (neurons, heat, surface, association) and (callosal, thalamic, -, -). */
export const Shown = d.arrayOf(d.vec4f, GRID_W * GRID_H * 2);

/** The camera and the canvas. */
export const View = d.struct({
  pos: d.vec3f,
  focal: d.f32,
  right: d.vec3f,
  distance: d.f32,
  up: d.vec3f,
  aspect: d.f32,
  forward: d.vec3f,
  height: d.f32,
});

/** The controls: signal frequency (Hz), connectivity (the share of connections that are on), the state (0 or 1), stimulation. */
export const Params = d.struct({ frequency: d.f32, connectivity: d.f32, mode: d.f32, strength: d.f32 });

/** A click: where it landed, when (on the simulation's clock), and how strongly. */
export const Burst = d.struct({ pos: d.vec3f, birth: d.f32, strength: d.f32 });

/** The pointer: where it stimulates (and whether it does), the neurons it hovers and has selected (-1: none), and the latest clicks. */
export const Pointer = d.struct({ pos: d.vec3f, pressed: d.f32, hovered: d.f32, selected: d.f32, bursts: d.arrayOf(Burst, MAX_BURSTS) });

/** Time, written every frame: this frame is (prev, time]. `decay` is how much light is left of the previous frame's. */
export const Clock = d.struct({ time: d.f32, prev: d.f32, dt: d.f32, decay: d.f32 });

type ViewBinding = TgpuUniform<typeof View>;
type ParamsBinding = TgpuUniform<typeof Params>;
type PointerBinding = TgpuUniform<typeof Pointer>;
type ClockBinding = TgpuUniform<typeof Clock>;
type AccumBinding = TgpuMutable<typeof Accum>;
type NeuronsBinding = TgpuReadonly<typeof Neurons>;
type SitesBinding = TgpuReadonly<typeof Sites>;
type EdgesBinding = TgpuReadonly<typeof Edges>;
type ShellBinding = TgpuReadonly<typeof Shell>;

const ICE = d.vec3f(0.22, 0.74, 1);
const AMBER = d.vec3f(1, 0.55, 0.14);
const SURFACE = d.vec3f(0.3, 0.5, 0.74);
const PULSE = d.vec3f(0.42, 0.86, 1);
const VIOLET = d.vec3f(0.86, 0.28, 1);
const GOLD = d.vec3f(1, 0.76, 0.28);

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

/** Pass 1, one thread per connection: delivers the pulse that arrives in this frame to the target neuron. */
export const arrivalKernel = (edges: EdgesBinding, neurons: NeuronsBinding, inputs: TgpuMutable<typeof Inputs>, params: ParamsBinding, clock: ClockBinding) => (i: number) => {
  'use gpu';
  const edge = edges.$[d.u32(i)];
  if (edge.rank < params.$.connectivity) {
    const arrive = neurons.$[edge.src].spike + edge.delay;
    if (arrive > clock.$.prev && arrive <= clock.$.time) {
      std.atomicAdd(inputs.$[edge.dst], d.i32(edge.weight * WEIGHT_SCALE));
    }
  }
};

/**
 * Pass 2, one thread per neuron: the potential leaks, takes what arrived and what the drive gives (pacemaker groups in the
 * first sheet tick at the signal frequency in the baseline state; a probe taps the sheet in the stimulated state; the
 * pointer charges the neurons around the one it presses), and at the threshold the neuron fires and rests.
 */
export const neuronKernel = (neurons: TgpuMutable<typeof Neurons>, sites: SitesBinding, inputs: TgpuMutable<typeof Inputs>, params: ParamsBinding, pointer: PointerBinding, clock: ClockBinding) => (i: number) => {
  'use gpu';
  const index = d.u32(i);
  const self = neurons.$[index];
  const time = clock.$.time;
  const prev = clock.$.prev;
  const dt = clock.$.dt;
  const frequency = params.$.frequency;
  const site = sites.$[index];
  const where = d.vec3f(site.xyz);

  let v = self.v * std.exp(-dt / TAU) + d.f32(std.atomicExchange(inputs.$[index], 0)) / WEIGHT_SCALE;
  let heat = self.heat * std.exp(-dt / 0.5);
  let spike = self.spike;
  let driven = d.f32(0);

  if (params.$.mode < 0.5 && site.w >= 0) {
    if (std.floor(time * frequency + site.w) > std.floor(prev * frequency + site.w)) {
      v = v + KICK;
      driven = 1;
    }
  }
  if (params.$.mode > 0.5) {
    if (std.distance(where, PROBE_AT) < PROBE_RADIUS && std.floor(time * frequency) > std.floor(prev * frequency)) {
      v = v + KICK;
      driven = 1;
    }
  }
  // A click makes the neurons around it fire as a wave spreads from it.
  for (let b = 0; b < MAX_BURSTS; b++) {
    const burst = pointer.$.bursts[b];
    const away = std.distance(where, burst.pos);
    const fireAt = burst.birth + away / BURST_SPEED;
    if (away < BURST_REACH_BASE + BURST_REACH_GAIN * burst.strength && fireAt > prev && fireAt <= time) {
      v = v + KICK;
      driven = 1;
    }
  }
  if (pointer.$.pressed > 0.5) {
    const away = std.distance(where, pointer.$.pos);
    if (away < STIMULUS_REACH) {
      const fall = 1 - away / STIMULUS_REACH;
      v = v + STIMULUS_DRIVE * params.$.strength * fall * dt;
      driven = std.max(driven, params.$.strength * fall);
    }
  }

  if (time - spike < REFRACTORY) {
    v = 0;
  } else if (v >= 1) {
    spike = time;
    v = 0;
    if (driven > 0.3) {
      heat = 1;
    }
  }
  neurons.$[index] = Neuron({ v, spike, heat, pad: 0 });
};

/** Camera projection: grid coordinates (x, y, with y down) and the depth in front of the camera. */
const projector = (view: ViewBinding) => (p: d.v3f) => {
  'use gpu';
  const v = view.$;
  const rel = p.sub(v.pos);
  const depth = std.dot(rel, v.forward);
  const safe = std.max(depth, 0.05);
  const sx = (std.dot(rel, v.right) * v.focal) / safe;
  const sy = (std.dot(rel, v.up) * v.focal) / safe;
  return d.vec3f((sx + GRID_HALF_WIDTH) * GRID_TEXELS_PER_UNIT, (1 - sy) * GRID_TEXELS_PER_UNIT, depth);
};

/** Nearer light is brighter, farther is dimmer: depth from nothing but intensity. */
const fadeFor = (view: ViewBinding) => (depth: number) => {
  'use gpu';
  return std.clamp(std.pow(view.$.distance / std.max(depth, 0.1), 1.9), 0.25, 1.7);
};

/** Adds light to one cell of the grid. */
const addTo = (accum: AccumBinding) => (ix: number, iy: number, channel: number, value: number) => {
  'use gpu';
  if (ix >= 0 && iy >= 0 && ix < GRID_W && iy < GRID_H && value >= 1) {
    std.atomicAdd(accum.$[(d.u32(iy) * GRID_W + d.u32(ix)) * CHANNELS + d.u32(channel)], d.u32(value));
  }
};

/** Adds light at a position of the grid, shared bilinearly between the four cells around it. */
const splatTo = (add: ReturnType<typeof addTo>) => (x: number, y: number, channel: number, amount: number) => {
  'use gpu';
  const gx = x - 0.5;
  const gy = y - 0.5;
  const x0 = std.floor(gx);
  const y0 = std.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const value = amount * FIXED;
  add(x0, y0, channel, value * (1 - fx) * (1 - fy));
  add(x0 + 1, y0, channel, value * fx * (1 - fy));
  add(x0, y0 + 1, channel, value * (1 - fx) * fy);
  add(x0 + 1, y0 + 1, channel, value * fx * fy);
};

/** Adds light along a segment between two projected points. `amount` is the light of one cell: a longer segment is longer, not brighter. */
const segmentTo = (splat: ReturnType<typeof splatTo>) => (a: d.v3f, b: d.v3f, channel: number, amount: number) => {
  'use gpu';
  const n = std.clamp(std.ceil(std.distance(a.xy, b.xy)), 1, 24);
  for (let k = 0; k < 24; k++) {
    if (d.f32(k) >= n) {
      break;
    }
    const t = (d.f32(k) + 0.5) / n;
    splat(std.mix(a.x, b.x, t), std.mix(a.y, b.y, t), channel, amount);
  }
};

/**
 * One thread per point of the brain's surface, which draws it six times, a little apart along the surface (six times the
 * points, and no gaps between them: the surface reads as one lit skin, not as dust). The surface is lit like a translucent shell: the side that faces the camera is lit from
 * above and a little to the side, so the gyri read as relief and the bottoms of the folds (and the sulci, which are folds
 * of their own) are dark; the rim is brightest, like a shell lit from inside; the far side is only a faint glow.
 */
export const shellKernel = (accum: AccumBinding, shell: ShellBinding, view: ViewBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  return (i: number) => {
    'use gpu';
    const point = shell.$[d.u32(i)];
    const p = d.vec3f(point.pos);
    const n = d.vec3f(point.normal);
    const toCamera = std.normalize(view.$.pos.sub(p));
    const facing = std.dot(n, toCamera);
    const light = std.normalize(toCamera.mul(0.75).add(view.$.up.mul(0.6)).sub(view.$.right.mul(0.4)));
    const lit = std.max(std.dot(n, light), 0);
    const front = std.smoothstep(-0.05, 0.3, facing);
    const rim = std.pow(1 - std.abs(facing), 2.6);
    const relief = (0.02 + 1.0 * lit * front) * (1 - 0.9 * point.fold);
    const glow = (0.015 + 0.45 * rim) * (1 - 0.6 * point.fold) * std.select(d.f32(0.35), d.f32(1), facing >= 0);
    const brightness = (relief + glow) * 0.2;
    const along = std.normalize(std.cross(n, std.select(d.vec3f(0, 1, 0), d.vec3f(1, 0, 0), std.abs(n.y) > 0.9)));
    const across = std.cross(n, along);
    for (let k = 0; k < 6; k++) {
      const jitter = d.u32(i) * d.u32(12) + d.u32(k * 2);
      const spot = p.add(along.mul((unit(jitter) - 0.5) * 0.026)).add(across.mul((unit(jitter + d.u32(1)) - 0.5) * 0.026));
      const q = project(spot);
      segment(q, q, 2, brightness * fade(q.z) * 1.5);
    }
  };
};

/** Pass 3, one thread per neuron: a soft point that flares when the neuron fires, a ring around the hovered and the selected one. */
export const neuronSplatKernel = (accum: AccumBinding, neurons: NeuronsBinding, sites: SitesBinding, view: ViewBinding, pointer: PointerBinding, clock: ClockBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const splat = splatTo(addTo(accum));
  const segment = segmentTo(splat);
  return (i: number) => {
    'use gpu';
    const index = d.u32(i);
    const self = neurons.$[index];
    const p = project(d.vec3f(sites.$[index].xyz));
    const age = clock.$.time - self.spike;
    const flash = std.select(d.f32(0), std.exp(-age / 0.22), self.spike > -100);
    let marked = d.f32(0);
    if (d.f32(i) === pointer.$.selected) {
      marked = 1;
    } else if (d.f32(i) === pointer.$.hovered) {
      marked = 0.6;
    }
    const f = fade(p.z);
    segment(p, p, 0, (0.07 + 0.9 * flash + 0.5 * marked) * f);
    segment(p, p, 1, self.heat * 0.8 * f);
    if (flash > 0.08 || marked > 0) {
      // The glow of a firing neuron is a small ring.
      const radius = 1.5 + 3.5 * flash + 7 * marked;
      for (let k = 0; k < 8; k++) {
        const angle = d.f32(k) * 0.7853982;
        splat(p.x + std.cos(angle) * radius, p.y + std.sin(angle) * radius, std.select(d.f32(0), d.f32(3), marked > 0), (0.12 * flash + 0.3 * marked) * f);
      }
    }
  };
};

/** The curve of a connection: a cubic Bezier through its two control points. */
const bezier = (a: d.v3f, m: d.v3f, m2: d.v3f, b: d.v3f, t: number) => {
  'use gpu';
  const u = 1 - t;
  return a.mul(u * u * u).add(m.mul(3 * u * u * t)).add(m2.mul(3 * u * t * t)).add(b.mul(t * t * t));
};

/**
 * Pass 4, one thread per piece of a connection: a faint filament, and the pulse that travels along it while the source's
 * last spike is younger than the connection's delay: a bright head and a long tail behind it. After the pulse has arrived the
 * whole fibre keeps a glow that fades, so the bundles stay lit like fibre optics for a moment. Each kind of fibre has its own
 * colour channel; inhibitory pulses are amber.
 */
export const edgeSplatKernel = (accum: AccumBinding, edges: EdgesBinding, neurons: NeuronsBinding, sites: SitesBinding, view: ViewBinding, params: ParamsBinding, clock: ClockBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  return (e: number, s: number) => {
    'use gpu';
    const edge = edges.$[d.u32(e)];
    if (edge.rank < params.$.connectivity) {
      const a = d.vec3f(sites.$[edge.src].xyz);
      const b = d.vec3f(sites.$[edge.dst].xyz);
      const m = d.vec3f(edge.mid);
      const m2 = d.vec3f(edge.mid2);
      const t0 = d.f32(s) / EDGE_SAMPLES;
      const t1 = d.f32(s + 1) / EDGE_SAMPLES;
      const q0 = project(bezier(a, m, m2, b, t0));
      const q1 = project(bezier(a, m, m2, b, t1));
      const spike = neurons.$[edge.src].spike;
      const progress = (clock.$.time - spike) / edge.delay;
      let pulse = d.f32(0);
      let afterglow = d.f32(0);
      if (spike > -100 && progress > 0 && progress < 1.5) {
        const ahead = t1 - progress;
        pulse = std.exp(-std.pow(ahead / 0.07, 2)) * 0.8 + std.select(d.f32(0), std.exp(ahead * 6) * 0.2, ahead < 0);
      }
      if (spike > -100 && progress > 1) {
        afterglow = std.exp(-(progress - 1) * edge.delay / 0.7) * 0.5;
      }
      const strength = std.abs(edge.weight);
      const f = fade(q1.z);
      // Which channel carries the fibre: short ones the surface's, then association (3), callosal (4), thalamic (5).
      const channel = std.select(d.f32(2), edge.kind + 2, edge.kind > 0.5);
      const long = std.select(d.f32(1), d.f32(1.8), edge.kind > 0.5);
      segment(q0, q1, d.u32(channel), 0.0011 * (0.4 + strength) * (1 + 3 * std.smoothstep(0.1, 0.35, edge.delay)) * f * long + afterglow * 0.014 * strength * f * long);
      if (edge.weight > 0) {
        segment(q0, q1, d.u32(std.select(d.f32(3), channel, edge.kind > 0.5)), pulse * 1.05 * strength * f * long);
      } else {
        segment(q0, q1, 1, pulse * 0.45 * f);
      }
    }
  };
};

/** Moves the light out of the atomics as floats, and fades it: what was left of this frame is what the next one adds to. */
export const resolveKernel = (accum: AccumBinding, shown: TgpuMutable<typeof Shown>, clock: ClockBinding) => (x: number, y: number) => {
  'use gpu';
  const cell = d.u32(y) * GRID_W + d.u32(x);
  const base = cell * CHANNELS;
  const neuronsLight = std.atomicLoad(accum.$[base]);
  const heat = std.atomicLoad(accum.$[base + 1]);
  const edgesLight = std.atomicLoad(accum.$[base + 2]);
  const pulses = std.atomicLoad(accum.$[base + 3]);
  const callosal = std.atomicLoad(accum.$[base + 4]);
  const thalamic = std.atomicLoad(accum.$[base + 5]);
  shown.$[cell * 2] = d.vec4f(d.f32(neuronsLight), d.f32(heat), d.f32(edgesLight), d.f32(pulses)).div(FIXED);
  shown.$[cell * 2 + 1] = d.vec4f(d.f32(callosal), d.f32(thalamic), 0, 0).div(FIXED);
  // Neurons and heat leave short trails; the connections and the pulses are drawn again every frame.
  std.atomicStore(accum.$[base], d.u32(d.f32(neuronsLight) * clock.$.decay));
  std.atomicStore(accum.$[base + 1], d.u32(d.f32(heat) * clock.$.decay));
  std.atomicStore(accum.$[base + 2], 0);
  std.atomicStore(accum.$[base + 3], 0);
  std.atomicStore(accum.$[base + 4], 0);
  std.atomicStore(accum.$[base + 5], 0);
};

/** The grid at a position of the canvas: bilinear. `k` is which of the two vec4 of a cell (0 or 1). */
const bilinearOf = (shown: TgpuReadonly<typeof Shown>) => (p: d.v2f, k: number) => {
  'use gpu';
  const q = std.clamp(p.sub(0.5), d.vec2f(0), d.vec2f(GRID_W - 1.001, GRID_H - 1.001));
  const base = std.floor(q);
  const f = q.sub(base);
  const i = (d.u32(base.y) * GRID_W + d.u32(base.x)) * 2 + d.u32(k);
  const top = std.mix(shown.$[i], shown.$[i + 2], f.x);
  const bottom = std.mix(shown.$[i + GRID_W * 2], shown.$[i + GRID_W * 2 + 2], f.x);
  return std.mix(top, bottom, f.y);
};

/** The nearest cell of the grid: for the cheap taps of the bloom. */
const nearestOf = (shown: TgpuReadonly<typeof Shown>) => (p: d.v2f, k: number) => {
  'use gpu';
  const q = std.clamp(std.floor(p), d.vec2f(0), d.vec2f(GRID_W - 1, GRID_H - 1));
  return d.vec4f(shown.$[(d.u32(q.y) * GRID_W + d.u32(q.x)) * 2 + d.u32(k)]);
};

export function neuralFragment(shown: TgpuReadonly<typeof Shown>, view: ViewBinding) {
  const bilinear = bilinearOf(shown);
  const nearest = nearestOf(shown);
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const v = view.$;
    // Canvas position as screen units (2 tall), and then as a position in the grid.
    const screen = d.vec2f((input.uv.x - 0.5) * v.aspect * 2, (0.5 - input.uv.y) * 2);
    const at = d.vec2f((screen.x + GRID_HALF_WIDTH) * GRID_TEXELS_PER_UNIT, (1 - screen.y) * GRID_TEXELS_PER_UNIT);
    const here = bilinear(at, 0);
    const hereMore = bilinear(at, 1);

    // Bloom: a few taps on three rings around the pixel, turned by a different angle in every pixel. Very large canvases
    // take half as many, so the cost of the picture does not grow with the screen.
    const lite = std.select(d.f32(0), d.f32(1), v.height * v.height * v.aspect > 2500000);
    const taps = std.select(d.f32(4), d.f32(2), lite > 0.5);
    const twist = unit(d.u32(input.uv.x * 4096) * d.u32(1973) + d.u32(input.uv.y * 4096) * d.u32(9277)) * TWO_PI;
    let halo = d.vec4f(0);
    let haloMore = d.vec4f(0);
    for (let ring = 0; ring < 3; ring++) {
      const radius = std.select(d.f32(2.5), std.select(d.f32(7), d.f32(17), ring === 2), ring > 0);
      const weight = std.select(d.f32(0.5), std.select(d.f32(0.3), d.f32(0.2), ring === 2), ring > 0);
      for (let k = 0; k < 4; k++) {
        if (d.f32(k) >= taps) {
          break;
        }
        const angle = twist + (d.f32(k) / taps) * TWO_PI;
        const tap = at.add(d.vec2f(std.cos(angle), std.sin(angle)).mul(radius));
        halo = halo.add(nearest(tap, 0).mul(weight / taps));
        haloMore = haloMore.add(nearest(tap, 1).mul(weight / taps));
      }
    }

    // Neurons are ice-blue, heat and inhibitory pulses amber, filaments steel blue, association pulses pale and white where they are
    // bright, the corpus callosum violet, the thalamic radiations gold.
    let color = ICE.mul(here.x + halo.x * 0.8).add(AMBER.mul(here.y + halo.y * 0.8)).add(SURFACE.mul(here.z + halo.z * 0.4)).add(PULSE.mul(here.w + halo.w * 0.7));
    color = color.add(VIOLET.mul(hereMore.x + haloMore.x * 0.8)).add(GOLD.mul(hereMore.y + haloMore.y * 0.8));
    color = d.vec3f(1).sub(std.exp(color.mul(-1.35)));

    // The dark: nearly black, a little blue in the middle, darker towards the corners.
    const far = std.dot(screen, screen);
    const dark = d.vec3f(0.004, 0.007, 0.014).add(d.vec3f(0.005, 0.013, 0.026).mul(std.exp(-far * 0.8)));
    const vignette = 1 - 0.35 * std.smoothstep(0.6, 2.6, far);
    return d.vec4f(std.pow(color.add(dark).mul(vignette), d.vec3f(0.95)), 1);
  });
}
