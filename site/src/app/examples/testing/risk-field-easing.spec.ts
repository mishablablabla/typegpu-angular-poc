// The Risk field surface must flow towards what the controls ask for, not jump: in both implementations, a change of a control makes the
// surface uniform move through many intermediate values, in one direction, without passing the target, and arrive. (The integrated one
// did not ease at all: `shown()` was the target itself until something had been eased, and nothing ever was.)
import { TestBed } from '@angular/core/testing';
import { ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { effective } from '../risk-field/risk-field.model';
import { installBrowserStubs, type BrowserStubs } from './example-env';
import { frameQueue, mount, pump, until } from './example-harness';
import { installFakeGpu, type FakeGpu } from './example-gpu';
import { createExampleRoot } from './example-root';

const example = EXAMPLES.find((candidate) => candidate.id === 'risk-field')!;
let frames: ManualAnimationFrames;
let stubs: BrowserStubs;
let gpuFake: FakeGpu | undefined;

beforeEach(() => {
  frames = frameQueue.current = installManualAnimationFrames();
});
afterEach(() => {
  frames.restore();
  gpuFake?.restore();
  stubs?.restore();
});

describe.each(['integration', 'manual'] as const)('the Risk field surface, %s version', (variant: Variant) => {
  it('flows to the new target in many small steps, in one direction, and arrives', async () => {
    stubs = installBrowserStubs();
    gpuFake = installFakeGpu(true);
    const gpu = createExampleRoot();
    gpuFake.queue.push(gpu);
    const handleError = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });

    const { fixture, params } = mount(example, variant);
    await until(fixture, () => gpu.stats.draws > 0);
    await pump(fixture, 10);

    // The surface uniform is the one that carries the numbers `s1` and `s2`.
    const surface = gpu.fake.resources.find((resource) => resource.kind === 'uniform' && typeof (resource.calls.at(-1) as { s1?: number } | undefined)?.s1 === 'number')!;
    expect(surface, 'the surface uniform').toBeDefined();
    const start = (surface.calls.at(-1) as { s1: number }).s1;
    const target = effective(55, params['correlation']!() as number, params['scenario']!() as never).s1;
    expect(Math.abs(target - start), 'the new target is far from where the surface is').toBeGreaterThan(0.5);

    const before = surface.calls.length;
    (params['volatility'] as unknown as { set(value: number): void }).set(55);
    fixture.componentRef.setInput('volatility', 55);
    await pump(fixture, 150);

    const series = (surface.calls.slice(before) as { s1: number }[]).map((write) => write.s1);
    const direction = Math.sign(target - start);
    // Many steps, not one jump.
    expect(series.length, 'writes after the change').toBeGreaterThan(20);
    expect(new Set(series.map((value) => value.toFixed(5))).size, 'distinct values').toBeGreaterThan(20);
    // The first step is a small part of the way, not all of it.
    expect(Math.abs(series[0]! - start), 'first step').toBeLessThan(0.5 * Math.abs(target - start));
    // Always on the way: never back, never past the target.
    for (let i = 1; i < series.length; i++) expect((series[i]! - series[i - 1]!) * direction, `step ${i} goes the same way`).toBeGreaterThanOrEqual(-1e-9);
    for (const value of series) expect((target - value) * direction, 'never past the target').toBeGreaterThanOrEqual(-1e-6);
    // And it arrives.
    expect(Math.abs(series.at(-1)! - target)).toBeLessThan(1e-3);
    expect(handleError).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
