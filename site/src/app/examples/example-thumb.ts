import { Component, input } from '@angular/core';

/** A preview image of an example (a screenshot of it running), with a plain fallback while it loads or is missing. */
@Component({
  selector: 'app-example-thumb',
  template: `<img [src]="src()" [alt]="alt()" loading="lazy" decoding="async" />`,
  styles: `
    :host { display: block; width: 100%; height: 100%; background: var(--ex-preview); }
    img { display: block; width: 100%; height: 100%; object-fit: cover; }
  `,
})
export class ExampleThumb {
  readonly src = input.required<string>();
  readonly alt = input('');
}
