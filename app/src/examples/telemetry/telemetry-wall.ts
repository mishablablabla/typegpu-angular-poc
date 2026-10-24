import { Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import tgpu, { common, d } from 'typegpu';
import {
  TgpuCanvas,
  TypeGpu,
  TgpuReady,
  injectFrame,
  injectReadonly,
  injectRoot,
  injectUniform,
  type CanvasSize,
} from '@typegpu-poc/angular';
import { CHANNELS, CHANNEL_NAMES, SAMPLES, TelemetrySimulator } from './simulator';

const Params = d.struct({
  size: d.vec2f,
  channels: d.u32,
  count: d.u32,
  gain: d.f32,
  threshold: d.f32,
});

/** The GPU part: eight traces drawn in one fragment shader from a ring buffer in a storage buffer. */
@Component({
  selector: 'app-telemetry-canvas',
  imports: [TgpuCanvas],
  template: `<canvas tgpuCanvas (resized)="size.set($event)"></canvas>`,
  styles: `canvas { width: 100%; height: 440px; display: block; background: #04110a; border-radius: 6px; }`,
})
export class TelemetryCanvas {
  readonly gain = input.required<number>();
  readonly threshold = input.required<number>();
  readonly paused = input(false);
  /** Alarm state per channel; emitted only when it changes. */
  readonly alarms = output<boolean[]>();

  protected readonly size = signal<CanvasSize>({ width: 1, height: 1 });
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly sim = new TelemetrySimulator();

  private readonly root = injectRoot();
  private readonly samples = injectReadonly(d.arrayOf(d.f32, CHANNELS * SAMPLES));
  // Follows signals: written only when gain, threshold, canvas size... change.
  private readonly params = injectUniform(Params, {
    from: computed(() => ({
      size: d.vec2f(this.size().width, this.size().height),
      channels: CHANNELS,
      count: SAMPLES,
      gain: this.gain(),
      threshold: this.threshold(),
    })),
  });

  // Changes every frame, so it is written from the frame callback instead.
  private readonly head = injectUniform(d.u32);

  private readonly pipeline = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })`{
      let rows = f32(params.channels);
      let rowF = in.uv.y * rows;
      let channel = u32(floor(rowF));
      let local = fract(rowF);
      let x = in.uv.x * f32(params.count);
      let first = i32(floor(x));
      let rowPx = params.size.y / rows;
      var best = 1e9;
      var hot = false;
      for (var k: i32 = -3; k <= 3; k++) {
        let idx = u32(clamp(first + k, 0, i32(params.count) - 1));
        let s = samples[channel * params.count + ((head + idx) % params.count)];
        let dx = (x - (f32(idx) + 0.5)) * (params.size.x / f32(params.count));
        let dy = (local - (0.5 - 0.5 * s * params.gain)) * rowPx;
        let dist = sqrt(dx * dx + dy * dy);
        if (dist < best) { best = dist; hot = abs(s) > params.threshold; }
      }
      let line = 1.0 - smoothstep(0.8, 2.2, best);
      let baseline = 1.0 - smoothstep(0.0, 1.0, abs(local - 0.5) * rowPx);
      let sep = 1.0 - smoothstep(0.0, 1.0, min(local, 1.0 - local) * rowPx);
      let trace = select(vec3f(0.2, 1.0, 0.45), vec3f(1.0, 0.3, 0.25), hot);
      let color = vec3f(0.02, 0.07, 0.04) + baseline * vec3f(0.0, 0.12, 0.05) + sep * vec3f(0.0, 0.2, 0.1) + line * trace;
      return vec4f(color, 1);
    }`.$uses({ params: this.params, samples: this.samples, head: this.head }),
  });

  constructor() {
    const frame = injectFrame(({ deltaSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.sim.step(deltaSeconds, this.threshold());
      this.samples.write(this.sim.samples);
      this.head.write(this.sim.head);
      this.pipeline.withColorAttachment({ view: context }).draw(3);
      this.#publishAlarms();
    });
    // Freezing stops drawing and simulating; every resource stays alive.
    effect(() => (this.paused() ? frame.pause() : frame.resume()));
  }

  #last = '';
  #publishAlarms(): void {
    const next = this.sim.alarms();
    const key = next.map(Number).join('');
    if (key !== this.#last) {
      this.#last = key;
      this.alarms.emit(next);
    }
  }
}

/** The Angular part: ordinary signals, forms and template. */
@Component({
  selector: 'app-telemetry-wall',
  imports: [TelemetryCanvas, TgpuReady],
  template: `
    <section class="wall">
      <header>
        <h2>ICU bedside monitor (synthetic data)</h2>
        <label>gain <input type="range" min="0.5" max="2" step="0.05" [value]="gain()" (input)="gain.set(+$any($event.target).value)" /> {{ gain() }}</label>
        <label>alarm threshold <input type="range" min="0.5" max="1" step="0.05" [value]="threshold()" (input)="threshold.set(+$any($event.target).value)" /> {{ threshold() }}</label>
        <button (click)="paused.set(!paused())">{{ paused() ? 'Resume' : 'Freeze' }}</button>
      </header>
      <div class="body">
        <app-telemetry-canvas *tgpuReady="let root; else fallback" [gain]="gain()" [threshold]="threshold()" [paused]="paused()" (alarms)="alarms.set($event)" />
        <ul>
          @for (name of names; track name; let i = $index) {
            <li [class.alarm]="alarms()[i]">{{ name }} <b>{{ alarms()[i] ? 'ALARM' : 'ok' }}</b></li>
          }
        </ul>
      </div>
      <p class="count">{{ activeAlarms() }} active alarm(s)</p>
    </section>
    <ng-template #fallback let-state>
      <p class="gpu-message">{{ state.status === 'unsupported' ? 'WebGPU is not available in this browser.' : 'Connecting to the GPU...' }}</p>
    </ng-template>
  `,
  styles: `
    .wall { font-family: system-ui, sans-serif; background: #0b1511; color: #cfe; padding: 12px; border-radius: 8px; }
    header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .body { display: grid; grid-template-columns: 1fr 180px; gap: 12px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-rows: repeat(8, 1fr); }
    li { display: flex; justify-content: space-between; align-items: center; padding: 0 8px; border-bottom: 1px solid #1d3a2b; }
    li.alarm { background: #3b1410; color: #ff8a80; }
  `,
})
export class TelemetryWall {
  protected readonly names = CHANNEL_NAMES;
  protected readonly gain = signal(1);
  protected readonly threshold = signal(0.95);
  protected readonly paused = signal(false);
  protected readonly alarms = signal<boolean[]>(Array.from({ length: CHANNELS }, () => false));
  protected readonly activeAlarms = computed(() => this.alarms().filter(Boolean).length);
  protected readonly gpu = inject(TypeGpu);
}
