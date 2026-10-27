import { Component, DestroyRef, ElementRef, afterNextRender, inject, viewChild } from '@angular/core';
import { Icon } from '../../shell/icons';

/** FPS and frame time of the page, averaged over the last 60 frames (same readout as the TypeGPU examples). */
@Component({
  selector: 'app-fps-counter',
  imports: [Icon],
  template: `
    <div class="fps">
      <app-icon name="chart" class="chart" />
      <span>FPS: <span #fps>--</span></span>
      <span>Frame: <span #frame>--</span>ms</span>
    </div>
  `,
  styles: `
    .fps { display: flex; align-items: center; gap: 0.9rem; font-family: var(--sl-font-mono); font-size: 0.75rem; color: var(--ex-muted); }
    .chart { font-size: 0.875rem; }
  `,
})
export class FpsCounter {
  private readonly fps = viewChild.required<ElementRef<HTMLElement>>('fps');
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const times: number[] = [];
      let last = 0;
      let lastUpdate = 0;
      let id = 0;
      const loop = (time: number) => {
        id = requestAnimationFrame(loop);
        if (!last) {
          last = lastUpdate = time;
          return;
        }
        times.push(time - last);
        last = time;
        if (times.length > 60) times.shift();
        if (time - lastUpdate >= 100) {
          const average = times.reduce((a, b) => a + b, 0) / times.length;
          this.fps().nativeElement.textContent = String(Math.round(1000 / average));
          this.frame().nativeElement.textContent = average.toFixed(2);
          lastUpdate = time;
        }
      };
      id = requestAnimationFrame(loop);
      destroyRef.onDestroy(() => cancelAnimationFrame(id));
    });
  }
}
