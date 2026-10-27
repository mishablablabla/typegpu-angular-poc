// The GPU root without the integration: one device for the whole application, created in the browser after the
// first render, safe against initialization races, failure and device loss. You write this once per application.
import { DestroyRef, ErrorHandler, Injectable, PLATFORM_ID, afterNextRender, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { tgpu, type TgpuRoot } from 'typegpu';

export type ManualGpuState =
  | { status: 'idle' | 'initializing' | 'unsupported' | 'lost' }
  | { status: 'ready'; root: TgpuRoot }
  | { status: 'failed'; error: unknown };

@Injectable({ providedIn: 'root' })
export class ManualGpu {
  readonly state = signal<ManualGpuState>({ status: 'idle' });
  private readonly errors = inject(ErrorHandler);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private destroyed = false;
  private generation = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    if (this.browser) afterNextRender(() => void this.start());
  }

  retry(): void {
    const { status } = this.state();
    if (this.browser && (status === 'failed' || status === 'lost' || status === 'unsupported')) void this.start();
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    this.state.set({ status: 'initializing' });
    if (!navigator.gpu) {
      this.state.set({ status: 'unsupported' });
      return;
    }
    let root: TgpuRoot;
    try {
      root = await tgpu.init();
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.state.set({ status: 'failed', error });
      this.errors.handleError(error);
      return;
    }
    if (this.destroyed || generation !== this.generation) {
      root.destroy(); // nobody can use it any more
      return;
    }
    this.state.set({ status: 'ready', root });
    void root.device.lost.then(() => {
      const current = this.state();
      if (!this.destroyed && current.status === 'ready' && current.root === root) this.state.set({ status: 'lost' });
    });
  }
}
