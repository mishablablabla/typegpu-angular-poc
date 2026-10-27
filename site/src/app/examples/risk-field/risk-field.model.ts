// The model and the application logic of RISK FIELD. Plain TypeScript with no Angular and no GPU: both implementations of
// the example drive this same code, and the shader evaluates the same formula (see `risk`).
//
// THE MODEL (synthetic and illustrative: it does not predict real losses)
//   A portfolio holds weight `a` in asset A and weight `b` in asset B, as a fraction of its capital: positive is long,
//   negative is short, the rest is cash, and |a| + |b| above 1 is leverage. The floor of the picture is that (a, b) plane,
//   -1 to 1 on both axes: the valley that crosses it is the hedge, where a long and a short position cancel.
//   The height and the colour are a one-day 99% parametric value-at-risk, in percent of capital:
//       sdA = a * sigmaA        sdB = b * sigmaB        sd = sqrt(sdA^2 + sdB^2 + 2 * rho * sdA * sdB)
//       VaR = 2.326 * sd * tail * (1 + tailLev * max(0, |a| + |b| - 0.5)) + drift * (|a| + |b|)
//   sigmaA is the daily volatility from the Volatility control (annual % divided by sqrt(252)); asset B is 1.35 times as
//   volatile. rho is the correlation. A stress scenario changes the volatilities, the correlation, a fat-tail multiplier
//   (`tail`, growing with leverage by `tailLev`) and a small loss `drift` per unit of exposure.

/** The weights run from -WMAX to WMAX on both axes. */
export const WMAX = 1;
export const Z99 = 2.326;
export const VOL_B_RATIO = 1.35;
/** The picture: the surface is a box of 2 by 2 scene units, `HEIGHT` tall at most. */
export const HEIGHT = 0.85;
export const BOX_TOP = 0.9;
/** VaR (percent) at which the surface has risen 63% of its height. */
export const HEIGHT_SCALE = 9;
/** Canvas pixels per CSS pixel, at most: the surface is ray marched, so a retina screen would multiply its cost. */
export const MAX_PIXEL_RATIO = 1;

