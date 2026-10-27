// The application logic of THE CORE: the camera, the pointer, and the disturbances the pointer makes in the plasma.
// Plain TypeScript with no Angular and no GPU: both implementations of the example drive this same code, and the
// numbers it produces (camera basis, disturbance events) are what the shaders read.

/** The reactor: a torus around the vertical axis. Lengths are in scene units. */
export const MAJOR = 1;
export const MINOR = 0.36;

/** Particles simulated on the GPU: the plasma itself, then dust that gives the dark some depth. */
export const PLASMA_PARTICLES = 40960;
export const DUST_PARTICLES = 6144;
export const PARTICLES = PLASMA_PARTICLES + DUST_PARTICLES;

/** Magnetic field lines (each winds twice around the torus) and the rigid structure around the plasma. */
export const FIELD_LINES = 72;
export const LINE_SAMPLES = 480;
export const LINE_TURNS = 2;
export const COILS = 18;
export const VESSEL_RINGS = 40;
export const VESSEL_LINES = 8;
export const STRANDS = COILS + VESSEL_RINGS + VESSEL_LINES;
export const STRAND_SAMPLES = 512;

/** Everything is splatted into a grid of fixed size, whatever the size of the canvas: the cost does not grow with the screen. */
export const GRID_TEXELS_PER_UNIT = 360;
export const GRID_W = 1584;
export const GRID_H = 720;
/** Half the width of the grid in screen units (the screen is 2 units tall): the widest canvas it can fill is 4.4:1. */
export const GRID_HALF_WIDTH = GRID_W / (2 * GRID_TEXELS_PER_UNIT);

/**
 * The canvas never has more than this many pixels per CSS pixel. The light grid above is the resolution of the picture, so
 * a retina screen would only make the last pass (bloom and tone mapping) several times more expensive.
 */
export const MAX_PIXEL_RATIO = 1;

export const MAX_EVENTS = 12;
/** 1 / tan(half of the vertical field of view). */
export const FOCAL = 1.9;

/** A narrow canvas (a phone held upright) widens the field of view instead of cutting the reactor off. */
export const focalFor = (aspect: number): number => Math.min(FOCAL, 2.05 * aspect);

export type Vec3 = readonly [number, number, number];

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
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- Parameters ---------------------------------------------------------------------------------------------

export const DEFAULTS = { confinement: 0.65, energy: 0.6, instability: 0.4 } as const;

// ---- Camera -------------------------------------------------------------------------------------------------

export interface CameraState {
  /** Around the vertical axis, and above or below the ring, in radians; and the distance to the centre. */
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
}

export const HOME_CAMERA: CameraState = { yaw: 0.45, pitch: 0.46, distance: 3.9 };
const PITCH_LIMIT = [-1.2, 1.35] as const;
const DISTANCE_LIMIT = [2.2, 9] as const;

