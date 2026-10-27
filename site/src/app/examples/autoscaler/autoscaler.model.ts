// The simulated platform behind the Autoscaler example: eight services, each with replicas, request flows between them,
// two autoscaling policies, and failures. A small deterministic model with a fixed time step. It is not a Kubernetes
// controller: it has no scheduler, no real metrics and no network, only enough structure to show what an autoscaler does.
// Plain TypeScript with no Angular and no GPU: both implementations of the example drive this same class.

export const STEP = 0.1;
/** Seconds a new replica needs before it takes traffic, and seconds a crashed one stays down before it is removed. */
export const STARTUP_SECONDS = 3.5;
export const CRASH_SECONDS = 6;
export const STOP_SECONDS = 1;

export type Health = 0 | 1 | 2;
export const HEALTH_NAMES = ['Healthy', 'Under pressure', 'Failing'] as const;

/** A replica starts, serves, crashes, or is stopped by a scale-down. */
export type InstanceState = 'starting' | 'running' | 'failed' | 'stopping';
export const INSTANCE_CODE: Record<InstanceState, number> = { starting: 0, running: 1, failed: 2, stopping: 3 };

export const POLICY_NAMES = ['Reactive', 'Conservative'] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

interface Policy {
  /** Time constant (seconds) of the utilisation the policy watches. */
  readonly window: number;
  readonly up: number;
  readonly down: number;
  /** Utilisation the policy aims for when it adds replicas. */
  readonly target: number;
  readonly maxStep: number;
  readonly upCooldown: number;
  readonly downCooldown: number;
  /** How long a shortage of replicas (after a crash) goes unanswered. */
  readonly replaceDelay: number;
  readonly summary: string;
}

export const POLICIES: Record<PolicyName, Policy> = {
  Reactive: {
    window: 0.8,
    up: 0.7,
    down: 0.3,
    target: 0.55,
    maxStep: 3,
    upCooldown: 2,
    downCooldown: 10,
    replaceDelay: 0,
    summary: 'Watches a short window, adds up to three replicas at a time, replaces a crashed one at once.',
  },
  Conservative: {
    window: 4,
    up: 0.85,
    down: 0.3,
    target: 0.7,
    maxStep: 1,
    upCooldown: 8,
    downCooldown: 25,
    replaceDelay: 6,
    summary: 'Averages over several seconds, adds one replica per cooldown, waits before replacing a crashed one.',
  },
};

export interface ServiceDef {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** Requests per second one replica can serve. */
  readonly capacity: number;
  readonly min: number;
  readonly max: number;
  /** Position on the map, in screen units (the screen is 2 tall). */
  readonly pos: readonly [number, number];
}

/** Ordered so that every call goes from a lower to a higher index: the flow is computed in one pass. */
export const SERVICES: readonly ServiceDef[] = [
  { id: 'gateway', name: 'Edge gateway', role: 'Terminates TLS and routes every external request.', capacity: 450, min: 2, max: 6, pos: [-0.95, 0] },
  { id: 'api', name: 'API', role: 'Public API: fans out to orders, cache and auth.', capacity: 260, min: 2, max: 8, pos: [-0.45, 0.62] },
  { id: 'catalog', name: 'Catalog', role: 'Product search and listings, mostly served from cache.', capacity: 300, min: 2, max: 6, pos: [-0.45, 0] },
  { id: 'orders', name: 'Orders', role: 'Creates and tracks orders; calls payments and the database.', capacity: 200, min: 2, max: 6, pos: [0.15, 0.7] },
  { id: 'payments', name: 'Payments', role: 'Charges customers; the slowest, scarcest service.', capacity: 160, min: 1, max: 5, pos: [0.7, 0.58] },
  { id: 'auth', name: 'Auth', role: 'Validates sessions for the gateway and the API.', capacity: 380, min: 2, max: 5, pos: [-0.45, -0.66] },
  { id: 'cache', name: 'Cache', role: 'In-memory reads for the API and the catalog.', capacity: 600, min: 2, max: 5, pos: [0.15, -0.2] },
  { id: 'db', name: 'Database', role: 'The system of record: every other tier ends here.', capacity: 520, min: 2, max: 4, pos: [0.78, -0.2] },
];

