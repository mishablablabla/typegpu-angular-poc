// Lifecycle tests for every example, in both implementations, on a fake GPU root (see example-root.ts: not a GPU emulator).
// They protect what the showcase promises about `@typegpu/angular` and about the same code written by hand: the scene starts
// and draws, its controls work, everything is released with it, a lost device or a missing GPU shows a notice instead of
// failing, and a retry brings a fresh scene back.
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { FakeResizeObserver, installBrowserStubs, type BrowserStubs } from './example-env';
import { button, frameQueue, mount, pump, settle, text, until } from './example-harness';
import { installFakeGpu, type FakeGpu, type Start } from './example-gpu';
import { createExampleRoot, type ExampleRoot } from './example-root';
import { installMotionPreference } from '../../testing/motion-preference';

const VARIANTS: Variant[] = ['integration', 'manual'];

let frames: ManualAnimationFrames;
let stubs: BrowserStubs;
const handleError = vi.fn();
let gpuFake: FakeGpu | undefined;

interface Setup {
  /** What the GPU does on each start, in order (see `Start`). */
  starts?: Start[];
  /** `navigator.gpu` exists. */
  gpu?: boolean;
}

/** Both implementations start the GPU the normal way (`tgpu.init()` through `navigator.gpu`): the fake answers there. */
function configure({ starts = [], gpu = true }: Setup = {}): void {
  stubs = installBrowserStubs();
  gpuFake = installFakeGpu(gpu);
  gpuFake.queue.push(...starts);
  handleError.mockClear();
  TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
}

beforeEach(() => {
  frames = frameQueue.current = installManualAnimationFrames();
});
afterEach(() => {
  frames.restore();
  gpuFake?.restore();
  stubs?.restore();
});

/** A scene that runs: it has drawn (so it has a size, a context, resources and a frame loop). */
async function untilDrawing(fixture: ComponentFixture<unknown>, gpu: ExampleRoot): Promise<void> {
  await until(fixture, () => gpu.stats.draws > 0);
}

/** The scene is (or soon is again) doing GPU work: a control change may restart a source before the next frame draws. */
async function expectWork(fixture: ComponentFixture<unknown>, gpu: ExampleRoot, label: string): Promise<void> {
  const before = gpu.work();
  for (let i = 0; i < 30 && gpu.work() === before; i++) await pump(fixture);
  expect(gpu.work(), label).toBeGreaterThan(before);
}

/** Runs frames and returns how much GPU work they did. */
async function workDone(fixture: ComponentFixture<unknown>, gpu: ExampleRoot, rounds = 3): Promise<number> {
  const before = gpu.work();
  await pump(fixture, rounds);
  return gpu.work() - before;
}

