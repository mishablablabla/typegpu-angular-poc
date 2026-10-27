// MATRIX MIRROR's hidden ending, on the scene (not on the plain modules, see matrix/matrix.ending.spec.ts): when the screen goes
// black the camera is switched off, and the frame in which that happens must not import the stopped video as a texture (the
// browser throws for a video that has nothing behind it, and a frame that throws ends the loop).
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { installBrowserStubs, type BrowserStubs } from './example-env';
import { frameQueue, mount, pump, until } from './example-harness';
import { installFakeGpu, type FakeGpu } from './example-gpu';
import { createExampleRoot } from './example-root';

const matrix = EXAMPLES.find((example) => example.id === 'matrix')!;
let frames: ManualAnimationFrames;
let stubs: BrowserStubs;
let gpuFake: FakeGpu;
const handleError = vi.fn();

beforeEach(() => {
  frames = frameQueue.current = installManualAnimationFrames();
});
afterEach(() => {
  frames.restore();
  gpuFake?.restore();
  stubs?.restore();
});

describe.each<Variant>(['integration', 'manual'])('matrix ending, %s version', (variant) => {
  it('does not import the video in the frame in which the camera is switched off', async () => {
    const gpu = createExampleRoot();
    stubs = installBrowserStubs();
    gpuFake = installFakeGpu(true);
    gpuFake.queue.push(gpu);
    handleError.mockClear();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const imports = vi.fn(() => ({}));
    (gpu.root.device as unknown as Record<string, unknown>)['importExternalTexture'] = imports;

    const { fixture } = mount(matrix, variant);
    await until(fixture, () => gpu.stats.draws > 0);
    const scene = fixture.debugElement.query(By.css(variant === 'integration' ? 'app-matrix-scene' : 'app-matrix-scene-manual')).componentInstance as {
      ending: { sequence: unknown; sequenceOf?: never };
    };

    // The shutdown ended long ago: the next frame moves on to the question, and switches the camera off.
    scene.ending.sequence = { phase: 'shutdown', since: -1000 };
    const before = imports.mock.calls.length;
    await pump(fixture, 1);
    expect((scene.ending.sequence as { phase: string }).phase).toBe('confirm');
    expect(imports.mock.calls.length, 'video imported in the frame that stopped it').toBe(before);
    // While the screen is black nothing is drawn and nothing is imported, and nothing fails.
    await pump(fixture, 3);
    expect(imports.mock.calls.length).toBe(before);
    expect(handleError).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
