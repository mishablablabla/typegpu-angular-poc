// The browser pieces the example scenes touch that jsdom does not have (or only pretends to have), as small fakes that a
// test installs and removes again. None of them does real work: they let the code run and let a test decide what happens.
import { vi } from 'vitest';

/** A ResizeObserver the test drives: `reportAll(width, height)` reports to every observer that is still observing. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  static live(): FakeResizeObserver[] {
    return FakeResizeObserver.instances.filter((observer) => !observer.disconnected);
  }
  static reportAll(width: number, height: number): void {
    const box = [{ inlineSize: width, blockSize: height }];
    for (const observer of FakeResizeObserver.live()) {
      observer.callback([{ contentBoxSize: box, devicePixelContentBoxSize: box } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  }
}

/** A 2D context that accepts every call (gradients too) and draws nothing. */
function context2d(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined };
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => (property === 'createLinearGradient' || property === 'createRadialGradient' ? () => gradient : () => undefined),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
}

/** The model file of MATRIX MIRROR, read from the assets folder (the specs run in Node, from the site's directory). */
const nodeFs = 'node:fs';
declare const process: { cwd(): string };
async function readModel(): Promise<ArrayBuffer> {
  const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: string): Uint8Array };
  const bytes = readFileSync(`${process.cwd()}/public/assets/selfie-segmentation/selfie_segmenter.ssgbin`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface BrowserStubs {
  restore(): void;
}

/**
 * Installs ResizeObserver, a 2D canvas context plus `captureStream`, and an HTMLVideoElement that plays at once.
 * `webgpuContext` answers `canvas.getContext('webgpu')` (only the shader gate runs TypeGPU's real root, which asks for it).
 * No `navigator.mediaDevices`: there is no camera, so MATRIX MIRROR falls back to its demo scene, which is the path we can test.
 * `fetch` answers the request for the person model with the real file (the only request the examples make), so the network's
 * pipelines are really built; anything else is refused.
 */
export function installBrowserStubs(options: { webgpuContext?: () => unknown } = {}): BrowserStubs {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('fetch', async (input: unknown) => {
    if (!String(input).endsWith('.ssgbin')) throw new Error(`unexpected request in a test: ${String(input)}`);
    const body = await readModel();
    return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => body };
  });

  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => (kind === '2d' ? context2d() : kind === 'webgpu' ? (options.webgpuContext?.() ?? null) : null)) as never);
  const stream = { getTracks: () => [{ stop: () => undefined }] };
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => stream });
  const media = HTMLMediaElement.prototype;
  const originals = { play: media.play, pause: media.pause };
  media.play = () => Promise.resolve();
  media.pause = () => undefined;
  Object.defineProperty(media, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 360 });

  return {
    restore() {
      vi.unstubAllGlobals();
      getContext.mockRestore();
      delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['captureStream'];
      media.play = originals.play;
      media.pause = originals.pause;
      delete (media as unknown as Record<string, unknown>)['readyState'];
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)['videoWidth'];
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)['videoHeight'];
    },
  };
}