describe.each(EXAMPLES.map((example) => [example.id, example] as const))('example %s', (_id, example) => {
  describe.each(VARIANTS)('%s version', (variant) => {
    it('starts on a ready GPU: resources, a configured canvas, and work every frame, without errors', async () => {
      const gpu = createExampleRoot();
      configure({ starts: [gpu] });
      const { fixture } = mount(example, variant);
      await untilDrawing(fixture, gpu);

      expect(gpu.fake.resources.length).toBeGreaterThan(0);
      expect(gpu.fake.resources.some((resource) => resource.writes.length > 0)).toBe(true);
      expect(gpu.fake.contexts.length).toBeGreaterThan(0);
      for (const { canvas } of gpu.fake.contexts) expect(canvas).toBeInstanceOf(HTMLCanvasElement);
      expect(gpu.stats.pipelines.render).toBeGreaterThan(0);
      // Every frame after the first one draws.
      const draws = gpu.stats.draws;
      await pump(fixture, 4);
      expect(gpu.stats.draws - draws).toBeGreaterThanOrEqual(4);
      expect(handleError).not.toHaveBeenCalled();
      // One start of the GPU, through the normal `tgpu.init()` path.
      expect(gpuFake!.starts()).toBe(1);
      fixture.destroy();
    });

    it('keeps rendering while every control changes, and a reset or button press does not break it', async () => {
      const gpu = createExampleRoot();
      configure({ starts: [gpu] });
      const { fixture, params, setParam } = mount(example, variant);
      await untilDrawing(fixture, gpu);

      for (const control of example.controls) {
        const input = control.key;
        if (control.kind === 'slider') {
          for (const value of [control.min, (control.min + control.max) / 2, control.max]) {
            fixture.componentRef.setInput(input, value);
            await expectWork(fixture, gpu, `${input}=${value}`);
          }
        } else if (control.kind === 'select') {
          for (const option of control.options) {
            fixture.componentRef.setInput(input, option);
            await expectWork(fixture, gpu, `${input}=${option}`);
          }
        } else if (control.kind === 'toggle') {
          for (const value of [false, true]) {
            fixture.componentRef.setInput(input, value);
            await expectWork(fixture, gpu, `${input}=${value}`);
          }
        } else {
          // A button counts clicks.
          fixture.componentRef.setInput(input, (params[input]!() as number) + 1);
          params[input]!.set((params[input]!() as number) + 1 as never);
          await expectWork(fixture, gpu, `button ${input}`);
        }
      }
      // The reset button of an example that can write controls back does so (the controls return to their defaults).
      const reset = example.controls.find((control) => control.kind === 'button' && control.key === 'reset');
      if (reset && example.setsParams) expect(setParam).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
      fixture.destroy();
    });

    it('releases everything when destroyed, stops its frame loop, and starts again from scratch', async () => {
      const gpu = createExampleRoot();
      configure({ starts: [gpu] });
      const first = mount(example, variant);
      await untilDrawing(first.fixture, gpu);
      expect(gpu.fake.liveResources()).toBeGreaterThan(0);

      first.fixture.destroy();
      expect(gpu.fake.liveResources()).toBe(0);
      const work = gpu.work();
      for (let i = 0; i < 4; i++) {
        frames.flush();
        await settle();
      }
      expect(gpu.work()).toBe(work);
      expect(FakeResizeObserver.live()).toHaveLength(0);

      // A new instance on the same GPU works like the first one.
      const resources = gpu.fake.resources.length;
      const second = mount(example, variant);
      await until(second.fixture, () => gpu.work() > work);
      expect(gpu.fake.resources.length).toBeGreaterThan(resources);
      expect(await workDone(second.fixture, gpu)).toBeGreaterThan(0);
      second.fixture.destroy();
      expect(gpu.fake.liveResources()).toBe(0);
      expect(handleError).not.toHaveBeenCalled();
    });

    it('shows a notice when the device is lost, frees the scene, and a reconnect brings a fresh one', async () => {
      const first = createExampleRoot();
      const second = createExampleRoot();
      configure({ starts: [first, second] });
      const { fixture } = mount(example, variant);
      await untilDrawing(fixture, first);

      first.fake.loseDevice();
      await until(fixture, () => text(fixture).includes('The GPU device was lost'));
      expect(first.fake.liveResources()).toBe(0);
      const work = first.work();
      await pump(fixture, 3);
      expect(first.work()).toBe(work);

      button(fixture, 'Reconnect')!.click();
      await until(fixture, () => second.stats.draws > 0);
      expect(text(fixture)).not.toContain('The GPU device was lost');
      expect(second.fake.liveResources()).toBeGreaterThan(0);
      expect(await workDone(fixture, second)).toBeGreaterThan(0);
      expect(gpuFake!.starts()).toBe(2);
      // The old scene stays gone.
      expect(first.work()).toBe(work);
      expect(first.fake.liveResources()).toBe(0);
      fixture.destroy();
      expect(second.fake.liveResources()).toBe(0);
      expect(handleError).not.toHaveBeenCalled();
    });

    it('says so when WebGPU is not available, creates nothing, and reports no error', async () => {
      const gpu = createExampleRoot();
      configure({ starts: [gpu], gpu: false });
      const { fixture } = mount(example, variant);
      await until(fixture, () => text(fixture).includes('WebGPU is not available'));
      await pump(fixture, 3);
      expect(gpu.fake.resources).toHaveLength(0);
      expect(gpu.stats.pipelines).toEqual({ compute: 0, render: 0 });
      expect(gpu.fake.contexts).toHaveLength(0);
      expect(gpuFake!.starts()).toBe(0);
      expect(handleError).not.toHaveBeenCalled();
      fixture.destroy();
    });

    it('reports an initialization failure once, offers a retry, and the retry works', async () => {
      const failure = new Error('adapter request failed');
      const gpu = createExampleRoot();
      configure({ starts: [failure, gpu] });
      const { fixture } = mount(example, variant);
      await until(fixture, () => text(fixture).includes('GPU initialization failed'));
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(handleError).toHaveBeenCalledWith(failure);
      expect(gpu.fake.resources).toHaveLength(0);

      button(fixture, 'Retry')!.click();
      await untilDrawing(fixture, gpu);
      expect(text(fixture)).not.toContain('GPU initialization failed');
      expect(handleError).toHaveBeenCalledTimes(1);
      expect(gpuFake!.starts()).toBe(2);
      fixture.destroy();
      expect(gpu.fake.liveResources()).toBe(0);
    });
  });
});

