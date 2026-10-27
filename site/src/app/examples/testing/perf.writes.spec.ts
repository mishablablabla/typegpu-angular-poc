// A measurement, not a guard: what the two implementations of every example write to the GPU's buffers when one control is driven
// on the same schedule, on the fake GPU root (see example-root.ts: it records every `write()` and is not a GPU emulator).
//
// It answers three questions of the second performance audit (docs/PERFORMANCE_AUDIT_2.md):
//   1. how many buffer writes per frame does each variant make (static scene, interactive control, a control changed every frame)?
//   2. do both variants end up with the same data in their buffers once the control has settled?
//   3. does the data in the buffers follow the control at all (the last value must differ from the first when the control moved)?
// Only 3 and "nothing threw" are asserted. 1 and 2 are written to `$PERF_RESULTS_DIR/writes.json` (only when that variable is set) and read by a person: two
// correct implementations may differ in how many writes they make, and time-dependent fields may differ by a frame.
import { TestBed } from '@angular/core/testing';
import { ErrorHandler } from '@angular/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { installBrowserStubs, type BrowserStubs } from './example-env';
import { frameQueue, mount, pump, until } from './example-harness';
import { installFakeGpu, type FakeGpu } from './example-gpu';
import { createExampleRoot } from './example-root';

const VARIANTS: Variant[] = ['integration', 'manual'];
type Mode = 'static' | 'interactive' | 'frequent';
const MODES: Mode[] = ['static', 'interactive', 'frequent'];
const EVERY: Record<Mode, number> = { static: 0, interactive: 6, frequent: 1 };
const FRAMES = 60;

/** The control driven in each example: the same ones the browser harness drives through the control panel. */
const DRIVEN: Record<string, { key: string; options?: readonly string[] }> = {
  life: { key: 'edges', options: ['wrap around', 'dead edges'] },
  autoscaler: { key: 'traffic' },
  'the-core': { key: 'confinement' },
  'risk-field': { key: 'volatility' },
  'neural-flow': { key: 'frequency' },
  matrix: { key: 'speed' },
};

interface Recorded {
  resources: { kind: string; calls: number; first: string; last: string; tail: string[] }[];
  /** Number of `write()` calls over all resources, in each of the driven frames. */
  perFrame: number[];
  totalCalls: number;
  controlEvents: number;
}

const nodeFs = 'node:fs';
declare const process: { cwd(): string };

const results: Record<string, unknown> = {};
const recorded = new Map<string, Recorded>();
const key = (id: string, mode: Mode, variant: Variant) => `${id}|${mode}|${variant}`;

/** A written value as text: typed arrays and vectors as plain numbers, rounded, so two equal values give equal text. */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, x: unknown) => {
    if (ArrayBuffer.isView(x)) return Array.from(x as unknown as ArrayLike<number>).map((n) => Math.round(n * 1e5) / 1e5);
    if (typeof x === 'number') return Math.round(x * 1e5) / 1e5;
    return x;
  }) ?? 'undefined';
}

let frames: ManualAnimationFrames;
let stubs: BrowserStubs;
let gpuFake: FakeGpu | undefined;
const handleError = vi.fn();

beforeEach(() => {
  frames = frameQueue.current = installManualAnimationFrames();
});
afterEach(() => {
  frames.restore();
  gpuFake?.restore();
  stubs?.restore();
});

