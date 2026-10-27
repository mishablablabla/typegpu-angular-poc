import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFE } from '../examples/life/life.example';
import { installMotionPreference } from '../testing/motion-preference';
import { injectReducedMotion, prefersReducedMotion } from './reduced-motion';

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('prefersReducedMotion', () => {
  it('reads the system setting, and is false where matchMedia does not exist', () => {
    expect(prefersReducedMotion()).toBe(false);
    installMotionPreference(true);
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('injectReducedMotion', () => {
  it('starts with the setting, follows it while the owner lives, and stops listening when the owner is destroyed', () => {
    const preference = installMotionPreference(false);
    const created = TestBed.runInInjectionContext(() => injectReducedMotion());
    expect(created()).toBe(false);
    expect(preference.listeners.size).toBe(1);

    preference.set(true);
    expect(created()).toBe(true);
    preference.set(false);
    expect(created()).toBe(false);

    TestBed.resetTestingModule(); // destroys the injector that owns it
    expect(preference.query.removeEventListener).toHaveBeenCalledOnce();
    expect(preference.listeners.size).toBe(0);
    preference.set(true);
    expect(created()).toBe(false); // no longer follows
  });

  it('works where matchMedia does not exist', () => {
    const created = TestBed.runInInjectionContext(() => injectReducedMotion());
    expect(created()).toBe(false);
  });
});

describe('Game of Life autoplay', () => {
  it('runs by default, and waits for the user when the system asks for less motion', () => {
    expect(LIFE.createParams()['running']!()).toBe(true);
    installMotionPreference(true);
    expect(LIFE.createParams()['running']!()).toBe(false);
  });
});