// Only the media-using example has a source that can be taken away.
describe('example matrix, camera', () => {
  const matrix = EXAMPLES.find((example) => example.id === 'matrix');

  it.each(VARIANTS)('%s version starts on the demo and never asks for the camera until the user picks it', async (variant) => {
    expect(matrix).toBeDefined();
    const getUserMedia = vi.fn().mockRejectedValue(new Error('should not be called'));
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia } }));
    try {
      const gpu = createExampleRoot();
      configure({ starts: [gpu] });
      const { fixture, params, setParam } = mount(matrix!, variant);
      expect(params['source']!()).toBe('Demo');
      await untilDrawing(fixture, gpu);
      await pump(fixture, 3);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(setParam).not.toHaveBeenCalled();
      expect(params['source']!()).toBe('Demo');
      fixture.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(VARIANTS)('%s version falls back to the demo scene when the camera is chosen but there is none, and says so through the control', async (variant) => {
    expect(matrix).toBeDefined();
    const gpu = createExampleRoot();
    configure({ starts: [gpu] });
    const { fixture, params, setParam } = mount(matrix!, variant);
    // The user picks the camera (the default is the demo).
    params['source']!.set('Camera' as never);
    fixture.componentRef.setInput('source', 'Camera');
    await untilDrawing(fixture, gpu);
    expect(setParam).toHaveBeenCalledWith('source', 'Demo');
    expect(params['source']!()).toBe('Demo');
    fixture.destroy();
  });
});

// The examples that read the system's "reduce motion" setting follow it while they run (it used to be read once at creation).
describe('reduced motion while an example runs', () => {
  const REDUCED_UNIFORM = ['the-core', 'matrix'];
  afterEach(() => vi.unstubAllGlobals());

  it.each(REDUCED_UNIFORM.flatMap((id) => VARIANTS.map((variant) => [id, variant] as const)))('%s %s version writes the new setting to its params uniform when it changes', async (id, variant) => {
    const example = EXAMPLES.find((candidate) => candidate.id === id)!;
    const preference = installMotionPreference(false);
    const gpu = createExampleRoot();
    configure({ starts: [gpu] });
    const { fixture } = mount(example, variant);
    await untilDrawing(fixture, gpu);
    const lastReduced = (): number | undefined => {
      for (const resource of gpu.fake.resources) {
        const written = [...resource.writes].reverse().find((value) => typeof value === 'object' && value !== null && 'reduced' in value) as { reduced: number } | undefined;
        if (written) return written.reduced;
      }
      return undefined;
    };
    expect(lastReduced()).toBe(0);
    expect(preference.listeners.size).toBeGreaterThan(0);

    preference.set(true);
    await pump(fixture, 3);
    expect(lastReduced()).toBe(1);
    preference.set(false);
    await pump(fixture, 3);
    expect(lastReduced()).toBe(0);

    fixture.destroy();
    expect(preference.listeners.size).toBe(0); // the listener goes with the scene
  });
});
