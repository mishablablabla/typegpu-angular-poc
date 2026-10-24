import { Component, inject, signal } from '@angular/core';
import { TypeGpu } from '@typegpu-poc/angular';
import { GradientFeature } from './gradient-feature';

@Component({
  selector: 'app-root',
  imports: [GradientFeature],
  template: `
    <h1>TypeGPU + Angular (SSR)</h1>
    <p id="status">gpu: {{ gpu.state().status }}</p>
    <button id="toggle" (click)="show.set(!show())">{{ show() ? 'Unmount' : 'Mount' }}</button>
    <label>hue <input id="hue" type="range" min="0" max="360" [value]="hue()" (input)="hue.set(+$any($event.target).value)" /></label>
    @if (show()) { <app-gradient-feature [hue]="hue()" /> }
  `,
})
export class App {
  protected readonly gpu = inject(TypeGpu);
  protected readonly show = signal(true);
  protected readonly hue = signal(120);
}
