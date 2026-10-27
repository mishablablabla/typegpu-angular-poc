import { describe, expect, it } from 'vitest';
import {
  HOME_CAMERA,
  MAX_EVENTS,
  MINOR,
  advance,
  cameraBasis,
  focalFor,
  hitPlasma,
  initialState,
  pointerDown,
  pointerLeave,
  pointerMove,
  pointerRay,
  pointerUp,
  reset,
  torusDistance,
  wheel,
  type PointerInput,
} from './core.model';

const at = (x: number, y: number, now: number, dx = 0, dy = 0): PointerInput => ({ x, y, aspect: 1.5, now, dx, dy });

/** The canvas position (-1..1) where the centre of the plasma ring's near side appears, found by searching for a hit. */
function plasmaPoint(): { x: number; y: number } {
  for (let y = -0.9; y <= 0.9; y += 0.02) {
    for (let x = -0.9; x <= 0.9; x += 0.02) {
      if (hitPlasma(pointerRay(HOME_CAMERA, x, y, 1.5))) return { x, y };
    }
  }
  throw new Error('the plasma is not on screen');
}

describe('the camera', () => {
  it('looks at the centre with an orthonormal basis', () => {
    const { pos, right, up, forward } = cameraBasis(HOME_CAMERA);
    expect(Math.hypot(...pos)).toBeCloseTo(HOME_CAMERA.distance);
    for (const v of [right, up, forward]) expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(0);
    expect(forward[0] * pos[0] + forward[1] * pos[1] + forward[2] * pos[2]).toBeCloseTo(-HOME_CAMERA.distance);
  });

  it('shoots the middle ray at the centre, and widens the view for narrow canvases', () => {
    const { direction, origin } = pointerRay(HOME_CAMERA, 0, 0, 1.5);
    expect(direction[0] * origin[0] + direction[1] * origin[1] + direction[2] * origin[2]).toBeCloseTo(-HOME_CAMERA.distance);
    expect(focalFor(1.5)).toBeGreaterThan(focalFor(0.5));
    expect(focalFor(10)).toBe(focalFor(2));
  });

  it('hits the torus, not its hole and not the empty space', () => {
    expect(hitPlasma(pointerRay(HOME_CAMERA, 0.95, 0.95, 1.5))).toBeUndefined();
    const { x, y } = plasmaPoint();
    const hit = hitPlasma(pointerRay(HOME_CAMERA, x, y, 1.5))!;
    expect(torusDistance(hit, 1.3)).toBeLessThan(0.01);
    expect(torusDistance(hit)).toBeLessThan(MINOR * 0.35);
  });
});

