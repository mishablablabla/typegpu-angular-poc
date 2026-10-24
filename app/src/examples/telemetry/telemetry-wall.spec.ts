import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type FakeTypeGpu, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import { TelemetryWall } from './telemetry-wall';

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

let fake: FakeTypeGpu;
let frames: ManualAnimationFrames;
let draws = 0;

beforeEach(() => {
  fake = createFakeTypeGpu();
  draws = 0;
  Object.assign(fake.root, {
    createRenderPipeline: () => ({ withColorAttachment: () => ({ draw: () => draws++ }) }),
  });
  frames = installManualAnimationFrames();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
});
afterEach(() => {
  frames.restore();
  vi.unstubAllGlobals();
});

const params = () => fake.resources.filter((r) => r.kind === 'uniform')[0]!;
const samples = () => fake.resources.find((r) => r.kind === 'readonly')!;

async function mount() {
  const fixture = TestBed.createComponent(TelemetryWall);
  await fixture.whenStable();
  return fixture;
}

describe('TelemetryWall (no GPU)', () => {
  it('uploads the ring buffer and draws on every frame', async () => {
    await mount();
    frames.flush();
    frames.flush();
    frames.flush();
    expect(samples().writes.length).toBe(3);
    expect(draws).toBeGreaterThanOrEqual(1); // the canvas context exists after the first effect run
  });

  it('writes shader params once per change of gain, not every frame', async () => {
    const fixture = await mount();
    for (let i = 0; i < 5; i++) frames.flush();
    const initial = params().writes.length;
    expect(initial).toBeLessThanOrEqual(2); // first sample, plus the canvas size becoming known

    const gain = fixture.nativeElement.querySelector('input[type=range]') as HTMLInputElement;
    gain.value = '1.5';
    gain.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    for (let i = 0; i < 5; i++) frames.flush();
    expect(params().writes.length).toBe(initial + 1);
  });

  it('freezing pauses simulation and drawing but keeps every GPU resource', async () => {
    const fixture = await mount();
    frames.flush();
    const live = fake.liveResources();
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    buttons[0]!.click();
    await fixture.whenStable();
    const uploaded = samples().writes.length;
    frames.flush();
    frames.flush();
    expect(samples().writes.length).toBe(uploaded);
    expect(fake.liveResources()).toBe(live);

    buttons[0]!.click();
    await fixture.whenStable();
    frames.flush();
    expect(samples().writes.length).toBe(uploaded + 1);
  });

  it('releases every GPU resource when destroyed', async () => {
    const fixture = await mount();
    frames.flush();
    expect(fake.liveResources()).toBeGreaterThan(0);
    fixture.destroy();
    expect(fake.liveResources()).toBe(0);
  });
});
