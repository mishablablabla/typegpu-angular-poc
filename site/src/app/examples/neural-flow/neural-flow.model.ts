// The application logic of NEURAL FLOW: a procedurally generated network, a small reference simulator that follows the
// same rules as the shaders, the camera, and the pointer (which stimulates, hovers, selects and orbits).
// Plain TypeScript with no Angular and no GPU: both implementations of the example drive this same code, and the numbers
// it produces (the network, the camera basis, the stimulus) are what the shaders read.
// An illustrative model: integrate-and-fire units with a refractory period and delays along the connections. Not a
// validated neuroscience simulator and not a diagnostic tool.

export type Vec3 = readonly [number, number, number];

// ---- The model's constants (shared with the shaders) ------------------------------------------------------------

/** A neuron fires when its potential reaches the threshold; the potential leaks away with this time constant. */
export const THRESHOLD = 1;
export const TAU = 0.08;
/** Seconds after a spike during which a neuron cannot fire again. Longer than the longest delay: pulses never overlap. */
export const REFRACTORY = 0.6;
export const MAX_DELAY = 0.55;
/** Weights are added with integer atomics on the GPU, in thousandths. */
export const WEIGHT_SCALE = 1000;
/** Samples along each connection when it is drawn. */
export const EDGE_SAMPLES = 10;
/** What a group of pacemaker (or probe) neurons receives when its rhythm ticks. */
export const KICK = 1.5;
/** Neurons within this distance of the pointer's point (or of a pacemaker site) are driven. */
export const STIMULUS_REACH = 0.25;
export const PROBE_RADIUS = 0.3;
/** How fast the pointer charges the neurons around it (potential per second, times the stimulation control). */
export const STIMULUS_DRIVE = 40;
/** A click starts a wave of firing that spreads over the cortex at this speed, as far as `burstRadius`. */
export const BURST_SPEED = 2.4;
export const MAX_BURSTS = 4;
export const BURST_REACH_BASE = 0.32;
export const BURST_REACH_GAIN = 0.4;
export const burstRadius = (strength: number): number => BURST_REACH_BASE + BURST_REACH_GAIN * strength;

export const GRID_TEXELS_PER_UNIT = 360;
export const GRID_W = 1584;
export const GRID_H = 720;
export const GRID_HALF_WIDTH = GRID_W / (2 * GRID_TEXELS_PER_UNIT);
/** The canvas never has more than this many pixels per CSS pixel: the light grid is the resolution of the picture. */
export const MAX_PIXEL_RATIO = 1;
export const FOCAL = 1.9;
export const focalFor = (aspect: number): number => Math.min(FOCAL, 2.05 * aspect);

export const DEFAULTS = { state: 'Spontaneous baseline', frequency: 1, connectivity: 0.85, stimulation: 0.6 } as const;
export const STATES = ['Spontaneous baseline', 'Stimulated propagation'] as const;

// ---- Vectors ------------------------------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- The brain ----------------------------------------------------------------------------------------------------
// A procedural brain, no assets: two hemispheres (the upper mass of the frontal, parietal and occipital lobes with a flat
// underside, and a tilted temporal lobe whose junction with it is the lateral fissure) with a longitudinal fissure between
// them, the major sulci (central, precentral, postcentral, superior and inferior frontal, intraparietal, temporal,
// parieto-occipital) as grooves along the surface, the small folds of the cortex as wandering ridges on top of them, a
// cerebellum with fine ridges (folia) under the back, and a brainstem with its pons. The surface is the zero of `brainField`, a signed distance
// (approximately: negative inside). x points to the right of the head, y up, z to the front.

function lattice(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRADIENTS: readonly Vec3[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/**
 * Smooth gradient noise (Perlin's), 0..1 with 0.5 in the middle. Gradient noise rather than value noise: the surfaces where it
 * crosses its middle value are smooth and round, not boxy, which is what the folds of the cortex are made from.
 */
function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const sx = fade(fx);
  const sy = fade(fy);
  const sz = fade(fz);
  const corner = (a: number, b: number, c: number) => {
    const g = GRADIENTS[Math.floor(lattice(ix + a, iy + b, iz + c) * 12) % 12]!;
    return g[0] * (fx - a) + g[1] * (fy - b) + g[2] * (fz - c);
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const v = lerp(
    lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), sx), lerp(corner(0, 1, 0), corner(1, 1, 0), sx), sy),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), sx), lerp(corner(0, 1, 1), corner(1, 1, 1), sx), sy),
    sz,
  );
  return clamp(0.5 + v * 0.55, 0, 1);
}

/** Distance to an ellipsoid (a good approximation near its surface). */
function ellipsoid(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

const smoothMin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

/** Distance to a capsule whose radius changes along it (a tapering limb of the brain: the temporal lobe, the brainstem). */
function capsule(x: number, y: number, z: number, a: Vec3, b: Vec3, ra: number, rb: number): number {
  const pax = x - a[0];
  const pay = y - a[1];
  const paz = z - a[2];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h);
}

const smoothMax = (a: number, b: number, k: number) => -smoothMin(-a, -b, k);

/**
 * One hemisphere before any folding, as a signed distance, for a point with x mirrored to the right (q >= 0). The upper mass
 * (frontal, parietal and occipital lobes) has a flat underside, where the brain rests on the skull base and the cerebellum;
 * the temporal lobe is a separate, tilted lobe below and beside it, with its pole pointing forwards and down; and the junction
 * of the two is the lateral (Sylvian) fissure. The medial face is flat: the hemispheres touch there.
 */
function hemisphere(q: number, y: number, z: number): number {
  let d = ellipsoid(q, y, z, 0.3, 0.14, -0.04, 0.5, 0.44, 0.82);
  d = smoothMin(d, ellipsoid(q, y, z, 0.26, 0.03, 0.58, 0.41, 0.35, 0.4), 0.14);
  d = smoothMin(d, ellipsoid(q, y, z, 0.22, 0.0, -0.64, 0.35, 0.31, 0.3), 0.14);
  // The underside rises towards the back (the orbital surface of the frontal lobe is the lowest part of the upper mass).
  d = smoothMax(d, -0.26 + 0.055 * (0.9 - z) - y + 0.0, 0.07);
  d = smoothMin(d, capsule(q, y, z, [0.5, -0.38, 0.5], [0.45, -0.14, -0.5], 0.115, 0.2), 0.045);
  return Math.max(d, 0.012 - q);
}