export interface CameraBasis {
  readonly pos: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

export function cameraBasis({ yaw, pitch, distance }: CameraState): CameraBasis {
  const pos: Vec3 = [distance * Math.cos(pitch) * Math.sin(yaw), distance * Math.sin(pitch), distance * Math.cos(pitch) * Math.cos(yaw)];
  const forward = normalize(scale(pos, -1));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { pos, right, up, forward };
}

/** The ray through a point of the canvas: `x` and `y` run from -1 to 1 (right and up), `aspect` is width over height. */
export function pointerRay(camera: CameraState, x: number, y: number, aspect: number): { origin: Vec3; direction: Vec3 } {
  const { pos, right, up, forward } = cameraBasis(camera);
  const direction = normalize(add(add(forward, scale(right, (x * aspect) / focalFor(aspect))), scale(up, y / focalFor(aspect))));
  return { origin: pos, direction };
}

/** Distance from a point to the surface of a torus of the reactor's size, with a tube `grow` times as thick. */
export function torusDistance(p: Vec3, grow = 1): number {
  return Math.hypot(Math.hypot(p[0], p[2]) - MAJOR, p[1]) - MINOR * grow;
}

/** Where the ray meets the plasma (marched with the distance to a slightly fattened torus), if it does. */
export function hitPlasma(ray: { origin: Vec3; direction: Vec3 }): Vec3 | undefined {
  let t = 0;
  for (let i = 0; i < 80; i++) {
    const p = add(ray.origin, scale(ray.direction, t));
    const distance = torusDistance(p, 1.3);
    if (distance < 0.004) return p;
    t += distance * 0.9;
    if (t > 20) return undefined;
  }
  return undefined;
}

// ---- Disturbances -------------------------------------------------------------------------------------------

/** A push in the plasma: where it started, which way the pointer was moving, when, and how hard. */
export interface CoreEvent {
  readonly pos: Vec3;
  readonly dir: Vec3;
  readonly birth: number;
  readonly strength: number;
}

/** The sustained disturbance under a pressed pointer: a swirl around `axis` that follows the pointer. */
export interface Vortex {
  readonly pos: Vec3;
  readonly axis: Vec3;
  readonly strength: number;
  readonly held: boolean;
}

export interface CoreState {
  readonly camera: CameraState;
  /** Camera angular velocity (yaw, pitch) that carries on after a drag is released. */
  readonly spin: readonly [number, number];
  readonly events: readonly CoreEvent[];
  readonly vortex: Vortex;
  /** What the pressed pointer is doing: turning the camera, or steering the plasma. */
  readonly mode: 'idle' | 'orbit' | 'plasma';
  /** Is the pointer over the plasma? (for the cursor) */
  readonly over: boolean;
  readonly last: { readonly hit: Vec3 | undefined; readonly time: number };
  /** When the user last did anything; the camera drifts on its own after a while. */
  readonly touched: number;
  /** Has the user interacted at all? (the hints go away) */
  readonly used: boolean;
}

export const initialState = (): CoreState => ({
  camera: HOME_CAMERA,
  spin: [0, 0],
  events: [],
  vortex: { pos: [0, 0, 0], axis: [0, 0, 1], strength: 0, held: false },
  mode: 'idle',
  over: false,
  last: { hit: undefined, time: 0 },
  touched: -10,
  used: false,
});

export interface PointerInput {
  /** Position on the canvas, -1..1 (right and up). */
  readonly x: number;
  readonly y: number;
  readonly aspect: number;
  /** Seconds, on the clock of the frame loop. */
  readonly now: number;
  /** Movement since the last event, as a fraction of the canvas height (positive right and down). */
  readonly dx: number;
  readonly dy: number;
}

const RIPPLE_INTERVAL = 0.045;
const EVENT_LIFETIME = 9;

function ripple(state: CoreState, hit: Vec3, input: PointerInput): CoreState {
  const { last } = state;
  const dt = Math.max(0.008, input.now - last.time);
  let events = state.events;
  if (last.hit) {
    const motion = sub(hit, last.hit);
    const speed = length(motion) / dt;
    const newest = events[events.length - 1];
    // Faster movement makes a stronger disturbance, within limits; a pointer at rest makes none.
    if (speed > 0.12 && (!newest || input.now - newest.birth >= RIPPLE_INTERVAL)) {
      const strength = clamp(0.2 + speed * 0.5, 0, 1.5);
      events = [...events, { pos: hit, dir: normalize(motion), birth: input.now, strength }].slice(-MAX_EVENTS);
    }
  }
  return { ...state, events, last: { hit, time: input.now } };
}

export function pointerDown(state: CoreState, input: PointerInput): CoreState {
  const camera = cameraBasis(state.camera);
  const hit = hitPlasma(pointerRay(state.camera, input.x, input.y, input.aspect));
  const base = { ...state, touched: input.now, used: true, spin: [0, 0] as const, last: { hit, time: input.now } };
  if (!hit) return { ...base, mode: 'orbit', over: false };
  return {
    ...base,
    mode: 'plasma',
    over: true,
    vortex: { pos: hit, axis: camera.forward, strength: state.vortex.strength, held: true },
    events: [...state.events, { pos: hit, dir: [0, 0, 0] as Vec3, birth: input.now, strength: 0.9 }].slice(-MAX_EVENTS),
  };
}

export function pointerMove(state: CoreState, input: PointerInput): CoreState {
  const dt = Math.max(0.008, input.now - state.last.time);
  if (state.mode === 'orbit') {
    // Dragging the empty scene turns the camera; the turn carries on a little after release.
    const yawStep = -input.dx * 3.2;
    const pitchStep = input.dy * 3.2;
    const camera = {
      ...state.camera,
      yaw: state.camera.yaw + yawStep,
      pitch: clamp(state.camera.pitch + pitchStep, PITCH_LIMIT[0], PITCH_LIMIT[1]),
    };
    const spin: readonly [number, number] = [
      state.spin[0] * 0.5 + (yawStep / dt) * 0.5,
      state.spin[1] * 0.5 + (pitchStep / dt) * 0.5,
    ];
    return { ...state, camera, spin: [clamp(spin[0], -4, 4), clamp(spin[1], -4, 4)], touched: input.now, last: { hit: undefined, time: input.now } };
  }
  const hit = hitPlasma(pointerRay(state.camera, input.x, input.y, input.aspect));
  if (!hit) return { ...state, over: false, last: { hit: undefined, time: input.now } };
  let next = ripple({ ...state, over: true, touched: input.now, used: true }, hit, input);
  if (state.mode === 'plasma') {
    // The pressed pointer steers the vortex.
    next = { ...next, vortex: { ...state.vortex, pos: hit, held: true } };
  }
  return next;
}

/** The pointer was released or the gesture was cancelled. */
export function pointerUp(state: CoreState, now: number): CoreState {
  return {
    ...state,
    mode: 'idle',
    vortex: { ...state.vortex, held: false },
    touched: now,
    last: { hit: undefined, time: now },
  };
}

/** The pointer left the canvas without being pressed. */
export function pointerLeave(state: CoreState, now: number): CoreState {
  return state.mode === 'idle' ? { ...state, over: false, last: { hit: undefined, time: now } } : state;
}

export function wheel(state: CoreState, deltaY: number, now: number): CoreState {
  const distance = clamp(state.camera.distance * Math.exp(deltaY * 0.0012), DISTANCE_LIMIT[0], DISTANCE_LIMIT[1]);
  return { ...state, camera: { ...state.camera, distance }, touched: now, used: true };
}

/** Moves things that have their own motion: camera inertia, the idle drift, the vortex fading, old events leaving. */
export function advance(state: CoreState, deltaSeconds: number, now: number, reducedMotion: boolean): CoreState {
  let { camera, spin, vortex, events } = state;
  let changed = false;

  if (state.mode !== 'orbit') {
    if (spin[0] !== 0 || spin[1] !== 0) {
      camera = { ...camera, yaw: camera.yaw + spin[0] * deltaSeconds, pitch: clamp(camera.pitch + spin[1] * deltaSeconds, PITCH_LIMIT[0], PITCH_LIMIT[1]) };
      const damping = Math.exp(-deltaSeconds * 2.8);
      spin = Math.hypot(spin[0], spin[1]) < 0.01 ? [0, 0] : [spin[0] * damping, spin[1] * damping];
      changed = true;
    }
    // Left alone, the camera drifts slowly, so the reactor is never a still image.
    const idle = clamp((now - state.touched - 3) / 3, 0, 1);
    if (idle > 0 && !reducedMotion) {
      camera = { ...camera, yaw: camera.yaw + 0.05 * idle * deltaSeconds };
      changed = true;
    }
  }

  if (vortex.held && vortex.strength < 1) {
    vortex = { ...vortex, strength: Math.min(1, vortex.strength + deltaSeconds * 2.5) };
    changed = true;
  } else if (!vortex.held && vortex.strength > 0) {
    const strength = vortex.strength * Math.exp(-deltaSeconds / 0.9);
    vortex = { ...vortex, strength: strength < 0.01 ? 0 : strength };
    changed = true;
  }

  if (events.length > 0 && now - events[0]!.birth > EVENT_LIFETIME) {
    events = events.filter((event) => now - event.birth <= EVENT_LIFETIME);
    changed = true;
  }
  return changed ? { ...state, camera, spin, vortex, events } : state;
}

/** Back to the starting view and a calm plasma (the three parameters are reset by the example). */
export const reset = (): CoreState => ({ ...initialState(), used: true });


/** The number of seconds of fade a frame covers, for frame-rate independent decay of the glow trails. */
export const trailDecay = (deltaSeconds: number): number => Math.pow(0.86, Math.min(deltaSeconds, 0.05) * 60);
