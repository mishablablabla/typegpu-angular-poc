// The interface around the canvas in RISK FIELD: the title and what it shows, the axis labels, the inspector and the
// colour scale. It is plain Angular with no GPU in it, and both implementations of the example use it; the canvas is
// projected behind it.
import { Component, computed, input } from '@angular/core';
import {
  HEIGHT,
  HEIGHT_SCALE,
  WMAX,
  effective,
  projectToCanvas,
  risk,
  toWorld,
  type Vec3,
  type RiskState,
} from './risk-field.model';

interface Label {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

@Component({
  selector: 'app-risk-field-panel',
  template: `
    <div class="stage" [style.cursor]="cursor()">
      <ng-content />
      <header>
        <h2>RISK FIELD</h2>
        <p>Synthetic one-day 99% value-at-risk of a two-asset portfolio. An illustrative model, not a prediction of real losses.</p>
      </header>

      @for (label of labels(); track $index) {
        <span class="axis" [style.left.%]="label.x" [style.top.%]="label.y">{{ label.text }}</span>
      }

      <aside class="inspector" aria-label="Selected allocation">
        <div class="row head"><span>Allocation</span><b>{{ selected().a.toFixed(2) }} A · {{ selected().b.toFixed(2) }} B</b></div>
        <div class="value" [class.high]="selectedRisk() > 14" [class.severe]="selectedRisk() > 24">
          {{ selectedRisk().toFixed(1) }}<small>% of capital</small>
        </div>
        <div class="row detail"><span>Each alone</span><b>A {{ alone().a.toFixed(1) }}% · B {{ alone().b.toFixed(1) }}%</b></div>
        <div class="row detail"><span>Together vs the sum</span><b [class.good]="together() < 0">{{ together() > 0 ? '+' : '' }}{{ together() }}%</b></div>
        <div class="row detail"><span>Volatility</span><b>{{ volatility() }}% a year · {{ scenario() }}</b></div>
        <div class="row detail"><span>Correlation</span><b>{{ effectiveRho() }}</b></div>
        <div class="row hover">
          <span>Under the pointer</span>
          <b>@if (hover(); as h) { {{ h.a.toFixed(2) }} / {{ h.b.toFixed(2) }} → {{ hoverRisk().toFixed(1) }}% } @else { — }</b>
        </div>
      </aside>

      <footer>
        <div class="scale" aria-hidden="true"><span>0%</span><i></i><span>{{ scaleTop() }}%+</span></div>
        <p class="hints" [class.quiet]="used()">
          <span>Floor: weight in asset A × weight in asset B (negative is short). The valley is the hedge</span>
          <span>Height and colour: VaR</span>
          <span>Drag to orbit · scroll to zoom · click to inspect</span>
        </p>
      </footer>
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; background: #010307; color: #d9ecff; container-type: size; container-name: risk; }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
    .stage ::ng-deep canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: inherit; touch-action: none; }
    header { position: absolute; top: 1.1rem; left: 1.25rem; max-width: 20rem; pointer-events: none; }
    h2 { margin: 0; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.42em; color: #e9f6ff; text-shadow: 0 0 18px rgb(80 190 255 / 0.5); }
    header p { margin: 0.35rem 0 0; font-size: 0.6875rem; line-height: 1.5; color: rgb(170 205 235 / 0.6); }
    .axis { position: absolute; transform: translate(-50%, -50%); font-family: var(--sl-font-mono); font-size: 0.625rem; letter-spacing: 0.04em; color: rgb(170 210 245 / 0.7); text-shadow: 0 0 8px #000; pointer-events: none; white-space: nowrap; }
    .inspector {
      position: absolute; top: 1.1rem; right: 1.1rem; width: 14.5rem; padding: 0.7rem 0.8rem;
      border: 1px solid rgb(120 190 255 / 0.18); border-radius: 10px; background: rgb(6 12 24 / 0.62); backdrop-filter: blur(12px);
      font-size: 0.6875rem; line-height: 1.4; pointer-events: none;
    }
    .row { display: flex; justify-content: space-between; gap: 0.6rem; padding: 2px 0; color: rgb(160 195 225 / 0.7); }
    .row b { font-weight: 500; color: #dbeeff; text-align: right; }
    .row.head { padding-bottom: 0.15rem; }
    .row.hover { margin-top: 0.15rem; border-top: 1px solid rgb(255 255 255 / 0.08); padding-top: 0.35rem; }
    .value { font-family: var(--sl-font-mono); font-size: 1.75rem; line-height: 1.15; color: #6fdcff; font-variant-numeric: tabular-nums; }
    .value small { margin-left: 0.4rem; font-size: 0.625rem; color: rgb(160 195 225 / 0.7); }
    .value.high { color: #ffc760; } .value.severe { color: #ff7a63; }
    .row b.good { color: #5fe9d6; }
    footer { position: absolute; left: 1.25rem; right: 1.25rem; bottom: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; pointer-events: none; }
    .scale { display: flex; align-items: center; gap: 0.5rem; width: 12rem; font-family: var(--sl-font-mono); font-size: 0.625rem; color: rgb(170 205 235 / 0.7); }
    .scale i { flex: 1; height: 5px; border-radius: 3px; background: linear-gradient(90deg, #04114a, #0d4d9e 25%, #1fc7f2 50%, #f5c766 72%, #fa4d38); }
    .hints { margin: 0; display: flex; flex-wrap: wrap; gap: 0.2rem 1.1rem; font-size: 0.6875rem; letter-spacing: 0.04em; color: rgb(170 205 235 / 0.75); transition: opacity 1.4s ease; }
    .hints span::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 0.5rem; border-radius: 50%; background: #5cc8ff; vertical-align: middle; box-shadow: 0 0 6px #5cc8ff; }
    .hints.quiet { opacity: 0.3; }
    @media (prefers-reduced-motion: reduce) { .hints { transition: none; } }
    @container risk (max-width: 36rem) {
      header p { display: none; }
      .inspector { top: 0.7rem; right: 0.7rem; width: 10.5rem; padding: 0.5rem 0.6rem; }
      .inspector .detail { display: none; }
      .value { font-size: 1.35rem; }
      .hints span:first-child { display: none; }
    }
  `,
})
export class RiskFieldPanel {
  readonly state = input.required<RiskState>();
  readonly volatility = input.required<number>();
  readonly correlation = input.required<number>();
  readonly scenario = input.required<string>();
  /** Canvas width over height, for placing the labels over the picture. */
  readonly aspect = input.required<number>();
  readonly cursor = input.required<string>();

