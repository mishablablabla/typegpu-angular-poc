import { Component, computed, input, viewChild } from '@angular/core';
import { common, d } from 'typegpu';
import { TgpuCanvas, injectFrame, injectRoot, injectUniform } from '@typegpu-poc/angular';
import { gradientFragment } from '../shaders/gradient.gpu';

/** hue in degrees -> rgb tint */
const tintOf = (hue: number) => d.vec3f(hue / 360, 1 - hue / 360, 0.6);

@Component({
  selector: 'app-gradient',
  imports: [TgpuCanvas],
  template: `<canvas tgpuCanvas></canvas>`,
  styles: `canvas { width: 100%; height: 240px; display: block; background: #111; }`,
})
export class Gradient {
  readonly hue = input.required<number>();

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);

  // Owned by this component: destroyed with it.
  private readonly time = injectUniform(d.f32);
  // Mirrors the signal: sampled once per frame, written only when the value changed.
  private readonly tint = injectUniform(d.vec3f, { from: computed(() => tintOf(this.hue())) });

  private readonly pipeline = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: gradientFragment(this.time, this.tint),
  });

  constructor() {
    injectFrame(({ elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.time.write(elapsedSeconds);
      this.pipeline.withColorAttachment({ view: context }).draw(3);
    });
  }
}