describe('the pointer', () => {
  it('turns the camera when dragging empty space, and lets it coast after release', () => {
    let state = pointerDown(initialState(), at(-0.95, 0.95, 1));
    expect(state.mode).toBe('orbit');
    state = pointerMove(state, at(-0.9, 0.9, 1.05, 0.2, 0));
    expect(state.camera.yaw).toBeLessThan(HOME_CAMERA.yaw);
    expect(state.events).toHaveLength(0);
    state = pointerUp(state, 1.1);
    expect(state.mode).toBe('idle');
    const coasting = advance(state, 0.1, 1.2, false);
    expect(coasting.camera.yaw).not.toBe(state.camera.yaw);
    // The coasting dies away.
    let later = coasting;
    for (let t = 1.3; t < 6; t += 0.1) later = advance(later, 0.1, t, false);
    expect(later.spin).toEqual([0, 0]);
  });

  it('keeps the pitch and the distance within limits', () => {
    let state = pointerDown(initialState(), at(-0.95, 0.95, 1));
    for (let i = 0; i < 100; i++) state = pointerMove(state, at(-0.95, 0.95, 1 + i * 0.01, 0, -5));
    expect(state.camera.pitch).toBeGreaterThanOrEqual(-1.2);
    expect(state.camera.pitch).toBeLessThanOrEqual(1.35);
    for (let i = 0; i < 50; i++) state = wheel(state, -500, 3);
    expect(state.camera.distance).toBe(2.2);
    for (let i = 0; i < 50; i++) state = wheel(state, 500, 3);
    expect(state.camera.distance).toBe(9);
  });

  it('disturbs the plasma when moving over it, harder when faster, and not when resting', () => {
    const p = plasmaPoint();
    const move = (speed: number) => {
      let state = pointerMove(initialState(), at(p.x, p.y, 1));
      state = pointerMove(state, at(p.x + 0.03 * speed, p.y, 1 + 0.1));
      return state;
    };
    const slow = move(0.4);
    const fast = move(2.5);
    expect(fast.events.length).toBeGreaterThan(0);
    expect(fast.events.at(-1)!.strength).toBeGreaterThan(slow.events.at(-1)?.strength ?? 0);
    expect(fast.events.at(-1)!.strength).toBeLessThanOrEqual(1.5);
    // The same place twice: no movement, no push.
    const resting = pointerMove(pointerMove(initialState(), at(p.x, p.y, 1)), at(p.x, p.y, 1.2));
    expect(resting.events).toHaveLength(0);
  });

  it('keeps only the most recent events', () => {
    const p = plasmaPoint();
    let state = pointerMove(initialState(), at(p.x, p.y, 1));
    for (let i = 1; i < 60; i++) state = pointerMove(state, at(p.x + (i % 2) * 0.1, p.y, 1 + i * 0.06));
    expect(state.events.length).toBeLessThanOrEqual(MAX_EVENTS);
  });

  it('holds a vortex under a pressed pointer on the plasma, steers it, and lets it fade after release', () => {
    const p = plasmaPoint();
    let state = pointerDown(initialState(), at(p.x, p.y, 1));
    expect(state.mode).toBe('plasma');
    expect(state.vortex.held).toBe(true);
    for (let t = 1; t < 2; t += 0.1) state = advance(state, 0.1, t, false);
    expect(state.vortex.strength).toBe(1);
    const before = state.vortex.pos;
    state = pointerMove(state, at(p.x + 0.12, p.y, 2.1, 0.1, 0));
    expect(state.vortex.pos).not.toEqual(before);
    state = pointerUp(state, 2.2);
    expect(state.vortex.held).toBe(false);
    for (let t = 2.3; t < 8; t += 0.1) state = advance(state, 0.1, t, false);
    expect(state.vortex.strength).toBe(0);
  });

  it('handles leaving the canvas and cancellation without leaving stale state behind', () => {
    const p = plasmaPoint();
    let state = pointerMove(initialState(), at(p.x, p.y, 1));
    expect(state.over).toBe(true);
    state = pointerLeave(state, 1.1);
    expect(state.over).toBe(false);
    expect(state.last.hit).toBeUndefined();
    // A cancelled press releases the vortex and the camera.
    state = pointerUp(pointerDown(initialState(), at(p.x, p.y, 2)), 2.1);
    expect(state.mode).toBe('idle');
    expect(state.vortex.held).toBe(false);
  });
});

describe('time', () => {
  it('drifts the camera only after a while alone, and not under reduced motion', () => {
    const state = { ...initialState(), touched: 0 };
    expect(advance(state, 0.1, 0, false).camera.yaw).toBe(state.camera.yaw);
    expect(advance(state, 0.1, 20, false).camera.yaw).toBeGreaterThan(state.camera.yaw);
    expect(advance(state, 0.1, 20, true)).toBe(state);
  });

  it('lets old events go', () => {
    const p = plasmaPoint();
    let state = pointerMove(pointerMove(initialState(), at(p.x, p.y, 1)), at(p.x + 0.2, p.y, 1.05));
    expect(state.events.length).toBeGreaterThan(0);
    state = advance(state, 0.1, 30, false);
    expect(state.events).toHaveLength(0);
  });

  it('resets to the starting view', () => {
    const moved = wheel(initialState(), -300, 1);
    expect(moved.camera).not.toEqual(HOME_CAMERA);
    expect(reset().camera).toEqual(HOME_CAMERA);
    expect(reset().events).toHaveLength(0);
  });
});