// Major sulci, as lines along the surface of the right hemisphere (the left is the mirror image). They are written as rough
// positions and snapped to the surface when the page starts; each is a groove of its own width and depth. The lateral fissure and
// the central sulcus are the ones everybody knows; the rest give the surface the pattern of a real brain before the small
// folds are added.
const SULCI: { readonly path: readonly Vec3[]; readonly width: number; readonly depth: number }[] = [
  { path: [[0.52, -0.12, 0.5], [0.64, -0.1, 0.28], [0.72, -0.05, 0.0], [0.7, 0.05, -0.28], [0.62, 0.16, -0.48]], width: 0.034, depth: 1 },
  { path: [[0.08, 0.55, 0.0], [0.17, 0.53, 0.05], [0.26, 0.5, -0.01], [0.36, 0.46, 0.06], [0.46, 0.4, 0.07], [0.55, 0.28, 0.16], [0.63, 0.16, 0.18], [0.69, 0.0, 0.24]], width: 0.028, depth: 0.95 },
  { path: [[0.1, 0.55, 0.15], [0.2, 0.53, 0.22], [0.3, 0.5, 0.17], [0.42, 0.43, 0.26], [0.52, 0.36, 0.25], [0.6, 0.24, 0.34], [0.64, 0.18, 0.34]], width: 0.022, depth: 0.7 },
  { path: [[0.1, 0.56, -0.15], [0.2, 0.54, -0.1], [0.3, 0.51, -0.16], [0.42, 0.45, -0.07], [0.52, 0.37, -0.08], [0.6, 0.26, 0.02], [0.64, 0.18, 0.07]], width: 0.022, depth: 0.7 },
  { path: [[0.2, 0.5, 0.12], [0.22, 0.47, 0.35], [0.24, 0.38, 0.6], [0.27, 0.22, 0.78]], width: 0.024, depth: 0.75 },
  { path: [[0.54, 0.2, 0.3], [0.58, 0.14, 0.5], [0.55, 0.06, 0.7]], width: 0.022, depth: 0.7 },
  { path: [[0.5, 0.38, -0.05], [0.4, 0.44, -0.28], [0.35, 0.42, -0.5]], width: 0.024, depth: 0.75 },
  { path: [[0.62, -0.22, 0.38], [0.7, -0.2, 0.15], [0.72, -0.12, -0.15], [0.64, 0.0, -0.42]], width: 0.026, depth: 0.8 },
  { path: [[0.6, -0.36, 0.3], [0.64, -0.34, 0.0], [0.58, -0.28, -0.35]], width: 0.022, depth: 0.65 },
  { path: [[0.04, 0.46, -0.45], [0.14, 0.38, -0.55], [0.22, 0.25, -0.62]], width: 0.026, depth: 0.85 },
  { path: [[0.5, 0.05, -0.6], [0.45, 0.0, -0.75]], width: 0.02, depth: 0.6 },
];

/** The sulci as a volume: how deep the groove is (0..1) around the surface, on a grid with trilinear lookup. */
const GROOVES = (() => {
  const step = 0.014;
  const lo: Vec3 = [0, -0.62, -1.06];
  const nx = Math.ceil(0.92 / step);
  const ny = Math.ceil(1.34 / step);
  const nz = Math.ceil(2.12 / step);
  // The paths, smoothed (Catmull-Rom, four points to the span) and put on the surface.
  const polylines = SULCI.map(({ path, width, depth }) => {
    const points: Vec3[] = [];
    const at = (i: number) => path[clamp(i, 0, path.length - 1)]!;
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = 0; k < 4; k++) {
        const t = k / 4;
        const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
        points.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c]! + (p2[c]! - p0[c]!) * t + (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * t * t + (3 * p1[c]! - p0[c]! - 3 * p2[c]! + p3[c]!) * t * t * t)) as unknown as Vec3);
      }
    }
    points.push(at(path.length - 1));
    const onSurface = points.map((p) => {
      let q = p;
      for (let i = 0; i < 6; i++) {
        const f = hemisphere(q[0], q[1], q[2]);
        const e = 0.004;
        const n = normalize([hemisphere(q[0] + e, q[1], q[2]) - hemisphere(q[0] - e, q[1], q[2]), hemisphere(q[0], q[1] + e, q[2]) - hemisphere(q[0], q[1] - e, q[2]), hemisphere(q[0], q[1], q[2] + e) - hemisphere(q[0], q[1], q[2] - e)]);
        q = sub(q, scale(n, f));
      }
      return q;
    });
    const center = onSurface.reduce((sum, p) => add(sum, p), [0, 0, 0] as Vec3);
    const mid = scale(center, 1 / onSurface.length);
    const radius = Math.max(...onSurface.map((p) => distance(p, mid))) + width * 2;
    return { points: onSurface, width, depth, mid, radius };
  });

  const grid = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = lo[0] + (ix + 0.5) * step;
        const y = lo[1] + (iy + 0.5) * step;
        const z = lo[2] + (iz + 0.5) * step;
        if (Math.abs(hemisphere(x, y, z)) > 0.1) continue;
        let groove = 0;
        for (const curve of polylines) {
          const rel: Vec3 = [x - curve.mid[0], y - curve.mid[1], z - curve.mid[2]];
          if (length(rel) > curve.radius) continue;
          let nearest = Infinity;
          for (let i = 0; i < curve.points.length - 1; i++) {
            const a = curve.points[i]!;
            const b = curve.points[i + 1]!;
            const ab = sub(b, a);
            const t = clamp(dot(sub([x, y, z], a), ab) / dot(ab, ab), 0, 1);
            nearest = Math.min(nearest, distance([x, y, z], add(a, scale(ab, t))));
          }
          if (nearest > curve.width * 2) continue;
          // The groove wanders in width and depth and is interrupted here and there (a real sulcus is not a cut).
          const wander = 0.4 + 0.6 * smoothstep(0.25, 0.65, noise(x * 8 + 5, y * 8, z * 8));
          groove = Math.max(groove, curve.depth * wander * (1 - smoothstep(0, curve.width * (1.1 + 0.8 * wander), nearest)));
        }
        grid[(iz * ny + iy) * nx + ix] = groove;
      }
    }
  }
  return { grid, nx, ny, nz, step, lo };
})();

