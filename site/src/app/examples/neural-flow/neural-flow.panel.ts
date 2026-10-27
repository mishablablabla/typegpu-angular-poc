// The little interface around the canvas in NEURAL FLOW: a title, the label that says what this is, the hints, and the
// inspector of the selected neuron. It is plain Angular with no GPU in it, and both implementations of the example use it;
// the canvas is projected behind it.
import { Component, computed, input } from '@angular/core';
import { NEURONS, describeNeuron } from './neural-flow.model';
import type { Activity } from './neural-flow.readback';

@Component({
  selector: 'app-neural-flow-panel',
  template: `
    <div class="stage" [style.cursor]="cursor()">
      <ng-content />
      <header>
        <h2>NEURAL FLOW</h2>
        <p>An illustrative brain model with synthetic activity. Not a diagnostic tool, not a validated neuroscience simulator.</p>
      </header>
      <div class="state" aria-live="polite">
        <span>{{ stateName() }}</span>
        <b>{{ firingPercent() }}% firing</b>
      </div>

      <aside class="inspector" aria-label="Selected neuron">
        @if (info(); as neuron) {
          <h3>{{ neuron.id }} <small>{{ neuron.kind }}</small></h3>
          <p class="region">{{ neuron.region }}</p>
          <dl>
            <dt>In</dt>
            <dd>{{ neuron.inActive }} <small>of {{ neuron.inTotal }} on</small></dd>
            <dt>Out</dt>
            <dd>{{ neuron.outActive }} <small>of {{ neuron.outTotal }} on</small></dd>
          </dl>
          <div class="bar" role="meter" aria-label="Activity" [attr.aria-valuenow]="levelPercent()" aria-valuemin="0" aria-valuemax="100">
            <i [style.width.%]="levelPercent()"></i>
          </div>
          <p class="foot">activity {{ levelPercent() }}%</p>
        } @else {
          <p class="empty">Click the brain: it fires, and the nearest neuron is inspected here.<br />{{ total }} neurons.</p>
        }
      </aside>

      <p class="hints" [class.quiet]="used()" aria-live="polite">
        <span>Click the brain to fire it, drag to keep stimulating</span>
        <span>Drag the empty space to orbit</span>
        <span>Scroll to zoom</span>
        <span>A click also selects the nearest neuron</span>
      </p>
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; background: #010204; color: #d9ecff; container-type: size; container-name: neural; }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
    .stage ::ng-deep canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: inherit; touch-action: none; }
    header { position: absolute; top: 1.1rem; left: 1.25rem; right: 1.25rem; pointer-events: none; }
    h2 { margin: 0; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.42em; color: #e9f6ff; text-shadow: 0 0 18px rgb(80 190 255 / 0.55); }
    header p { margin: 0.35rem 0 0; max-width: 25rem; font-size: 0.6875rem; line-height: 1.5; letter-spacing: 0.02em; color: rgb(170 205 235 / 0.6); }
    .state { position: absolute; top: 1.1rem; right: 1.25rem; display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; font-size: 0.6875rem; letter-spacing: 0.06em; color: rgb(170 205 235 / 0.7); pointer-events: none; }
    .state b { font-family: var(--sl-font-mono); font-weight: 500; color: #8fdcff; }
    .inspector {
      position: absolute; left: 1.25rem; top: 5.6rem; width: 12.5rem; padding: 0.7rem 0.8rem;
      border: 1px solid rgb(120 190 255 / 0.18); border-radius: 10px; background: rgb(4 9 18 / 0.62); backdrop-filter: blur(10px);
      font-size: 0.75rem; pointer-events: none;
    }
    .inspector h3 { margin: 0; font-family: var(--sl-font-mono); font-size: 0.875rem; font-weight: 500; color: #e9f6ff; }
    .inspector h3 small { margin-left: 0.4rem; font-family: var(--sl-font); font-size: 0.625rem; letter-spacing: 0.08em; text-transform: uppercase; color: #ffb45e; }
    .region { margin: 0.1rem 0 0.5rem; color: rgb(170 205 235 / 0.7); }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0 0 0.55rem; }
    dt { color: rgb(170 205 235 / 0.55); }
    dd { margin: 0; font-family: var(--sl-font-mono); color: #e9f6ff; }
    dd small { font-family: var(--sl-font); color: rgb(170 205 235 / 0.55); }
    .bar { height: 4px; border-radius: 2px; background: rgb(255 255 255 / 0.1); overflow: hidden; }
    .bar i { display: block; height: 100%; background: linear-gradient(90deg, #38b6ff, #bff0ff); transition: width 200ms; }
    .foot { margin: 0.3rem 0 0; font-size: 0.625rem; color: rgb(170 205 235 / 0.55); }
    .empty { margin: 0; line-height: 1.5; color: rgb(170 205 235 / 0.65); }
    .hints {
      position: absolute; left: 1.25rem; right: 1.25rem; bottom: 1rem; margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem;
      font-size: 0.6875rem; letter-spacing: 0.06em; color: rgb(170 205 235 / 0.75); pointer-events: none; transition: opacity 1.4s ease;
    }
    .hints span::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 0.5rem; border-radius: 50%; background: #5cc8ff; vertical-align: middle; box-shadow: 0 0 6px #5cc8ff; }
    .hints.quiet { opacity: 0.22; }
    @media (prefers-reduced-motion: reduce) { .hints, .bar i { transition: none; } }
    @container neural (max-width: 34rem) {
      header p { display: none; }
      .inspector { top: 4.4rem; width: 11rem; }
      .hints { gap: 0.15rem 0.9rem; }
      .hints span:nth-child(3) { display: none; }
    }
  `,
})
export class NeuralFlowPanel {
  /** The CSS cursor over the canvas: grab over empty space, crosshair over the brain. */
  readonly cursor = input.required<string>();
  /** Has the user already interacted? The hints fade to a whisper. */
  readonly used = input.required<boolean>();
  readonly selected = input.required<number>();
  readonly connectivity = input.required<number>();
  readonly stateName = input.required<string>();
  /** From the GPU, a few times a second. */
  readonly activity = input.required<Activity>();

  protected readonly total = NEURONS;
  protected readonly info = computed(() => (this.selected() >= 0 ? describeNeuron(this.selected(), this.connectivity()) : undefined));
  protected readonly levelPercent = computed(() => Math.round(this.activity().level * 100));
  protected readonly firingPercent = computed(() => Math.round(this.activity().firing * 100));
}
