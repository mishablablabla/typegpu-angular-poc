// The shader of RISK FIELD, shared by both implementations (see life.gpu.ts for how `*.gpu.ts` modules work).
// The surface is a heightfield ray marched in one fragment shader: every pixel casts a ray through the box, walks it until it
// goes under the surface, and shades the hit. The height is the model's value-at-risk, computed by the same formula as
// `risk` in risk-field.model.ts, evaluated per ray step: there is no mesh to update when a control moves.
import tgpu, { d, std } from 'typegpu';
import type { TgpuUniform } from 'typegpu';
import { BOX_TOP, HEIGHT, HEIGHT_SCALE, WMAX, Z99 } from './risk-field.model';

/** What the surface is made of: the controls and the scenario, eased (see `effective` in the model). */
export const Surface = d.struct({ s1: d.f32, s2: d.f32, rho: d.f32, tail: d.f32, tailLev: d.f32, drift: d.f32 });

/** The camera and the canvas. */
export const View = d.struct({
  pos: d.vec3f,
  focal: d.f32,
  right: d.vec3f,
  aspect: d.f32,
  up: d.vec3f,
  pad: d.f32,
  forward: d.vec3f,
  pad2: d.f32,
});

/** The allocation being inspected, and the one under the pointer (in weights). */
export const Marks = d.struct({ selected: d.vec2f, hover: d.vec2f, selectedOn: d.f32, hoverOn: d.f32 });

type SurfaceBinding = TgpuUniform<typeof Surface>;
type ViewBinding = TgpuUniform<typeof View>;
type MarksBinding = TgpuUniform<typeof Marks>;

const UP = d.vec3f(0, 1, 0);
const AMBER = d.vec3f(1, 0.72, 0.28);
const ICE = d.vec3f(0.55, 0.9, 1);

/** The value-at-risk of an allocation, in percent. */
const riskOf = (surface: SurfaceBinding) => (a: number, b: number) => {
  'use gpu';
  const s = surface.$;
  const gross = std.abs(a) + std.abs(b);
  const va = a * s.s1;
  const vb = b * s.s2;
  const sd = std.sqrt(std.max(va * va + vb * vb + 2 * s.rho * va * vb, 0));
  const multiplier = s.tail * (1 + s.tailLev * std.max(0, gross - 0.5));
  return Z99 * sd * multiplier + s.drift * gross;
};

/** From deep blue through cyan to amber and a restrained red, by height (0..1). */
const ramp = (n: number) => {
  'use gpu';
  let c = std.mix(d.vec3f(0.015, 0.04, 0.16), d.vec3f(0.05, 0.3, 0.62), std.smoothstep(0, 0.25, n));
  c = std.mix(c, d.vec3f(0.12, 0.78, 0.95), std.smoothstep(0.2, 0.5, n));
  c = std.mix(c, d.vec3f(0.96, 0.78, 0.4), std.smoothstep(0.45, 0.72, n));
  return std.mix(c, d.vec3f(0.98, 0.3, 0.22), std.smoothstep(0.68, 0.95, n));
};

/** A soft glow around a point, as seen along the ray, only if it is in front of `limit`. */
const pointGlow = (ro: d.v3f, rd: d.v3f, point: d.v3f, radius: number, limit: number) => {
  'use gpu';
  const t = std.dot(point.sub(ro), rd);
  const miss = std.length(ro.add(rd.mul(t)).sub(point));
  return std.select(d.f32(0), std.exp(-(miss * miss) / (radius * radius)), t > 0 && t < limit + 0.03);
};

/** A soft glow along the vertical line through (x, z), from the floor up to `top`. */
const stemGlow = (ro: d.v3f, rd: d.v3f, x: number, z: number, top: number, limit: number) => {
  'use gpu';
  const base = d.vec3f(x, 0, z);
  const n = std.cross(rd, UP);
  const nn = std.max(std.dot(n, n), 0.000001);
  const diff = base.sub(ro);
  const t = std.dot(std.cross(diff, UP), n) / nn;
  const s = std.dot(std.cross(diff, rd), n) / nn;
  const miss = std.abs(std.dot(diff, n)) / std.sqrt(nn);
  const inside = t > 0 && t < limit + 0.03 && s > 0 && s < top;
  return std.select(d.f32(0), std.exp(-(miss * miss) / 0.00018), inside);
};