/** How deep the major sulci are at a point (0..1), for a point of the right hemisphere (x mirrored). */
function majorSulci(q: number, y: number, z: number): number {
  const { grid, nx, ny, nz, step, lo } = GROOVES;
  const gx = (q - lo[0]) / step - 0.5;
  const gy = (y - lo[1]) / step - 0.5;
  const gz = (z - lo[2]) / step - 0.5;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const iz = Math.floor(gz);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) return 0;
  const fx = gx - ix;
  const fy = gy - iy;
  const fz = gz - iz;
  const at = (a: number, b: number, c: number) => grid[((iz + c) * ny + (iy + b)) * nx + ix + a]!;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(lerp(lerp(at(0, 0, 0), at(1, 0, 0), fx), lerp(at(0, 1, 0), at(1, 1, 0), fx), fy), lerp(lerp(at(0, 0, 1), at(1, 0, 1), fx), lerp(at(0, 1, 1), at(1, 1, 1), fx), fy), fz);
}

/**
 * The small folds: winding ridges and grooves, like the maze of gyri and sulci of a real cortex. The noise is bent by more noise
 * first (that is what makes the ridges wander instead of forming cells), and only the thin line where it crosses its middle
 * value is a groove, so the crowns of the gyri are broad and the grooves narrow.
 */
function smallFolds(x: number, y: number, z: number): number {
  const a = noise(x * 3.1 + 11, y * 3.1, z * 3.1) - 0.5;
  const b = noise(x * 3.1, y * 3.1 + 23, z * 3.1 + 37) - 0.5;
  const wx = x + 0.16 * a;
  const wy = y - 0.16 * a + 0.1 * b;
  const wz = z + 0.16 * b;
  const broad = 1 - smoothstep(0, 0.3, Math.abs(noise(wx * 6.4, wy * 6.4, wz * 6.4) - 0.5) * 2);
  const fine = 1 - smoothstep(0, 0.3, Math.abs(noise(wx * 13 + 3, wy * 13, wz * 13) - 0.5) * 2);
  return clamp(broad + 0.22 * fine, 0, 1);
}

/** How deep the cortex is folded at a point: 1 at the bottom of a sulcus, 0 on top of a gyrus. */
export function sulcus(x: number, y: number, z: number): number {
  const q = Math.abs(x);
  return clamp(Math.max(majorSulci(q, y, z), 0.8 * smallFolds(x, y, z)), 0, 1);
}

/** The two hemispheres, folded, with the fissure between them. */
export function cerebrumField(x: number, y: number, z: number): number {
  const q = Math.abs(x);
  const d = hemisphere(q, y, z);
  // Folds only matter near the surface, which also keeps the field cheap far from it.
  if (d > 0.14) return d;
  // Grooves pull the surface inward; none right at the fissure.
  const folded = d + 0.07 * majorSulci(q, y, z) * smoothstep(0.02, 0.08, q) + 0.04 * smallFolds(x, y, z) * smoothstep(0.015, 0.07, q);
  return Math.max(folded, 0.012 - q);
}

/** The cerebellum: two hemispheres under the occipital lobes, finely ridged across (the folia). */
export function cerebellumField(x: number, y: number, z: number): number {
  const q = Math.abs(x);
  const base = smoothMin(ellipsoid(q, y, z, 0.23, -0.4, -0.68, 0.37, 0.23, 0.3), ellipsoid(x, y, z, 0, -0.42, -0.68, 0.2, 0.22, 0.29), 0.1);
  if (base > 0.1) return base;
  return base + 0.011 * (0.5 + 0.5 * Math.sin((y + 0.05 * (z + 0.7) * (z + 0.7)) * 125 + noise(x * 4, 0, z * 4) * 5));
}

/** The brainstem: the midbrain, the pons with its bulge at the front, the medulla, and the start of the spinal cord. */
export function stemField(x: number, y: number, z: number): number {
  let d = capsule(x, y, z, [0, -0.2, -0.04], [0, -0.5, -0.12], 0.11, 0.13);
  d = smoothMin(d, ellipsoid(x, y, z, 0, -0.5, -0.04, 0.12, 0.12, 0.1), 0.07);
  d = smoothMin(d, capsule(x, y, z, [0, -0.5, -0.12], [0, -0.82, -0.28], 0.13, 0.08), 0.08);
  return smoothMin(d, capsule(x, y, z, [0, -0.82, -0.28], [0, -1.05, -0.36], 0.085, 0.06), 0.05);
}

/** Signed distance to the brain (negative inside). */
export function brainField(p: Vec3): number {
  return Math.min(cerebrumField(p[0], p[1], p[2]), cerebellumField(p[0], p[1], p[2]), stemField(p[0], p[1], p[2]));
}

/** The outward direction of the surface at a point. */
export function brainNormal(p: Vec3): Vec3 {
  const e = 0.004;
  return normalize([
    brainField([p[0] + e, p[1], p[2]]) - brainField([p[0] - e, p[1], p[2]]),
    brainField([p[0], p[1] + e, p[2]]) - brainField([p[0], p[1] - e, p[2]]),
    brainField([p[0], p[1], p[2] + e]) - brainField([p[0], p[1], p[2] - e]),
  ]);
}

/** Moves a point near the surface onto it. */
export function toSurface(p: Vec3): Vec3 {
  let q = p;
  for (let i = 0; i < 5; i++) q = sub(q, scale(brainNormal(q), brainField(q)));
  return q;
}

