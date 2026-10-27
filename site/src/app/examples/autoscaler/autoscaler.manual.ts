import {
  Component,
  DestroyRef,
  ElementRef,
  ErrorHandler,
  NgZone,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { common } from 'typegpu';
import { ManualGpu } from '../manual/manual-gpu';
import { Accum, Clock, Edges, Nodes, Particles, Shown, View, mapFragment, particleKernel, resolveKernel } from './autoscaler.gpu';
import { AutoscalerPanel } from './autoscaler.panel';
import {
  DEFAULTS,
  GRID_H,
  GRID_W,
  MAX_PIXEL_RATIO,
  PARTICLES,
  PlatformSimulator,
  SERVICES,
  SERVICE_COUNT,
  SLOT_BASE,
  hitTest,
  type PlatformSnapshot,
  type PolicyName,
} from './autoscaler.model';
import { edgesData, nodesData, viewData } from './autoscaler.uniforms';
import { trailDecay } from './autoscaler.motion';
import { injectReducedMotion } from '../../shared/reduced-motion';

/** What is selected on the map: a service (`node` is the service) or one replica of it (`node` is its slot's node). */
interface Selection {
  readonly service: number;
  readonly node: number;
}

/** The GPU part. It must only exist while the root is ready; the host below guarantees that. */
@Component({
  selector: 'app-autoscaler-scene-manual',
  imports: [AutoscalerPanel],
  template: `
    <app-autoscaler-panel
      [snapshot]="snapshot()"
      [service]="selected()?.service ?? -1"
      [node]="selected()?.node ?? -1"
      [aspect]="aspect()"
      [cursor]="hovered() === undefined ? 'default' : 'pointer'"
      (pick)="selected.set({ service: $event, node: $event })"
    >
      <canvas role="img" aria-label="Autoscaler: a map of cloud services, replicas and the requests streaming between them, drawn on the GPU" #canvas (pointermove)="hover($event)" (pointerleave)="hovered.set(undefined)" (click)="select($event)">Autoscaler: a map of cloud services, replicas and the requests streaming between them, drawn on the GPU</canvas>
    </app-autoscaler-panel>
  `,
  styles: `:host { display: block; width: 100%; height: 100%; }`,
})
export class AutoscalerScene {
  readonly traffic = input.required<number>();
  readonly policy = input.required<string>();
  readonly failure = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  // Application state: the simulated platform as a signal of immutable snapshots, and what the pointer is on.
  private sim = new PlatformSimulator();
  protected readonly snapshot = signal(this.sim.snapshot());
  protected readonly selected = signal<Selection | undefined>(undefined);
  protected readonly hovered = signal<number | undefined>(undefined);
  protected readonly aspect = signal(1.78);

  constructor() {
    const gpu = inject(ManualGpu).state();
    if (gpu.status !== 'ready') throw new Error('AutoscalerScene must only exist while the GPU is ready');
    const { root } = gpu;
    const zone = inject(NgZone);
    const errors = inject(ErrorHandler);
    const destroyRef = inject(DestroyRef);
    const reduced = injectReducedMotion();

    // Resources, and their cleanup.
    const particles = root.createBuffer(Particles).$usage('storage');
    const light = root.createBuffer(Accum).$usage('storage');
    const shown = root.createBuffer(Shown).$usage('storage');
    const nodes = root.createReadonly(Nodes, nodesData(this.snapshot()));
    const edges = root.createReadonly(Edges, edgesData(this.snapshot()));
    const view = root.createUniform(View);
    const clock = root.createUniform(Clock);
    destroyRef.onDestroy(() => {
      particles.destroy();
      light.destroy();
      shown.destroy();
      nodes.buffer.destroy();
      edges.buffer.destroy();
      view.buffer.destroy();
      clock.buffer.destroy();
    });

    // A compute pass moves the requests, another fades the light, and a render pass draws the map over it.
    const move = root.createGuardedComputePipeline(particleKernel(particles.as('mutable'), nodes, edges, light.as('mutable'), view, clock));
    const resolve = root.createGuardedComputePipeline(resolveKernel(light.as('mutable'), shown.as('mutable'), clock));
    const draw = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: mapFragment(shown.as('readonly'), nodes, edges, view, clock),
    });

    // Canvas context and pixel size: browser only, after the view exists.
    let context: GPUCanvasContext | undefined;
    let size = { width: 1, height: 1 };
    afterNextRender(() => {
      const canvas = this.canvasRef().nativeElement;
      context = root.configureContext({ canvas });
      const observer = new ResizeObserver(([entry]) => {
        const box = entry?.contentBoxSize[0];
        if (!box) return;
        // CSS pixels times the pixel ratio, but never more than the limit.
        const scale = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
        canvas.width = Math.max(1, Math.round(box.inlineSize * scale));
        canvas.height = Math.max(1, Math.round(box.blockSize * scale));
        size = { width: canvas.width, height: canvas.height };
        this.aspect.set(size.width / size.height);
      });
      observer.observe(canvas);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    // Render loop: outside the zone, stopped on destroy, errors reported once.
    let frameId = 0;
    let stopped = false;
    let start: number | undefined;
    let last: number | undefined;
    let seen: { failure: number; reset: number } | undefined;
    let uploaded: PlatformSnapshot | undefined;
    let lastView = '';
    const frame = (now: number) => {
      if (stopped) return;
      frameId = requestAnimationFrame(frame);
      try {
        start ??= now;
        const elapsed = (now - start) / 1000;
        const deltaSeconds = last === undefined ? 0 : (now - last) / 1000;
        last = now;
        if (!context) return;
        const dt = Math.min(deltaSeconds, 0.05);

        // The buttons count clicks. Reset starts over and puts the controls back; the failure crashes a replica of what is selected.
        if (seen && this.reset() !== seen.reset) {
          this.sim = new PlatformSimulator();
          this.snapshot.set(this.sim.snapshot());
          this.selected.set(undefined);
          this.setParam()('traffic', DEFAULTS.traffic);
          this.setParam()('policy', DEFAULTS.policy);
        } else if (seen && this.failure() !== seen.failure) {
          const target = this.selected();
          const service = target?.service ?? SERVICES.findIndex((s) => s.id === 'api');
          const slot = target && target.node >= SERVICE_COUNT ? target.node - SERVICE_COUNT - SLOT_BASE[service]! : undefined;
          this.sim.injectFailure(service, slot);
          this.snapshot.set(this.sim.snapshot());
        }
        seen = { failure: this.failure(), reset: this.reset() };

        // The platform moves on by its own clock.
        if (this.sim.advance(Math.min(deltaSeconds, 0.25), this.traffic(), this.policy() as PolicyName)) this.snapshot.set(this.sim.snapshot());

        // Mirror the state into the resources, writing only what changed.
        const snapshot = this.snapshot();
        if (snapshot !== uploaded) {
          uploaded = snapshot;
          nodes.write(nodesData(snapshot));
          edges.write(edgesData(snapshot));
        }
        const key = `${size.width}x${size.height}|${this.selected()?.node}|${this.hovered()}`;
        if (key !== lastView) {
          lastView = key;
          view.write(viewData(size, this.selected()?.node, this.hovered()));
        }
        clock.write({ time: elapsed, dt, decay: trailDecay(dt), slow: reduced() ? 1 : 0 });

        move.dispatchThreads(PARTICLES);
        resolve.dispatchThreads(GRID_W, GRID_H);
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

  protected hover(event: PointerEvent): void {
    const { u, v } = this.point(event);
    this.hovered.set(hitTest(this.snapshot(), u, v, this.aspect())?.node);
  }

  protected select(event: MouseEvent): void {
    const { u, v } = this.point(event);
    const hit = hitTest(this.snapshot(), u, v, this.aspect());
    this.selected.update((current) => (hit && current?.node !== hit.node ? hit : undefined));
  }

  private point(event: MouseEvent): { u: number; v: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { u: (event.clientX - rect.left) / rect.width, v: (event.clientY - rect.top) / rect.height };
  }
}

@Component({
  selector: 'app-autoscaler-manual',
  imports: [AutoscalerScene],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') {
        <app-autoscaler-scene-manual
          [traffic]="traffic()" [policy]="policy()" [failure]="failure()" [reset]="reset()" [setParam]="setParam()"
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
export class AutoscalerManual {
  readonly traffic = input.required<number>();
  readonly policy = input.required<string>();
  readonly failure = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();
  protected readonly gpu = inject(ManualGpu);
}
