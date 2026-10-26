import { Component, DestroyRef, TemplateRef, inject, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import { TgpuReady, TypeGpu, injectUniform, provideTypeGpu, type TgpuReadyElseContext } from '@typegpu-poc/angular';
import { createFakeTypeGpu } from '@typegpu-poc/angular/testing';

@Component({ selector: 'app-gpu-child', template: 'child' })
class GpuChild {
  readonly uniform = injectUniform(d.f32);
}

@Component({
  imports: [TgpuReady, GpuChild],
  template: `
    @if (show()) {
      <app-gpu-child *tgpuReady="let root; else fallback" />
    }
    <ng-template #fallback let-state><span id="fallback">{{ state.status }}</span></ng-template>
  `,
})
class Host {
  readonly show = signal(true);
}

const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('*tgpuReady', () => {
  it('renders the else template with the state until a root is ready, then the content', async () => {
    const fake = createFakeTypeGpu();
    let resolve!: (root: TgpuRoot) => void;
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>((r) => (resolve = r)) })],
    });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('initializing');
    expect(fake.liveResources()).toBe(0);

    resolve(fake.root);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('child');
    expect(fake.liveResources()).toBe(1);
  });

  it('shows "unsupported" when WebGPU is missing', async () => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('unsupported');
  });

  it('destroys GPU content (and its resources) when the device is lost, and recreates it after retry', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('child');
    expect(first.liveResources()).toBe(1);

    first.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('lost');
    expect(first.liveResources()).toBe(0); // cleanup ran on the dead device's resources

    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('child');
    expect(second.liveResources()).toBe(1);
    expect(first.liveResources()).toBe(0);
  });

  it('creates and destroys one resource per mount across repeated mount/unmount', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();

    for (let i = 0; i < 20; i++) {
      fixture.componentInstance.show.set(false);
      await fixture.whenStable();
      fixture.componentInstance.show.set(true);
      await fixture.whenStable();
    }
    expect(fake.resources.length).toBe(21);
    expect(fake.liveResources()).toBe(1); // only the currently mounted component

    fixture.destroy();
    expect(fake.liveResources()).toBe(0);
  });
});

// A gate whose else template can be switched, and whose content counts how often it is created.
@Component({ selector: 'app-counted', template: 'counted' })
class Counted {
  static created = 0;
  static destroyed = 0;
  constructor() {
    Counted.created++;
    inject(DestroyRef).onDestroy(() => Counted.destroyed++);
  }
}

@Component({
  imports: [TgpuReady, Counted],
  template: `
    <app-counted *tgpuReady="let root; else chosen()" />
    <ng-template #a let-state><span id="a">A {{ state.status }}</span></ng-template>
    <ng-template #b let-state><span id="b">B {{ state.status }}</span></ng-template>
  `,
})
class Switchable {
  readonly a = viewChild.required<TemplateRef<TgpuReadyElseContext>>('a');
  readonly b = viewChild.required<TemplateRef<TgpuReadyElseContext>>('b');
  readonly pick = signal<'a' | 'b' | 'none'>('a');
  readonly chosen = () => (this.pick() === 'a' ? this.a() : this.pick() === 'b' ? this.b() : undefined);
}

describe('*tgpuReady: the else template', () => {
  beforeEach(() => {
    Counted.created = 0;
    Counted.destroyed = 0;
  });

  it('changing the else template while the content is shown does not recreate the content', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Switchable);
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('counted');
    expect(Counted.created).toBe(1);

    fixture.componentInstance.pick.set('b');
    await fixture.whenStable();
    fixture.componentInstance.pick.set('none');
    await fixture.whenStable();
    fixture.componentInstance.pick.set('a');
    await fixture.whenStable();
    expect(Counted.created).toBe(1);
    expect(Counted.destroyed).toBe(0);
    expect(text(fixture.nativeElement)).toBe('counted');
  });

  it('changing the else template while no root is ready swaps what is shown; the content is never created without a root', async () => {
    let resolve!: (root: TgpuRoot) => void;
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>((r) => (resolve = r)) })],
    });
    const fixture = TestBed.createComponent(Switchable);
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('A initializing');
    fixture.componentInstance.pick.set('b');
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('B initializing');
    fixture.componentInstance.pick.set('none');
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('');
    expect(Counted.created).toBe(0);

    fixture.componentInstance.pick.set('b');
    resolve(fake.root);
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('counted');
    expect(Counted.created).toBe(1);
  });

  it('shows the else template again with the new state when the device is lost, and recreates the content for the new root only', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const fixture = TestBed.createComponent(Switchable);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(Counted.created).toBe(1);
    first.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(text(fixture.nativeElement)).toBe('A lost');
    expect(Counted.destroyed).toBe(1);
    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    expect(Counted.created).toBe(2);
    expect(text(fixture.nativeElement)).toBe('counted');
  });
});
