// The shaders of THE CORE, shared by both implementations (see life.gpu.ts for how `*.gpu.ts` modules work).
//
// Nothing is rasterized as geometry. Compute kernels move tens of thousands of plasma particles and evaluate the magnetic
// field lines and the rigid coils; every one of them projects its points through the camera and splats light into a grid
// with atomics. A last kernel moves the grid out as floats (and lets the glow fade, which makes the trails), and one
// fragment shader turns the grid into the picture: bloom, tone mapping, the dark around it.
import tgpu, { d, std } from 'typegpu';
import type { TgpuMutable, TgpuReadonly, TgpuUniform } from 'typegpu';
import {
  COILS,
  DUST_PARTICLES,
  GRID_H,
  GRID_HALF_WIDTH,
  GRID_TEXELS_PER_UNIT,
  GRID_W,
  LINE_SAMPLES,
  LINE_TURNS,
  MAJOR,
  MAX_EVENTS,
  MINOR,
  PARTICLES,
  PLASMA_PARTICLES,
  STRAND_SAMPLES,
  VESSEL_LINES,
  VESSEL_RINGS,
} from './core.model';

const TWO_PI = 6.2831853;
/** How many light samples a unit of brightness is: light is counted in fixed point so atomics can add it up. */
const FIXED = 1024;

/** A plasma or dust particle. `heat` is how excited it is: it turns amber and fades. */
export const Particle = d.struct({ pos: d.vec3f, heat: d.f32, vel: d.vec3f, phase: d.f32 });
export const Particles = d.arrayOf(Particle, PARTICLES);

/** Light, four channels per cell: plasma (fades into trails), heat (the same), field lines and structure (redrawn every frame). */
export const Accum = d.arrayOf(d.atomic(d.u32), GRID_W * GRID_H * 4);
export const Shown = d.arrayOf(d.vec4f, GRID_W * GRID_H);

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

/** The three controls (and whether the system asked for less motion). */
export const Params = d.struct({ confinement: d.f32, energy: d.f32, instability: d.f32, reduced: d.f32 });

/** Time, written every frame. `decay` is how much light is left of the previous frame's. */
export const Clock = d.struct({ time: d.f32, dt: d.f32, decay: d.f32 });

/** The pointer's doing: a few recent pushes, and the swirl under a pressed pointer. */
export const Event = d.struct({ pos: d.vec3f, birth: d.f32, dir: d.vec3f, strength: d.f32 });
export const Vortex = d.struct({ pos: d.vec3f, strength: d.f32, axis: d.vec3f, held: d.f32 });
export const Disturbance = d.struct({ events: d.arrayOf(Event, MAX_EVENTS), vortex: Vortex });

type ViewBinding = TgpuUniform<typeof View>;
type ParamsBinding = TgpuUniform<typeof Params>;
type ClockBinding = TgpuUniform<typeof Clock>;
type DisturbanceBinding = TgpuUniform<typeof Disturbance>;
type AccumBinding = TgpuMutable<typeof Accum>;

const ICE = d.vec3f(0.2, 0.76, 1);
const AMBER = d.vec3f(1, 0.5, 0.12);
const FIELD = d.vec3f(0.5, 0.88, 1);
const STEEL = d.vec3f(0.36, 0.5, 0.72);
const UP = d.vec3f(0, 1, 0);

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

/** An angle brought into (-π, π]. */
const wrap = (angle: number) => {
  'use gpu';
  const turns = angle / TWO_PI;
  return (turns - std.floor(turns + 0.5)) * TWO_PI;
};

/** The centre of the plasma ring at toroidal angle `theta`: bent by slow kink modes, more when the plasma is unstable. */
const ringCenter = (theta: number, time: number, instability: number) => {
  'use gpu';
  const amp = 0.03 + 0.1 * instability;
  const radial = amp * (0.6 * std.sin(2 * theta - time * 0.9) + 0.4 * std.sin(3 * theta + time * 0.6));
  const lift = amp * 0.8 * std.sin(theta + time * 0.7);
  const r = MAJOR + radial;
  return d.vec3f(r * std.cos(theta), lift, r * std.sin(theta));
};

