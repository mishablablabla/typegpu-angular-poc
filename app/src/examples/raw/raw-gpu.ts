// "Before": TypeGPU used directly from Angular. This is the app-level GPU root holder you
// have to write yourself (one device for the whole app, browser only, safe against init races,
// failure and device loss). Written to be correct, not minimal.
import {
  DestroyRef,
  ErrorHandler,
  Injectable,
  InjectionToken,
  PLATFORM_ID,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { tgpu, type TgpuRoot } from 'typegpu';

export type RawGpuState =
  | { status: 'idle' | 'initializing' | 'unsupported' }
  | { status: 'ready'; root: TgpuRoot }
  | { status: 'failed'; error: unknown }
  | { status: 'lost' };

/** Lets tests replace `tgpu.init`. */
export const RAW_INIT = new InjectionToken<() => Promise<TgpuRoot>>('RAW_INIT', { factory: () => () => tgpu.init() });

@Injectable({ providedIn: 'root' })
export class RawGpu {
  readonly state = signal<RawGpuState>({ status: 'idle' });
  readonly #init = inject(RAW_INIT);
  readonly #errors = inject(ErrorHandler);
  readonly #browser = isPlatformBrowser(inject(PLATFORM_ID));
  #destroyed = false;
  #generation = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.#destroyed = true));
    if (this.#browser) afterNextRender(() => void this.start());
  }

  retry(): void {
    const { status } = this.state();
    if (this.#browser && (status === 'failed' || status === 'lost' || status === 'unsupported')) void this.start();
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    this.state.set({ status: 'initializing' });
    if (!('gpu' in navigator) || !navigator.gpu) {
      this.state.set({ status: 'unsupported' });
      return;
    }
    let root: TgpuRoot;
    try {
      root = await this.#init();
    } catch (error) {
      if (this.#destroyed || generation !== this.#generation) return;
      this.state.set({ status: 'failed', error });
      this.#errors.handleError(error);
      return;
    }
    if (this.#destroyed || generation !== this.#generation) {
      root.destroy();
      return;
    }
    this.state.set({ status: 'ready', root });
    void root.device.lost.then(() => {
      const current = this.state();
      if (!this.#destroyed && current.status === 'ready' && current.root === root) this.state.set({ status: 'lost' });
    });
  }
}
