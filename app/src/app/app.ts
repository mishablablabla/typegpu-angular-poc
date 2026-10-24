import { Component, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { TypeGpu } from '@typegpu-poc/angular';
import { GradientFeature } from '../examples/integrated/gradient-feature';
import { RawGradientFeature } from '../examples/raw/raw-gradient-feature';
import { TelemetryWall } from '../examples/telemetry/telemetry-wall';
import { SyncHost } from '../examples/sync-compare/sync-compare';

/** `?demo=raw` shows the hand-written "before" version of the same feature. */
@Component({
  selector: 'app-root',
  imports: [GradientFeature, RawGradientFeature, TelemetryWall, SyncHost],
  template: `
    <h1>TypeGPU + Angular</h1>
    <p id="status">gpu: {{ gpu.state().status }} ({{ raw ? 'raw' : 'integration' }})</p>
    <button id="toggle" (click)="show.set(!show())">{{ show() ? 'Unmount' : 'Mount' }}</button>
    <label>hue <input id="hue" type="range" min="0" max="360" [value]="hue()" (input)="hue.set(+$any($event.target).value)" /></label>
    @if (sync) { <app-sync-host /> }
    @if (telemetry) { <app-telemetry-wall /> }
    @if (show() && !telemetry && !sync) {
      @if (raw) { <app-raw-gradient-feature [hue]="hue()" /> } @else { <app-gradient-feature [hue]="hue()" /> }
    }
  `,
})
export class App {
  protected readonly gpu = inject(TypeGpu);
  protected readonly raw = new URLSearchParams(inject(DOCUMENT).defaultView?.location.search ?? '').get('demo') === 'raw';
  protected readonly telemetry = new URLSearchParams(inject(DOCUMENT).defaultView?.location.search ?? '').get('demo') === 'telemetry';
  protected readonly sync = new URLSearchParams(inject(DOCUMENT).defaultView?.location.search ?? '').get('demo') === 'sync';
  protected readonly show = signal(true);
  protected readonly hue = signal(120);
}
