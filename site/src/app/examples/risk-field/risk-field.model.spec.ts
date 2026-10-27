import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  HOME_CAMERA,
  SCENARIOS,
  WMAX,
  advance,
  ease,
  effective,
  initialState,
  pickSurface,
  pointerDown,
  pointerMove,
  pointerUp,
  projectToCanvas,
  risk,
  surfaceY,
  toWeight,
  toWorld,
  wheel,
  type PointerInput,
} from './risk-field.model';

const base = effective(DEFAULTS.volatility, DEFAULTS.correlation, 'Baseline');

describe('the risk model', () => {
  it('is zero with nothing invested, and grows with each position', () => {
    expect(risk(0, 0, base)).toBe(0);
    expect(risk(0.5, 0, base)).toBeGreaterThan(0);
    expect(risk(1, 0.5, base)).toBeGreaterThan(risk(0.5, 0.5, base));
    expect(risk(0.5, 1, base)).toBeGreaterThan(risk(0.5, 0.5, base));
  });

  it('grows with volatility', () => {
    for (const scenario of SCENARIOS) {
      const calm = effective(15, 0.3, scenario);
      const wild = effective(45, 0.3, scenario);
      expect(risk(0.8, 0.8, wild), scenario).toBeGreaterThan(risk(0.8, 0.8, calm));
    }
  });

  it('rewards a hedge: long and short positions cancel, and the better the more correlated the assets are', () => {
    const low = effective(22, -0.5, 'Baseline');
    const high = effective(22, 0.9, 'Baseline');
    // Held the same way, higher correlation means more risk; held against each other, less.
    expect(risk(0.7, 0.7, high)).toBeGreaterThan(risk(0.7, 0.7, low));
    expect(risk(0.7, -0.5, high)).toBeLessThan(risk(0.7, -0.5, low));
    // The valley: along the hedge the risk is far below that of either leg alone.
    expect(risk(0.7, -0.5, high)).toBeLessThan(risk(0.7, 0, high) / 1.8);
    // A single position does not care about correlation.
    expect(risk(0.8, 0, high)).toBeCloseTo(risk(0.8, 0, low));
    // Long or short makes no difference to a single position.
    expect(risk(-0.8, 0, high)).toBeCloseTo(risk(0.8, 0, high));
  });

  it('orders the scenarios: every stress is worse than the baseline', () => {
    for (const scenario of SCENARIOS.filter((s) => s !== 'Baseline')) {
      const stressed = effective(DEFAULTS.volatility, DEFAULTS.correlation, scenario);
      expect(risk(0.9, 0.9, stressed), scenario).toBeGreaterThan(risk(0.9, 0.9, base));
    }
    const spike = effective(22, 0.1, 'Correlation spike');
    expect(spike.rho).toBeGreaterThanOrEqual(0.9);
  });

  it('makes the liquidity crunch hurt leveraged portfolios more than light ones', () => {
    const crunch = effective(22, 0.3, 'Liquidity crunch');
    const light = risk(0.3, 0.2, crunch) / risk(0.3, 0.2, base);
    const heavy = risk(0.95, 0.95, crunch) / risk(0.95, 0.95, base);
    expect(heavy).toBeGreaterThan(light);
  });

  it('maps weights to the scene and back', () => {
    expect(toWorld(-WMAX)).toBe(-1);
    expect(toWorld(WMAX)).toBe(1);
    expect(toWeight(toWorld(-0.7))).toBeCloseTo(-0.7);
    expect(toWeight(5)).toBe(1);
  });

  it('eases towards a target and stops there', () => {
    const target = effective(50, 0.8, 'Market shock');
    let shown = base;
    shown = ease(shown, target, 0.016);
    expect(shown.s1).toBeGreaterThan(base.s1);
    expect(shown.s1).toBeLessThan(target.s1);
    for (let i = 0; i < 400; i++) shown = ease(shown, target, 0.016);
    expect(shown).toEqual(target);
    expect(ease(shown, target, 0.016)).toBe(shown);
  });
});

const at = (x: number, y: number, now = 1, dx = 0, dy = 0): PointerInput => ({ x, y, aspect: 1.5, now, dx, dy });

/** A canvas position that looks at the surface. */
function surfacePoint(): { x: number; y: number } {
  for (let y = -0.8; y <= 0.8; y += 0.02) for (let x = -0.8; x <= 0.8; x += 0.02) if (pickSurface(HOME_CAMERA, x, y, 1.5, base)) return { x, y };
  throw new Error('the surface is not on screen');
}

describe('picking', () => {
  it('returns the point of the surface that is drawn under the pointer', () => {
    // Project a known point of the surface onto the canvas, and pick there.
    const a = 0.5;
    const b = -0.3;
    const world: [number, number, number] = [toWorld(a), surfaceY(toWorld(a), toWorld(b), base), toWorld(b)];
    const spot = projectToCanvas(HOME_CAMERA, 1.5, world)!;
    const x = (spot.x / 100 - 0.5) * 2;
    const y = (0.5 - spot.y / 100) * 2;
    const picked = pickSurface(HOME_CAMERA, x, y, 1.5, base)!;
    expect(picked.a).toBeCloseTo(a, 1);
    expect(picked.b).toBeCloseTo(b, 1);
  });

  it('misses the empty space around the surface', () => {
    expect(pickSurface(HOME_CAMERA, -0.99, 0.99, 1.5, base)).toBeUndefined();
  });
});

describe('the pointer', () => {
  it('hovers over the surface and leaves nothing under the pointer in empty space', () => {
    const p = surfacePoint();
    expect(pointerMove(initialState(), at(p.x, p.y), base).hover).toBeDefined();
    expect(pointerMove(initialState(), at(-0.99, 0.99), base).hover).toBeUndefined();
  });

  it('selects on a click and turns the camera on a drag, never both', () => {
    const p = surfacePoint();
    const click = pointerUp(pointerDown(initialState(), at(p.x, p.y)), at(p.x, p.y), base);
    expect(click.selected).not.toEqual(initialState().selected);
    expect(click.camera).toBe(initialState().camera);

    let drag = pointerDown(initialState(), at(p.x, p.y));
    drag = pointerMove(drag, at(p.x + 0.1, p.y, 1.05, 0.15, 0), base);
    drag = pointerUp(drag, at(p.x + 0.1, p.y, 1.1), base);
    expect(drag.camera.yaw).not.toBe(HOME_CAMERA.yaw);
    expect(drag.selected).toEqual(initialState().selected);
  });

  it('does not select when the gesture is cancelled', () => {
    const p = surfacePoint();
    const cancelled = pointerUp(pointerDown(initialState(), at(p.x, p.y)), at(p.x, p.y), base, true);
    expect(cancelled.selected).toEqual(initialState().selected);
    expect(cancelled.press).toBeUndefined();
  });

  it('keeps the zoom within limits, and drifts only after a while alone and not under reduced motion', () => {
    let state = initialState();
    for (let i = 0; i < 60; i++) state = wheel(state, -500, 1);
    expect(state.camera.distance).toBe(2.2);
    for (let i = 0; i < 60; i++) state = wheel(state, 500, 1);
    expect(state.camera.distance).toBe(8);
    const quiet = { ...initialState(), touched: 0 };
    expect(advance(quiet, 0.1, 1, false)).toBe(quiet);
    expect(advance(quiet, 0.1, 20, false).camera.yaw).toBeGreaterThan(quiet.camera.yaw);
    expect(advance(quiet, 0.1, 20, true)).toBe(quiet);
  });
});
