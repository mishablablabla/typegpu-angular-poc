// The little interface around the canvas in THE CORE: a title, the label that says what this is, and the hints. It is plain
// Angular with no GPU in it, and both implementations of the example use it; the canvas is projected behind it.
import { Component, input } from '@angular/core';

@Component({
  selector: 'app-core-panel',
  template: `
    <div class="stage" [style.cursor]="cursor()">
      <ng-content />
      <header>
        <h2>THE CORE</h2>
        <p>An artistic, interactive plasma simulation. Not a model of real fusion physics.</p>
      </header>
      <p class="hints" [class.quiet]="used()" aria-live="polite">
        <span>Drag the space to orbit</span>
        <span>Scroll to zoom</span>
        <span>Sweep across the plasma to disturb it</span>
        <span>Press and drag on it to steer</span>
      </p>
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; height: 100%; background: #010204; color: #d9ecff; container-type: size; container-name: core; }
    .stage { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
    .stage ::ng-deep canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: inherit; touch-action: none; }
    header { position: absolute; top: 1.1rem; left: 1.25rem; right: 1.25rem; pointer-events: none; }
    h2 { margin: 0; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.42em; color: #e9f6ff; text-shadow: 0 0 18px rgb(80 190 255 / 0.55); }
    header p { margin: 0.35rem 0 0; max-width: 24rem; font-size: 0.6875rem; line-height: 1.5; letter-spacing: 0.02em; color: rgb(170 205 235 / 0.6); }
    .hints {
      position: absolute; left: 1.25rem; right: 1.25rem; bottom: 1rem; margin: 0;
      display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem;
      font-size: 0.6875rem; letter-spacing: 0.06em; color: rgb(170 205 235 / 0.75);
      pointer-events: none; transition: opacity 1.4s ease;
    }
    .hints span::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 0.5rem; border-radius: 50%; background: #5cc8ff; vertical-align: middle; box-shadow: 0 0 6px #5cc8ff; }
    .hints.quiet { opacity: 0.22; }
    @media (prefers-reduced-motion: reduce) { .hints { transition: none; } }
    @container core (max-width: 34rem) {
      header p { display: none; }
      .hints { gap: 0.15rem 0.9rem; }
      .hints span:nth-child(2) { display: none; }
    }
  `,
})
export class CorePanel {
  /** The CSS cursor over the canvas: grab over empty space, crosshair over the plasma. */
  readonly cursor = input.required<string>();
  /** Has the user already interacted? The hints fade to a whisper. */
  readonly used = input.required<boolean>();
}
