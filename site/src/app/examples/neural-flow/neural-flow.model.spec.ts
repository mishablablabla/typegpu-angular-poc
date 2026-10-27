import { describe, expect, it } from 'vitest';
import {
  BURST_SPEED,
  DEFAULTS,
  EDGE_COUNT,
  HOME_CAMERA,
  MAX_BURSTS,
  MAX_DELAY,
  NEURONS,
  NETWORK,
  PROBE,
  REFRACTORY,
  REGION_NAMES,
  ReferenceSimulator,
  SHELL,
  SHELL_COUNT,
  SimClock,
  advance,
  brainField,
  burstRadius,
  cerebellumField,
  cerebrumField,
  FIBRE_KINDS,
  describeNeuron,
  fibrePoint,
  hitBrain,
  initialState,
  nearestNeuron,
  pointerDown,
  pointerLeave,
  pointerMove,
  pointerRay,
  pointerUp,
  reset,
  toSurface,
  wheel,
  type Burst,
  type PointerInput,
  type SimControls,
  type Vec3,
} from './neural-flow.model';

const controls = (over: Partial<SimControls> = {}): SimControls => ({ frequency: 1, connectivity: DEFAULTS.connectivity, mode: 1, stimulation: 0.6, ...over });
const run = (sim: ReferenceSimulator, seconds: number, c: SimControls, bursts: readonly Burst[] = [], stimulus?: { pos: Vec3 }) => {
  for (let t = 0; t < seconds; t += 1 / 60) sim.step(1 / 60, c, stimulus, bursts);
};
const quiet = { frequency: 0.001 } as const;
const regionOf = (i: number) => REGION_NAMES[NETWORK.region[i]!];
const mean = (indices: number[], axis: 0 | 1 | 2) => indices.reduce((s, i) => s + NETWORK.positions[i]![axis], 0) / indices.length;
const inRegion = (name: (typeof REGION_NAMES)[number]) => NETWORK.positions.map((_, i) => i).filter((i) => regionOf(i) === name);
const spiked = (sim: ReferenceSimulator, side: number) => NETWORK.positions.reduce((n, p, i) => n + (Math.sign(p[0]) === side && sim.spikes[i]! > 0 && NETWORK.region[i]! <= 3 ? 1 : 0), 0);
const CLICK: Vec3 = [0.6, 0.3, 0.6];

describe('the brain', () => {
  it('has two hemispheres with a fissure, a cerebellum under the back, and a brainstem', () => {
    // The midline between the hemispheres is outside the cerebrum; inside each hemisphere it is inside.
    expect(cerebrumField(0, 0.1, 0)).toBeGreaterThan(0);
    expect(cerebrumField(0.35, 0.05, 0)).toBeLessThan(-0.2);
    expect(cerebrumField(-0.35, 0.05, 0)).toBeLessThan(-0.2);
    expect(cerebellumField(0, -0.5, -0.68)).toBeLessThan(0);
    expect(brainField([0, -0.8, -0.35])).toBeLessThan(0);
    expect(brainField([1.2, 0, 0])).toBeGreaterThan(0.3);
    const cortex = inRegion('frontal cortex').concat(inRegion('parietal cortex'), inRegion('temporal cortex'), inRegion('occipital cortex'));
    // The cerebellum sits lower and further back than the middle of the cortex.
    expect(mean(inRegion('cerebellum'), 1)).toBeLessThan(mean(cortex, 1) - 0.3);
    expect(mean(inRegion('cerebellum'), 2)).toBeLessThan(mean(cortex, 2));
  });

  it('has its lobes where they belong', () => {
    expect(mean(inRegion('frontal cortex'), 2)).toBeGreaterThan(mean(inRegion('parietal cortex'), 2));
    expect(mean(inRegion('parietal cortex'), 2)).toBeGreaterThan(mean(inRegion('occipital cortex'), 2));
    expect(mean(inRegion('temporal cortex'), 1)).toBeLessThan(mean(inRegion('parietal cortex'), 1) - 0.15);
    expect(inRegion('thalamus')).toHaveLength(120);
  });

  it('puts the neurons just under the folded cortex, and the shell on the surface', () => {
    for (const i of NETWORK.positions.map((_, k) => k).filter((k) => NETWORK.region[k]! <= 3)) expect(brainField(NETWORK.positions[i]!)).toBeLessThan(0);
    expect(SHELL_COUNT).toBe(SHELL.positions.length);
    for (let i = 0; i < SHELL_COUNT; i += 400) expect(Math.abs(brainField(SHELL.positions[i]!))).toBeLessThan(0.004);
    // The folds really change the surface: the field varies along it, and normals are unit length.
    expect(Math.hypot(...SHELL.normals[10]!)).toBeCloseTo(1, 3);
    expect(new Set(SHELL.folds.map((f) => Math.round(f * 10))).size).toBeGreaterThan(4);
  });

  it('is the same every time', () => {
    expect(NEURONS).toBe(3520);
    expect(EDGE_COUNT).toBeGreaterThan(15000);
    expect(toSurface([0.6, 0.3, 0.6])).toEqual(toSurface([0.6, 0.3, 0.6]));
  });
});

