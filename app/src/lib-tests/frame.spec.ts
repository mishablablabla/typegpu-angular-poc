import { Component, ErrorHandler, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectFrame, provideTypeGpu, type FrameInfo, type FrameRef } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';

let frames: ManualAnimationFrames;
const handleError = vi.fn();
beforeEach(() => {
  frames = installManualAnimationFrames();
  handleError.mockClear();
  TestBed.configureTestingModule({
    providers: [provideTypeGpu({ root: createFakeTypeGpu().root }), { provide: ErrorHandler, useValue: { handleError } }],
  });
});
afterEach(() => frames.restore());

// One component class for every test (defining a fresh class per call trips Angular's NG0912 id-collision warning).
@Component({ selector: 'app-frame', template: '' })
class Consumer {
  static next: ((frame: FrameInfo) => void) | undefined;
  readonly ref: FrameRef = injectFrame(Consumer.next!);
}

function consumer(callback: (frame: FrameInfo) => void) {
  Consumer.next = callback;
  const fixture = TestBed.createComponent(Consumer);
  TestBed.tick(); // the first frame callback happens after the owner's first render
  return { fixture, ref: { current: fixture.componentInstance.ref } };
}

describe('injectFrame', () => {
  it('shares one loop: every consumer runs exactly once per frame', () => {
    const a = vi.fn();
    const b = vi.fn();
    consumer(a);
    consumer(b);
    frames.flush();
    frames.flush();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('reports delta and elapsed time per callback and reuses the info object', () => {
    const seen: { delta: number; elapsed: number; info: FrameInfo }[] = [];
    consumer((info) => seen.push({ delta: info.deltaSeconds, elapsed: info.elapsedSeconds, info }));
    frames.flush(16);
    frames.flush(16);
    frames.flush(16);
    expect(seen.map((s) => s.delta)).toEqual([0, 0.016, 0.016]);
    expect(seen.map((s) => s.elapsed)).toEqual([0, 0.016, 0.032]);
    expect(new Set(seen.map((s) => s.info)).size).toBe(1);
  });

  it('stops when the owner is destroyed', () => {
    const callback = vi.fn();
    const { fixture } = consumer(callback);
    frames.flush();
    fixture.destroy();
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('can be paused and resumed without touching other consumers', () => {
    const paused = vi.fn();
    const other = vi.fn();
    const { ref } = consumer(paused);
    consumer(other);
    frames.flush();
    ref.current!.pause();
    expect(ref.current!.paused()).toBe(true);
    frames.flush();
    frames.flush();
    ref.current!.resume();
    frames.flush();
    expect(paused).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(4);
  });

  it('goes idle while every consumer is paused and wakes up on resume', () => {
    const callback = vi.fn();
    const { ref } = consumer(callback);
    frames.flush();
    ref.current!.pause();
    frames.flush(); // the pause is noticed, nothing runs, nothing is rescheduled
    frames.flush();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    ref.current!.resume();
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    frames.flush();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('stops a callback that throws, reports it once, and keeps other consumers running', () => {
    const boom = new Error('shader setup failed');
    const broken = vi.fn(() => {
      throw boom;
    });
    const healthy = vi.fn();
    consumer(broken);
    consumer(healthy);
    frames.flush();
    frames.flush();
    frames.flush();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(boom);
    expect(healthy).toHaveBeenCalledTimes(3);
  });

  it('never runs on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }, { provide: ErrorHandler, useValue: { handleError } }] });
    const callback = vi.fn();
    consumer(callback);
    frames.flush();
    expect(callback).not.toHaveBeenCalled();
  });
});