export const SERVICE_COUNT = SERVICES.length;
/** Slot k of service s sits at node `SERVICE_COUNT + SLOT_BASE[s] + k`. */
export const SLOT_BASE: readonly number[] = SERVICES.map((_, i) => SERVICES.slice(0, i).reduce((sum, s) => sum + s.max, 0));
export const SLOT_COUNT = SERVICES.reduce((sum, s) => sum + s.max, 0);
/** The virtual node for the clients, after the services and their replica slots. */
export const CLIENT_NODE = SERVICE_COUNT + SLOT_COUNT;
export const NODE_COUNT = CLIENT_NODE + 1;
export const CLIENT_POS: readonly [number, number] = [-1.5, 0];
export const NO_NODE = 255;

export interface EdgeDef {
  /** A service index, or `CLIENT_NODE` for the clients. */
  readonly from: number;
  readonly to: number;
  /** Calls made to `to` for every request `from` serves. */
  readonly weight: number;
  /** How far the request streams bend away from the straight line (fraction of its length). */
  readonly curve: number;
}

const index = (id: string) => SERVICES.findIndex((s) => s.id === id);
export const EDGES: readonly EdgeDef[] = [
  { from: CLIENT_NODE, to: index('gateway'), weight: 1, curve: 0 },
  { from: index('gateway'), to: index('api'), weight: 0.6, curve: 0.12 },
  { from: index('gateway'), to: index('catalog'), weight: 0.3, curve: 0.05 },
  { from: index('gateway'), to: index('auth'), weight: 0.25, curve: -0.12 },
  { from: index('api'), to: index('orders'), weight: 0.45, curve: 0.1 },
  { from: index('api'), to: index('cache'), weight: 0.5, curve: -0.1 },
  { from: index('api'), to: index('auth'), weight: 0.6, curve: 0.2 },
  { from: index('catalog'), to: index('cache'), weight: 0.9, curve: 0.1 },
  { from: index('orders'), to: index('payments'), weight: 0.5, curve: 0.12 },
  { from: index('orders'), to: index('db'), weight: 0.8, curve: -0.08 },
  { from: index('payments'), to: index('db'), weight: 0.6, curve: 0.1 },
  { from: index('cache'), to: index('db'), weight: 0.12, curve: 0.06 },
  { from: index('auth'), to: index('db'), weight: 0.2, curve: -0.08 },
];
export const EDGE_COUNT = EDGES.length;

export const MIN_RPS = 100;
export const MAX_RPS = 1600;
/** Requests per second at the clients for a traffic setting from 0 to 1. */
export const rpsFor = (traffic: number): number => MIN_RPS + (MAX_RPS - MIN_RPS) * Math.min(1, Math.max(0, traffic));

/** Request streams: particles per edge, and the request rate at which every particle of an edge is out. */
export const PER_EDGE = 1024;
export const PARTICLES = EDGE_COUNT * PER_EDGE;
export const RATE_FULL = 1000;

/** The light grid has a fixed size whatever the canvas size (see the CORE example). */
export const GRID_TEXELS_PER_UNIT = 300;
export const GRID_W = 1280;
export const GRID_H = 600;
export const GRID_HALF_WIDTH = GRID_W / (2 * GRID_TEXELS_PER_UNIT);
/** The canvas never has more than this many pixels per CSS pixel. */
export const MAX_PIXEL_RATIO = 1;

export const DEFAULTS = { traffic: 0.25, policy: 'Reactive' as PolicyName };

const HISTORY = 120;
const HISTORY_EVERY = 0.5;
const EVENTS = 7;

export interface InstanceStat {
  readonly service: number;
  readonly slot: number;
  readonly state: InstanceState;
  /** Starting, crashed and stopping instances: how far along they are (0..1). */
  readonly progress: number;
  /** Utilisation of this replica (running only). */
  readonly load: number;
}

export interface ServiceStat {
  readonly offered: number;
  readonly served: number;
  /** Requests per second the running replicas can serve. */
  readonly capacity: number;
  /** Offered load over capacity, smoothed over the policy's window. */
  readonly load: number;
  readonly running: number;
  readonly starting: number;
  readonly failed: number;
  /** Fraction of the offered requests that were not served. */
  readonly drop: number;
  readonly health: Health;
}

export interface PlatformEvent {
  readonly time: number;
  readonly service: number;
  readonly text: string;
  readonly level: Health;
}