describe.each(EXAMPLES.map((example) => [example.id, example] as const))('writes of example %s', (id, example) => {
  const driven = DRIVEN[id]!;
  const control = example.controls.find((c) => c.key === driven.key)!;

  describe.each(MODES)('%s', (mode) => {
    it.each(VARIANTS)('%s version', async (variant) => {
      stubs = installBrowserStubs();
      gpuFake = installFakeGpu(true);
      const gpu = createExampleRoot();
      gpuFake.queue.push(gpu);
      handleError.mockClear();
      TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });

      const { fixture, params } = mount(example, variant);
      await until(fixture, () => gpu.stats.draws > 0);
      await pump(fixture, 10); // the first frames: sizes, first writes

      const total = () => gpu.fake.resources.reduce((sum, resource) => sum + resource.calls.length, 0);
      const startCalls = total();
      const perFrame: number[] = [];
      let events = 0;
      let changes = 0;
      for (let frame = 1; frame <= FRAMES; frame++) {
        if (EVERY[mode] > 0 && (frame - 1) % EVERY[mode] === 0) {
          const value =
            control.kind === 'slider'
              ? control.min + (control.max - control.min) * (0.5 + 0.5 * Math.sin(frame * 0.07))
              : driven.options![changes % driven.options!.length]!;
          changes++;
          events++;
          (params[driven.key] as unknown as { set(v: unknown): void }).set(value);
          fixture.componentRef.setInput(driven.key, value);
        }
        const before = total();
        await pump(fixture, 1);
        perFrame.push(total() - before);
      }
      await pump(fixture, 6); // settle: the last change must have reached the buffers

      recorded.set(key(id, mode, variant), {
        resources: gpu.fake.resources.map((resource) => ({
          kind: resource.kind,
          calls: resource.calls.length,
          first: show(resource.writes[0]),
          last: show(resource.writes.at(-1)),
          tail: resource.calls.slice(-8).map((value) => show(value).slice(0, 110)),
        })),
        perFrame,
        totalCalls: total() - startCalls,
        controlEvents: events,
      });
      expect(handleError).not.toHaveBeenCalled();
      fixture.destroy();
    });
  });
});

describe('the buffers follow the control, and both variants end up with the same data', () => {
  it.each(EXAMPLES.map((example) => [example.id] as const))('%s', (id) => {
    const report: Record<string, unknown> = {};
    for (const mode of MODES) {
      const a = recorded.get(key(id, mode, 'integration'));
      const b = recorded.get(key(id, mode, 'manual'));
      expect(a, `${id} ${mode} integration ran`).toBeDefined();
      expect(b, `${id} ${mode} manual ran`).toBeDefined();
      const sameShape = a!.resources.length === b!.resources.length;
      const pairs = sameShape ? a!.resources.map((resource, index) => ({ resource, other: b!.resources[index]! })) : [];
      report[mode] = {
        resources: [a!.resources.length, b!.resources.length],
        callsPerFrame: [+(a!.totalCalls / FRAMES).toFixed(3), +(b!.totalCalls / FRAMES).toFixed(3)],
        controlEvents: a!.controlEvents,
        sameLastValue: sameShape ? pairs.filter(({ resource, other }) => resource.last === other.last).length : null,
        differentLastValue: sameShape ? pairs.map(({ resource, other }, index) => ({ resource, other, index })).filter(({ resource, other }) => resource.last !== other.last).map(({ resource, other, index }) => ({ index, kind: resource.kind, integration: resource.last.slice(0, 120), manual: other.last.slice(0, 120) })) : 'different numbers of resources',
        tails: sameShape ? pairs.map(({ resource, other }, index) => ({ index, kind: resource.kind, integration: resource.tail, manual: other.tail })).filter(({ integration, manual }) => JSON.stringify(integration) !== JSON.stringify(manual)) : null,
        callsEachResource: sameShape ? pairs.map(({ resource, other }) => [resource.kind, resource.calls, other.calls]) : null,
      };
    }
    // What must hold: in a driven mode something was written after the control moved, in both variants.
    for (const mode of ['interactive', 'frequent'] as const) {
      for (const variant of VARIANTS) {
        const run = recorded.get(key(id, mode, variant))!;
        expect(run.controlEvents, `${id} ${mode} drove the control`).toBeGreaterThan(0);
        expect(
          run.resources.some((resource) => resource.calls > 0 && resource.first !== resource.last),
          `${id} ${mode} ${variant}: a buffer changed while the control moved`,
        ).toBe(true);
      }
    }
    results[id] = report;
  });

  afterAll(async () => {
    // The numbers are for a person to read: written only when a folder is asked for (PERF_RESULTS_DIR), never into the repository by a plain test run.
    const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const dir = processEnv?.['PERF_RESULTS_DIR'];
    if (!dir) return;
    const { mkdirSync, writeFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { mkdirSync(path: string, o: { recursive: boolean }): void; writeFileSync(path: string, text: string): void };
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/writes.json`, JSON.stringify({ frames: FRAMES, modes: EVERY, results }, null, 2) + '\n');
  });
});