export function riskFragment(surface: SurfaceBinding, view: ViewBinding, marks: MarksBinding, clock: TgpuUniform<d.F32>) {
  const risk = riskOf(surface);
  /** The surface height above the scene position (x, z). */
  const height = (x: number, z: number) => {
    'use gpu';
    const value = risk(x * WMAX, z * WMAX);
    return HEIGHT * (1 - std.exp(-value / HEIGHT_SCALE));
  };

  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const v = view.$;
    const time = clock.$;
    const screen = d.vec2f((input.uv.x - 0.5) * v.aspect * 2, (0.5 - input.uv.y) * 2);
    const ro = d.vec3f(v.pos);
    const rd = std.normalize(v.forward.add(v.right.mul(screen.x / v.focal)).add(v.up.mul(screen.y / v.focal)));

    // The box around the surface: where the ray enters and leaves.
    const safe = d.vec3f(
      std.select(rd.x, d.f32(0.00001), std.abs(rd.x) < 0.00001),
      std.select(rd.y, d.f32(0.00001), std.abs(rd.y) < 0.00001),
      std.select(rd.z, d.f32(0.00001), std.abs(rd.z) < 0.00001),
    );
    const inv = d.vec3f(1).div(safe);
    const lo = d.vec3f(-1, 0, -1).sub(ro).mul(inv);
    const hi = d.vec3f(1, BOX_TOP, 1).sub(ro).mul(inv);
    const near = std.min(lo, hi);
    const far = std.max(lo, hi);
    const tEnter = std.max(std.max(near.x, near.y), near.z);
    const tExit = std.min(std.min(far.x, far.y), far.z);

    // The dark: nearly black, a little blue in the middle, and a faint grid on the floor around the surface.
    const spot = std.dot(screen, screen);
    let color = d.vec3f(0.004, 0.007, 0.014).add(d.vec3f(0.01, 0.022, 0.04).mul(std.exp(-spot * 0.55)));
    const floorT = -ro.y / safe.y;
    if (floorT > 0) {
      const f = ro.add(rd.mul(floorT));
      const radius = std.length(d.vec2f(f.x, f.z));
      const gx = std.abs(std.fract(f.x * 2 + 0.5) - 0.5);
      const gz = std.abs(std.fract(f.z * 2 + 0.5) - 0.5);
      const line = 1 - std.smoothstep(0, 0.035 + radius * 0.01, std.min(gx, gz));
      const around = std.select(d.f32(1), d.f32(0), tEnter < tExit && tExit > 0);
      color = color.add(d.vec3f(0.06, 0.15, 0.26).mul(line * std.exp(-radius * 0.5) * 0.55 * around));
    }

    let hitT = d.f32(1000);
    if (tEnter < tExit && tExit > 0) {
      let t = std.max(tEnter, 0);
      let prev = t;
      let hit = false;
      for (let i = 0; i < 120; i++) {
        const p = ro.add(rd.mul(t));
        const gap = p.y - height(p.x, p.z);
        if (gap < 0.0015) {
          hit = true;
          break;
        }
        prev = t;
        t = t + std.max(gap * 0.55, 0.003);
        if (t > tExit) {
          break;
        }
      }
      if (hit) {
        // Narrow down where the ray crossed the surface.
        let a = prev;
        let b = t;
        for (let k = 0; k < 6; k++) {
          const mid = (a + b) * 0.5;
          const q = ro.add(rd.mul(mid));
          if (q.y - height(q.x, q.z) < 0) {
            b = mid;
          } else {
            a = mid;
          }
        }
        t = b;
        hitT = t;
        const p = ro.add(rd.mul(t));
        const e = 0.012;
        const hx = height(p.x + e, p.z) - height(p.x - e, p.z);
        const hz = height(p.x, p.z + e) - height(p.x, p.z - e);
        const n = std.normalize(d.vec3f(-hx / (2 * e), 1, -hz / (2 * e)));
        const level = p.y / HEIGHT;
        const entered = t - std.max(tEnter, 0) < 0.002;
        // Which weights are under this point, for the grid and the contours.
        const a0 = p.x * WMAX;
        const b0 = p.z * WMAX;
        const top = height(p.x, p.z);

        if (entered) {
          // The side of the box: the surface seen as a solid, banded by height.
          const band = std.smoothstep(0.82, 1, std.cos(p.y * 60));
          color = ramp(p.y / HEIGHT).mul(0.28 + 0.32 * band);
        } else {
          const light = std.normalize(d.vec3f(-0.4, 0.8, 0.35));
          const diffuse = std.clamp(std.dot(n, light), 0, 1);
          const half = std.normalize(light.sub(rd));
          const glint = std.pow(std.clamp(std.dot(n, half), 0, 1), 60) * 0.35;
          const rim = std.pow(1 - std.clamp(std.dot(n, rd.mul(-1)), 0, 1), 3);
          let base = ramp(top / HEIGHT).mul(0.2 + 0.85 * diffuse);
          base = base.add(d.vec3f(0.6, 0.85, 1).mul(glint + rim * 0.22));
          // Contour lines of equal risk, a little wider where the surface is flat.
          const slope = std.length(d.vec2f(n.x, n.z)) / std.max(n.y, 0.2);
          const width = 16 * 0.006 * slope + 0.02;
          const contour = 1 - std.smoothstep(width * 0.5, width, std.abs(std.fract(top * 16 + 0.5) - 0.5));
          base = base.add(d.vec3f(0.55, 0.9, 1).mul(contour * 0.22));
          // Grid lines every quarter of capital, on both axes.
          const gridA = std.abs(std.fract(a0 / 0.25 + 0.5) - 0.5);
          const gridB = std.abs(std.fract(b0 / 0.25 + 0.5) - 0.5);
          const grid = 1 - std.smoothstep(0, 0.045, std.min(gridA, gridB));
          base = base.add(d.vec3f(0.35, 0.6, 0.9).mul(grid * 0.13));
          // A slow wave leaves the safest corner and runs across the surface: motion, not data.
          const away = std.length(d.vec2f(p.x + 1, p.z + 1));
          const front = std.fract(time * 0.09) * 3.6;
          const pulse = std.exp(-std.pow((away - front) / 0.18, 2)) * (1 - front / 3.6);
          color = base.add(d.vec3f(0.3, 0.65, 0.95).mul(pulse * 0.3));
        }
        // Distance fades the far side a little: depth from intensity.
        color = color.mul(std.clamp(1.25 - (t - 2.5) * 0.12, 0.55, 1.2));
        if (level < 0) {
          color = d.vec3f(0);
        }
      }
    }

    // The marks: the allocation being inspected (amber), and the one under the pointer (ice).
    const m = marks.$;
    const sx = m.selected.x / WMAX;
    const sz = m.selected.y / WMAX;
    const sy = height(sx, sz);
    const selectedGlow = stemGlow(ro, rd, sx, sz, sy + 0.01, hitT) * 0.7 + pointGlow(ro, rd, d.vec3f(sx, sy + 0.02, sz), 0.035, hitT) * 1.4;
    color = color.add(AMBER.mul(selectedGlow * m.selectedOn));
    const hx2 = m.hover.x / WMAX;
    const hz2 = m.hover.y / WMAX;
    const hy2 = height(hx2, hz2);
    const hoverGlow = stemGlow(ro, rd, hx2, hz2, hy2 + 0.01, hitT) * 0.3 + pointGlow(ro, rd, d.vec3f(hx2, hy2 + 0.015, hz2), 0.022, hitT) * 0.8;
    color = color.add(ICE.mul(hoverGlow * m.hoverOn));

    const vignette = 1 - 0.35 * std.smoothstep(0.6, 2.6, spot);
    const mapped = d.vec3f(1).sub(std.exp(color.mul(-1.15)));
    return d.vec4f(std.pow(mapped.mul(vignette), d.vec3f(0.92)), 1);
  });
}
