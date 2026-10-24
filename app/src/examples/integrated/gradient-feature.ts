// The integrated version of the gradient feature (the hand-written one is in ../raw): an animated gradient
// whose tint follows a `hue` input.
// Requirements: no GPU work on the server; placeholder, "unsupported", "failed" and "lost" UI;
// canvas sized in device pixels; render loop outside the zone and stopped on destroy;
// hue mirrored to a uniform without redundant writes; buffers destroyed with the component.
import { Component, input } from '@angular/core';
import { TgpuReady, TypeGpu } from '@typegpu-poc/angular';
import { inject } from '@angular/core';
import { Gradient } from './gradient';

@Component({
  selector: 'app-gradient-feature',
  imports: [Gradient, TgpuReady],
  template: `
    <app-gradient *tgpuReady="let root; else fallback" [hue]="hue()" />
    <ng-template #fallback let-state>
      @switch (state.status) {
        @case ('unsupported') { <p class="gpu-message">WebGPU is not available in this browser.</p> }
        @case ('failed') { <p class="gpu-message">GPU initialisation failed. <button (click)="gpu.retry()">Retry</button></p> }
        @case ('lost') { <p class="gpu-message">The GPU device was lost. <button (click)="gpu.retry()">Reconnect</button></p> }
        @default { <div class="gpu-placeholder"></div> }
      }
    </ng-template>
  `,
  styles: `.gpu-placeholder { height: 240px; background: #111; }`,
})
export class GradientFeature {
  readonly hue = input.required<number>();
  protected readonly gpu = inject(TypeGpu);
}