/** Where a ray meets the surface of the brain, if it does (marched with the distance field). */
export function hitBrain(ray: { origin: Vec3; direction: Vec3 }): Vec3 | undefined {
  // The brain fits in a sphere of radius 1.3: the ray starts where it enters it.
  const o = ray.origin;
  const b = dot(o, ray.direction);
  const c = dot(o, o) - 1.69;
  const disc = b * b - c;
  if (disc < 0) return undefined;
  let t = Math.max(0, -b - Math.sqrt(disc));
  for (let i = 0; i < 90; i++) {
    const p = add(o, scale(ray.direction, t));
    const f = brainField(p);
    if (f < 0.003) return p;
    t += f * 0.6;
    if (t > -b + Math.sqrt(disc)) return undefined;
  }
  return undefined;
}

// ---- The network ---------------------------------------------------------------------------------------------------

/** Regions: the four lobes of the cerebrum, the cerebellum, and three deep ones. */
export const REGION_NAMES = ['frontal cortex', 'parietal cortex', 'temporal cortex', 'occipital cortex', 'cerebellum', 'thalamus', 'basal ganglia', 'brainstem'] as const;
const FRONTAL = 0;
const PARIETAL = 1;
const TEMPORAL = 2;
const OCCIPITAL = 3;
const CEREBELLUM = 4;
const THALAMUS = 5;
const BASAL = 6;
const STEM = 7;

/** The lobe of a cortical point. */
function lobeOf(p: Vec3): number {
  if (p[2] < -0.5) return OCCIPITAL;
  if (p[1] < -0.12 && p[2] < 0.6) return TEMPORAL;
  if (p[2] > 0.25) return FRONTAL;
  return PARIETAL;
}

/**
 * One connection: from `src` to `dst`, `delay` seconds for a pulse to cross it. The fibre is a cubic curve from the source through
 * two control points (`mid`, then `mid2`) to the target; fibres of one tract share their corridor, so they run as a bundle and
 * fan out at the ends.
 */
export interface Edge {
  readonly src: number;
  readonly dst: number;
  readonly delay: number;
  /** Positive excites, negative inhibits. */
  readonly weight: number;
  readonly mid: Vec3;
  readonly mid2: Vec3;
  /** 0..1, a fixed shuffle: the Connectivity control keeps the connections whose rank is below it. */
  readonly rank: number;
  /** What kind of fibre it is. */
  readonly kind: 'local' | 'association' | 'callosal' | 'thalamic';
}

/** The kinds of fibre, in the order the GPU numbers them (it tints each kind differently). */
export const FIBRE_KINDS = ['local', 'association', 'callosal', 'thalamic'] as const;

/** A point of a fibre, `t` from 0 (the source) to 1 (the target). */
export function fibrePoint(a: Vec3, mid: Vec3, mid2: Vec3, b: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1, 2].map((c) => w[0]! * a[c]! + w[1]! * mid[c]! + w[2]! * mid2[c]! + w[3]! * b[c]!) as unknown as Vec3;
}

export interface Network {
  readonly positions: readonly Vec3[];
  /** Index into REGION_NAMES. */
  readonly region: Uint8Array;
  /** 1 for the right hemisphere, -1 for the left, 0 on the midline. */
  readonly side: Int8Array;
  /** The phase of the pacemaker group a neuron belongs to (0..1), or -1. */
  readonly pacemaker: Float32Array;
  readonly inhibitory: Uint8Array;
  readonly edges: readonly Edge[];
  readonly outEdges: readonly (readonly number[])[];
  readonly inEdges: readonly (readonly number[])[];
}

/** Points of the brain's surface, for the translucent shell: where, which way it faces, and how deep the fold is. */
export interface Shell {
  readonly positions: readonly Vec3[];
  readonly normals: readonly Vec3[];
  readonly folds: readonly number[];
}

/** Where the probe of the stimulated state taps the cortex: the back of the brain (the visual cortex). */
export let PROBE: Vec3 = [0, 0, 0];

const SHELL_POINTS = 60000;