describe('the anatomy of the brain', () => {
  const cerebrum = SHELL.positions.filter((p) => Math.abs(cerebrumField(p[0], p[1], p[2]) - brainField(p)) < 1e-3);
  const extent = (axis: 0 | 1 | 2) => [Math.min(...cerebrum.map((p) => p[axis])), Math.max(...cerebrum.map((p) => p[axis]))] as const;
  /** Where a ray along -x from outside the right side meets the brain at this height and depth: how far out the surface is there. */
  const surfaceX = (y: number, z: number) => hitBrain({ origin: [1.2, y, z], direction: [-1, 0, 0] })![0];

  it('has the proportions of a human cerebrum: about 1.2 times as long as wide, and a little over half as tall as long', () => {
    const [x0, x1] = extent(0);
    const [y0, y1] = extent(1);
    const [z0, z1] = extent(2);
    const length = z1 - z0;
    const width = x1 - x0;
    const height = y1 - y0;
    expect(length / width).toBeGreaterThan(1.1);
    expect(length / width).toBeLessThan(1.35);
    expect(height / length).toBeGreaterThan(0.5);
    expect(height / length).toBeLessThan(0.65);
    // Symmetric about the midline, and the frontal pole is blunter and further out than the occipital one.
    expect(x0).toBeCloseTo(-x1, 1);
    expect(z1).toBeGreaterThan(-z0);
  });

  it('has a temporal lobe below and beside the rest, with the lateral fissure between them', () => {
    // Inside the temporal lobe, below the level where the upper mass ends.
    expect(brainField([0.5, -0.35, 0.3])).toBeLessThan(-0.05);
    expect(brainField([0.5, -0.4, 0.5])).toBeLessThan(0);
    // The fissure is a recess in the side: at the same depth the surface is further out above it and below it.
    const above = surfaceX(0.1, 0.2);
    const fissure = surfaceX(-0.2, 0.2);
    const lobe = surfaceX(-0.3, 0.2);
    expect(above - fissure).toBeGreaterThan(0.1);
    expect(lobe - fissure).toBeGreaterThan(0.03);
  });

  it('has hemispheres that nearly touch along a flat medial wall (a narrow fissure, not a gap)', () => {
    for (const [y, z] of [[0.1, 0], [0.3, 0.3], [-0.1, -0.3], [0.2, 0.6]] as const) {
      const gap = cerebrumField(0, y, z);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(0.03);
    }
  });

  it('is folded: grooves cover part of the surface, deep ones included, and the surface is rougher than a smooth shell', () => {
    const deep = SHELL.folds.filter((fold) => fold > 0.5).length / SHELL_COUNT;
    expect(deep).toBeGreaterThan(0.1);
    expect(deep).toBeLessThan(0.6);
    // Neighbouring points on the same sulcus-free stretch differ: the field of the cerebrum is not a smooth ellipsoid.
    const along = [0.1, 0.12, 0.14, 0.16, 0.18, 0.2].map((x) => cerebrumField(0.3 + x, 0.45, 0.25));
    expect(Math.max(...along) - Math.min(...along)).toBeGreaterThan(0.005);
  });

  it('has a brainstem that leaves the underside and reaches well below, and a cerebellum tucked under the back with its own ridges', () => {
    expect(Math.min(...SHELL.positions.map((p) => p[1]))).toBeLessThan(-0.95);
    expect(brainField([0, -0.5, -0.1])).toBeLessThan(0);
    expect(cerebellumField(0.3, -0.4, -0.7)).toBeLessThan(0);
    // The ridges (folia): the surface of the cerebellum varies with height by a visible amount.
    const rows = Array.from({ length: 12 }, (_, k) => cerebellumField(0.3, -0.62 + k * 0.004, -0.68));
    expect(Math.max(...rows) - Math.min(...rows)).toBeGreaterThan(0.005);
  });
});