export interface HistoryPoint {
  readonly rps: number;
  readonly replicas: number;
  readonly errors: number;
}

/** An immutable view of the platform after one step. A new object every step. */
export interface PlatformSnapshot {
  readonly time: number;
  readonly step: number;
  readonly rps: number;
  readonly policy: PolicyName;
  readonly services: readonly ServiceStat[];
  readonly instances: readonly InstanceStat[];
  /** Requests per second on every edge of `EDGES`, and the fraction of them dropped at the receiving end. */
  readonly edgeRates: readonly number[];
  readonly edgeDrops: readonly number[];
  readonly errorRate: number;
  readonly replicas: number;
  readonly events: readonly PlatformEvent[];
  readonly history: readonly HistoryPoint[];
}

interface Instance {
  slot: number;
  state: InstanceState;
  progress: number;
}

interface ServiceState {
  instances: Instance[];
  fast: number;
  slow: number;
  /** Per-policy smoothed utilisation. */
  smooth: number;
  drop: number;
  cooldownUntil: number;
  shortageSince: number | undefined;
}

/** A fixed, deterministic spread of load between replicas, so they do not all look alike. */
const jitter = (service: number, slot: number) => 0.92 + 0.16 * ((((service * 7 + slot * 13) * 2654435761) >>> 0) / 4294967296);

export class PlatformSimulator {
  private time = 0;
  private stepCount = 0;
  private owed = 0;
  private states: ServiceState[] = [];
  private events: PlatformEvent[] = [];
  private history: HistoryPoint[] = [];
  private nextSample = 0;
  private edgeRates: number[] = new Array<number>(EDGE_COUNT).fill(0);
  private edgeDrops: number[] = new Array<number>(EDGE_COUNT).fill(0);
  private stats: ServiceStat[] = [];
  private errorRate = 0;
  private rps = rpsFor(DEFAULTS.traffic);
  private policy: PolicyName = DEFAULTS.policy;
  private current: PlatformSnapshot;

  constructor() {
    this.states = SERVICES.map((def) => ({
      instances: Array.from({ length: def.min }, (_, slot) => ({ slot, state: 'running' as InstanceState, progress: 1 })),
      fast: 0,
      slow: 0,
      smooth: 0,
      drop: 0,
      cooldownUntil: 0,
      shortageSince: undefined,
    }));
    // Warm start: the platform has been running at the default traffic for a while.
    for (let i = 0; i < 80; i++) this.step();
    this.events = [];
    this.history = [];
    this.nextSample = this.time;
    this.current = this.build();
  }

  snapshot(): PlatformSnapshot {
    return this.current;
  }

  /** Moves the clock forward; returns true when at least one step was taken. */
  advance(deltaSeconds: number, traffic: number, policy: PolicyName): boolean {
    this.rps = rpsFor(traffic);
    this.policy = policy;
    this.owed += deltaSeconds;
    let steps = 0;
    while (this.owed >= STEP && steps < 30) {
      this.owed -= STEP;
      this.step();
      steps++;
    }
    if (steps === 30) this.owed = 0;
    if (steps > 0) this.current = this.build();
    return steps > 0;
  }

  /** Crashes one running replica of a service (the one in `slot` if it is running, else the first). */
  injectFailure(service: number, slot?: number): boolean {
    const state = this.states[service];
    if (!state) return false;
    const running = state.instances.filter((i) => i.state === 'running');
    const target = running.find((i) => i.slot === slot) ?? running[0];
    if (!target) return false;
    target.state = 'failed';
    target.progress = 0;
    this.log(service, `${SERVICES[service]!.id}-${target.slot + 1} crashed`, 2);
    this.current = this.build();
    return true;
  }

  private log(service: number, text: string, level: Health): void {
    this.events = [{ time: this.time, service, text, level }, ...this.events].slice(0, EVENTS);
  }

