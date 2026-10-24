import { Component, input, signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d } from 'typegpu';
import {
  injectBuffer,
  injectFrame,
  injectMutable,
  injectReadonly,
  injectUniform,
  provideTypeGpu,
} from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames, type FakeTypeGpu, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';

let fake: FakeTypeGpu;
let frames: ManualAnimationFrames;
beforeEach(() => {
  fake = createFakeTypeGpu();
  frames = installManualAnimationFrames();
  TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
});
afterEach(() => frames.restore());

const writes = (index = 0) => fake.resources[index]!.writes;

describe('owned resources', () => {
  it('create one resource each and destroy it exactly once with the owner', () => {
    @Component({ selector: 'app-all', template: '' })
    class All {
      constructor() {
        injectUniform(d.f32);
        injectBuffer(d.f32);
        injectMutable(d.f32);
        injectReadonly(d.f32);
      }
    }
    const fixture = TestBed.createComponent(All);
    expect(fake.resources.map((r) => r.kind)).toEqual(['uniform', 'buffer', 'mutable', 'readonly']);
    expect(fake.liveResources()).toBe(4);
    fixture.destroy();
    expect(fake.liveResources()).toBe(0);
    fixture.destroy(); // idempotent from the user's view
    expect(fake.liveResources()).toBe(0);
  });

  it('writes `initial` at creation', () => {
    @Component({ selector: 'app-init', template: '' })
    class Init {
      constructor() {
        injectUniform(d.f32, { initial: 3 });
      }
    }
    TestBed.createComponent(Init);
    expect(writes()).toEqual([3]);
  });
});

describe('`from`: signal mirroring, sampled per frame', () => {
  function create(source: Signal<number>, onFrame?: () => void) {
    @Component({ selector: 'app-mirror', template: '' })
    class Mirror {
      constructor() {
        injectUniform(d.f32, { from: source });
        if (onFrame) injectFrame(onFrame);
      }
    }
    const fixture = TestBed.createComponent(Mirror);
    TestBed.tick(); // sampling starts after the owner's first render
    return fixture;
  }

  it('does not read the signal at construction, writes the first value on the first frame', () => {
    let reads = 0;
    const source = signal(5);
    const counted = (() => { reads++; return source(); }) as unknown as Signal<number>;
    create(counted);
    expect(reads).toBe(0);
    frames.flush();
    expect(writes()).toEqual([5]);
    expect(reads).toBe(1);
  });

  it('writes once per change and never while unchanged', () => {
    const source = signal(1);
    create(source);
    for (let i = 0; i < 5; i++) frames.flush();
    expect(writes()).toEqual([1]);
    source.set(2);
    for (let i = 0; i < 5; i++) frames.flush();
    expect(writes()).toEqual([1, 2]);
  });

  it('collapses several changes before a frame into one write of the latest value', () => {
    const source = signal(1);
    create(source);
    frames.flush();
    source.set(2);
    source.set(3);
    source.set(4);
    frames.flush();
    expect(writes()).toEqual([1, 4]);
  });

  it('is visible to the frame callback of the same frame, even without change detection in between', () => {
    const source = signal(1);
    const seen: unknown[] = [];
    create(source, () => seen.push(writes().at(-1)));
    frames.flush();
    source.set(2); // no fixture.whenStable(): this is the case effect() would miss
    frames.flush();
    expect(seen).toEqual([1, 2]);
  });

  it('works with a required signal input that is not available during construction', async () => {
    @Component({ selector: 'app-input', template: '' })
    class WithInput {
      readonly value = input.required<number>();
      constructor() {
        injectUniform(d.f32, { from: this.value });
      }
    }
    const fixture = TestBed.createComponent(WithInput);
    fixture.componentRef.setInput('value', 7);
    await fixture.whenStable();
    frames.flush();
    expect(writes()).toEqual([7]);
    fixture.componentRef.setInput('value', 8);
    await fixture.whenStable();
    frames.flush();
    expect(writes()).toEqual([7, 8]);
  });

  it('stops sampling and stops writing when the owner is destroyed', () => {
    const source = signal(1);
    const fixture = create(source);
    frames.flush();
    fixture.destroy();
    source.set(2);
    frames.flush();
    frames.flush();
    expect(writes()).toEqual([1]);
  });
});