export const SCENARIOS = ['Baseline', 'Market shock', 'Correlation spike', 'Liquidity crunch'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const DEFAULTS = { volatility: 22, correlation: 0.3, scenario: 'Baseline' as Scenario };

/** The numbers the surface is made of: what the controls and the scenario come to. */
export interface Effective {
  /** Daily volatility of asset A and B, in percent. */
  readonly s1: number;
  readonly s2: number;
  readonly rho: number;
  readonly tail: number;
  readonly tailLev: number;
  readonly drift: number;
}

interface ScenarioRule {
  readonly volMult: number;
  readonly rho: (rho: number) => number;
  readonly tail: number;
  readonly tailLev: number;
  readonly drift: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const RULES: Record<Scenario, ScenarioRule> = {
  Baseline: { volMult: 1, rho: (r) => r, tail: 1, tailLev: 0.15, drift: 0 },
  'Market shock': { volMult: 1.8, rho: (r) => clamp(r + 0.25, -0.95, 0.95), tail: 1.12, tailLev: 0.3, drift: 0.5 },
  'Correlation spike': { volMult: 1.2, rho: (r) => Math.max(r, 0.92), tail: 1.1, tailLev: 0.2, drift: 0 },
  'Liquidity crunch': { volMult: 1.35, rho: (r) => clamp(r + 0.1, -0.95, 0.95), tail: 1.05, tailLev: 1.4, drift: 0.2 },
};

export function effective(volatility: number, correlation: number, scenario: string): Effective {
  const rule = RULES[(SCENARIOS as readonly string[]).includes(scenario) ? (scenario as Scenario) : 'Baseline'];
  const daily = (volatility / Math.sqrt(252)) * rule.volMult;
  return { s1: daily, s2: daily * VOL_B_RATIO, rho: rule.rho(clamp(correlation, -0.95, 0.95)), tail: rule.tail, tailLev: rule.tailLev, drift: rule.drift };
}

/** One-day 99% value-at-risk, in percent of capital, of the allocation (a, b). The shader computes the same. */
export function risk(a: number, b: number, e: Effective): number {
  const va = a * e.s1;
  const vb = b * e.s2;
  const sd = Math.sqrt(Math.max(0, va * va + vb * vb + 2 * e.rho * va * vb));
  const gross = Math.abs(a) + Math.abs(b);
  const multiplier = e.tail * (1 + e.tailLev * Math.max(0, gross - 0.5));
  return Z99 * sd * multiplier + e.drift * gross;
}

export const heightOf = (value: number): number => HEIGHT * (1 - Math.exp(-value / HEIGHT_SCALE));
/** The scene is the weights themselves: -1 to 1 on both horizontal axes. */
export const toWeight = (world: number): number => clamp(world, -WMAX, WMAX);
export const toWorld = (weight: number): number => weight;
/** The height of the surface above the scene position (x, z). */
export const surfaceY = (x: number, z: number, e: Effective): number => heightOf(risk(toWeight(x), toWeight(z), e));

/** Eases the surface towards its target, so a change of a control or a scenario flows instead of jumping. */
export function ease(current: Effective, target: Effective, deltaSeconds: number): Effective {
  const k = 1 - Math.exp(-deltaSeconds * 5);
  const next = {} as { -readonly [K in keyof Effective]: number };
  let moved = false;
  for (const key of Object.keys(target) as (keyof Effective)[]) {
    const gap = target[key] - current[key];
    next[key] = Math.abs(gap) < 1e-4 ? target[key] : current[key] + gap * k;
    if (next[key] !== current[key]) moved = true;
  }
  return moved ? next : current;
}

// ---- Vectors and the camera ---------------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface CameraState {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
}

export const HOME_CAMERA: CameraState = { yaw: 0.62, pitch: 0.4, distance: 3.9 };
const PITCH_LIMIT = [0.08, 1.4] as const;
const DISTANCE_LIMIT = [2.2, 8] as const;
const FOCAL = 1.8;
/** A narrow canvas widens the field of view instead of cutting the surface off. */
export const focalFor = (aspect: number): number => Math.min(FOCAL, 1.9 * aspect);

export interface CameraBasis {
  readonly pos: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

/** The camera looks at the middle of the surface. */
const TARGET: Vec3 = [0, 0.3, 0];

export function cameraBasis({ yaw, pitch, distance }: CameraState): CameraBasis {
  const offset: Vec3 = [distance * Math.cos(pitch) * Math.sin(yaw), distance * Math.sin(pitch), distance * Math.cos(pitch) * Math.cos(yaw)];
  const pos = add(TARGET, offset);
  const forward = normalize(scale(offset, -1));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { pos, right, up, forward };
}

/** The ray through a point of the canvas: `x` and `y` run from -1 to 1 (right and up), `aspect` is width over height. */
export function pointerRay(camera: CameraState, x: number, y: number, aspect: number): { origin: Vec3; direction: Vec3 } {
  const { pos, right, up, forward } = cameraBasis(camera);
  const focal = focalFor(aspect);
  return { origin: pos, direction: normalize(add(add(forward, scale(right, (x * aspect) / focal)), scale(up, y / focal))) };
}

/** Where a scene point appears on the canvas, in percent of its width and height. */
export function projectToCanvas(camera: CameraState, aspect: number, point: Vec3): { x: number; y: number } | undefined {
  const { pos, right, up, forward } = cameraBasis(camera);
  const rel: Vec3 = [point[0] - pos[0], point[1] - pos[1], point[2] - pos[2]];
  const depth = dot(rel, forward);
  if (depth < 0.1) return undefined;
  const focal = focalFor(aspect);
  const sx = (dot(rel, right) * focal) / depth;
  const sy = (dot(rel, up) * focal) / depth;
  return { x: (sx / aspect / 2 + 0.5) * 100, y: (0.5 - sy / 2) * 100 };
}

export interface Point {
  /** Weights in asset A and B, as a fraction of capital. */
  readonly a: number;
  readonly b: number;
}

/** The allocation under a point of the canvas: the ray is marched through the box until it goes under the surface. */
export function pickSurface(camera: CameraState, x: number, y: number, aspect: number, e: Effective): Point | undefined {
  const { origin, direction } = pointerRay(camera, x, y, aspect);
  const lo: Vec3 = [-1, 0, -1];
  const hi: Vec3 = [1, BOX_TOP, 1];
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = origin[i]!;
    const d = direction[i]!;
    if (Math.abs(d) < 1e-9) {
      if (o < lo[i]! || o > hi[i]!) return undefined;
    } else {
      const p = (lo[i]! - o) / d;
      const q = (hi[i]! - o) / d;
      t0 = Math.max(t0, Math.min(p, q));
      t1 = Math.min(t1, Math.max(p, q));
    }
  }
  if (t0 > t1) return undefined;
  const under = (t: number) => {
    const p = add(origin, scale(direction, t));
    return p[1] - surfaceY(p[0], p[2], e);
  };
  let before = t0;
  for (let t = t0; t <= t1; t += 0.01) {
    if (under(t) <= 0) {
      let lowT = before;
      let highT = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lowT + highT) / 2;
        if (under(mid) <= 0) highT = mid;
        else lowT = mid;
      }
      const p = add(origin, scale(direction, highT));
      return { a: toWeight(p[0]), b: toWeight(p[2]) };
    }
    before = t;
  }
  return undefined;
}