  private step(): void {
    this.time += STEP;
    this.stepCount++;
    const policy = POLICIES[this.policy];

    // Replicas change state with time.
    for (const state of this.states) {
      state.instances = state.instances.filter((instance) => {
        if (instance.state === 'starting') {
          instance.progress += STEP / STARTUP_SECONDS;
          if (instance.progress >= 1) {
            instance.state = 'running';
            instance.progress = 1;
          }
        } else if (instance.state === 'failed') {
          instance.progress += STEP / CRASH_SECONDS;
          if (instance.progress >= 1) return false;
        } else if (instance.state === 'stopping') {
          instance.progress -= STEP / STOP_SECONDS;
          if (instance.progress <= 0) return false;
        }
        return true;
      });
    }

    // Requests flow down the graph. Callers retry what a failing service dropped, so trouble spreads upstream's load.
    const offered = new Array<number>(SERVICE_COUNT).fill(0);
    offered[0] = this.rps;
    const stats: ServiceStat[] = [];
    for (let s = 0; s < SERVICE_COUNT; s++) {
      const def = SERVICES[s]!;
      const state = this.states[s]!;
      const running = state.instances.filter((i) => i.state === 'running').length;
      const capacity = running * def.capacity;
      const served = Math.min(offered[s]!, capacity);
      const drop = offered[s]! > 0.01 ? 1 - served / offered[s]! : 0;
      const instant = capacity > 0 ? offered[s]! / capacity : offered[s]! > 0.01 ? 4 : 0;
      state.fast += (instant - state.fast) * (1 - Math.exp(-STEP / POLICIES.Reactive.window));
      state.slow += (instant - state.slow) * (1 - Math.exp(-STEP / POLICIES.Conservative.window));
      state.smooth += (instant - state.smooth) * (1 - Math.exp(-STEP / 0.8));
      state.drop += (drop - state.drop) * (1 - Math.exp(-STEP / 0.5));
      stats.push({
        offered: offered[s]!,
        served,
        capacity,
        load: state.smooth,
        running,
        starting: state.instances.filter((i) => i.state === 'starting').length,
        failed: state.instances.filter((i) => i.state === 'failed').length,
        drop: state.drop,
        health: running === 0 || state.drop > 0.04 ? 2 : state.smooth > 0.85 ? 1 : 0,
      });
      EDGES.forEach((edge, e) => {
        if (edge.from !== s) return;
        const retries = 1 + 0.6 * this.states[edge.to]!.drop;
        const flow = served * edge.weight * retries;
        offered[edge.to]! += flow;
        this.edgeRates[e] = flow;
        this.edgeDrops[e] = this.states[edge.to]!.drop;
      });
    }
    this.edgeRates[0] = this.rps;
    this.edgeDrops[0] = this.states[0]!.drop;
    this.stats = stats;
    this.errorRate = Math.min(1, stats.reduce((sum, s) => sum + (s.offered - s.served), 0) / Math.max(1, this.rps));

    // The autoscaler looks at every service.
    for (let s = 0; s < SERVICE_COUNT; s++) this.scale(s, policy, stats[s]!);

    if (this.time >= this.nextSample) {
      this.nextSample = this.time + HISTORY_EVERY;
      const replicas = this.states.reduce((sum, st) => sum + st.instances.filter((i) => i.state !== 'failed').length, 0);
      this.history = [...this.history, { rps: this.rps, replicas, errors: this.errorRate }].slice(-HISTORY);
    }
  }

  private scale(s: number, policy: Policy, stat: ServiceStat): void {
    const def = SERVICES[s]!;
    const state = this.states[s]!;
    const live = state.instances.filter((i) => i.state === 'running' || i.state === 'starting').length;
    const watched = policy === POLICIES.Reactive ? state.fast : state.slow;

    // Fewer replicas than the minimum (a crash): replace them, after the policy's delay.
    if (live < def.min) {
      state.shortageSince ??= this.time;
      if (this.time - state.shortageSince >= policy.replaceDelay) {
        this.add(s, def.min - live, `replacing a lost replica`);
        state.shortageSince = undefined;
      }
      return;
    }
    state.shortageSince = undefined;
    if (this.time < state.cooldownUntil) return;

    if (watched > policy.up && live < def.max) {
      const wanted = Math.ceil(stat.offered / (def.capacity * policy.target));
      const count = Math.min(policy.maxStep, Math.max(1, wanted - live), def.max - live);
      this.add(s, count, `load ${Math.round(watched * 100)}%`);
      state.cooldownUntil = this.time + policy.upCooldown;
    } else if (watched < policy.down && live > def.min && stat.starting === 0) {
      const victim = [...state.instances].reverse().find((i) => i.state === 'running');
      if (victim) {
        victim.state = 'stopping';
        victim.progress = 1;
        this.log(s, `${def.id} scaled down to ${live - 1}`, 0);
      }
      state.cooldownUntil = this.time + policy.downCooldown;
    }
  }