/** A pulse that circles the ring now and then: a bright head and a trail. Brighter and more often with more energy. */
const pulseAt = (theta: number, time: number, energy: number) => {
  'use gpu';
  const period = 4.2 / (0.6 + 1.2 * energy);
  const n = std.floor(time / period);
  const local = time - n * period;
  const head = unit(d.u32(n) * d.u32(31) + d.u32(7)) * TWO_PI + local * (2.4 + energy);
  const behind = wrap(head - theta);
  const life = 1 - local / period;
  const front = std.exp(-std.pow(behind / 0.26, 2));
  const trail = std.select(d.f32(0), std.exp(-behind * 2.4) * 0.5, behind > 0);
  return (front + trail) * life;
};

/** How far the plasma gives way to the pointer's pushes at a point, as a displacement (used by the field lines). */
const displacement = (dist: DisturbanceBinding, params: ParamsBinding, clock: ClockBinding) => (p: d.v3f) => {
  'use gpu';
  const instability = params.$.instability;
  const tau = 0.5 + 2.8 * instability;
  // Less confinement and more instability: bigger deformations that last longer.
  const gain = (0.6 + 1.6 * instability) * (1.35 - 0.7 * params.$.confinement);
  let total = d.vec3f(0);
  for (let e = 0; e < MAX_EVENTS; e++) {
    const ev = dist.$.events[e];
    const age = clock.$.time - ev.birth;
    if (age > 0 && age < 9) {
      const rel = p.sub(ev.pos);
      const r = std.length(rel) + 0.0001;
      const front = 1.9 * age;
      const shell = std.exp(-std.pow((r - front) / (0.14 + 0.1 * age), 2));
      const amp = ev.strength * std.exp(-age / tau) * gain * shell;
      total = total.add(rel.div(r).mul(std.sin((r - front) * 16) * amp * 0.1)).add(ev.dir.mul(amp * 0.09));
    }
  }
  // Under a pressed pointer the field is twisted around the view axis.
  const vortex = dist.$.vortex;
  if (vortex.strength > 0.001) {
    const rel = p.sub(vortex.pos);
    const fall = std.exp(-std.dot(rel, rel) / 0.1) * vortex.strength;
    const angle = fall * (1.6 + 1.6 * instability);
    const c = std.cos(angle);
    const s = std.sin(angle);
    const turned = rel.mul(c).add(std.cross(vortex.axis, rel).mul(s)).add(vortex.axis.mul(std.dot(vortex.axis, rel) * (1 - c)));
    total = total.add(turned.sub(rel));
  }
  return total;
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
  return std.clamp(std.pow(view.$.distance / std.max(depth, 0.1), 1.7), 0.4, 1.6);
};

