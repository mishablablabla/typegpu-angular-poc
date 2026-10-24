import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TgpuRoot } from 'typegpu';
import { TgpuCanvas, TypeGpu, provideTypeGpu, type CanvasSize, type TgpuCanvasOptions } from '@typegpu-poc/angular';
import { createFakeTypeGpu } from '@typegpu-poc/angular/testing';

// jsdom has no ResizeObserver; this one lets the test decide when and what it reports.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  report(width: number, height: number, exact = true) {
    const box = [{ inlineSize: width, blockSize: height }];
    this.callback(
      [{ contentBoxSize: box, devicePixelContentBoxSize: exact ? box : undefined } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}
const live = () => FakeResizeObserver.instances.filter((o) => !o.disconnected);
const settle = () => new Promise((resolve) => setTimeout(resolve));

@Component({
  imports: [TgpuCanvas],
  template: `<canvas [tgpuCanvas]="options()" #c="tgpuCanvas" (resized)="sizes.push($event)"></canvas>`,
})
class Host {
  readonly options = signal<TgpuCanvasOptions>({});
  readonly sizes: CanvasSize[] = [];
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('tgpuCanvas', () => {
  it('has no context until a root is ready, then configures the canvas with the options', async () => {
    const fake = createFakeTypeGpu();
    let resolve!: (root: TgpuRoot) => void;
    TestBed.configureTestingModule({
      providers: [provideTypeGpu({ createRoot: () => new Promise<TgpuRoot>((r) => (resolve = r)) })],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.options.set({ alphaMode: 'premultiplied', autoResize: false });
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect(fake.contexts.length).toBe(0);

    resolve(fake.root);
    await settle();
    await fixture.whenStable();
    expect(fake.contexts.length).toBe(1);
    expect(fake.contexts[0]!.canvas).toBe(canvas);
    // `autoResize` is ours and must not reach WebGPU.
    expect(fake.contexts[0]!.options).toEqual({ alphaMode: 'premultiplied' });
  });

  it('reconfigures when the options change', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    fixture.componentInstance.options.set({ alphaMode: 'premultiplied' });
    await fixture.whenStable();
    expect(fake.contexts.map((c) => c.options)).toEqual([{}, { alphaMode: 'premultiplied' }]);
  });

  it('sizes the canvas in device pixels, emits on real changes only, and corrects external resizes', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const observer = live()[0]!;

    observer.report(400, 200);
    expect([canvas.width, canvas.height]).toEqual([400, 200]);
    observer.report(400, 200);
    expect(fixture.componentInstance.sizes).toEqual([{ width: 400, height: 200 }]);

    canvas.width = 10; // something else resized it (which also clears the canvas)
    observer.report(400, 200);
    expect(canvas.width).toBe(400);

    observer.report(800, 300);
    expect(fixture.componentInstance.sizes.at(-1)).toEqual({ width: 800, height: 300 });
    expect(fixture.componentInstance.sizes.length).toBe(2);
  });

  it('falls back to devicePixelRatio when devicePixelContentBoxSize is unavailable', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    live()[0]!.report(100, 50, false);
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
  });

  it('does not run away when the canvas has no CSS size (its bitmap decides its layout size)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    // What a canvas without width/height CSS does: its layout size is its bitmap size (CSS pixels).
    Object.defineProperty(canvas, 'clientWidth', { get: () => canvas.width });
    Object.defineProperty(canvas, 'clientHeight', { get: () => canvas.height });
    const observer = live()[0]!;

    observer.report(600, 300); // devicePixelRatio 2: 300x150 CSS pixels measured in device pixels
    observer.report(1200, 600); // what the browser would report next, and next, and next...
    observer.report(2400, 1200);

    expect([canvas.width, canvas.height]).toEqual([300, 150]); // back to what it was: no growth
    expect(fixture.componentInstance.sizes).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/tgpuCanvas.*CSS/s);
    warn.mockRestore();
  });

  it('stops observing when autoResize is turned off and when destroyed', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(live().length).toBe(1);

    fixture.componentInstance.options.set({ autoResize: false });
    await fixture.whenStable();
    expect(live().length).toBe(0);

    fixture.componentInstance.options.set({});
    await fixture.whenStable();
    expect(live().length).toBe(1);

    fixture.destroy();
    expect(live().length).toBe(0);
  });

  it('drops its context when the device is lost and configures again for the new root', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const fixture = TestBed.createComponent(Host);
    const canvas = fixture.debugElement.children[0]!.injector.get(TgpuCanvas);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(canvas.context()).toBeDefined();

    first.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(canvas.context()).toBeUndefined();

    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    expect(canvas.context()).toBe(second.contexts[0]!.context);
    expect(second.contexts[0]!.canvas).toBe(fixture.nativeElement.querySelector('canvas'));
  });
});
