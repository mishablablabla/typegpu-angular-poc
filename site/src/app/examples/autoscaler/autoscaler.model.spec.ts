import { describe, expect, it } from 'vitest';
import {
  CLIENT_NODE,
  DEFAULTS,
  EDGES,
  NODE_COUNT,
  PlatformSimulator,
  SERVICES,
  SLOT_COUNT,
  STARTUP_SECONDS,
  fitFor,
  hitTest,
  nodeIndex,
  slotPos,
  toCanvas,
  toMap,
  type PlatformSnapshot,
  type PolicyName,
} from './autoscaler.model';

const api = SERVICES.findIndex((s) => s.id === 'api');

function run(sim: PlatformSimulator, seconds: number, traffic: number, policy: PolicyName): PlatformSnapshot {
  for (let t = 0; t < seconds; t += 0.1) sim.advance(0.1, traffic, policy);
  return sim.snapshot();
}

const replicas = (snapshot: PlatformSnapshot, service: number) =>
  snapshot.instances.filter((i) => i.service === service && (i.state === 'running' || i.state === 'starting')).length;

describe('the layout', () => {
  it('has a node for every replica slot and the clients, and calls go from lower to higher services', () => {
    expect(NODE_COUNT).toBe(SERVICES.length + SLOT_COUNT + 1);
    expect(CLIENT_NODE).toBe(NODE_COUNT - 1);
    for (const edge of EDGES) if (edge.from !== CLIENT_NODE) expect(edge.from).toBeLessThan(edge.to);
  });

  it('converts between canvas and map coordinates, and finds what is under a point', () => {
    for (const aspect of [0.5, 1, 1.78, 3]) {
      const [x, y] = toMap(...toCanvas(0.3, -0.2, aspect), aspect);
      expect(x).toBeCloseTo(0.3);
      expect(y).toBeCloseTo(-0.2);
    }
    expect(fitFor(3)).toBe(1);
    expect(fitFor(0.5)).toBeLessThan(1);
    const snapshot = new PlatformSimulator().snapshot();
    const [px, py] = slotPos(api, 0);
    expect(hitTest(snapshot, ...toCanvas(px, py, 1.8), 1.8)).toEqual({ service: api, node: nodeIndex(api, 0) });
    expect(hitTest(snapshot, ...toCanvas(...SERVICES[api]!.pos, 1.8), 1.8)).toEqual({ service: api, node: api });
    expect(hitTest(snapshot, 0.01, 0.01, 1.8)).toBeUndefined();
  });
});

