import { Component, computed, inject, input, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectFrame, injectMutable, injectRoot, injectUniform } from '@typegpu-poc/angular';
import { Brush, Cells, GRID, commitKernel, emptyCells, lifeFragment, paintKernel, randomCells, stepKernel } from './life.gpu';

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-life-scene',
  imports: [TgpuCanvas],
  template: `
    <canvas role="img" aria-label="Game of Life: a grid of living and dead cells, simulated and drawn on the GPU"
      tgpuCanvas
      (pointerdown)="paint($event)"
      (pointermove)="paint($event)"
    >Game of Life: a grid of living and dead cells, simulated and drawn on the GPU</canvas>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; image-rendering: pixelated; }
  `,
})
export class LifeScene {
  readonly running = input.required<boolean>();
  readonly speed = input.required<number>();
  readonly brush = input.required<number>();
  readonly edges = input.required<string>();
  readonly stepOnce = input.required<number>();
  readonly randomize = input.required<number>();
  readonly clear = input.required<number>();

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);

  // Two generations, as read-write storage bindings. Each is owned by this component and destroyed with it.
  private readonly current = injectMutable(Cells, { initial: randomCells() });
  private readonly next = injectMutable(Cells);
  // `wrap` follows a signal; `brushUniform` is written when the pointer paints.
  private readonly wrap = injectUniform(d.u32, { from: computed(() => (this.edges() === 'wrap around' ? 1 : 0)) });
  private readonly brushUniform = injectUniform(Brush);

  // The compute passes use the bindings as they are; the fragment shader sees the same buffer read-only.
  private readonly step = this.root.createGuardedComputePipeline(stepKernel(this.current, this.next, this.wrap));
  private readonly commit = this.root.createGuardedComputePipeline(commitKernel(this.current, this.next));
  private readonly paintCells = this.root.createGuardedComputePipeline(paintKernel(this.current, this.brushUniform));
  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: lifeFragment(this.current.buffer.as('readonly')),
  });

  private readonly pending: { x: number; y: number; erase: boolean }[] = [];
  private owed = 0;
  private seen: { step: number; randomize: number; clear: number } | undefined;

  constructor() {
    injectFrame(({ deltaSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;

      // Buttons count clicks: act when a counter moved since the last frame.
      const clicks = { step: this.stepOnce(), randomize: this.randomize(), clear: this.clear() };
      let generations = 0;
      if (this.seen) {
        if (clicks.step !== this.seen.step) generations++;
        if (clicks.randomize !== this.seen.randomize) this.current.write(randomCells());
        if (clicks.clear !== this.seen.clear) this.current.write(emptyCells());
      }
      this.seen = clicks;

      // Paint every point the pointer visited since the last frame.
      for (const point of this.pending.splice(0)) {
        this.brushUniform.write({ center: d.vec2f(point.x, point.y), radius: this.brush(), value: point.erase ? 0 : 1 });
        this.paintCells.dispatchThreads(GRID, GRID);
      }

      // Run the simulation at `speed` generations per second.
      if (this.running()) {
        this.owed = Math.min(this.owed + deltaSeconds * this.speed(), 8);
        generations += Math.floor(this.owed);
        this.owed -= Math.floor(this.owed);
      } else {
        this.owed = 0;
      }
      for (let i = 0; i < generations; i++) {
        this.step.dispatchThreads(GRID, GRID);
        this.commit.dispatchThreads(GRID, GRID);
      }
      this.draw.withColorAttachment({ view: context }).draw(3);
    });
  }

  /** Dragging with the primary button draws; holding Shift erases. */
  protected paint(event: PointerEvent): void {
    if ((event.buttons & 1) === 0) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.pending.push({
      x: ((event.clientX - rect.left) / rect.width) * GRID,
      y: ((event.clientY - rect.top) / rect.height) * GRID,
      erase: event.shiftKey,
    });
  }
}

@Component({
  selector: 'app-life',
  imports: [LifeScene, TgpuReady],
  template: `
    <app-life-scene
      *tgpuReady="let root; else fallback"
      [running]="running()" [speed]="speed()" [brush]="brush()" [edges]="edges()"
      [stepOnce]="stepOnce()" [randomize]="randomize()" [clear]="clear()"
    />
    <ng-template #fallback let-state>
      @switch (state.status) {
        @case ('unsupported') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">WebGPU is not available</p><p>This example needs WebGPU. Try a recent Chrome or Edge.</p></div>
        }
        @case ('failed') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">GPU initialization failed</p><button type="button" (click)="gpu.retry()">Retry</button></div>
        }
        @case ('lost') {
          <div class="gpu-notice" role="alert"><p class="gpu-notice-title">The GPU device was lost</p><button type="button" (click)="gpu.retry()">Reconnect</button></div>
        }
        @default {
          <div class="gpu-spinner" role="status"><span class="sr-only">Starting the GPU…</span></div>
        }
      }
    </ng-template>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class LifeIntegrated {
  readonly running = input.required<boolean>();
  readonly speed = input.required<number>();
  readonly brush = input.required<number>();
  readonly edges = input.required<string>();
  readonly stepOnce = input.required<number>();
  readonly randomize = input.required<number>();
  readonly clear = input.required<number>();
  protected readonly gpu = inject(TypeGpu);
}