  protected readonly used = computed(() => this.state().used);
  protected readonly selected = computed(() => this.state().selected);
  protected readonly hover = computed(() => this.state().hover);
  private readonly target = computed(() => effective(this.volatility(), this.correlation(), this.scenario()));
  protected readonly effectiveRho = computed(() => this.target().rho.toFixed(2));
  protected readonly selectedRisk = computed(() => risk(this.selected().a, this.selected().b, this.target()));
  protected readonly hoverRisk = computed(() => {
    const h = this.hover();
    return h ? risk(h.a, h.b, this.target()) : 0;
  });
  protected readonly scaleTop = computed(() => Math.round(-HEIGHT_SCALE * Math.log(1 - 0.95)));
  /** The risk of each position held alone, and what holding both does to the sum of the two. */
  protected readonly alone = computed(() => ({ a: risk(this.selected().a, 0, this.target()), b: risk(0, this.selected().b, this.target()) }));
  protected readonly together = computed(() => {
    const { a, b } = this.alone();
    return a + b > 0 ? Math.round((this.selectedRisk() / (a + b) - 1) * 100) : 0;
  });

  /** Axis names and ends, projected from the scene onto the canvas. */
  protected readonly labels = computed<Label[]>(() => {
    const camera = this.state().camera;
    const aspect = this.aspect();
    const at = (text: string, p: Vec3): Label[] => {
      const spot = projectToCanvas(camera, aspect, p);
      return spot ? [{ text, ...spot }] : [];
    };
    return [
      ...at('weight in A →', [0, 0, 1.28]),
      ...at('weight in B →', [1.28, 0, 0]),
      ...at('−1', [toWorld(-WMAX) - 0.05, 0, 1.12]),
      ...at('+1', [toWorld(WMAX) + 0.05, 0, 1.12]),
      ...at('−1', [1.12, 0, toWorld(-WMAX) - 0.05]),
      ...at('+1', [1.12, 0, toWorld(WMAX) + 0.05]),
      ...at('VaR', [-1, HEIGHT + 0.12, -1]),
    ];
  });
}
