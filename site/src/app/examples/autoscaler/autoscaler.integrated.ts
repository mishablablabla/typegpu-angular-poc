import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { common } from 'typegpu';
import { TgpuCanvas, TgpuReady, TypeGpu, injectBuffer, injectFrame, injectReadonly, injectRoot, injectUniform } from '@typegpu-poc/angular';
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

/** The GPU part. It calls `injectRoot()`, so it only exists behind `*tgpuReady`. */
@Component({
  selector: 'app-autoscaler-scene',
  imports: [TgpuCanvas, AutoscalerPanel],
  template: `
    <app-autoscaler-panel
      [snapshot]="snapshot()"
      [service]="selected()?.service ?? -1"
      [node]="selected()?.node ?? -1"
      [aspect]="aspect()"
      [cursor]="hovered() === undefined ? 'default' : 'pointer'"
      (pick)="selected.set({ service: $event, node: $event })"
    >
      <canvas role="img" aria-label="Autoscaler: a map of cloud services, replicas and the requests streaming between them, drawn on the GPU" [tgpuCanvas]="canvasOptions" (pointermove)="hover($event)" (pointerleave)="hovered.set(undefined)" (click)="select($event)">Autoscaler: a map of cloud services, replicas and the requests streaming between them, drawn on the GPU</canvas>
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

  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);
  private readonly reduced = injectReducedMotion();
  /** The canvas follows its CSS size, with a limit on the pixel ratio. */
  protected readonly canvasOptions = { maxPixelRatio: MAX_PIXEL_RATIO };

  // Application state: the simulated platform as a signal of immutable snapshots, and what the pointer is on.
  private sim = new PlatformSimulator();
  protected readonly snapshot = signal(this.sim.snapshot());
  protected readonly selected = signal<Selection | undefined>(undefined);
  protected readonly hovered = signal<number | undefined>(undefined);
  protected readonly aspect = computed(() => {
    const size = this.canvas().size();
    return size ? size.width / size.height : 1.78;
  });

  // GPU resources, each owned by this component. The map follows the snapshot: one readonly buffer for the nodes, one for the links.
  private readonly particles = injectBuffer(Particles).$usage('storage');
  private readonly light = injectBuffer(Accum).$usage('storage');
  private readonly shown = injectBuffer(Shown).$usage('storage');
  private readonly nodes = injectReadonly(Nodes, { from: computed(() => nodesData(this.snapshot())) });
  private readonly edges = injectReadonly(Edges, { from: computed(() => edgesData(this.snapshot())) });
  private readonly view = injectUniform(View, {
    from: computed(() => viewData(this.canvas().size(), this.selected()?.node, this.hovered())),
  });
  private readonly clock = injectUniform(Clock);

  // A compute pass moves the requests, another fades the light, and a render pass draws the map over it.
  private readonly move = this.root.createGuardedComputePipeline(
    particleKernel(this.particles.as('mutable'), this.nodes, this.edges, this.light.as('mutable'), this.view, this.clock),
  );
  private readonly resolve = this.root.createGuardedComputePipeline(resolveKernel(this.light.as('mutable'), this.shown.as('mutable'), this.clock));
  private readonly draw = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: mapFragment(this.shown.as('readonly'), this.nodes, this.edges, this.view, this.clock),
  });

  private seen: { failure: number; reset: number } | undefined;

  constructor() {
    injectFrame(({ deltaSeconds, elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      const dt = Math.min(deltaSeconds, 0.05);

      // The buttons count clicks. Reset starts over and puts the controls back; the failure crashes a replica of what is selected.
      if (this.seen && this.reset() !== this.seen.reset) {
        this.sim = new PlatformSimulator();
        this.snapshot.set(this.sim.snapshot());
        this.selected.set(undefined);
        this.setParam()('traffic', DEFAULTS.traffic);
        this.setParam()('policy', DEFAULTS.policy);
      } else if (this.seen && this.failure() !== this.seen.failure) {
        const target = this.selected();
        const service = target?.service ?? SERVICES.findIndex((s) => s.id === 'api');
        const slot = target && target.node >= SERVICE_COUNT ? target.node - SERVICE_COUNT - SLOT_BASE[service]! : undefined;
        this.sim.injectFailure(service, slot);
        this.snapshot.set(this.sim.snapshot());
      }
      this.seen = { failure: this.failure(), reset: this.reset() };

      // The platform moves on by its own clock; the snapshot signal feeds the GPU.
      if (this.sim.advance(Math.min(deltaSeconds, 0.25), this.traffic(), this.policy() as PolicyName)) this.snapshot.set(this.sim.snapshot());

      this.clock.write({ time: elapsedSeconds, dt, decay: trailDecay(dt), slow: this.reduced() ? 1 : 0 });
      this.move.dispatchThreads(PARTICLES);
      this.resolve.dispatchThreads(GRID_W, GRID_H);
      this.draw.withColorAttachment({ view: context }).draw(3);
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
  selector: 'app-autoscaler',
  imports: [AutoscalerScene, TgpuReady],
  template: `
    <app-autoscaler-scene
      *tgpuReady="let root; else fallback"
      [traffic]="traffic()" [policy]="policy()" [failure]="failure()" [reset]="reset()" [setParam]="setParam()"
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
export class AutoscalerIntegrated {
  readonly traffic = input.required<number>();
  readonly policy = input.required<string>();
  readonly failure = input.required<number>();
  readonly reset = input.required<number>();
  readonly setParam = input.required<(key: string, value: string | number) => void>();
  protected readonly gpu = inject(TypeGpu);
}
