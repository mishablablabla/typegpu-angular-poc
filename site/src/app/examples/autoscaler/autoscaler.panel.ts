// The heads-up display over the canvas in the Autoscaler example: service labels, the inspector, the timeline, the event
// log. It is plain Angular with no GPU in it, and both implementations of the example use it; the canvas is projected behind it.
import { Component, computed, input, output } from '@angular/core';
import {
  HEALTH_NAMES,
  MAX_RPS,
  SERVICES,
  CLIENT_POS,
  SERVICE_COUNT,
  SLOT_BASE,
  toCanvas,
  type Health,
  type PlatformSnapshot,
} from './autoscaler.model';

const HEALTH_CLASS = ['ok', 'warn', 'crit'] as const;

@Component({
  selector: 'app-autoscaler-panel',
  template: `
    <div class="stage" [style.cursor]="cursor()">
      <ng-content />

      <header>
        <h2>AUTOSCALER</h2>
        <p>A synthetic, deterministic model of autoscaling. Not a Kubernetes controller.</p>
        <p class="line">
          <span>{{ snapshot().policy }} policy</span>
          <span>{{ snapshot().replicas }} replicas</span>
          <span [class.bad]="snapshot().errorRate > 0.02">{{ errors() }} errors</span>
        </p>
      </header>

      @for (label of labels(); track label.id) {
        <button
          type="button"
          class="label"
          [class]="label.cls"
          [class.selected]="label.index === service()"
          [style.left.%]="label.left"
          [style.top.%]="label.top"
          [attr.aria-label]="label.name + ', ' + label.replicas + ' replicas'"
          (click)="pick.emit(label.index)"
        >
          <b>{{ label.name }}</b>
          <span>{{ label.replicas }}<small> / {{ label.max }}</small></span>
        </button>
      }

 <span class="clients" [style.left.%]="clients().left" [style.top.%]="clients().top">
        <b>Clients</b>
        <span>{{ rps() }} rps</span>
      </span>

      <aside class="events" aria-label="Events">
        @for (event of snapshot().events.slice(0, 4); track event.time + event.text) {
          <div [class]="healthClass(event.level)">{{ event.text }} <small>{{ ago(event.time) }}</small></div>
        }
      </aside>

      <section class="inspector" aria-label="Inspector">
        @if (inspected(); as s) {
          <div class="head">
            <strong>{{ s.name }}</strong>
            <span class="tag" [class]="s.cls">{{ s.health }}</span>
          </div>
          <p class="role">{{ s.role }}</p>
          <div class="bar" [attr.aria-label]="'Load ' + s.loadPercent + '%'"><i [style.width.%]="s.barPercent" [class]="s.cls"></i></div>
          <dl>
            <div><dt>Load</dt><dd>{{ s.loadPercent }}%</dd></div>
            <div><dt>Traffic</dt><dd>{{ s.offered }} / {{ s.capacity }} rps</dd></div>
            <div><dt>Replicas</dt><dd>{{ s.running }} up<ng-container> · {{ s.starting }} starting · {{ s.failed }} down</ng-container></dd></div>
            <div><dt>Dropped</dt><dd>{{ s.dropped }}%</dd></div>
            @if (s.replica) {
              <div class="replica"><dt>Replica {{ s.replica.name }}</dt><dd>{{ s.replica.state }}{{ s.replica.load }}</dd></div>
            }
          </dl>
        } @else {
          <p class="role">Click a service or a replica to inspect it. Select one, then press “Inject failure” to crash a replica of it.</p>
        }
      </section>

      <section class="timeline" aria-label="Traffic and replicas over the last minute">
        <svg viewBox="0 0 200 50" preserveAspectRatio="none">
          <polyline class="errors" [attr.points]="errorsLine()" />
          <polyline class="rps" [attr.points]="rpsLine()" />
          <polyline class="replicas" [attr.points]="replicasLine()" />
        </svg>
        <div class="legend"><span class="rps">traffic</span><span class="replicas">replicas</span><span class="errors">errors</span><span>last minute</span></div>
      </section>
    </div>
  `,
  styles: `
    :host {
      --ok: #3ccbff; --warn: #ffb347; --crit: #ff5560;
      --ink: #e8f2ff; --dim: #8fa3bf; --line: rgb(255 255 255 / 0.11);
      --glass: rgb(7 11 20 / 0.66);
      display: block; width: 100%; height: 100%; container-type: size; container-name: scaler;
      color: var(--ink); background: #02050b; font-size: 0.75rem; line-height: 1.3;
    }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
    .stage ::ng-deep canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: inherit; touch-action: none; }
    header { position: absolute; top: 1rem; left: 1.25rem; right: 1.25rem; pointer-events: none; }
    h2 { margin: 0; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.4em; color: #eaf6ff; text-shadow: 0 0 18px rgb(60 203 255 / 0.5); }
    header p { margin: 0.3rem 0 0; font-size: 0.6875rem; color: rgb(160 190 220 / 0.6); }
    header .line { display: flex; gap: 0.9rem; color: var(--dim); font-family: var(--sl-font-mono); }
    header .line .bad { color: var(--crit); }

    .label { position: absolute; transform: translate(-50%, 0.4rem); display: flex; flex-direction: column; align-items: center; padding: 1px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
    .label b { font-size: 0.6875rem; font-weight: 500; letter-spacing: 0.04em; }
    .label span { font-family: var(--sl-font-mono); font-size: 0.6875rem; color: var(--ok); }
    .label small { color: var(--dim); }
    .label.warn span { color: var(--warn); } .label.crit span { color: var(--crit); }
    .label:hover, .label.selected { background: var(--glass); border-color: var(--line); backdrop-filter: blur(8px); }

    .clients { position: absolute; transform: translate(-50%, 0.5rem); display: flex; flex-direction: column; align-items: center; pointer-events: none; }
    .clients b { font-size: 0.6875rem; font-weight: 500; letter-spacing: 0.04em; }
    .clients span { font-family: var(--sl-font-mono); font-size: 0.6875rem; color: #9ee6ff; }
    .events { position: absolute; top: 1rem; right: 1.25rem; display: flex; flex-direction: column; gap: 3px; align-items: flex-end; pointer-events: none; max-width: 16rem; }
    .events div { padding: 2px 8px; border-right: 2px solid var(--ok); background: var(--glass); backdrop-filter: blur(8px); font-size: 0.6875rem; text-align: right; }
    .events .warn { border-right-color: var(--warn); } .events .crit { border-right-color: var(--crit); }
    .events small { color: var(--dim); font-family: var(--sl-font-mono); margin-left: 4px; }

    .inspector { position: absolute; left: 1.25rem; bottom: 1rem; width: min(17rem, calc(100% - 2.5rem)); padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 10px; background: var(--glass); backdrop-filter: blur(12px); }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .head strong { font-size: 0.875rem; font-weight: 600; }
    .tag { padding: 1px 8px; border-radius: 999px; font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.08em; background: rgb(60 203 255 / 0.16); color: var(--ok); }
    .tag.warn { background: rgb(255 179 71 / 0.16); color: var(--warn); } .tag.crit { background: rgb(255 85 96 / 0.18); color: var(--crit); }
    .role { margin: 0.3rem 0 0; color: var(--dim); font-size: 0.6875rem; line-height: 1.45; }
    .bar { height: 4px; margin: 0.5rem 0; border-radius: 2px; background: rgb(255 255 255 / 0.08); overflow: hidden; }
    .bar i { display: block; height: 100%; max-width: 100%; background: var(--ok); transition: width 0.2s; }
    .bar i.warn { background: var(--warn); } .bar i.crit { background: var(--crit); }
    dl { margin: 0; display: grid; gap: 2px; }
    dl div { display: flex; justify-content: space-between; gap: 0.75rem; }
    dt { color: var(--dim); } dd { margin: 0; font-family: var(--sl-font-mono); font-variant-numeric: tabular-nums; text-align: right; }

    .timeline { position: absolute; right: 1.25rem; bottom: 1rem; width: min(15rem, 40%); padding: 0.4rem 0.6rem 0.3rem; border: 1px solid var(--line); border-radius: 10px; background: var(--glass); backdrop-filter: blur(12px); }
    .timeline svg { display: block; width: 100%; height: 3.2rem; overflow: visible; }
    .timeline polyline { fill: none; stroke-width: 1.4; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    polyline.rps { stroke: var(--ok); } polyline.replicas { stroke: var(--warn); } polyline.errors { stroke: var(--crit); stroke-width: 1; opacity: 0.8; }
    .legend { display: flex; flex-wrap: wrap; gap: 0 0.6rem; margin-top: 2px; color: var(--dim); font-size: 0.5625rem; }
    .legend .rps { color: var(--ok); } .legend .replicas { color: var(--warn); } .legend .errors { color: var(--crit); }

    @container scaler (max-width: 40rem) {
      header p:not(.line), .events { display: none; }
      .inspector { width: calc(100% - 2.5rem); bottom: 5.8rem; }
      .timeline { left: 1.25rem; right: 1.25rem; width: auto; }
      .timeline svg { height: 2.2rem; }
      .label small { display: none; }
      .label b, .clients b { font-size: 0.5625rem; }
      .label span, .clients span { font-size: 0.5625rem; }
    }
  `,
})
export class AutoscalerPanel {
  readonly snapshot = input.required<PlatformSnapshot>();
  /** The selected service, or -1; and the selected node (a service or one of its replicas), or -1. */
  readonly service = input.required<number>();
  readonly node = input.required<number>();
  /** Width over height of the canvas. */
  readonly aspect = input.required<number>();
  readonly cursor = input.required<string>();
  readonly pick = output<number>();

