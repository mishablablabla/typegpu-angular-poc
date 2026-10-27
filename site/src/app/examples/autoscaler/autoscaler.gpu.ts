// The shaders of the Autoscaler example, shared by both implementations (see life.gpu.ts for how `*.gpu.ts` modules work).
//
// Every request stream is a few hundred particles that live on the GPU: a compute kernel moves them from a replica of one
// service to a replica of the next, slower where the receiver is overloaded, and splats a streak of light for each into a
// grid with atomics. A second kernel moves the grid out as floats and fades it (the trails). One fragment shader draws the
// map itself (links, replicas, services, selection) and adds the light, with bloom.
import tgpu, { d, std } from 'typegpu';
import type { TgpuMutable, TgpuReadonly, TgpuUniform } from 'typegpu';
import {
  CLIENT_NODE,
  EDGE_COUNT,
  GRID_H,
  GRID_HALF_WIDTH,
  GRID_TEXELS_PER_UNIT,
  GRID_W,
  MAP_SHIFT,
  NODE_COUNT,
  PARTICLES,
  PER_EDGE,
  SERVICE_COUNT,
} from './autoscaler.model';

const TWO_PI = 6.2831853;
/** Light is counted in fixed point so atomics can add it up. */
const FIXED = 1024;

/**
 * Everything that can be seen on the map: the services (nodes 0..7), the replica slots, and the clients (the last node).
 * `state`: -1 no replica in this slot, 0 starting, 1 running, 2 crashed, 3 stopping; `progress` is how far a starting or
 * stopping replica is. A service has its health (0, 1, 2) and the first slot's node and the number of slots in `base`, `count`.
 */
export const Node = d.struct({
  pos: d.vec2f,
  radius: d.f32,
  load: d.f32,
  state: d.f32,
  progress: d.f32,
  base: d.f32,
  count: d.f32,
  health: d.f32,
});
export const Nodes = d.arrayOf(Node, NODE_COUNT);

/** A link between two nodes: requests per second as a fraction of the busiest, the share dropped, how much it bends. */
export const Edge = d.struct({ source: d.f32, sink: d.f32, rate: d.f32, drop: d.f32, curve: d.f32 });
export const Edges = d.arrayOf(Edge, EDGE_COUNT);

/** One request in flight: how far along its link, how fast, between which nodes, and where it ends if it is dropped. */
export const Particle = d.struct({ t: d.f32, speed: d.f32, src: d.f32, dst: d.f32, end: d.f32 });
export const Particles = d.arrayOf(Particle, PARTICLES);

/** Light, two channels per cell (healthy flow, trouble), counted with atomics and then moved out as floats. */
export const Accum = d.arrayOf(d.atomic(d.u32), GRID_W * GRID_H * 2);
export const Shown = d.arrayOf(d.vec2f, GRID_W * GRID_H);

/** The canvas and what the pointer is on. */
export const View = d.struct({ aspect: d.f32, fit: d.f32, height: d.f32, selected: d.f32, hovered: d.f32 });

/** Time, written every frame. `decay` is how much light is left of the previous frame's. `slow` is 1 under reduced motion. */
export const Clock = d.struct({ time: d.f32, dt: d.f32, decay: d.f32, slow: d.f32 });

type NodesBinding = TgpuReadonly<typeof Nodes>;
type EdgesBinding = TgpuReadonly<typeof Edges>;
type ViewBinding = TgpuUniform<typeof View>;
type ClockBinding = TgpuUniform<typeof Clock>;
type AccumBinding = TgpuMutable<typeof Accum>;

const CYAN = d.vec3f(0.2, 0.78, 1);
const ICE = d.vec3f(0.62, 0.9, 1);
const AMBER = d.vec3f(1, 0.62, 0.16);
const RED = d.vec3f(1, 0.25, 0.28);

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

