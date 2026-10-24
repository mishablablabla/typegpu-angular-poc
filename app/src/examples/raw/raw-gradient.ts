// "Before": the same gradient, written against TypeGPU and Angular directly.
import {
  Component,
  DestroyRef,
  ElementRef,
  ErrorHandler,
  NgZone,
  afterNextRender,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import tgpu, { common, d } from 'typegpu';
import { RawGpu, type RawGpuState } from './raw-gpu';

@Component({
  selector: 'app-raw-gradient',
  template: `<canvas #canvas></canvas>`,
  styles: `canvas { width: 100%; height: 240px; display: block; background: #111; }`,
})
export class RawGradient {
  readonly hue = input.required<number>();
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    const state = inject(RawGpu).state();
    if (state.status !== 'ready') throw new Error('RawGradient must only exist while the GPU is ready');
    const { root } = state;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);

    // Resources, and their cleanup.
    const time = root.createUniform(d.f32);
    const tint = root.createUniform(d.vec3f);
    destroyRef.onDestroy(() => {
      time.buffer.destroy();
      tint.buffer.destroy();
    });

    const pipeline = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })`{
        return vec4f(in.uv * (0.5 + 0.5 * sin(time)), 0.3, 1) * vec4f(tint, 1);
      }`.$uses({ time, tint }),
    });

    const wanted = computed(() => {
      const h = this.hue() / 360;
      return d.vec3f(h, 1 - h, 0.6);
    });

    // Canvas context and resizing: browser only, after the view exists.
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

    // Render loop outside the zone, stopped on destroy, errors reported once.
    let frameId = 0;
    let stopped = false;
    let start: number | undefined;
    let lastTint: unknown;
    const frame = (now: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        start ??= now;
        const next = wanted();
        if (next !== lastTint) {
          lastTint = next;
          tint.write(next);
        }
        if (!context) return;
        time.write((now - start) / 1000);
        pipeline.withColorAttachment({ view: context }).draw(3);
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
}

export type { RawGpuState };