describe('the connections', () => {
  it('have delays that grow with their length, shorter than the refractory period', () => {
    for (const edge of NETWORK.edges) {
      expect(edge.delay).toBeGreaterThanOrEqual(0.03);
      expect(edge.delay).toBeLessThanOrEqual(MAX_DELAY);
      expect(edge.delay).toBeLessThan(REFRACTORY);
    }
    const mean = (kind: string) => {
      const edges = NETWORK.edges.filter((e) => e.kind === kind);
      return edges.reduce((s, e) => s + e.delay, 0) / edges.length;
    };
    expect(mean('callosal')).toBeGreaterThan(mean('local') * 2);
    expect(mean('association')).toBeGreaterThan(mean('local'));
  });

  it('include a corpus callosum that arches over the midline between the hemispheres', () => {
    const callosal = NETWORK.edges.filter((e) => e.kind === 'callosal');
    expect(callosal.length).toBeGreaterThan(300);
    for (const e of callosal) {
      expect(NETWORK.side[e.src]! * NETWORK.side[e.dst]!).toBe(-1);
      // Where the fibre crosses the midline it is up in the arch.
      const across = fibrePoint(NETWORK.positions[e.src]!, e.mid, e.mid2, NETWORK.positions[e.dst]!, 0.5);
      expect(Math.abs(across[0])).toBeLessThan(0.06);
      expect(across[1]).toBeGreaterThan(0.2);
    }
    expect(callosal.some((e) => NETWORK.side[e.src] === 1)).toBe(true);
    expect(callosal.some((e) => NETWORK.side[e.src] === -1)).toBe(true);
  });

  it('are cubic curves that start and end at their neurons, and bend away from the straight line', () => {
    expect(FIBRE_KINDS).toEqual(['local', 'association', 'callosal', 'thalamic']);
    for (const e of NETWORK.edges.slice(0, 400)) {
      const a = NETWORK.positions[e.src]!;
      const b = NETWORK.positions[e.dst]!;
      expect(fibrePoint(a, e.mid, e.mid2, b, 0)).toEqual(a);
      for (let c = 0; c < 3; c++) expect(fibrePoint(a, e.mid, e.mid2, b, 1)[c]).toBeCloseTo(b[c]!, 6);
    }
    // The long fibres are not straight: half way along, they are well off the chord.
    for (const kind of ['association', 'callosal', 'thalamic'] as const) {
      const edges = NETWORK.edges.filter((e) => e.kind === kind);
      const bend = edges.map((e) => {
        const a = NETWORK.positions[e.src]!;
        const b = NETWORK.positions[e.dst]!;
        const half = fibrePoint(a, e.mid, e.mid2, b, 0.5);
        return Math.hypot(half[0] - (a[0] + b[0]) / 2, half[1] - (a[1] + b[1]) / 2, half[2] - (a[2] + b[2]) / 2);
      });
      expect(bend.reduce((sum, x) => sum + x, 0) / bend.length, kind).toBeGreaterThan(0.04);
    }
  });

  it('run as bundles: the fibres of a tract come together half way along, far more than their ends are together', () => {
    const spread = (points: readonly Vec3[]) => {
      const mean = [0, 1, 2].map((c) => points.reduce((sum, p) => sum + p[c]!, 0) / points.length);
      return Math.sqrt(points.reduce((sum, p) => sum + (p[0] - mean[0]!) ** 2 + (p[1] - mean[1]!) ** 2 + (p[2] - mean[2]!) ** 2, 0) / points.length);
    };
    const tract = NETWORK.edges.filter((e) => e.kind === 'association' && regionOf(e.src) === 'frontal cortex' && regionOf(e.dst) === 'parietal cortex' && NETWORK.side[e.src] === 1);
    expect(tract.length).toBeGreaterThan(30);
    const chords = tract.map((e) => NETWORK.positions[e.src]!.map((v, c) => (v + NETWORK.positions[e.dst]![c]!) / 2) as unknown as Vec3);
    const halves = tract.map((e) => fibrePoint(NETWORK.positions[e.src]!, e.mid, e.mid2, NETWORK.positions[e.dst]!, 0.5));
    expect(spread(halves)).toBeLessThan(spread(chords) * 0.75);
  });

  it('keep association tracts inside a hemisphere, and radiate from the thalamus to the cortex', () => {
    for (const e of NETWORK.edges.filter((x) => x.kind === 'association')) expect(NETWORK.side[e.src]).toBe(NETWORK.side[e.dst]);
    const radiations = NETWORK.edges.filter((e) => e.kind === 'thalamic' && regionOf(e.src) === 'thalamus');
    expect(radiations.length).toBeGreaterThan(300);
    for (const e of radiations) expect(NETWORK.region[e.dst]!).toBeLessThanOrEqual(3);
  });

  it('are switched on by rank: describeNeuron counts them', () => {
    const full = describeNeuron(400, 1);
    expect(full.id).toBe('N-0400');
    expect(full.outActive).toBe(full.outTotal);
    const none = describeNeuron(400, 0);
    expect(none.outActive + none.inActive).toBe(0);
    expect(none.outTotal).toBe(full.outTotal);
    expect(describeNeuron(0, 1).region).toMatch(/^(Left|Right) /);
  });
});

