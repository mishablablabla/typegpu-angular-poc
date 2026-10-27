import {
  Component,
  DestroyRef,
  ElementRef,
  ErrorHandler,
  NgZone,
  afterNextRender,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { common, d } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
import { Brush, Cells, GRID, commitKernel, emptyCells, lifeFragment, paintKernel, randomCells, stepKernel } from './life.gpu';

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-life-scene-manual',
  template: `
    <canvas role="img" aria-label="Game of Life: a grid of living and dead cells, simulated and drawn on the GPU"
      #canvas
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
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly pending: { x: number; y: number; erase: boolean }[] = [];

  constructor() {
    const state = inject(ManualGpu).state();
    if (state.status !== 'ready') throw new Error('LifeScene must only exist while the GPU is ready');
    const { root } = state;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);

    // Resources, and their cleanup. Two generations, each a read-write storage binding.
    const current = root.createMutable(Cells, randomCells());
    const next = root.createMutable(Cells);
    const wrap = root.createUniform(d.u32);
    const brush = root.createUniform(Brush);
    destroyRef.onDestroy(() => {
      current.buffer.destroy();
      next.buffer.destroy();
      wrap.buffer.destroy();
      brush.buffer.destroy();
    });

    // The compute passes use the bindings as they are; the fragment shader sees the same buffer read-only.
    const step = root.createGuardedComputePipeline(stepKernel(current, next, wrap));
    const commit = root.createGuardedComputePipeline(commitKernel(current, next));
    const paintCells = root.createGuardedComputePipeline(paintKernel(current, brush));
    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: lifeFragment(current.buffer.as('readonly')),
    });

    // Canvas context and pixel size: browser only, after the view exists.
    let context: GPUCanvasContext | undefined;
    afterNextRender(() => {
      const canvas = this.canvasRef().nativeElement;
      context = root.configureContext({ canvas });
      const observer = new ResizeObserver(([entry]) => {
        const exact = entry?.devicePixelContentBoxSize?.[0];
        const box = exact ?? entry?.contentBoxSize[0];
        if (!box) return;
        const scale = exact ? 1 : devicePixelRatio;
        canvas.width = Math.max(1, Math.round(box.inlineSize * scale));
        canvas.height = Math.max(1, Math.round(box.blockSize * scale));
      });
      observer.observe(canvas);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    // Render loop: outside the zone, stopped on destroy, errors reported once.
    let frameId = 0;
    let stopped = false;
    let last: number | undefined;
    let owed = 0;
    let seen: { step: number; randomize: number; clear: number } | undefined;
    let writtenWrap: number | undefined;
    const frame = (now: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        if (!context) return;
        const deltaSeconds = last === undefined ? 0 : (now - last) / 1000;
        last = now;

        // Mirror the edge mode, writing only when it changed.
        const wantedWrap = this.edges() === 'wrap around' ? 1 : 0;
        if (wantedWrap !== writtenWrap) {
          writtenWrap = wantedWrap;
          wrap.write(wantedWrap);
        }

        // Buttons count clicks: act when a counter moved since the last frame.
        const clicks = { step: this.stepOnce(), randomize: this.randomize(), clear: this.clear() };
        let generations = 0;
        if (seen) {
          if (clicks.step !== seen.step) generations++;
          if (clicks.randomize !== seen.randomize) current.write(randomCells());
          if (clicks.clear !== seen.clear) current.write(emptyCells());
        }
        seen = clicks;

        // Paint every point the pointer visited since the last frame.
        for (const point of this.pending.splice(0)) {
          brush.write({ center: d.vec2f(point.x, point.y), radius: this.brush(), value: point.erase ? 0 : 1 });
          paintCells.dispatchThreads(GRID, GRID);
        }

        // Run the simulation at `speed` generations per second.
        if (this.running()) {
          owed = Math.min(owed + deltaSeconds * this.speed(), 8);
          generations += Math.floor(owed);
          owed -= Math.floor(owed);
        } else {
          owed = 0;
        }
        for (let i = 0; i < generations; i++) {
          step.dispatchThreads(GRID, GRID);
          commit.dispatchThreads(GRID, GRID);
        }
        draw.withColorAttachment({ view: context }).draw(3);
      } catch (error) {
        stopped = true;
        errors.handleError(error);
      }
    };
    zone.runOutsideAngular(() => (frameId = requestAnimationFrame(frame)));
    destroyRef.onDestroy(() => {
      stopped = true;
      cancelAnimationFrame(frameId);
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
  selector: 'app-life-manual',
  imports: [LifeScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-life-scene-manual
          [running]="running()" [speed]="speed()" [brush]="brush()" [edges]="edges()"
          [stepOnce]="stepOnce()" [randomize]="randomize()" [clear]="clear()"
        />
      }
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
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class LifeManual {
  readonly running = input.required<boolean>();
  readonly speed = input.required<number>();
  readonly brush = input.required<number>();
  readonly edges = input.required<string>();
  readonly stepOnce = input.required<number>();
  readonly randomize = input.required<number>();
  readonly clear = input.required<number>();
  protected readonly gpu = inject(ManualGpu);
}
