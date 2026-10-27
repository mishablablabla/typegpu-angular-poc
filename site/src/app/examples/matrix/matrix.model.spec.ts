import {
  MAX_RIPPLES,
  RIPPLE_LIFETIME,
  WALK_IN_SECONDS,
  advanceFx,
  clampCutoff,
  clampGlyph,
  clampReach,
  clampSpeed,
  demoPose,
  demoPresence,
  initialFx,
  isPersonVisible,
  needsFallback,
  needsInference,
  paletteIndex,
  pointerDown,
  pointerLeave,
  pointerMove,
  statusText,
} from './matrix.model';

describe('parameters and status', () => {
  it('clamps what the controls could send', () => {
    expect(clampSpeed(0)).toBe(0.2);
    expect(clampSpeed(99)).toBe(3);
    expect(clampCutoff(-1)).toBe(0.25);
    expect(clampCutoff(1)).toBe(0.75);
    expect(clampReach(0)).toBe(0.1);
    expect(clampReach(9)).toBe(1.5);
    expect(clampReach(0.3)).toBe(0.3);
    expect(clampGlyph(1)).toBe(7);
    expect(clampGlyph(99)).toBe(24);
    expect(clampGlyph(10.6)).toBe(11);
    expect(paletteIndex('Amber')).toBe(2);
    expect(paletteIndex('nope')).toBe(0);
  });

  it('says what is going on, and falls back to the demo when the camera fails', () => {
    expect(statusText('live', 'Camera')).toBe('Camera live');
    expect(statusText('denied', 'Camera')).toMatch(/denied/);
    expect(statusText('live', 'Demo')).toMatch(/Demo/);
    expect(needsFallback('denied', 'Camera')).toBe(true);
    expect(needsFallback('unavailable', 'Camera')).toBe(true);
    expect(needsFallback('live', 'Camera')).toBe(false);
    expect(needsFallback('denied', 'Demo')).toBe(false);
  });

  it('says when the person model is loading or failed, and nothing else changes the camera messages', () => {
    expect(statusText('live', 'Camera', 'loading')).toMatch(/Camera live.*loading the person model/);
    expect(statusText('live', 'Demo', 'loading')).toMatch(/loading the person model/);
    expect(statusText('live', 'Camera', 'ready')).toBe('Camera live');
    expect(statusText('live', 'Camera', 'failed')).toMatch(/could not be loaded/);
    expect(statusText('denied', 'Camera', 'loading')).toBe(statusText('denied', 'Camera', 'ready'));
  });
});

describe('inference', () => {
  it('runs once per new video frame, not once per page frame', () => {
    expect(needsInference(5, -1)).toBe(true);
    expect(needsInference(5, 5)).toBe(false);
    expect(needsInference(6, 5)).toBe(true);
  });
});

describe('pointer', () => {
  it('eases the hover in and out, and keeps the pointer inside the picture', () => {
    let fx = pointerMove(initialFx(), 1.5, -0.2);
    expect(fx.pointer).toEqual({ x: 1, y: 0 });
    expect(fx.used).toBe(true);
    for (let i = 0; i < 60; i++) fx = advanceFx(fx, 0.016, i * 0.016);
    expect(fx.hover).toBe(1);
    fx = pointerLeave(fx);
    for (let i = 0; i < 120; i++) fx = advanceFx(fx, 0.016, 2 + i * 0.016);
    expect(fx.hover).toBe(0);
  });

  it('makes a ripple per click, keeps the latest few, and lets them go', () => {
    let fx = initialFx();
    for (let i = 0; i < 7; i++) fx = pointerDown(fx, 0.5, 0.5, i * 0.1);
    expect(fx.ripples).toHaveLength(MAX_RIPPLES);
    expect(advanceFx(fx, 0.016, 1).ripples).toHaveLength(MAX_RIPPLES);
    expect(advanceFx(fx, 0.016, RIPPLE_LIFETIME + 5).ripples).toHaveLength(0);
  });
});

describe('demo person', () => {
  it('walks in during the first seconds of the picture and then stays', () => {
    expect(demoPresence(0)).toBe(0);
    expect(demoPresence(WALK_IN_SECONDS / 2)).toBeCloseTo(0.5);
    expect(demoPresence(WALK_IN_SECONDS)).toBe(1);
    expect(demoPresence(1000)).toBe(1);
    expect(demoPresence(-5)).toBe(0);
  });

  it('is out of the picture before it walks in, and there afterwards', () => {
    expect(isPersonVisible(demoPose(1, 0))).toBe(false);
    expect(isPersonVisible(demoPose(1, 1))).toBe(true);
    const x = [0, 0.25, 0.5, 0.75, 1].map((p) => demoPose(0, p).x);
    expect(x).toEqual([...x].sort((a, b) => b - a));
  });

  it('keeps moving once it is there', () => {
    expect(demoPose(0, 1).rightArm).not.toBe(demoPose(0.3, 1).rightArm);
  });
});
