import { Component, inject, input } from '@angular/core';
import { RawGpu } from './raw-gpu';
import { RawGradient } from './raw-gradient';

@Component({
  selector: 'app-raw-gradient-feature',
  imports: [RawGradient],
  template: `
    @switch (gpu.state().status) {
      @case ('ready') { <app-raw-gradient [hue]="hue()" /> }
      @case ('unsupported') { <p class="gpu-message">WebGPU is not available in this browser.</p> }
      @case ('failed') { <p class="gpu-message">GPU initialisation failed. <button (click)="gpu.retry()">Retry</button></p> }
      @case ('lost') { <p class="gpu-message">The GPU device was lost. <button (click)="gpu.retry()">Reconnect</button></p> }
      @default { <div class="gpu-placeholder"></div> }
    }
  `,
  styles: `.gpu-placeholder { height: 240px; background: #111; }`,
})
export class RawGradientFeature {
  readonly hue = input.required<number>();
  protected readonly gpu = inject(RawGpu);
}