  private add(s: number, count: number, why: string): void {
    const def = SERVICES[s]!;
    const state = this.states[s]!;
    let added = 0;
    for (let n = 0; n < count; n++) {
      const used = new Set(state.instances.map((i) => i.slot));
      const slot = Array.from({ length: def.max }, (_, k) => k).find((k) => !used.has(k));
      if (slot === undefined) break;
      state.instances.push({ slot, state: 'starting', progress: 0 });
      added++;
    }
    if (added > 0) {
      const live = state.instances.filter((i) => i.state === 'running' || i.state === 'starting').length;
      this.log(s, `${def.id} scaling to ${live} (${why})`, 1);
    }
  }

  private build(): PlatformSnapshot {
    const instances: InstanceStat[] = [];
    this.states.forEach((state, s) => {
      const stat = this.stats[s];
      for (const instance of [...state.instances].sort((a, b) => a.slot - b.slot)) {
        instances.push({
          service: s,
          slot: instance.slot,
          state: instance.state,
          progress: instance.progress,
          load: instance.state === 'running' && stat ? Math.min(1.6, stat.load * jitter(s, instance.slot)) : 0,
        });
      }
    });
    return {
      time: this.time,
      step: this.stepCount,
      rps: this.rps,
      policy: this.policy,
      services: this.stats.slice(),
      instances,
      edgeRates: this.edgeRates.slice(),
      edgeDrops: this.edgeDrops.slice(),
      errorRate: this.errorRate,
      replicas: instances.filter((i) => i.state !== 'failed').length,
      events: this.events,
      history: this.history,
    };
  }
}

// ---- Layout -------------------------------------------------------------------------------------------------

/** The map is centred and shrinks on narrow canvases instead of being cut off. */
export const MAP_SHIFT = 0.3;
export const fitFor = (aspect: number): number => Math.min(1, aspect / 1.5);

const SLOT_RADIUS = 0.15;
/** Where replica `slot` of a service stands: on a ring around the service. */
export function slotPos(service: number, slot: number): readonly [number, number] {
  const def = SERVICES[service]!;
  const angle = -Math.PI / 2 + (slot / def.max) * Math.PI * 2 + (service % 2) * 0.3;
  return [def.pos[0] + Math.cos(angle) * SLOT_RADIUS, def.pos[1] + Math.sin(angle) * SLOT_RADIUS];
}

export const nodeIndex = (service: number, slot: number): number => SERVICE_COUNT + SLOT_BASE[service]! + slot;

export const HUB_RADIUS = 0.06;
export const SLOT_NODE_RADIUS = 0.03;

/** A point of the canvas (0..1 across and down) in map coordinates, and back. */
export function toMap(u: number, v: number, aspect: number): readonly [number, number] {
  const fit = fitFor(aspect);
  return [((u - 0.5) * aspect * 2) / fit - MAP_SHIFT, ((0.5 - v) * 2) / fit];
}
export function toCanvas(x: number, y: number, aspect: number): readonly [number, number] {
  const fit = fitFor(aspect);
  return [0.5 + ((x + MAP_SHIFT) * fit) / (aspect * 2), 0.5 - (y * fit) / 2];
}

/** What is under a point of the canvas: a replica (and its service), a service, or nothing. */
export function hitTest(snapshot: PlatformSnapshot, u: number, v: number, aspect: number): { service: number; node: number } | undefined {
  const [x, y] = toMap(u, v, aspect);
  const reach = 0.05;
  for (const instance of snapshot.instances) {
    const [px, py] = slotPos(instance.service, instance.slot);
    if (Math.hypot(x - px, y - py) < reach) return { service: instance.service, node: nodeIndex(instance.service, instance.slot) };
  }
  for (let s = 0; s < SERVICE_COUNT; s++) {
    const [px, py] = SERVICES[s]!.pos;
    if (Math.hypot(x - px, y - py) < HUB_RADIUS * 1.6) return { service: s, node: s };
  }
  return undefined;
}