/** Adds light to one cell of the grid. */
const addTo = (accum: AccumBinding) => (ix: number, iy: number, channel: number, value: number) => {
  'use gpu';
  if (ix >= 0 && iy >= 0 && ix < GRID_W && iy < GRID_H && value >= 1) {
    std.atomicAdd(accum.$[(d.u32(iy) * GRID_W + d.u32(ix)) * 4 + d.u32(channel)], d.u32(value));
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

/**
 * Adds light along a segment between two projected points: continuous lines and streaks, whatever the length. `amount` is
 * the light of one cell, so a longer segment (a faster particle, a slower frame) is longer, not brighter.
 */
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
 * One thread per particle. Plasma particles follow the helical magnetic field around the torus, held on nested flux surfaces
 * by the confinement; pushes, the pulse that circles the ring and the pressed pointer's vortex throw them off their path and
 * heat them; the confinement pulls them back. Dust drifts. Each particle splats a streak from where it was to where it is.
 */
export const plasmaKernel = (
  particles: TgpuMutable<typeof Particles>,
  accum: AccumBinding,
  view: ViewBinding,
  params: ParamsBinding,
  clock: ClockBinding,
  dist: DisturbanceBinding,
) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  return (i: number) => {
    'use gpu';
    const index = d.u32(i);
    const time = clock.$.time;
    const dt = clock.$.dt;
    const conf = params.$.confinement;
    const energy = params.$.energy;
    const instability = params.$.instability;
    const self = particles.$[index];
    let pos = d.vec3f(self.pos);
    let vel = d.vec3f(self.vel);
    let heat = self.heat;
    let before = d.vec3f(pos);
    const s1 = unit(index * d.u32(7) + d.u32(1));
    const s2 = unit(index * d.u32(7) + d.u32(2));
    const s3 = unit(index * d.u32(7) + d.u32(3));

    if (index < PLASMA_PARTICLES) {
      // Each particle lives on one of five nested flux surfaces (a few drift freely, which fills the volume).
      const level = std.select(std.floor(s1 * 5) / 4, s1, s3 < 0.18);
      const rhoTarget = MINOR * (0.2 + 0.78 * level);
      const speed = (0.45 + 1.25 * energy) * (1 - 0.65 * params.$.reduced) * (0.8 + 0.4 * s2);

      const theta = std.atan2(pos.z, pos.x);
      const eR = d.vec3f(std.cos(theta), 0, std.sin(theta));
      const eT = d.vec3f(-std.sin(theta), 0, std.cos(theta));
      const offset = pos.sub(ringCenter(theta, time, instability));
      const radial = std.dot(offset, eR);
      const rho = std.sqrt(radial * radial + offset.y * offset.y) + 0.00001;
      const phi = std.atan2(offset.y, radial);
      const eRho = eR.mul(std.cos(phi)).add(UP.mul(std.sin(phi)));
      const ePhi = eR.mul(-std.sin(phi)).add(UP.mul(std.cos(phi)));

      // The field winds around the torus: q times toroidally for every poloidal turn, a little differently on each surface.
      const q = (1.4 + 2.2 * conf) * (0.85 + (0.45 * rhoTarget) / MINOR);
      const flow = eT.mul(speed).add(ePhi.mul((speed * rho) / (MAJOR * q)));
      vel = vel.add(flow.sub(vel).mul(std.min(1, dt * (1.2 + 5 * conf))));
      // Confinement holds the particle on its surface.
      vel = vel.add(eRho.mul(-(rho - rhoTarget) * (6 + 30 * conf) * dt));
      vel = vel.sub(eRho.mul(std.dot(vel, eRho) * std.min(1, dt * (2 + 6 * conf))));

      // Everything that throws the plasma around.
      let kick = d.vec3f(0);
      let boost = d.f32(0);
      const tau = 0.5 + 2.8 * instability;
      const gain = (0.6 + 1.6 * instability) * (1.35 - 0.7 * conf);
      for (let e = 0; e < MAX_EVENTS; e++) {
        const ev = dist.$.events[e];
        const age = time - ev.birth;
        if (age > 0 && age < 9) {
          const rel = pos.sub(ev.pos);
          const r = std.length(rel) + 0.0001;
          const shell = std.exp(-std.pow((r - 1.9 * age) / (0.14 + 0.1 * age), 2));
          const amp = ev.strength * std.exp(-age / tau) * gain;
          // A wave that leaves the point of the disturbance and pushes along the way the pointer moved.
          kick = kick.add(rel.div(r).mul(shell * amp * 22)).add(ev.dir.mul(shell * amp * 12));
          // And a pulse that travels around the ring in both directions.
          const away = std.abs(wrap(theta - std.atan2(ev.pos.z, ev.pos.x)));
          const ring = std.exp(-std.pow((away - 2.3 * age) / 0.38, 2));
          kick = kick.add(eRho.mul(ring * amp * 3));
          boost = boost + (shell * 2.6 + ring * 0.5) * ev.strength * std.exp(-age / tau);
        }
      }
      // A pressed pointer holds a vortex: a swirl around the view axis that draws the plasma into a spiral.
      const vortex = dist.$.vortex;
      if (vortex.strength > 0.001) {
        const rel = pos.sub(vortex.pos);
        const fall = std.exp(-std.dot(rel, rel) / 0.14) * vortex.strength;
        kick = kick.add(std.cross(vortex.axis, rel).mul(fall * (16 + 20 * instability))).add(rel.mul(-fall * 5));
        boost = boost + fall * 1.2;
      }
      // Instability also keeps a little turbulence going.
      const swirl = d.vec3f(
        std.sin(pos.y * 5 + time * 1.3 + pos.z * 3),
        std.sin(pos.z * 5 - time * 1.1 + pos.x * 3),
        std.sin(pos.x * 5 + time * 0.9 + pos.y * 3),
      );
      kick = kick.add(swirl.mul(0.4 + 2.2 * instability));
      boost = boost + pulseAt(theta, time, energy) * 3;

      vel = vel.add(kick.mul(dt));
      const pace = std.length(vel);
      if (pace > 7) {
        vel = vel.mul(7 / pace);
      }
      pos = pos.add(vel.mul(dt));
      heat = std.min(std.max(0, heat - dt * 1.3) + boost * dt * 3, 2.2);

      // New particles (and ones thrown far out of the plasma) start again on their own surface.
      if (std.length(self.pos) < 0.001 || rho > MINOR * 1.6) {
        const spawn = d.u32(time * 10) + index * d.u32(13);
        const at = unit(spawn) * TWO_PI;
        const around = unit(spawn + d.u32(1)) * TWO_PI;
        const ahead = d.vec3f(std.cos(at), 0, std.sin(at));
        pos = ringCenter(at, time, instability).add(ahead.mul(std.cos(around) * rhoTarget)).add(UP.mul(std.sin(around) * rhoTarget));
        vel = d.vec3f(-std.sin(at), 0, std.cos(at)).mul(speed);
        heat = 0;
        before = d.vec3f(pos);
      }
      particles.$[index] = Particle({ pos, heat, vel, phase: self.phase });

      const a = project(before);
      const b = project(pos);
      // Amber sparks: now and then a particle flares for a moment.
      const spark = std.select(d.f32(0), d.f32(2.5), unit(index * d.u32(3) + d.u32(time * 2)) > 0.9985);
      const glow = (0.55 + 0.9 * energy) * (1.3 - 0.6 * level) * fade(b.z);
      segment(a, b, 0, glow * 0.024);
      segment(a, b, 1, (heat * 0.026 + spark * 0.02) * fade(b.z));
    } else {
      // Dust: slow drift around the reactor, a faint twinkle, depth from nothing but intensity.
      if (std.length(self.pos) < 0.001 || std.length(pos) > 4.2) {
        const spawn = d.u32(time * 10) + index * d.u32(17);
        const dir = std.normalize(d.vec3f(unit(spawn) - 0.5, (unit(spawn + d.u32(1)) - 0.5) * 0.7, unit(spawn + d.u32(2)) - 0.5));
        pos = dir.mul(1.6 + 2.5 * unit(spawn + d.u32(3)));
        before = d.vec3f(pos);
      }
      const drift = d.vec3f(-pos.z, 0.05 * std.sin(time * 0.3 + s1 * 6), pos.x).mul(0.05 * (0.5 + s2) * (1 - 0.7 * params.$.reduced));
      pos = pos.add(drift.mul(dt));
      particles.$[index] = Particle({ pos, heat: 0, vel: drift, phase: self.phase });
      const b = project(pos);
      const twinkle = 0.5 + 0.5 * std.sin(time * (0.8 + 2 * s3) + s1 * 40);
      segment(b, b, 0, 0.012 * twinkle * fade(b.z) * (0.5 + s2));
    }
  };
};

/**
 * One thread per piece of a magnetic field line (two turns around the torus, helical, sheared: every line has its own pitch).
 * The lines pulse and drift, bend where the plasma is pushed, and turn amber where they are bent most.
 */
export const fieldKernel = (accum: AccumBinding, view: ViewBinding, params: ParamsBinding, clock: ClockBinding, dist: DisturbanceBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const displace = displacement(dist, params, clock);
  const segment = segmentTo(splatTo(addTo(accum)));
  /** Where a field line is, `t` turns around the torus. */
  const lineAt = (line: number, t: number) => {
    'use gpu';
    const time = clock.$.time;
    const theta = t * TWO_PI;
    const frac = unit(d.u32(line) * d.u32(3) + d.u32(11));
    const rho = MINOR * (0.5 + 0.62 * frac) * (1 + 0.05 * std.sin(3 * theta - time * 1.3 + d.f32(line)));
    const q = (1.3 + 2.2 * params.$.confinement) * (0.85 + 0.5 * frac);
    const phi = d.f32(line) * 2.399963 + theta / q + time * 0.14;
    const eR = d.vec3f(std.cos(theta), 0, std.sin(theta));
    return ringCenter(theta, time, params.$.instability).add(eR.mul(std.cos(phi) * rho)).add(UP.mul(std.sin(phi) * rho));
  };
  return (line: number, sample: number) => {
    'use gpu';
    const t0 = (d.f32(sample) / LINE_SAMPLES) * LINE_TURNS;
    const t1 = (d.f32(sample + 1) / LINE_SAMPLES) * LINE_TURNS;
    const p0 = lineAt(line, t0);
    const p1 = lineAt(line, t1);
    // Neighbouring samples bend alike: one displacement serves both ends of the segment.
    const bent = displace(p1);
    const a = project(p0.add(bent));
    const b = project(p1.add(bent));
    const bend = std.length(bent);
    const pulse = pulseAt(t1 * TWO_PI, clock.$.time, params.$.energy);
    const glow = (0.5 + 0.7 * params.$.energy) * (0.55 + 0.6 * pulse) * fade(b.z);
    segment(a, b, 2, glow * 0.5);
    segment(a, b, 1, std.min(bend * 1.4, 1.5) * 0.25 * fade(b.z));
  };
};

/**
 * One thread per piece of the rigid structure around the plasma: the toroidal field coils, and the rings and lines of the
 * vessel wall. It does not move, so it is the part of the picture that says "this is a torus".
 */
export const structureKernel = (accum: AccumBinding, view: ViewBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  /** A point of a strand: a coil or ring is a loop in a poloidal plane, a vessel line follows the ring. */
  const strandAt = (strand: number, t: number) => {
    'use gpu';
    const angle = t * TWO_PI;
    let point = d.vec3f(0);
    if (strand < COILS) {
      const at = (d.f32(strand) / COILS) * TWO_PI;
      const eR = d.vec3f(std.cos(at), 0, std.sin(at));
      // The coils are slightly tall D shapes.
      point = eR.mul(MAJOR + MINOR * 1.75 * std.cos(angle) * 0.86).add(UP.mul(MINOR * 1.75 * std.sin(angle) * 1.22));
    } else if (strand < COILS + VESSEL_RINGS) {
      const at = (d.f32(strand - COILS) / VESSEL_RINGS) * TWO_PI;
      const eR = d.vec3f(std.cos(at), 0, std.sin(at));
      point = eR.mul(MAJOR + MINOR * 1.14 * std.cos(angle)).add(UP.mul(MINOR * 1.14 * std.sin(angle)));
    } else {
      const around = (d.f32(strand - COILS - VESSEL_RINGS) / VESSEL_LINES) * TWO_PI;
      const eR = d.vec3f(std.cos(angle), 0, std.sin(angle));
      point = eR.mul(MAJOR + MINOR * 1.14 * std.cos(around)).add(UP.mul(MINOR * 1.14 * std.sin(around)));
    }
    return point;
  };
  return (strand: number, sample: number) => {
    'use gpu';
    const a = project(strandAt(strand, d.f32(sample) / STRAND_SAMPLES));
    const b = project(strandAt(strand, d.f32(sample + 1) / STRAND_SAMPLES));
    const weight = std.select(d.f32(0.07), d.f32(0.16), strand < COILS);
    segment(a, b, 3, weight * fade(b.z));
  };
};

/** Samples on each ripple ring and on the vortex spiral. */
export const RIPPLE_SAMPLES = 128;

/**
 * The visible face of the disturbances: every recent push sends out a ring that grows at the speed of the wave that is
 * shoving the particles, and a pressed pointer draws the spiral it is winding up. The last row is the spiral.
 */
export const rippleKernel = (accum: AccumBinding, view: ViewBinding, params: ParamsBinding, clock: ClockBinding, dist: DisturbanceBinding) => {
  const project = projector(view);
  const fade = fadeFor(view);
  const segment = segmentTo(splatTo(addTo(accum)));
  return (row: number, sample: number) => {
    'use gpu';
    const v = view.$;
    const time = clock.$.time;
    const tau = 0.5 + 2.8 * params.$.instability;
    let center = d.vec3f(0);
    let amount = d.f32(0);
    let radius0 = d.f32(0);
    let radius1 = d.f32(0);
    let swirl = d.f32(0);
    if (row < MAX_EVENTS) {
      const ev = dist.$.events[row];
      const age = time - ev.birth;
      if (age > 0 && age < 6) {
        center = d.vec3f(ev.pos);
        radius0 = 1.9 * age;
        radius1 = 1.9 * age * 0.8;
        amount = std.min(ev.strength, 1.2) * std.exp(-age / tau) * std.select(d.f32(1), d.f32(0), radius0 > 1.8);
      }
    } else {
      const vortex = dist.$.vortex;
      center = d.vec3f(vortex.pos);
      amount = vortex.strength;
      radius0 = 0.34;
      radius1 = 0.04;
      swirl = 1;
    }
    if (amount > 0.01) {
      const turns = d.f32(sample) / RIPPLE_SAMPLES;
      const next = d.f32(sample + 1) / RIPPLE_SAMPLES;
      // A ring is a circle in the plane facing the camera; the vortex is a spiral that winds from small to large.
      const a0 = turns * TWO_PI * (1 + swirl * 1.5) + swirl * time * 3;
      const a1 = next * TWO_PI * (1 + swirl * 1.5) + swirl * time * 3;
      const r0 = std.select(radius0, std.mix(radius1, radius0, turns), swirl > 0.5);
      const r1 = std.select(radius0, std.mix(radius1, radius0, next), swirl > 0.5);
      const p0 = center.add(v.right.mul(std.cos(a0) * r0)).add(v.up.mul(std.sin(a0) * r0));
      const p1 = center.add(v.right.mul(std.cos(a1) * r1)).add(v.up.mul(std.sin(a1) * r1));
      const a = project(p0);
      const b = project(p1);
      segment(a, b, 2, amount * 1.1 * fade(b.z));
      segment(a, b, 1, amount * 0.3 * fade(b.z));
      // A fainter echo inside the ring.
      if (swirl < 0.5) {
        const q0 = project(center.add(v.right.mul(std.cos(a0) * radius1)).add(v.up.mul(std.sin(a0) * radius1)));
        const q1 = project(center.add(v.right.mul(std.cos(a1) * radius1)).add(v.up.mul(std.sin(a1) * radius1)));
        segment(q0, q1, 2, amount * 0.35 * fade(b.z));
      }
    }
  };
};

/** Moves the light out of the atomics as floats, and fades it: what was left of this frame is what the next one adds to. */
export const resolveKernel = (accum: AccumBinding, shown: TgpuMutable<typeof Shown>, clock: ClockBinding) => (x: number, y: number) => {
  'use gpu';
  const cell = d.u32(y) * GRID_W + d.u32(x);
  const base = cell * 4;
  const plasma = std.atomicLoad(accum.$[base]);
  const heat = std.atomicLoad(accum.$[base + 1]);
  const field = std.atomicLoad(accum.$[base + 2]);
  const structure = std.atomicLoad(accum.$[base + 3]);
  shown.$[cell] = d.vec4f(d.f32(plasma), d.f32(heat), d.f32(field), d.f32(structure)).div(FIXED);
  // The plasma and its heat leave trails; the field lines and the structure are drawn again every frame.
  std.atomicStore(accum.$[base], d.u32(d.f32(plasma) * clock.$.decay));
  std.atomicStore(accum.$[base + 1], d.u32(d.f32(heat) * clock.$.decay));
  std.atomicStore(accum.$[base + 2], 0);
  std.atomicStore(accum.$[base + 3], 0);
};

/** The grid at a position of the canvas: bilinear. */
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

/** The nearest cell of the grid: for the cheap taps of the bloom. */
const nearestOf = (shown: TgpuReadonly<typeof Shown>) => (p: d.v2f) => {
  'use gpu';
  const q = std.clamp(std.floor(p), d.vec2f(0), d.vec2f(GRID_W - 1, GRID_H - 1));
  return d.vec4f(shown.$[d.u32(q.y) * GRID_W + d.u32(q.x)]);
};

export function coreFragment(shown: TgpuReadonly<typeof Shown>, view: ViewBinding, clock: ClockBinding) {
  const bilinear = bilinearOf(shown);
  const nearest = nearestOf(shown);
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const v = view.$;
    // Canvas position as screen units (2 tall), and then as a position in the grid.
    const screen = d.vec2f((input.uv.x - 0.5) * v.aspect * 2, (0.5 - input.uv.y) * 2);
    const at = d.vec2f((screen.x + GRID_HALF_WIDTH) * GRID_TEXELS_PER_UNIT, (1 - screen.y) * GRID_TEXELS_PER_UNIT);

    const here = bilinear(at);

    // Bloom: a few taps on three rings around the pixel, turned by a different angle in every pixel. Very large canvases
    // take half as many, so the cost of the picture does not grow with the screen.
    const lite = std.select(d.f32(0), d.f32(1), v.height * v.height * v.aspect > 2500000);
    const taps = std.select(d.f32(4), d.f32(2), lite > 0.5);
    const twist = unit(d.u32(input.uv.x * 4096) * d.u32(1973) + d.u32(input.uv.y * 4096) * d.u32(9277)) * TWO_PI;
    let halo = d.vec4f(0);
    for (let ring = 0; ring < 3; ring++) {
      const radius = std.select(d.f32(2.5), std.select(d.f32(7), d.f32(18), ring === 2), ring > 0);
      const weight = std.select(d.f32(0.5), std.select(d.f32(0.3), d.f32(0.2), ring === 2), ring > 0);
      for (let k = 0; k < 4; k++) {
        if (d.f32(k) >= taps) {
          break;
        }
        const angle = twist + (d.f32(k) / taps) * TWO_PI;
        halo = halo.add(nearest(at.add(d.vec2f(std.cos(angle), std.sin(angle)).mul(radius))).mul(weight / taps));
      }
    }

    // Plasma is icy cyan, heat is amber, field lines are paler, the structure is steel. Bright places go white: each
    // channel of the colour saturates on its own.
    let color = ICE.mul(here.x + halo.x * 0.9).add(AMBER.mul(here.y + halo.y * 0.9)).add(FIELD.mul(here.z + halo.z * 0.7)).add(STEEL.mul(here.w + halo.w * 0.3));
    color = d.vec3f(1).sub(std.exp(color.mul(-1.05)));

    // The dark: nearly black, a little blue near the reactor, darker towards the corners.
    const far = std.dot(screen, screen);
    const dark = d.vec3f(0.004, 0.007, 0.014).add(d.vec3f(0.006, 0.016, 0.03).mul(std.exp(-far * 0.7)));
    const vignette = 1 - 0.35 * std.smoothstep(0.6, 2.6, far);
    return d.vec4f(std.pow(color.add(dark).mul(vignette), d.vec3f(0.95)), 1);
  });
}