function generate(): { network: Network; shell: Shell } {
  const next = random(1856);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const positions: Vec3[] = [];
  const regionList: number[] = [];
  const sideList: number[] = [];
  const sideOf = (p: Vec3) => (Math.abs(p[0]) < 0.015 ? 0 : p[0] > 0 ? 1 : -1);
  const place = (p: Vec3, region: number) => {
    positions.push(p);
    regionList.push(region);
    sideList.push(sideOf(p));
  };

  // Cortex: just under the folded surface of each hemisphere.
  for (const side of [1, -1]) {
    let count = 0;
    while (count < 1500) {
      const p: Vec3 = [side * next() * 0.85, -0.65 + next() * 1.25, -1.0 + next() * 2.0];
      const f = cerebrumField(p[0], p[1], p[2]);
      if (f < -0.006 && f > -0.07 && cerebellumField(p[0], p[1], p[2]) > 0.02 && stemField(p[0], p[1], p[2]) > 0.02) {
        place(p, lobeOf(p));
        count++;
      }
    }
  }
  // The cerebellum.
  for (let count = 0; count < 260; ) {
    const p: Vec3 = [(next() - 0.5) * 1.2, -0.8 + next() * 0.6, -1.05 + next() * 0.7];
    const f = cerebellumField(p[0], p[1], p[2]);
    if (f < -0.006 && f > -0.06) {
      place(p, CEREBELLUM);
      count++;
    }
  }
  // Deep nuclei: the thalamus and the basal ganglia of each hemisphere, and the brainstem.
  for (const side of [1, -1]) {
    for (let i = 0; i < 60; i++) place([side * (0.1 + 0.06 * gauss()), 0.02 + 0.05 * gauss(), 0.0 + 0.08 * gauss()], THALAMUS);
    for (let i = 0; i < 50; i++) place([side * (0.24 + 0.07 * gauss()), 0.08 + 0.06 * gauss(), 0.22 + 0.09 * gauss()], BASAL);
  }
  for (let i = 0; i < 40; i++) {
    const t = next();
    place([0.03 * gauss(), -0.4 - 0.55 * t, -0.3 - 0.1 * t + 0.03 * gauss()], STEM);
  }
  const count = positions.length;
  const region = Uint8Array.from(regionList);
  const side = Int8Array.from(sideList);
  const inhibitory = new Uint8Array(count);
  for (let i = 0; i < count; i++) inhibitory[i] = region[i]! <= OCCIPITAL && next() < 0.1 ? 1 : 0;

  // A spatial hash for neighbour searches.
  const CELL = 0.12;
  const cellOf = (p: Vec3) => `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)},${Math.floor(p[2] / CELL)}`;
  const grid = new Map<string, number[]>();
  positions.forEach((p, i) => {
    const key = cellOf(p);
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
  });
  const nearbyWhere = (i: number, accept: (j: number) => boolean, k: number): number[] => {
    const p = positions[i]!;
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    const cz = Math.floor(p[2] / CELL);
    const found: { j: number; d: number }[] = [];
    for (let x = -2; x <= 2; x++)
      for (let y = -2; y <= 2; y++)
        for (let z = -2; z <= 2; z++)
          for (const j of grid.get(`${cx + x},${cy + y},${cz + z}`) ?? []) if (j !== i && accept(j)) found.push({ j, d: distance(p, positions[j]!) });
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, k).map((f) => f.j);
  };
  const cortical = (j: number) => region[j]! <= OCCIPITAL;

  const raw: { src: number; dst: number; weight: number; mid: Vec3; mid2: Vec3; kind: Edge['kind'] }[] = [];
  const seen = new Set<number>();
  const connect = (src: number, dst: number, weight: number, mid: Vec3, mid2: Vec3, kind: Edge['kind']) => {
    const key = src * count + dst;
    if (src === dst || seen.has(key)) return;
    seen.add(key);
    raw.push({ src, dst, weight: (inhibitory[src] ? -0.5 : weight) * (0.9 + 0.2 * next()), mid, mid2, kind });
  };
  const hemisphereCenter = (s: number): Vec3 => [s * 0.3, 0.0, 0.0];
  const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(scale(a, 1 - t), scale(b, t));
  /** A small random offset: the width of a bundle. */
  const jitter = (size: number): Vec3 => [gauss() * size, gauss() * size, gauss() * size];
  const centroid = (indices: number[]): Vec3 => scale(indices.reduce((sum, i) => add(sum, positions[i]!), [0, 0, 0] as Vec3), 1 / Math.max(1, indices.length));

  // Short fibres under the cortex follow the folds: arcs that dip into the white matter.
  for (let i = 0; i < count; i++) {
    const r = region[i]!;
    const group = (j: number) => (r <= OCCIPITAL ? cortical(j) && side[j] === side[i] : r === CEREBELLUM ? region[j] === CEREBELLUM : region[j] === r);
    for (const j of nearbyWhere(i, group, 5)) {
      const a = positions[i]!;
      const b = positions[j]!;
      const m = scale(add(a, b), 0.5);
      const arc = r <= OCCIPITAL ? sub(m, scale(brainNormal(m), distance(a, b) * 0.6)) : add(m, [0, distance(a, b) * 0.2, 0]);
      connect(i, j, 0.82, lerp3(a, arc, 0.75), lerp3(b, arc, 0.75), 'local');
    }
  }

  // Association tracts: bundles between the lobes of a hemisphere. All the fibres of a tract run through the same two waypoints in the
  // white matter (so they gather into a bundle in the middle) and fan out to their own neurons at the ends.
  const lobePairs: [number, number][] = [[FRONTAL, PARIETAL], [PARIETAL, OCCIPITAL], [FRONTAL, TEMPORAL], [TEMPORAL, OCCIPITAL], [PARIETAL, TEMPORAL]];
  for (const s of [1, -1]) {
    for (const [from, to] of lobePairs) {
      const sources = positions.map((_, i) => i).filter((i) => region[i] === from && side[i] === s);
      const targets = positions.map((_, i) => i).filter((i) => region[i] === to && side[i] === s);
      const inward = (lobe: number[]): Vec3 => add(lerp3(centroid(lobe), hemisphereCenter(s), 0.62), [0, -0.04, 0]);
      const gateA = inward(sources);
      const gateB = inward(targets);
      for (const i of sources) {
        if (next() > 0.45) continue;
        const j = targets[Math.floor(next() * targets.length)]!;
        connect(i, j, 1.05, add(lerp3(positions[i]!, gateA, 0.78), jitter(0.018)), add(lerp3(positions[j]!, gateB, 0.78), jitter(0.018)), 'association');
      }
    }
  }

  // The corpus callosum: a bundle of fibres that arches over the midline and joins mirror-image places of the hemispheres. Both control
  // points of a fibre are in the arch, close to the midline, so the bundle rises from each hemisphere and crosses in one band.
  const rightIndices = positions.map((_, i) => i).filter((i) => side[i] === 1 && region[i]! <= OCCIPITAL);
  const leftIndices = positions.map((_, i) => i).filter((i) => side[i] === -1 && region[i]! <= OCCIPITAL);
  for (const i of rightIndices) {
    if (next() > 0.45) continue;
    const a = positions[i]!;
    const mirror: Vec3 = [-a[0], a[1], a[2]];
    let best = -1;
    let bestD = Infinity;
    for (const j of leftIndices) {
      const d = distance(positions[j]!, mirror);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    const b = positions[best]!;
    const z = (a[2] + b[2]) * 0.5;
    const archY = 0.38 + 0.12 * (1 - Math.min(1, Math.abs(z)));
    const rise = (end: Vec3): Vec3 => add([end[0] * 0.28, archY + 0.02 * gauss(), z + (end[2] - z) * 0.3], jitter(0.012));
    // Some fibres go one way, some the other, so the bundle does not simply ring.
    if (next() < 0.5) connect(i, best, 1.1, rise(a), rise(b), 'callosal');
    else connect(best, i, 1.1, rise(b), rise(a), 'callosal');
  }

  // Thalamocortical radiations: from each thalamic neuron up through one gate above the thalamus and out to the cortex of its hemisphere,
  // entering the cortex from the white matter below it (a fan, like the corona radiata); and some fibres back.
  for (let i = 0; i < count; i++) {
    if (region[i] !== THALAMUS) continue;
    const s = side[i]!;
    const targets = positions.map((_, j) => j).filter((j) => region[j]! <= OCCIPITAL && side[j] === s);
    for (let k = 0; k < 3 && targets.length > 0; k++) {
      const j = targets[Math.floor(next() * targets.length)]!;
      const a = positions[i]!;
      const b = positions[j]!;
      const gate: Vec3 = [s * 0.2, 0.24, b[2] * 0.3];
      const below = sub(b, scale(brainNormal(b), 0.16));
      connect(i, j, 1.0, add(lerp3(a, gate, 0.85), jitter(0.016)), add(lerp3(below, gate, 0.3), jitter(0.02)), 'thalamic');
    }
  }
  for (const j of [...rightIndices, ...leftIndices]) {
    if (next() > 0.04) continue;
    const pool = positions.map((_, i) => i).filter((i) => region[i] === THALAMUS && side[i] === side[j]);
    if (pool.length === 0) continue;
    const i = pool[Math.floor(next() * pool.length)]!;
    const a = positions[j]!;
    const b = positions[i]!;
    const s = side[j]!;
    const gate: Vec3 = [s * 0.2, 0.24, a[2] * 0.3];
    connect(j, i, 0.8, add(lerp3(sub(a, scale(brainNormal(a), 0.16)), gate, 0.3), jitter(0.02)), add(lerp3(b, gate, 0.85), jitter(0.016)), 'thalamic');
  }

  // A fixed shuffle decides which connections go first when connectivity is reduced.
  const order = raw.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const rankOf = new Array<number>(raw.length);
  order.forEach((edgeIndex, rank) => (rankOf[edgeIndex] = (rank + 0.5) / raw.length));
  const edges: Edge[] = raw.map(({ src, dst, weight, mid, mid2, kind }, i) => {
    const a = positions[src]!;
    const b = positions[dst]!;
    // The delay is proportional to the length of the curve (measured on eight pieces).
    let path = 0;
    let last = a;
    for (let k = 1; k <= 8; k++) {
      const point = fibrePoint(a, mid, mid2, b, k / 8);
      path += distance(last, point);
      last = point;
    }
    return { src, dst, delay: clamp(0.03 + 0.46 * path, 0.03, MAX_DELAY), weight, mid, mid2, rank: rankOf[i]!, kind };
  });
  const outEdges: number[][] = Array.from({ length: count }, () => []);
  const inEdges: number[][] = Array.from({ length: count }, () => []);
  edges.forEach((edge, i) => {
    outEdges[edge.src]!.push(i);
    inEdges[edge.dst]!.push(i);
  });

  // Pacemakers: the thalamus ticks, one hemisphere half a period after the other.
  const pacemaker = new Float32Array(count).fill(-1);
  for (let i = 0; i < count; i++) if (region[i] === THALAMUS) pacemaker[i] = side[i] === 1 ? 0 : 0.5;
  PROBE = toSurface([0.28, 0.06, -0.95]);

  // The shell: points on the surface, found by projecting random points near it (a few Newton steps along the gradient of the field,
  // which costs four evaluations of the field each instead of seven).
  const shellPositions: Vec3[] = [];
  const shellNormals: Vec3[] = [];
  const shellFolds: number[] = [];
  const gradientAt = (p: Vec3, f: number): Vec3 => {
    const e = 0.004;
    return normalize([brainField([p[0] + e, p[1], p[2]]) - f, brainField([p[0], p[1] + e, p[2]]) - f, brainField([p[0], p[1], p[2] + e]) - f]);
  };
  while (shellPositions.length < SHELL_POINTS) {
    let p: Vec3 = [(next() * 2 - 1) * 0.85, -1.0 + next() * 1.65, (next() * 2 - 1) * 1.05];
    let f = brainField(p);
    if (f > 0.08 || f < -0.12) continue;
    for (let i = 0; i < 4; i++) {
      p = sub(p, scale(gradientAt(p, f), f));
      f = brainField(p);
    }
    if (Math.abs(f) > 0.003) continue;
    shellPositions.push(p);
    shellNormals.push(gradientAt(p, f));
    shellFolds.push(Math.abs(p[1] + 0.5) < 0.3 && p[2] < -0.3 && p[1] < -0.3 ? 0.4 : sulcus(p[0], p[1], p[2]));
  }
  return {
    network: { positions, region, side, pacemaker, inhibitory, edges, outEdges, inEdges },
    shell: { positions: shellPositions, normals: shellNormals, folds: shellFolds },
  };
}

