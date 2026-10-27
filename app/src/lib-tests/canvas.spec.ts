import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TgpuRoot } from 'typegpu';
import { TgpuCanvas, TypeGpu, provideTypeGpu, type CanvasSize, type TgpuCanvasOptions } from '@typegpu-poc/angular';
import { createFakeTypeGpu } from '@typegpu-poc/angular/testing';

// jsdom has no ResizeObserver; this one lets the test decide when and what it reports.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  /** Emulates a browser that does not know `device-pixel-content-box` (Safari): `observe()` with that box throws a TypeError. */
  static rejectDevicePixelBox = false;
  disconnected = false;
  /** The options of every `observe()` call (`undefined` for a plain `observe(target)`). */
  readonly observed: (ResizeObserverOptions | undefined)[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(_target: Element, options?: ResizeObserverOptions) {
    if (options?.box === 'device-pixel-content-box' && FakeResizeObserver.rejectDevicePixelBox) {
      throw new TypeError("The provided value 'device-pixel-content-box' is not a valid enum value of type ResizeObserverBoxOptions.");
    }
    this.observed.push(options);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** One size for both boxes (`exact`), or for the content box only. */
  report(width: number, height: number, exact = true) {
    this.reportBoxes([width, height], exact ? [width, height] : undefined);
  }
  /** Distinct CSS-pixel (content box) and device-pixel boxes, as a browser with a pixel ratio other than 1 reports them. */
  reportBoxes(content: [number, number], device?: [number, number]) {
    const box = (size: [number, number]) => [{ inlineSize: size[0], blockSize: size[1] }];
    this.callback(
      [{ contentBoxSize: box(content), devicePixelContentBoxSize: device ? box(device) : undefined } as unknown as ResizeObserverEntry],
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
  FakeResizeObserver.rejectDevicePixelBox = false;
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

  it('caps the pixel ratio with maxPixelRatio, and keeps the option away from WebGPU', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.options.set({ maxPixelRatio: 1.5 });
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    // Measured in CSS pixels and scaled by the cap, with or without exact device-pixel sizes.
    live()[0]!.report(100, 50, true);
    expect([canvas.width, canvas.height]).toEqual([150, 75]);
    live()[0]!.report(200, 50, false);
    expect([canvas.width, canvas.height]).toEqual([300, 75]);
    expect(fake.contexts.every((context) => !('maxPixelRatio' in context.options))).toBe(true);

    // A cap above the screen's own ratio changes nothing.
    fixture.componentInstance.options.set({ maxPixelRatio: 4 });
    await fixture.whenStable();
    live()[0]!.report(100, 50, false);
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
  });

  it('does not run away when the canvas has no CSS size (its bitmap decides its layout size)', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
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

    // devicePixelRatio 2: a canvas of 300x150 CSS pixels is measured as 600x300 device pixels, and writing that
    // bitmap size makes it 600x300 CSS pixels, which is then measured as 1200x600, and so on without end.
    observer.report(600, 300);
    observer.report(1200, 600);
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

describe('tgpuCanvas: when the WebGPU context is (re)configured', () => {
  async function mount(options: TgpuCanvasOptions = {}) {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.options.set(options);
    await fixture.whenStable();
    return { fake, fixture, set: async (next: TgpuCanvasOptions) => (fixture.componentInstance.options.set(next), await fixture.whenStable()) };
  }

  it('changing only maxPixelRatio or autoResize does not reconfigure the context (which would clear the canvas)', async () => {
    const { fake, set } = await mount({ alphaMode: 'premultiplied' });
    expect(fake.contexts.length).toBe(1);
    await set({ alphaMode: 'premultiplied', maxPixelRatio: 1.5 });
    await set({ alphaMode: 'premultiplied', maxPixelRatio: 2 });
    await set({ alphaMode: 'premultiplied', maxPixelRatio: 2, autoResize: false });
    await set({ alphaMode: 'premultiplied', autoResize: true });
    expect(fake.contexts.length).toBe(1);
    expect(fake.unconfigured.length).toBe(0);
  });

  it('a new options object with the same content does not reconfigure; a changed field does', async () => {
    const { fake, set } = await mount({ alphaMode: 'premultiplied', viewFormats: ['rgba8unorm'], toneMapping: { mode: 'standard' } });
    await set({ alphaMode: 'premultiplied', viewFormats: ['rgba8unorm'], toneMapping: { mode: 'standard' } }); // fresh objects, same data
    expect(fake.contexts.length).toBe(1);
    await set({ alphaMode: 'premultiplied', viewFormats: ['rgba8unorm'], toneMapping: { mode: 'extended' } });
    expect(fake.contexts.length).toBe(2);
    await set({ alphaMode: 'opaque', viewFormats: ['rgba8unorm'], toneMapping: { mode: 'extended' } });
    expect(fake.contexts.length).toBe(3);
    await set({ alphaMode: 'opaque', viewFormats: ['rgba8unorm', 'bgra8unorm'], toneMapping: { mode: 'extended' } });
    expect(fake.contexts.length).toBe(4);
    expect(fake.contexts.at(-1)!.options).toEqual({ alphaMode: 'opaque', viewFormats: ['rgba8unorm', 'bgra8unorm'], toneMapping: { mode: 'extended' } });
  });

  it('passes `format` and `usage` through, and a changed format reconfigures', async () => {
    const { fake, set } = await mount({ format: 'rgba8unorm', usage: 0x10 });
    expect(fake.contexts[0]!.options).toEqual({ format: 'rgba8unorm', usage: 0x10 });
    await set({ format: 'bgra8unorm', usage: 0x10 });
    expect(fake.contexts.map((c) => c.options['format'])).toEqual(['rgba8unorm', 'bgra8unorm']);
  });

  it('a new root (retry after loss) configures again, once', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(first.contexts.length).toBe(1);
    first.loseDevice();
    await settle();
    await fixture.whenStable();
    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    expect(first.contexts.length).toBe(1);
    expect(second.contexts.length).toBe(1);
  });
});

describe('tgpuCanvas: releasing the context', () => {
  it('unconfigures the context when the directive is destroyed', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect(fake.unconfigured.length).toBe(0);
    fixture.destroy();
    expect(fake.unconfigured).toEqual([{ canvas, context: fake.contexts[0]!.context }]);
  });

  it('unconfigures the context when the device is lost, and configures it again for the new root', async () => {
    const first = createFakeTypeGpu();
    const second = createFakeTypeGpu();
    const createRoot = vi.fn<() => Promise<TgpuRoot>>().mockResolvedValueOnce(first.root).mockResolvedValueOnce(second.root);
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    first.loseDevice();
    await settle();
    await fixture.whenStable();
    expect(first.unconfigured.length).toBe(1);
    TestBed.inject(TypeGpu).retry();
    await settle();
    await fixture.whenStable();
    expect(second.contexts.length).toBe(1);
    expect(second.unconfigured.length).toBe(0);
    fixture.destroy();
    expect(second.unconfigured.length).toBe(1);
  });

  it('a context that has no unconfigure() (or whose unconfigure throws) never breaks teardown', async () => {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    (fake.contexts[0]!.context as unknown as { unconfigure: () => void }).unconfigure = () => {
      throw new Error('context lost');
    };
    expect(() => fixture.destroy()).not.toThrow();
  });
});

describe('tgpuCanvas: measuring the canvas', () => {
  async function mount(options: TgpuCanvasOptions = {}) {
    const fake = createFakeTypeGpu();
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.options.set(options);
    await fixture.whenStable();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    return { fake, fixture, canvas, observer: () => live()[0]! };
  }

  it('observes the device-pixel box (so a change of devicePixelRatio alone is reported)', async () => {
    const { observer } = await mount();
    expect(observer().observed).toEqual([{ box: 'device-pixel-content-box' }]);
  });

  it('falls back to a plain observe() where the device-pixel box is unknown (Safari throws a TypeError), and still sizes the canvas', async () => {
    FakeResizeObserver.rejectDevicePixelBox = true;
    vi.stubGlobal('devicePixelRatio', 2);
    const { observer, canvas } = await mount();
    expect(observer().observed).toEqual([undefined]);
    observer().reportBoxes([100, 50]);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
  });

  it('prefers the exact device-pixel size over content size x pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { observer, canvas } = await mount();
    observer().reportBoxes([100.3, 50.3], [200, 100]); // 100.3 x 2 would round to 201 x 101
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
  });

  it('without a device-pixel size it uses content size x devicePixelRatio, rounded', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { observer, canvas } = await mount();
    observer().reportBoxes([100.3, 50.3]);
    expect([canvas.width, canvas.height]).toEqual([201, 101]);
  });

  it('follows a change of the pixel ratio alone: same CSS size, different device size', async () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const { observer, canvas, fixture } = await mount();
    observer().reportBoxes([100, 50], [100, 50]);
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
    vi.stubGlobal('devicePixelRatio', 2); // dragged to a Retina screen
    observer().reportBoxes([100, 50], [200, 100]);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    expect(fixture.componentInstance.sizes).toEqual([
      { width: 100, height: 50 },
      { width: 200, height: 100 },
    ]);
  });

  it.each([
    ['exact device size', (o: FakeResizeObserver) => o.reportBoxes([0, 0], [0, 0])],
    ['content size only', (o: FakeResizeObserver) => o.reportBoxes([0, 0])],
  ])('never makes the canvas 0 pixels wide or high (%s)', async (_name, report) => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { observer, canvas, fixture } = await mount();
    report(observer());
    expect([canvas.width, canvas.height]).toEqual([1, 1]);
    expect(fixture.componentInstance.sizes).toEqual([{ width: 1, height: 1 }]);
  });

  it('measures a capped canvas from the CSS size even when the exact device size is available', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { observer, canvas } = await mount({ maxPixelRatio: 2 });
    observer().reportBoxes([100, 50], [300, 150]); // device box says 3x; the cap says 2x
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
  });

  it('changing maxPixelRatio re-measures with a new observer and clears nothing else', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { fake, observer, canvas, fixture } = await mount({ maxPixelRatio: 2 });
    observer().reportBoxes([100, 50], [300, 150]);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    fixture.componentInstance.options.set({ maxPixelRatio: 1 });
    await fixture.whenStable();
    expect(FakeResizeObserver.instances.length).toBe(2);
    expect(live().length).toBe(1);
    observer().reportBoxes([100, 50], [300, 150]);
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
    expect(fake.contexts.length).toBe(1);
  });

  it('a canvas without CSS size does not run away without exact device sizes either (Safari path)', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { observer, canvas } = await mount();
    Object.defineProperty(canvas, 'clientWidth', { get: () => canvas.width });
    Object.defineProperty(canvas, 'clientHeight', { get: () => canvas.height });
    observer().reportBoxes([300, 150]); // 300x150 CSS pixels -> 600x300 bitmap -> it would be measured as 600x300 CSS next
    observer().reportBoxes([600, 300]);
    observer().reportBoxes([1200, 600]);
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