// ---- Pointer state -------------------------------------------------------------------------------------------

export interface RiskState {
  readonly camera: CameraState;
  /** Camera angular velocity (yaw, pitch) that carries on after a drag is released. */
  readonly spin: readonly [number, number];
  /** The allocation being inspected. */
  readonly selected: Point;
  /** The allocation under the pointer. */
  readonly hover: Point | undefined;
  /** A pressed pointer: how far it moved (a short press is a click and selects, a long one turned the camera). */
  readonly press: { readonly moved: number } | undefined;
  readonly touched: number;
  readonly used: boolean;
}

export const DEFAULT_SELECTION: Point = { a: 0.7, b: -0.35 };

export const initialState = (): RiskState => ({
  camera: HOME_CAMERA,
  spin: [0, 0],
  selected: DEFAULT_SELECTION,
  hover: undefined,
  press: undefined,
  touched: -10,
  used: false,
});

export interface PointerInput {
  /** Position on the canvas, -1..1 (right and up). */
  readonly x: number;
  readonly y: number;
  readonly aspect: number;
  readonly now: number;
  /** Movement since the last event, as a fraction of the canvas height (positive right and down). */
  readonly dx: number;
  readonly dy: number;
}

const CLICK_DISTANCE = 0.02;

export function pointerDown(state: RiskState, input: PointerInput): RiskState {
  return { ...state, press: { moved: 0 }, spin: [0, 0], touched: input.now, used: true };
}

export function pointerMove(state: RiskState, input: PointerInput, e: Effective): RiskState {
  if (state.press) {
    const dt = 1 / 60;
    const yawStep = -input.dx * 3.2;
    const pitchStep = input.dy * 3.2;
    const camera = {
      ...state.camera,
      yaw: state.camera.yaw + yawStep,
      pitch: Math.min(PITCH_LIMIT[1], Math.max(PITCH_LIMIT[0], state.camera.pitch + pitchStep)),
    };
    const spin: readonly [number, number] = [yawStep / dt, pitchStep / dt];
    return {
      ...state,
      camera,
      spin: [clamp(spin[0] * 0.5 + state.spin[0] * 0.5, -4, 4), clamp(spin[1] * 0.5 + state.spin[1] * 0.5, -4, 4)],
      hover: undefined,
      press: { moved: state.press.moved + Math.hypot(input.dx, input.dy) },
      touched: input.now,
    };
  }
  return { ...state, hover: pickSurface(state.camera, input.x, input.y, input.aspect, e), touched: input.now, used: true };
}

/** The pointer was released (or the gesture cancelled: `cancelled`). A short press selects the allocation under it. */
export function pointerUp(state: RiskState, input: PointerInput, e: Effective, cancelled = false): RiskState {
  const click = state.press && state.press.moved < CLICK_DISTANCE && !cancelled;
  const picked = click ? pickSurface(state.camera, input.x, input.y, input.aspect, e) : undefined;
  return { ...state, press: undefined, selected: picked ?? state.selected, touched: input.now };
}

export const pointerLeave = (state: RiskState): RiskState => (state.hover ? { ...state, hover: undefined } : state);

export function wheel(state: RiskState, deltaY: number, now: number): RiskState {
  const distance = clamp(state.camera.distance * Math.exp(deltaY * 0.0012), DISTANCE_LIMIT[0], DISTANCE_LIMIT[1]);
  return { ...state, camera: { ...state.camera, distance }, touched: now, used: true };
}

/** Camera inertia and the idle drift: left alone, the view turns slowly, so the surface is never a still image. */
export function advance(state: RiskState, deltaSeconds: number, now: number, reducedMotion: boolean): RiskState {
  let { camera, spin } = state;
  let changed = false;
  if (!state.press) {
    if (spin[0] !== 0 || spin[1] !== 0) {
      camera = {
        ...camera,
        yaw: camera.yaw + spin[0] * deltaSeconds,
        pitch: clamp(camera.pitch + spin[1] * deltaSeconds, PITCH_LIMIT[0], PITCH_LIMIT[1]),
      };
      const damping = Math.exp(-deltaSeconds * 3);
      spin = Math.hypot(spin[0], spin[1]) < 0.01 ? [0, 0] : [spin[0] * damping, spin[1] * damping];
      changed = true;
    }
    const idle = clamp((now - state.touched - 4) / 3, 0, 1);
    if (idle > 0 && !reducedMotion) {
      camera = { ...camera, yaw: camera.yaw + 0.04 * idle * deltaSeconds };
      changed = true;
    }
  }
  return changed ? { ...state, camera, spin } : state;
}

export const reset = (): RiskState => ({ ...initialState(), used: true });
