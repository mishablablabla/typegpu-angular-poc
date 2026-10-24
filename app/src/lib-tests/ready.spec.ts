import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { d } from 'typegpu';
import type { TgpuRoot } from 'typegpu';
import { TgpuReady, TypeGpu, injectUniform, provideTypeGpu } from '@typegpu-poc/angular';
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
