import { Component, ErrorHandler, EnvironmentInjector, createEnvironmentInjector, input, runInInjectionContext, signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const handleError = vi.fn();
beforeEach(() => {
  fake = createFakeTypeGpu();
  frames = installManualAnimationFrames();
  handleError.mockClear();
  TestBed.configureTestingModule({
    providers: [provideTypeGpu({ root: fake.root }), { provide: ErrorHandler, useValue: { handleError } }],
  });
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

describe('`from` on every resource kind', () => {
  const kinds = {
    uniform: (from: Signal<number>) => injectUniform(d.f32, { from }),
    buffer: (from: Signal<number>) => injectBuffer(d.f32, { from }),
    mutable: (from: Signal<number>) => injectMutable(d.f32, { from }),
    readonly: (from: Signal<number>) => injectReadonly(d.f32, { from }),
  } as const;

  it.each(Object.keys(kinds) as (keyof typeof kinds)[])('%s: first frame writes the value, a change writes once, unchanged writes nothing, destroy stops it', (kind) => {
    const source = signal(1);
    @Component({ selector: 'app-kind', template: '' })
    class Kind {
      static make: ((from: Signal<number>) => unknown) | undefined;
      readonly resource = Kind.make!(source);
    }
    Kind.make = kinds[kind];
    const fixture = TestBed.createComponent(Kind);
    TestBed.tick();
    expect(fake.resources.map((r) => r.kind)).toEqual([kind]);
    for (let i = 0; i < 3; i++) frames.flush();
    expect(writes()).toEqual([1]);
    source.set(2);
    frames.flush();
    frames.flush();
    expect(writes()).toEqual([1, 2]);
    fixture.destroy();
    source.set(3);
    frames.flush();
    frames.flush();
    expect(writes()).toEqual([1, 2]);
    expect(fake.liveResources()).toBe(0);
  });
});

describe('`from` compares by Object.is: replace, don\'t mutate', () => {
  function mirror<T>(source: Signal<T>, schema: Parameters<typeof injectUniform>[0] = d.f32 as never) {
    @Component({ selector: 'app-identity', template: '' })
    class Identity {
      constructor() {
        injectUniform(schema as never, { from: source as never });
      }
    }
    TestBed.createComponent(Identity);
    TestBed.tick();
  }

  it('an array mutated in place is not uploaded again; a new array is', () => {
    const items = [1, 2, 3];
    const source = signal(items);
    mirror(source, d.arrayOf(d.f32, 3));
    frames.flush();
    expect(writes()).toEqual([items]);
    items.push(4); // same identity: invisible
    source.update((value) => value); // even an explicit "update" with the same reference is no change
    frames.flush();
    frames.flush();
    expect(writes().length).toBe(1);
    source.set([...items]);
    frames.flush();
    expect(writes().length).toBe(2);
    expect(writes()[1]).toEqual([1, 2, 3, 4]);
  });

  it('an object edited in place is not uploaded again; a copy is', () => {
    const value = { x: 1 };
    const source = signal(value);
    mirror(source);
    frames.flush();
    value.x = 2;
    frames.flush();
    expect(writes().length).toBe(1);
    source.update((v) => ({ ...v }));
    frames.flush();
    expect(writes().length).toBe(2);
  });

  it('NaN is equal to NaN (written once) while -0 differs from 0 (one extra write)', () => {
    const source = signal(NaN);
    mirror(source);
    frames.flush();
    source.set(NaN);
    frames.flush();
    frames.flush();
    expect(writes().length).toBe(1);
    source.set(0);
    frames.flush();
    source.set(-0);
    frames.flush();
    expect(writes().length).toBe(3);
    expect(Object.is(writes()[2], -0)).toBe(true);
  });

  it('the first sampled value is written even when it equals `initial`', () => {
    const source = signal(5);
    @Component({ selector: 'app-initial-equal', template: '' })
    class InitialEqual {
      constructor() {
        injectUniform(d.f32, { initial: 5, from: source });
      }
    }
    TestBed.createComponent(InitialEqual);
    TestBed.tick();
    frames.flush();
    expect(fake.resources[0]!.initial).toBe(5);
    expect(fake.resources[0]!.calls).toEqual([5]); // `initial` is not a write() call, the sampled value is
  });
});

describe('a `from` write that fails', () => {
  it('freezes that resource (no retry every frame), reports once, and leaves a manual write() possible', async () => {
    const boom = new Error('does not fit the schema');
    const source = signal(1);
    @Component({ selector: 'app-freeze', template: '' })
    class Freeze {
      readonly uniform = injectUniform(d.f32, { from: source });
    }
    const fixture = TestBed.createComponent(Freeze);
    await fixture.whenStable();
    const original = fixture.componentInstance.uniform.write.bind(fixture.componentInstance.uniform);
    let fail = true;
    vi.spyOn(fixture.componentInstance.uniform, 'write').mockImplementation((value) => {
      if (fail) throw boom;
      original(value);
    });
    frames.flush(); // first value: the write throws
    expect(handleError).toHaveBeenCalledExactlyOnceWith(boom);
    fail = false;
    source.set(2);
    source.set(3);
    frames.flush();
    frames.flush();
    expect(writes()).toEqual([]); // nothing is mirrored any more, and nothing is retried
    expect(handleError).toHaveBeenCalledTimes(1);
    fixture.componentInstance.uniform.write(9); // the resource itself is intact
    expect(writes()).toEqual([9]);
  });
});

describe('creating a resource where the owner is already destroyed', () => {
  it('throws and releases the buffer it had already created (a destroyed component\'s injector)', () => {
    @Component({ selector: 'app-late-owner', template: '' })
    class LateOwner {}
    const fixture = TestBed.createComponent(LateOwner);
    const injector = fixture.debugElement.injector;
    fixture.destroy();
    expect(() => runInInjectionContext(injector, () => injectUniform(d.f32))).toThrow(/NG0911/);
    expect(fake.resources.length).toBe(1); // the buffer was created before Angular refused the cleanup...
    expect(fake.liveResources()).toBe(0); // ...so the library destroyed it itself
  });

  it('creates nothing in a destroyed environment injector (Angular refuses to resolve TypeGpu there)', () => {
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    injector.destroy();
    expect(() => runInInjectionContext(injector, () => injectUniform(d.f32))).toThrow(/NG0205/);
    expect(fake.resources.length).toBe(0);
  });
});
