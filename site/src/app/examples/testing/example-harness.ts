// Helpers shared by the example specs: mount a scene the way the example page does, and drive its frames.
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { expect, vi } from 'vitest';
import type { ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { ExampleDefinition, ExampleParams, Variant } from '../example.model';
import { FakeResizeObserver } from './example-env';

export const settle = () => new Promise((resolve) => setTimeout(resolve));

/** The frame queue the running spec installed; `pump` runs it. */
export const frameQueue: { current: ManualAnimationFrames | undefined } = { current: undefined };

export interface Mounted {
  fixture: ComponentFixture<unknown>;
  params: ExampleParams;
  setParam: ReturnType<typeof vi.fn>;
}

/** The host the example page would create: every control is an input of the same name, and `setParam` writes one back. */
export function mount(example: ExampleDefinition, variant: Variant): Mounted {
  const params = example.createParams();
  const fixture = TestBed.createComponent(example.scenes[variant]);
  const apply = (key: string, value: unknown) => {
    (params[key] as WritableSignal<unknown> | undefined)?.set(value);
    fixture.componentRef.setInput(key, value);
  };
  const setParam = vi.fn(apply);
  for (const [key, parameter] of Object.entries(params)) fixture.componentRef.setInput(key, parameter());
  if (example.setsParams) fixture.componentRef.setInput('setParam', setParam);
  return { fixture, params, setParam };
}

/** Lets timers, microtasks and Angular settle, reports a canvas size to every observer and runs one animation frame. */
export async function pump(fixture: ComponentFixture<unknown>, rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    fixture.detectChanges();
    await settle();
    FakeResizeObserver.reportAll(1280, 720);
    frameQueue.current!.flush();
    await settle();
    fixture.detectChanges();
  }
}

/** Pumps until `done()` holds (a start of the GPU takes a few turns of the event loop). */
export async function until(fixture: ComponentFixture<unknown>, done: () => boolean, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await pump(fixture);
  expect(done()).toBe(true);
}

export const text = (fixture: ComponentFixture<unknown>): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
export const button = (fixture: ComponentFixture<unknown>, label: string): HTMLButtonElement | undefined =>
  [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