  protected readonly labels = computed(() => {
    const aspect = this.aspect();
    const { services } = this.snapshot();
    return SERVICES.map((def, index) => {
      const [left, top] = toCanvas(def.pos[0], def.pos[1] - 0.2, aspect);
      const stat = services[index]!;
      return {
        id: def.id,
        index,
        name: def.name,
        max: def.max,
        replicas: stat.running + stat.starting,
        cls: HEALTH_CLASS[stat.health],
        left: left * 100,
        top: top * 100,
      };
    });
  });

  protected readonly clients = computed(() => {
    const [left, top] = toCanvas(CLIENT_POS[0], CLIENT_POS[1] - 0.1, this.aspect());
    return { left: left * 100, top: top * 100 };
  });
  protected readonly rps = computed(() => Math.round(this.snapshot().rps));

  protected readonly errors = computed(() => `${(this.snapshot().errorRate * 100).toFixed(this.snapshot().errorRate > 0.1 ? 0 : 1)}%`);

  protected readonly inspected = computed(() => {
    const index = this.service();
    if (index < 0) return undefined;
    const def = SERVICES[index]!;
    const snapshot = this.snapshot();
    const stat = snapshot.services[index]!;
    let replica: { name: string; state: string; load: string } | undefined;
    const node = this.node();
    if (node >= SERVICE_COUNT) {
      const slot = node - SERVICE_COUNT - SLOT_BASE[index]!;
      const instance = snapshot.instances.find((i) => i.service === index && i.slot === slot);
      if (instance) {
        replica = {
          name: `${def.id}-${slot + 1}`,
          state: instance.state === 'failed' ? 'crashed' : instance.state,
          load: instance.state === 'running' ? ` · ${Math.round(instance.load * 100)}% busy` : '',
        };
      }
    }
    return {
      name: def.name,
      role: def.role,
      health: HEALTH_NAMES[stat.health],
      cls: HEALTH_CLASS[stat.health],
      loadPercent: Math.round(stat.load * 100),
      barPercent: Math.min(100, stat.load * 100),
      offered: Math.round(stat.offered),
      capacity: Math.round(stat.capacity),
      running: stat.running,
      starting: stat.starting,
      failed: stat.failed,
      dropped: Math.round(stat.drop * 100),
      replica,
    };
  });

  protected readonly rpsLine = computed(() => this.line((point) => point.rps / MAX_RPS));
  protected readonly replicasLine = computed(() => {
    const total = SERVICES.reduce((sum, def) => sum + def.max, 0);
    return this.line((point) => point.replicas / total);
  });
  protected readonly errorsLine = computed(() => this.line((point) => Math.min(1, point.errors * 2)));

  private line(value: (point: PlatformSnapshot['history'][number]) => number): string {
    const history = this.snapshot().history;
    return history.map((point, i) => `${(((i + 120 - history.length) / 119) * 200).toFixed(1)},${(47 - Math.min(1, value(point)) * 44).toFixed(1)}`).join(' ');
  }

  protected healthClass(level: Health): string {
    return HEALTH_CLASS[level];
  }

  protected ago(time: number): string {
    return `${Math.max(0, this.snapshot().time - time).toFixed(0)} s`;
  }
}
