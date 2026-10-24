// The same behaviour tests run against the hand-written ("raw") and the integrated version of the
// gradient feature. Both need the same fakes; only the wiring differs.
import { signal, type EnvironmentProviders, type Provider, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TgpuRoot } from 'typegpu';
import { provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type FakeTypeGpu, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import { GradientFeature } from './integrated/gradient-feature';
import { RAW_INIT } from './raw/raw-gpu';
import { RawGradientFeature } from './raw/raw-gradient-feature';

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

/** The fake root has no pipelines; this adds one that only counts draws. */
function withPipeline(fake: FakeTypeGpu) {
  const state = { draws: 0 };
  Object.assign(fake.root, {
    createRenderPipeline: () => ({ withColorAttachment: () => ({ draw: () => state.draws++ }) }),
  });
  return state;
}

interface Feature {
  hue: unknown;
}
const variants: { name: string; feature: Type<Feature>; providers(fake: FakeTypeGpu): (Provider | EnvironmentProviders)[] }[] = [
  {
    name: 'integrated',
    feature: GradientFeature as Type<Feature>,
    providers: (fake: FakeTypeGpu): (Provider | EnvironmentProviders)[] => [provideTypeGpu({ createRoot: async () => fake.root })],
  },
  {
    name: 'raw',
    feature: RawGradientFeature as Type<Feature>,
    providers: (fake: FakeTypeGpu): Provider[] => [{ provide: RAW_INIT, useValue: async () => fake.root as TgpuRoot }],
  },
];

const settle = () => new Promise((resolve) => setTimeout(resolve));
const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();

describe.each(variants)('gradient feature ($name)', ({ feature, providers }) => {
  let fake: FakeTypeGpu;
  let draws: { draws: number };
  let frames: ManualAnimationFrames;

  beforeEach(() => {
    fake = createFakeTypeGpu();
    draws = withPipeline(fake);
    frames = installManualAnimationFrames();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
    TestBed.configureTestingModule({ providers: providers(fake) });
  });
  afterEach(() => {
    frames.restore();
    vi.unstubAllGlobals();
    delete (navigator as { gpu?: unknown }).gpu;
  });

  function mount() {
    const hue = signal(120);
    const fixture = TestBed.createComponent(feature);
    fixture.componentRef.setInput('hue', hue());
    return { fixture, hue };
  }

  async function ready(fixture: ReturnType<typeof mount>['fixture']) {
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  }

  it('renders a placeholder, then draws once the root is ready', async () => {
    const { fixture } = mount();
    fixture.detectChanges(); // first render: nothing has resolved yet
    expect(fixture.nativeElement.querySelector('.gpu-placeholder')).not.toBeNull();
    await ready(fixture);
    frames.flush();
    frames.flush();
    expect(draws.draws).toBeGreaterThan(0);
  });

  it('destroys its buffers and stops drawing when destroyed', async () => {
    const { fixture } = mount();
    await ready(fixture);
    frames.flush();
    expect(fake.liveResources()).toBe(2);
    fixture.destroy();
    const drawn = draws.draws;
    frames.flush();
    frames.flush();
    expect(fake.liveResources()).toBe(0);
    expect(draws.draws).toBe(drawn);
  });

  it('writes the tint once per hue change and not while it is unchanged', async () => {
    const { fixture } = mount();
    await ready(fixture);
    const tint = () => fake.resources.find((r) => r.kind === 'uniform' && r !== fake.resources[0])!;
    for (let i = 0; i < 5; i++) frames.flush();
    expect(tint().writes.length).toBe(1);
    fixture.componentRef.setInput('hue', 200);
    await fixture.whenStable();
    for (let i = 0; i < 5; i++) frames.flush();
    expect(tint().writes.length).toBe(2);
  });

  it('shows a message when the device is lost and releases its buffers', async () => {
    const { fixture } = mount();
    await ready(fixture);
    fake.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toContain('The GPU device was lost.');
    expect(fake.liveResources()).toBe(0);
  });

  it('shows a message when WebGPU is not available', async () => {
    TestBed.resetTestingModule();
    delete (navigator as { gpu?: unknown }).gpu;
    TestBed.configureTestingModule({ providers: [] });
    const fixture = TestBed.createComponent(feature);
    fixture.componentRef.setInput('hue', 120);
    await fixture.whenStable();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toContain('WebGPU is not available');
  });
});