const GENERATED = generate();
export const NETWORK: Network = GENERATED.network;
export const SHELL: Shell = GENERATED.shell;
export const NEURONS = NETWORK.positions.length;
export const EDGE_COUNT = NETWORK.edges.length;
export const SHELL_COUNT = SHELL.positions.length;

export interface NeuronInfo {
  readonly id: string;
  readonly region: string;
  readonly inActive: number;
  readonly inTotal: number;
  readonly outActive: number;
  readonly outTotal: number;
  readonly kind: 'excitatory' | 'inhibitory';
}

/** What the inspector shows about a neuron: its name, where it is, and how many of its connections are switched on. */
export function describeNeuron(index: number, connectivity: number, network: Network = NETWORK): NeuronInfo {
  const active = (list: readonly number[]) => list.filter((e) => network.edges[e]!.rank < connectivity).length;
  const region = network.region[index]!;
  const side = network.side[index]!;
  const hemisphere = region === CEREBELLUM || region === STEM || side === 0 ? '' : side > 0 ? 'Right ' : 'Left ';
  const name = `${hemisphere}${REGION_NAMES[region]}`;
  return {
    id: `N-${String(index).padStart(4, '0')}`,
    region: name.charAt(0).toUpperCase() + name.slice(1),
    inActive: active(network.inEdges[index]!),
    inTotal: network.inEdges[index]!.length,
    outActive: active(network.outEdges[index]!),
    outTotal: network.outEdges[index]!.length,
    kind: network.inhibitory[index] ? 'inhibitory' : 'excitatory',
  };
}