describe('the platform', () => {
  it('starts calm at the default traffic, with the minimum replicas everywhere', () => {
    const snapshot = new PlatformSimulator().snapshot();
    SERVICES.forEach((def, s) => {
      expect(replicas(snapshot, s)).toBeGreaterThanOrEqual(def.min);
      expect(snapshot.services[s]!.health).toBe(0);
    });
    expect(snapshot.errorRate).toBe(0);
  });

  it('is deterministic', () => {
    const a = new PlatformSimulator();
    const b = new PlatformSimulator();
    const left = run(a, 20, 0.9, 'Reactive');
    const right = run(b, 20, 0.9, 'Reactive');
    expect(left.instances).toEqual(right.instances);
    expect(left.edgeRates).toEqual(right.edgeRates);
  });

  it('scales up under load, gradually: new replicas start, then take traffic', () => {
    const sim = new PlatformSimulator();
    const before = replicas(sim.snapshot(), api);
    const early = run(sim, 1.5, 1, 'Reactive');
    expect(early.instances.some((i) => i.service === api && i.state === 'starting')).toBe(true);
    expect(early.instances.filter((i) => i.service === api && i.state === 'running')).toHaveLength(before);
    const later = run(sim, STARTUP_SECONDS + 10, 1, 'Reactive');
    expect(replicas(later, api)).toBeGreaterThan(before);
    expect(later.instances.filter((i) => i.service === api && i.state === 'running').length).toBeGreaterThan(before);
    expect(later.services[api]!.load).toBeLessThan(1);
  });

  it('scales back down when traffic falls', () => {
    const sim = new PlatformSimulator();
    run(sim, 40, 1, 'Reactive');
    const peak = replicas(sim.snapshot(), api);
    const calm = run(sim, 90, 0.05, 'Reactive');
    expect(replicas(calm, api)).toBeLessThan(peak);
    expect(replicas(calm, api)).toBeGreaterThanOrEqual(SERVICES[api]!.min);
  });

  it('answers a traffic spike faster with the reactive policy than with the conservative one', () => {
    const reactive = new PlatformSimulator();
    const conservative = new PlatformSimulator();
    const a = run(reactive, 6, 1, 'Reactive');
    const b = run(conservative, 6, 1, 'Conservative');
    expect(replicas(a, api)).toBeGreaterThan(replicas(b, api));
    // And the conservative platform suffers more meanwhile.
    expect(Math.max(...b.services.map((s) => s.load))).toBeGreaterThan(Math.max(...a.services.map((s) => s.load)) - 1e-9);
  });

  it('survives a failure: the replica goes down, siblings take over, the policy replaces it', () => {
    const sim = new PlatformSimulator();
    run(sim, 5, DEFAULTS.traffic, 'Reactive');
    expect(sim.injectFailure(api, 0)).toBe(true);
    const hit = sim.snapshot();
    expect(hit.instances.find((i) => i.service === api && i.slot === 0)!.state).toBe('failed');
    const after = run(sim, 1, DEFAULTS.traffic, 'Reactive');
    // Traffic moved to the sibling: its load went up.
    expect(after.services[api]!.load).toBeGreaterThan(new PlatformSimulator().snapshot().services[api]!.load);
    expect(after.events.some((e) => e.text.includes('crashed'))).toBe(true);
    const recovered = run(sim, 30, DEFAULTS.traffic, 'Reactive');
    expect(recovered.instances.filter((i) => i.service === api && i.state === 'running').length).toBeGreaterThanOrEqual(SERVICES[api]!.min);
    expect(recovered.instances.some((i) => i.state === 'failed')).toBe(false);
  });

  it('replaces a lost replica later under the conservative policy', () => {
    const reactive = new PlatformSimulator();
    const conservative = new PlatformSimulator();
    run(reactive, 5, DEFAULTS.traffic, 'Reactive');
    run(conservative, 5, DEFAULTS.traffic, 'Conservative');
    reactive.injectFailure(api);
    conservative.injectFailure(api);
    const a = run(reactive, 2, DEFAULTS.traffic, 'Reactive');
    const b = run(conservative, 2, DEFAULTS.traffic, 'Conservative');
    expect(replicas(a, api)).toBeGreaterThan(replicas(b, api));
  });

  it('spreads a failure to the services behind it: retries add load', () => {
    const sim = new PlatformSimulator();
    run(sim, 5, 0.6, 'Conservative');
    const auth = SERVICES.findIndex((s) => s.id === 'auth');
    const db = SERVICES.findIndex((s) => s.id === 'db');
    const calm = sim.snapshot().services[db]!.offered;
    for (const s of [auth, auth]) sim.injectFailure(s);
    const hurt = run(sim, 2, 0.6, 'Conservative');
    expect(hurt.services[auth]!.drop).toBeGreaterThan(0);
    expect(hurt.services[auth]!.health).toBe(2);
    expect(hurt.services[db]!.offered).not.toBe(calm);
  });

  it('refuses to crash what is not running', () => {
    const sim = new PlatformSimulator();
    expect(sim.injectFailure(99)).toBe(false);
  });

  it('keeps a bounded history and event log', () => {
    const sim = new PlatformSimulator();
    const snapshot = run(sim, 200, 1, 'Reactive');
    expect(snapshot.history.length).toBeLessThanOrEqual(120);
    expect(snapshot.events.length).toBeLessThanOrEqual(7);
  });
});