/** Map position to a position in the light grid (y down). */
const gridOf = (view: ViewBinding) => (p: d.v2f) => {
  'use gpu';
  const fit = view.$.fit;
  return d.vec2f(((p.x + MAP_SHIFT) * fit + GRID_HALF_WIDTH) * GRID_TEXELS_PER_UNIT, (1 - p.y * fit) * GRID_TEXELS_PER_UNIT);
};

/** A point of a quadratic curve. */
const curveAt = (a: d.v2f, control: d.v2f, b: d.v2f, t: number) => {
  'use gpu';
  const u = 1 - t;
  return a.mul(u * u).add(control.mul(2 * u * t)).add(b.mul(t * t));
};

/** Adds light to one cell of the grid. */
const addTo = (accum: AccumBinding) => (ix: number, iy: number, channel: number, value: number) => {
  'use gpu';
  if (ix >= 0 && iy >= 0 && ix < GRID_W && iy < GRID_H && value >= 1) {
    std.atomicAdd(accum.$[(d.u32(iy) * GRID_W + d.u32(ix)) * 2 + d.u32(channel)], d.u32(value));
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

/** Adds light along a segment of the grid; `amount` is the light of one cell, so a longer streak is longer, not brighter. */
const segmentTo = (splat: ReturnType<typeof splatTo>) => (a: d.v2f, b: d.v2f, channel: number, amount: number) => {
  'use gpu';
  const n = std.clamp(std.ceil(std.distance(a, b)), 1, 16);
  for (let k = 0; k < 16; k++) {
    if (d.f32(k) >= n) {
      break;
    }
    const t = (d.f32(k) + 0.5) / n;
    splat(std.mix(a.x, b.x, t), std.mix(a.y, b.y, t), channel, amount);
  }
};

/**
 * One thread per request. The first requests of a link are always in flight, the last ones only when the link is busy,
 * so the density of the stream is the request rate. A request goes from a running replica of one service to a running
 * replica of the next (a service without one is addressed as a whole), slows down when the receiver is loaded, and
 * dies on the way if the receiver is dropping requests.
 */
export const particleKernel = (
  particles: TgpuMutable<typeof Particles>,
  nodes: NodesBinding,
  edges: EdgesBinding,
  accum: AccumBinding,
  view: ViewBinding,
  clock: ClockBinding,
) => {
  const grid = gridOf(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  /** A running replica of a service, chosen by the seed; the service itself when it has none. */
  const pick = (service: number, seed: number) => {
    'use gpu';
    let chosen = service;
    if (service < SERVICE_COUNT) {
      const hub = nodes.$[d.u32(service)];
      for (let k = 0; k < 6; k++) {
        const candidate = hub.base + std.floor(unit(d.u32(seed) + d.u32(k)) * hub.count);
        const state = nodes.$[d.u32(candidate)].state;
        if (state > 0.5 && state < 1.5) {
          chosen = candidate;
          break;
        }
      }
    }
    return chosen;
  };
  return (i: number) => {
    'use gpu';
    const index = d.u32(i);
    const edge = edges.$[index / d.u32(PER_EDGE)];
    const share = d.f32(index % d.u32(PER_EDGE)) / PER_EDGE;
    const self = particles.$[index];
    let t = self.t;
    let speed = self.speed;
    let src = self.src;
    let dst = self.dst;
    let end = self.end;
    const time = clock.$.time;

    if (share >= edge.rate) {
      particles.$[index] = Particle({ t: -1, speed, src, dst, end });
    } else {
      if (t < 0 || t >= end) {
        const seed = index * d.u32(11) + d.u32(time * 13);
        src = pick(edge.source, seed);
        dst = pick(edge.sink, seed + d.u32(97));
        speed = 0.45 + 0.7 * unit(seed + d.u32(3));
        t = std.select(d.f32(0), unit(seed + d.u32(5)) * 0.2, self.t < 0);
        end = std.select(d.f32(1), 0.3 + 0.5 * unit(seed + d.u32(7)), unit(seed + d.u32(9)) < edge.drop);
      }
      const from = nodes.$[d.u32(src)].pos;
      const to = nodes.$[d.u32(dst)].pos;
      const jam = std.clamp(nodes.$[d.u32(dst)].load, 0, 1.3);
      const before = t;
      t = t + clock.$.dt * speed * (1.15 - 0.65 * jam) * (1 - 0.6 * clock.$.slow);
      particles.$[index] = Particle({ t, speed, src, dst, end });

      const control = from.add(to).mul(0.5).add(d.vec2f(-(to.y - from.y), to.x - from.x).mul(edge.curve));
      const a = grid(curveAt(from, control, to, before));
      const b = grid(curveAt(from, control, to, t));
      // Healthy requests are cyan; the ones sent to an overloaded replica, or doomed to be dropped, are amber.
      const trouble = std.max(std.smoothstep(0.8, 1.15, jam), std.select(d.f32(0), d.f32(0.9), end < 0.99));
      segment(a, b, 0, 0.05 * (1 - trouble));
      segment(a, b, 1, 0.07 * trouble);
      if (t >= end && end < 0.99) {
        // A dropped request ends in a small flash.
        segment(b, b, 1, 0.9);
      }
    }
  };
};

/** Moves the light out of the atomics as floats, and fades it: what is left is what the next frame adds to. */
export const resolveKernel = (accum: AccumBinding, shown: TgpuMutable<typeof Shown>, clock: ClockBinding) => (x: number, y: number) => {
  'use gpu';
  const cell = d.u32(y) * GRID_W + d.u32(x);
  const base = cell * 2;
  const healthy = std.atomicLoad(accum.$[base]);
  const trouble = std.atomicLoad(accum.$[base + 1]);
  shown.$[cell] = d.vec2f(d.f32(healthy), d.f32(trouble)).div(FIXED);
  std.atomicStore(accum.$[base], d.u32(d.f32(healthy) * clock.$.decay));
  std.atomicStore(accum.$[base + 1], d.u32(d.f32(trouble) * clock.$.decay));
};

/** The grid at a position: bilinear. */
const bilinearOf = (shown: TgpuReadonly<typeof Shown>) => (p: d.v2f) => {
  'use gpu';
  const q = std.clamp(p.sub(0.5), d.vec2f(0), d.vec2f(GRID_W - 1.001, GRID_H - 1.001));
  const base = std.floor(q);
  const f = q.sub(base);
  const i = d.u32(base.y) * GRID_W + d.u32(base.x);
  const top = std.mix(shown.$[i], shown.$[i + 1], f.x);
  const bottom = std.mix(shown.$[i + GRID_W], shown.$[i + GRID_W + 1], f.x);
  return std.mix(top, bottom, f.y);
};

/** The nearest cell: for the cheap taps of the bloom. */
const nearestOf = (shown: TgpuReadonly<typeof Shown>) => (p: d.v2f) => {
  'use gpu';
  const q = std.clamp(std.floor(p), d.vec2f(0), d.vec2f(GRID_W - 1, GRID_H - 1));
  return d.vec2f(shown.$[d.u32(q.y) * GRID_W + d.u32(q.x)]);
};

/** Distance from a point to a segment. */
const segmentDistance = (p: d.v2f, a: d.v2f, b: d.v2f) => {
  'use gpu';
  const pa = p.sub(a);
  const ba = b.sub(a);
  const h = std.clamp(std.dot(pa, ba) / std.max(std.dot(ba, ba), 0.0001), 0, 1);
  return std.length(pa.sub(ba.mul(h)));
};

/** Healthy cyan, amber under pressure, red when overloaded. */
const loadColor = (load: number) => {
  'use gpu';
  const warm = std.mix(CYAN, AMBER, std.smoothstep(0.55, 0.88, load));
  return std.mix(warm, RED, std.smoothstep(0.95, 1.18, load));
};

export function mapFragment(shown: TgpuReadonly<typeof Shown>, nodes: NodesBinding, edges: EdgesBinding, view: ViewBinding, clock: ClockBinding) {
  const bilinear = bilinearOf(shown);
  const nearest = nearestOf(shown);
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const v = view.$;
    const time = clock.$.time;
    const screen = d.vec2f((input.uv.x - 0.5) * v.aspect * 2, (0.5 - input.uv.y) * 2);
    const at = d.vec2f((screen.x + GRID_HALF_WIDTH) * GRID_TEXELS_PER_UNIT, (1 - screen.y) * GRID_TEXELS_PER_UNIT);
    // Map coordinates, and the size of a pixel in them (for crisp edges).
    const map = d.vec2f(screen.x / v.fit - MAP_SHIFT, screen.y / v.fit);
    const pixel = 2 / (v.fit * v.height);

    // The dark: a fine grid of dots and a pale haze behind the middle.
    let color = d.vec3f(0.006, 0.01, 0.018).add(d.vec3f(0.01, 0.02, 0.034).mul(std.exp(-std.dot(screen, screen) * 0.5)));
    const dots = d.vec2f(std.fract(map.x * 12), std.fract(map.y * 12)).sub(0.5);
    color = color.add(d.vec3f(0.05, 0.09, 0.13).mul(std.smoothstep(0.045 * 12 * pixel * 2 + 0.03, 0.0, std.length(dots) - 0.0)).mul(0.12));

    // Links: a faint line that brightens with the traffic on it, reddens where requests are being dropped.
    for (let e = 0; e < EDGE_COUNT; e++) {
      const edge = edges.$[e];
      const a = nodes.$[d.u32(edge.source)].pos;
      const b = nodes.$[d.u32(edge.sink)].pos;
      const line = 1 - std.smoothstep(pixel * 0.6, pixel * 2.2, segmentDistance(map, a, b));
      const tint = std.mix(CYAN, RED, std.min(edge.drop * 4, 1));
      color = color.add(tint.mul(line * (0.05 + 0.22 * edge.rate)));
    }

    // Replicas and services.
    for (let n = 0; n < NODE_COUNT; n++) {
      const node = nodes.$[n];
      const off = map.sub(node.pos);
      const dist = std.length(off);
      if (node.state > -0.5 && dist < 0.22) {
        const angle = std.atan2(off.y, off.x);
        const turn = std.fract(angle / TWO_PI + 0.25);
        const r = node.radius;
        if (n < SERVICE_COUNT) {
          // A service: a ring in the colour of its health, ticks that turn faster the more load it carries.
          const tint = std.mix(CYAN, std.mix(AMBER, RED, std.select(d.f32(0), d.f32(1), node.health > 1.5)), std.min(node.health, 1));
          const ring = 1 - std.smoothstep(pixel * 0.8, pixel * 2.4, std.abs(dist - r));
          const tick = std.smoothstep(0.35, 0.5, std.abs(std.fract(turn * 24 + time * (0.1 + 0.4 * node.load) * (1 - 0.7 * clock.$.slow)) - 0.5) * 2);
          const outer = 1 - std.smoothstep(pixel * 0.8, pixel * 2.4, std.abs(dist - r * 1.3));
          color = color.add(tint.mul(ring * 0.95 + outer * tick * 0.5));
          color = color.add(tint.mul(std.exp(-std.max(dist - r, 0) * 22) * (0.1 + 0.2 * node.health)));
          color = color.add(tint.mul(std.select(d.f32(0), d.f32(0.06), dist < r)));
        } else if (n < CLIENT_NODE) {
          // A replica.
          const state = node.state;
          const grow = std.select(d.f32(1), std.clamp(node.progress, 0, 1), state < 0.5 || state > 2.5);
          const rr = r * grow;
          const tint = loadColor(node.load);
          const aa = pixel * 1.2;
          const disc = 1 - std.smoothstep(rr - aa, rr + aa, dist);
          const ringR = r * 1.65;
          const arc = 1 - std.smoothstep(pixel * 0.7, pixel * 2, std.abs(dist - ringR));
          if (state > 0.5 && state < 1.5) {
            const lit = std.select(d.f32(0.16), d.f32(1), turn < std.min(node.load, 1));
            color = color.add(tint.mul(disc * (0.35 + 0.65 * std.min(node.load, 1.2))));
            color = color.add(tint.mul(arc * lit * 0.9));
            color = color.add(tint.mul(std.exp(-std.max(dist - rr, 0) * 45) * (0.06 + 0.3 * node.load)));
          } else if (state < 0.5) {
            // Starting: a growing core inside a ring of dashes that turns.
            const dash = std.select(d.f32(0.15), d.f32(1), std.fract(turn * 10 - time * 1.5) < 0.5);
            color = color.add(CYAN.mul(disc * 0.5 + arc * dash * 0.8));
          } else if (state < 2.5) {
            // Crashed: dark, with a red cross that flickers.
            const cross = std.min(std.abs(std.abs(off.x) - std.abs(off.y)), 1) < pixel * 1.4 && dist < r * 1.2;
            const flicker = 0.55 + 0.45 * std.sin(time * 18 + d.f32(n));
            color = color.mul(1 - disc * 0.85);
            color = color.add(RED.mul(std.select(d.f32(0), flicker, cross)));
            color = color.add(RED.mul(arc * 0.35 * flicker));
          } else {
            color = color.add(tint.mul(disc * 0.4 * grow));
          }
        } else {
          // The clients: three pulses that travel towards the gateway.
          const pulse = std.fract(time * 0.6 - dist * 6);
          const wave = 1 - std.smoothstep(pixel * 0.8, pixel * 2.6, std.abs(dist - r * (0.5 + pulse)));
          color = color.add(ICE.mul(wave * (1 - pulse) * (0.25 + 0.5 * node.load)));
          color = color.add(ICE.mul((1 - std.smoothstep(0.004, 0.012, dist)) * 0.9));
        }
        // What the pointer is on.
        if (d.f32(n) === v.selected) {
          const sweep = std.fract(turn - time * 0.35);
          const ring = 1 - std.smoothstep(pixel * 0.8, pixel * 2.2, std.abs(dist - r * 2.3));
          color = color.add(d.vec3f(1).mul(ring * (0.4 + 0.6 * sweep)));
        }
        if (d.f32(n) === v.hovered) {
          const ring = 1 - std.smoothstep(pixel * 0.8, pixel * 2.2, std.abs(dist - r * 2));
          color = color.add(ICE.mul(ring * 0.5));
        }
      }
    }

    // The requests in flight: the grid, with a little bloom from a few taps turned by a different angle in every pixel.
    const here = bilinear(at);
    const twist = unit(d.u32(input.uv.x * 4096) * d.u32(1973) + d.u32(input.uv.y * 4096) * d.u32(9277)) * TWO_PI;
    const lite = std.select(d.f32(0), d.f32(1), v.height * v.height * v.aspect > 2500000);
    const taps = std.select(d.f32(4), d.f32(2), lite > 0.5);
    let halo = d.vec2f(0);
    for (let ring = 0; ring < 2; ring++) {
      const radius = std.select(d.f32(2.5), d.f32(8), ring === 1);
      for (let k = 0; k < 4; k++) {
        if (d.f32(k) >= taps) {
          break;
        }
        const angle = twist + (d.f32(k) / taps) * TWO_PI;
        halo = halo.add(nearest(at.add(d.vec2f(std.cos(angle), std.sin(angle)).mul(radius))).mul(0.5 / taps));
      }
    }
    const flow = ICE.mul((here.x + halo.x * 1.1) * 1.4).add(AMBER.mul((here.y + halo.y * 1.1) * 1.4));
    color = color.add(flow);
    color = d.vec3f(1).sub(std.exp(color.mul(-1.25)));
    const vignette = 1 - 0.3 * std.smoothstep(0.7, 2.6, std.dot(screen, screen));
    return d.vec4f(std.pow(color.mul(vignette), d.vec3f(0.95)), 1);
  });
}