/** The neuron closest to a point of the brain (within `radius`), or -1. */
export function nearestNeuron(p: Vec3, radius: number, network: Network = NETWORK): number {
  let best = -1;
  let bestD = radius;
  for (let i = 0; i < network.positions.length; i++) {
    const d = distance(network.positions[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---- The reference simulator --------------------------------------------------------------------------------------

export interface SimControls {
  readonly frequency: number;
  readonly connectivity: number;
  /** 0: the thalamus ticks. 1: a probe taps the visual cortex. */
  readonly mode: 0 | 1;
  readonly stimulation: number;
}

/** A click: a wave of firing that starts at `pos` at time `birth` and spreads over the cortex. */
export interface Burst {
  readonly pos: Vec3;
  readonly birth: number;
  readonly strength: number;
}

export interface Stimulus {
  readonly pos: Vec3;
}

/**
 * The same rules as the shaders, one fixed step at a time: a spike sends a pulse along every connection that arrives after
 * the connection's delay; a neuron adds what arrives to its leaking potential, fires at the threshold, and is silent for
 * the refractory period. A click makes the neurons around it fire as a wave spreads from it. The shaders run these rules
 * for every neuron and connection in parallel (and with the frame's own time step); this class is what the unit tests
 * check them against.
 */
export class ReferenceSimulator {
  time = 0;
  readonly potential = new Float32Array(NEURONS);
  readonly spike = new Float32Array(NEURONS).fill(-1000);
  readonly spikes = new Uint32Array(NEURONS);
  private readonly incoming = new Float32Array(NEURONS);

  constructor(private readonly network: Network = NETWORK) {}

  step(dt: number, controls: SimControls, stimulus?: Stimulus, bursts: readonly Burst[] = []): void {
    const { edges, positions, pacemaker } = this.network;
    const before = this.time;
    this.time += dt;
    const now = this.time;
    for (const edge of edges) {
      if (edge.rank >= controls.connectivity) continue;
      const arrive = this.spike[edge.src]! + edge.delay;
      if (arrive > before && arrive <= now) this.incoming[edge.dst]! += Math.trunc(edge.weight * WEIGHT_SCALE) / WEIGHT_SCALE;
    }
    const f = controls.frequency;
    for (let i = 0; i < NEURONS; i++) {
      let v = this.potential[i]! * Math.exp(-dt / TAU) + this.incoming[i]!;
      this.incoming[i] = 0;
      let kick = 0;
      if (controls.mode === 0 && pacemaker[i]! >= 0 && Math.floor(now * f + pacemaker[i]!) > Math.floor(before * f + pacemaker[i]!)) kick = KICK;
      if (controls.mode === 1 && distance(positions[i]!, PROBE) < PROBE_RADIUS && Math.floor(now * f) > Math.floor(before * f)) kick = KICK;
      for (const burst of bursts) {
        const d = distance(positions[i]!, burst.pos);
        const fireAt = burst.birth + d / BURST_SPEED;
        if (d < burstRadius(burst.strength) && fireAt > before && fireAt <= now) kick = KICK;
      }
      if (stimulus) {
        const d = distance(positions[i]!, stimulus.pos);
        if (d < STIMULUS_REACH) v += STIMULUS_DRIVE * controls.stimulation * (1 - d / STIMULUS_REACH) * dt;
      }
      v += kick;
      if (now - this.spike[i]! < REFRACTORY) v = 0;
      else if (v >= THRESHOLD) {
        this.spike[i] = now;
        this.spikes[i]!++;
        v = 0;
      }
      this.potential[i] = v;
    }
  }

  /** Neurons that fired within the last `window` seconds. */
  firing(window: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < NEURONS; i++) if (this.time - this.spike[i]! <= window) result.push(i);
    return result;
  }
}

// ---- Time ---------------------------------------------------------------------------------------------------------

/** Simulation time: advances by the frame's time (at most 200 ms, half speed when the system asks for less motion). */
export class SimClock {
  time = 0;
  prev = 0;
  dt = 0;
  /** How much light is left of the previous frame's, for frame-rate independent trails. */
  decay = 0.86;

  advance(deltaSeconds: number, reduced: boolean): void {
    const capped = Math.min(deltaSeconds, 0.2);
    this.dt = capped * (reduced ? 0.5 : 1);
    this.prev = this.time;
    this.time += this.dt;
    this.decay = Math.pow(0.86, Math.min(capped, 0.05) * 60);
  }
}


// ---- Camera -------------------------------------------------------------------------------------------------------

export interface CameraState {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
}

/** A lateral three-quarter view: the brain seen from the right and a little from the front, facing left. */
export const HOME_CAMERA: CameraState = { yaw: 1.05, pitch: 0.2, distance: 2.7 };
const PITCH_LIMIT = [-1.3, 1.4] as const;
const DISTANCE_LIMIT = [1.5, 7] as const;

export interface CameraBasis {
  readonly pos: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

export function cameraBasis({ yaw, pitch, distance: d }: CameraState): CameraBasis {
  const pos: Vec3 = [d * Math.cos(pitch) * Math.sin(yaw), d * Math.sin(pitch), d * Math.cos(pitch) * Math.cos(yaw)];
  const forward = normalize(scale(pos, -1));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { pos, right, up, forward };
}

/** The ray through a point of the canvas: `x` and `y` run from -1 to 1 (right and up), `aspect` is width over height. */
export function pointerRay(camera: CameraState, x: number, y: number, aspect: number): { origin: Vec3; direction: Vec3 } {
  const { pos, right, up, forward } = cameraBasis(camera);
  const f = focalFor(aspect);
  return { origin: pos, direction: normalize(add(add(forward, scale(right, (x * aspect) / f)), scale(up, y / f))) };
}

// ---- The pointer --------------------------------------------------------------------------------------------------

export interface NeuralState {
  readonly camera: CameraState;
  /** Camera angular velocity (yaw, pitch) that carries on after a drag is released. */
  readonly spin: readonly [number, number];
  /** What a pressed pointer is doing: turning the camera, or stimulating the brain under it. */
  readonly mode: 'idle' | 'orbit' | 'stimulate';
  /** The neuron nearest the pointer, the selected one (or -1), and the neuron nearest where the press began. */
  readonly hovered: number;
  readonly selected: number;
  readonly pressed: number;
  readonly moved: boolean;
  /** Where the stimulus is applied while it is on, and the latest clicks (waves of firing). */
  readonly stimulus: { readonly pos: Vec3; readonly active: boolean };
  readonly bursts: readonly Burst[];
  readonly lastBurst: Vec3 | undefined;
  readonly touched: number;
  readonly used: boolean;
}

export const initialState = (): NeuralState => ({
  camera: HOME_CAMERA,
  spin: [0, 0],
  mode: 'idle',
  hovered: -1,
  selected: -1,
  pressed: -1,
  moved: false,
  stimulus: { pos: [0, 0, 0], active: false },
  bursts: [],
  lastBurst: undefined,
  touched: -10,
  used: false,
});

export interface PointerInput {
  readonly x: number;
  readonly y: number;
  readonly aspect: number;
  readonly now: number;
  /** The simulation's clock, and the stimulation control: a click's wave starts on that clock with that strength. */
  readonly sim: number;
  readonly strength: number;
  /** Movement since the last event, as a fraction of the canvas height (positive right and down). */
  readonly dx: number;
  readonly dy: number;
}

const HOVER_RADIUS = 0.1;
const SELECT_RADIUS = 0.2;
/** A press-and-drag starts a new wave every time it has travelled this far over the brain. */
const BURST_SPACING = 0.18;

function withBurst(state: NeuralState, pos: Vec3, input: PointerInput): Pick<NeuralState, 'bursts' | 'lastBurst'> {
  // The wave starts just after the frame that has been drawn, so no neuron's moment falls in a frame already gone.
  const burst: Burst = { pos, birth: input.sim + 0.001, strength: input.strength };
  return { bursts: [...state.bursts, burst].slice(-MAX_BURSTS), lastBurst: pos };
}

export function pointerDown(state: NeuralState, input: PointerInput): NeuralState {
  const hit = hitBrain(pointerRay(state.camera, input.x, input.y, input.aspect));
  const base = { ...state, touched: input.now, used: true, spin: [0, 0] as const, moved: false };
  // Pressing the brain fires it on the spot; pressing the empty space takes hold of the camera.
  if (!hit) return { ...base, mode: 'orbit', hovered: -1, pressed: -1 };
  return {
    ...base,
    ...withBurst(state, hit, input),
    mode: 'stimulate',
    pressed: nearestNeuron(hit, SELECT_RADIUS),
    hovered: nearestNeuron(hit, HOVER_RADIUS),
    stimulus: { pos: hit, active: true },
  };
}

export function pointerMove(state: NeuralState, input: PointerInput): NeuralState {
  const travelled = Math.hypot(input.dx, input.dy);
  if (state.mode === 'orbit') {
    const camera = {
      ...state.camera,
      yaw: state.camera.yaw - input.dx * 3.2,
      pitch: clamp(state.camera.pitch + input.dy * 3.2, PITCH_LIMIT[0], PITCH_LIMIT[1]),
    };
    const dt = 0.016;
    const spin: readonly [number, number] = [clamp(state.spin[0] * 0.5 + ((-input.dx * 3.2) / dt) * 0.5, -4, 4), clamp(state.spin[1] * 0.5 + ((input.dy * 3.2) / dt) * 0.5, -4, 4)];
    return { ...state, camera, spin, moved: state.moved || travelled > 0.004, touched: input.now };
  }
  const hit = hitBrain(pointerRay(state.camera, input.x, input.y, input.aspect));
  if (state.mode === 'stimulate') {
    // Dragging over the brain carries the stimulus along, with a new wave every so often.
    if (!hit) return { ...state, hovered: -1, moved: state.moved || travelled > 0.004, touched: input.now };
    const burst = !state.lastBurst || distance(hit, state.lastBurst) > BURST_SPACING ? withBurst(state, hit, input) : {};
    return { ...state, ...burst, hovered: nearestNeuron(hit, HOVER_RADIUS), stimulus: { pos: hit, active: true }, moved: state.moved || travelled > 0.004, touched: input.now };
  }
  const hovered = hit ? nearestNeuron(hit, HOVER_RADIUS) : -1;
  return hovered === state.hovered ? state : { ...state, hovered, touched: input.now };
}

/** The pointer was released or the gesture was cancelled: a press that did not move is a click and selects. */
export function pointerUp(state: NeuralState, now: number): NeuralState {
  let selected = state.selected;
  if (!state.moved) {
    if (state.mode === 'stimulate') selected = state.pressed;
    else if (state.mode === 'orbit') selected = -1;
  }
  return { ...state, mode: 'idle', selected, pressed: -1, stimulus: { ...state.stimulus, active: false }, lastBurst: undefined, touched: now };
}

/** The pointer left the canvas without being pressed. */
export function pointerLeave(state: NeuralState): NeuralState {
  return state.mode === 'idle' && state.hovered !== -1 ? { ...state, hovered: -1 } : state;
}

export function wheel(state: NeuralState, deltaY: number, now: number): NeuralState {
  const distance = clamp(state.camera.distance * Math.exp(deltaY * 0.0012), DISTANCE_LIMIT[0], DISTANCE_LIMIT[1]);
  return { ...state, camera: { ...state.camera, distance }, touched: now, used: true };
}

/** Moves things that have their own motion: camera inertia and the idle drift. */
export function advance(state: NeuralState, deltaSeconds: number, now: number, reducedMotion: boolean): NeuralState {
  let { camera, spin } = state;
  let changed = false;
  if (state.mode !== 'orbit') {
    if (spin[0] !== 0 || spin[1] !== 0) {
      camera = { ...camera, yaw: camera.yaw + spin[0] * deltaSeconds, pitch: clamp(camera.pitch + spin[1] * deltaSeconds, PITCH_LIMIT[0], PITCH_LIMIT[1]) };
      const damping = Math.exp(-deltaSeconds * 2.8);
      spin = Math.hypot(spin[0], spin[1]) < 0.01 ? [0, 0] : [spin[0] * damping, spin[1] * damping];
      changed = true;
    }
    // Left alone, the camera drifts slowly around the brain, so it is never a still image.
    const idle = clamp((now - state.touched - 2) / 2, 0, 1);
    if (idle > 0 && !reducedMotion) {
      camera = { ...camera, yaw: camera.yaw + 0.07 * idle * deltaSeconds };
      changed = true;
    }
  }
  return changed ? { ...state, camera, spin } : state;
}

/** Back to the starting view, with nothing selected (the controls and the neurons are reset by the example). */
export const reset = (): NeuralState => ({ ...initialState(), used: true });