describe('the reference simulator', () => {
  it('is deterministic', () => {
    const a = new ReferenceSimulator();
    const b = new ReferenceSimulator();
    run(a, 1.5, controls({ mode: 0 }));
    run(b, 1.5, controls({ mode: 0 }));
    expect(Array.from(a.spike)).toEqual(Array.from(b.spike));
  });

  it('stays quiet without drive; the thalamus ticks at the signal frequency in the baseline state', () => {
    const idle = new ReferenceSimulator();
    run(idle, 2, controls({ ...quiet, mode: 0 }));
    expect(idle.firing(2)).toHaveLength(0);

    const sim = new ReferenceSimulator();
    run(sim, 4.5, controls({ mode: 0, frequency: 1 }));
    const thalamic = inRegion('thalamus');
    // Each thalamic neuron fires once per period (the refractory period is shorter than a period at 1 Hz).
    const counts = thalamic.map((i) => sim.spikes[i]!);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    // Its radiations reach the cortex.
    expect(spiked(sim, 1)).toBeGreaterThan(50);
    // ...but the resting brain is not blazing: a calm background for a click to stand out against.
    expect(sim.firing(0.3).length).toBeLessThan(NEURONS * 0.12);
  });

  it('starts a wave on a click: neurons fire as it passes, nearer ones first', () => {
    const sim = new ReferenceSimulator();
    const pos = toSurface(CLICK);
    run(sim, 1.2, controls(quiet), [{ pos, birth: 0.001, strength: 0.6 }]);
    const reach = burstRadius(0.6);
    const near = nearestNeuron(pos, 0.1);
    expect(near).toBeGreaterThanOrEqual(0);
    const distanceOf = (i: number) => Math.hypot(...NETWORK.positions[i]!.map((v, k) => v - pos[k]!));
    // Within the reach, neurons fire close to birth + distance / speed.
    let checked = 0;
    for (let i = 0; i < NEURONS; i++) {
      const d = distanceOf(i);
      if (d < reach - 0.02 && sim.spikes[i]! > 0) {
        expect(sim.spike[i]!).toBeGreaterThanOrEqual(0.001 + d / BURST_SPEED - 0.02);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('carries the wave across the corpus callosum to the other hemisphere, later than it fired at home', () => {
    const sim = new ReferenceSimulator();
    const pos = toSurface(CLICK);
    let firstRight = Infinity;
    let firstLeftFar = Infinity;
    for (let t = 0; t < 5; t += 1 / 60) {
      sim.step(1 / 60, controls(quiet), undefined, [{ pos, birth: 0.001, strength: 0.6 }]);
      for (const i of sim.firing(1 / 60)) {
        const p = NETWORK.positions[i]!;
        if (NETWORK.region[i]! > 3) continue;
        if (p[0] > 0) firstRight = Math.min(firstRight, sim.time);
        else firstLeftFar = Math.min(firstLeftFar, sim.time);
      }
    }
    expect(firstRight).toBeLessThan(firstLeftFar);
    expect(firstLeftFar).toBeLessThan(Infinity);
    expect(spiked(sim, -1)).toBeGreaterThan(100);
    // It reaches far on its own side too.
    expect(spiked(sim, 1)).toBeGreaterThan(500);
  });

  it('limits the firing rate with the refractory period, and dies down after a click', () => {
    const sim = new ReferenceSimulator();
    const pos = toSurface(CLICK);
    run(sim, 4, controls({ ...quiet, stimulation: 1 }), [], { pos });
    const most = Math.max(...sim.spikes);
    expect(most).toBeGreaterThan(2);
    expect(most).toBeLessThanOrEqual(Math.ceil(4 / REFRACTORY) + 1);

    const click = new ReferenceSimulator();
    run(click, 14, controls(quiet), [{ pos, birth: 0.001, strength: 0.6 }]);
    expect(click.firing(0.5).length).toBeLessThan(NEURONS * 0.02);
  });

  it('reaches fewer neurons when connectivity is lower', () => {
    const reach = (connectivity: number) => {
      const sim = new ReferenceSimulator();
      run(sim, 5, controls({ ...quiet, connectivity }), [{ pos: toSurface(CLICK), birth: 0.001, strength: 0.6 }]);
      return sim.spikes.reduce((n, s) => n + (s > 0 ? 1 : 0), 0);
    };
    const low = reach(0.4);
    const high = reach(1);
    expect(high).toBeGreaterThan(low * 1.8);
    expect(high).toBeGreaterThan(800);
  });

  it('is driven by the probe at the back of the brain in the stimulated state', () => {
    const sim = new ReferenceSimulator();
    run(sim, 3, controls({ mode: 1, frequency: 1 }));
    expect(sim.spikes.reduce((n, s, i) => n + (s > 0 && Math.hypot(...NETWORK.positions[i]!.map((v, k) => v - PROBE[k]!)) < 0.3 ? 1 : 0), 0)).toBeGreaterThan(20);
    expect(PROBE[2]).toBeLessThan(-0.8);
  });
});

const at = (x: number, y: number, now: number, over: Partial<PointerInput> = {}): PointerInput => ({ x, y, aspect: 1.5, now, sim: now, strength: 0.6, dx: 0, dy: 0, ...over });
/** A canvas position where the pointer is over the brain, and one where it is not. */
function onBrain(): { x: number; y: number } {
  for (let y = -0.8; y <= 0.8; y += 0.02) for (let x = -0.8; x <= 0.8; x += 0.02) if (hitBrain(pointerRay(HOME_CAMERA, x, y, 1.5))) return { x, y };
  throw new Error('the brain is not on screen');
}

describe('picking', () => {
  it('finds the surface of the brain under a ray, and nothing beside it', () => {
    const { x, y } = onBrain();
    const hit = hitBrain(pointerRay(HOME_CAMERA, x, y, 1.5))!;
    expect(Math.abs(brainField(hit))).toBeLessThan(0.01);
    expect(hitBrain(pointerRay(HOME_CAMERA, -0.99, 0.99, 1.5))).toBeUndefined();
    // Through the middle of the screen the ray meets the near side of the brain, in front of the centre.
    const middle = hitBrain(pointerRay(HOME_CAMERA, 0, 0, 1.5))!;
    expect(Math.hypot(...middle)).toBeLessThan(1.2);
  });
});

describe('the pointer', () => {
  it('fires the brain where it is pressed, immediately, and selects the nearest neuron on a plain click', () => {
    const p = onBrain();
    let state = pointerDown(initialState(), at(p.x, p.y, 1, { sim: 2.5, strength: 0.8 }));
    expect(state.mode).toBe('stimulate');
    expect(state.stimulus.active).toBe(true);
    expect(state.bursts).toHaveLength(1);
    expect(state.bursts[0]!.birth).toBeGreaterThan(2.5);
    expect(state.bursts[0]!.birth).toBeLessThan(2.51);
    expect(state.bursts[0]!.strength).toBe(0.8);
    expect(Math.abs(brainField(state.bursts[0]!.pos))).toBeLessThan(0.01);
    const pressed = state.pressed;
    state = pointerUp(state, 1.1);
    expect(state.stimulus.active).toBe(false);
    expect(state.selected).toBe(pressed);
  });

  it('keeps stimulating along a drag over the brain, a new wave for every stretch, and does not select', () => {
    const p = onBrain();
    let state = pointerDown(initialState(), at(p.x, p.y, 1));
    // Drag towards the middle of the screen, which stays over the brain.
    for (let i = 1; i <= 24; i++) state = pointerMove(state, at(p.x - Math.sign(p.x || 1) * i * 0.02, p.y * (1 - i / 48), 1 + i * 0.03, { dx: 0.03 }));
    expect(state.bursts.length).toBeGreaterThan(1);
    expect(state.bursts.length).toBeLessThanOrEqual(MAX_BURSTS);
    expect(state.stimulus.active).toBe(true);
    const selected = pointerUp(state, 2).selected;
    expect(selected).toBe(-1);
  });

  it('turns the camera when dragging empty space, deselects on a click there, and lets the turn coast', () => {
    let state = pointerDown(initialState(), at(-0.98, 0.98, 1));
    expect(state.mode).toBe('orbit');
    expect(state.bursts).toHaveLength(0);
    state = pointerMove(state, at(-0.9, 0.9, 1.05, { dx: 0.2 }));
    expect(state.camera.yaw).toBeLessThan(HOME_CAMERA.yaw);
    state = pointerUp(state, 1.1);
    const coasting = advance(state, 0.1, 1.2, false);
    expect(coasting.camera.yaw).not.toBe(state.camera.yaw);

    const selected = { ...initialState(), selected: 5 };
    expect(pointerUp(pointerDown(selected, at(-0.98, 0.98, 1)), 1.1).selected).toBe(-1);
  });

  it('highlights the neuron under the pointer, clears it on leaving, and keeps the zoom in range', () => {
    const p = onBrain();
    const hovered = pointerMove(initialState(), at(p.x, p.y, 1));
    expect(hovered.mode).toBe('idle');
    expect(pointerLeave(hovered).hovered).toBe(-1);
    let state = initialState();
    for (let i = 0; i < 50; i++) state = wheel(state, -500, 1);
    expect(state.camera.distance).toBe(1.5);
    for (let i = 0; i < 50; i++) state = wheel(state, 500, 1);
    expect(state.camera.distance).toBe(7);
  });

  it('drifts the camera only after a while alone and not under reduced motion, and resets', () => {
    const state = { ...initialState(), touched: 0 };
    expect(advance(state, 0.1, 0, false).camera.yaw).toBe(state.camera.yaw);
    expect(advance(state, 0.1, 20, false).camera.yaw).toBeGreaterThan(state.camera.yaw);
    expect(advance(state, 0.1, 20, true)).toBe(state);
    expect(reset().camera).toEqual(HOME_CAMERA);
    expect(reset().selected).toBe(-1);
    expect(reset().bursts).toHaveLength(0);
  });
});

describe('time', () => {
  it('advances by at most 200 ms, half as fast under reduced motion', () => {
    const clock = new SimClock();
    clock.advance(1, false);
    expect(clock.dt).toBeCloseTo(0.2);
    expect(clock.prev).toBe(0);
    clock.advance(1, true);
    expect(clock.dt).toBeCloseTo(0.1);
    expect(clock.prev).toBeCloseTo(0.2);
  });
});
