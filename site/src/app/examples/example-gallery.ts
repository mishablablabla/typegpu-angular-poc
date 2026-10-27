import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExampleThumb } from './example-thumb';
import { EXAMPLES } from './registry';

/** The examples landing page: a grid of cards, each with a screenshot of the example, its title and an arrow. */
@Component({
  selector: 'app-example-gallery',
  imports: [RouterLink, ExampleThumb],
  template: `
    <div class="gallery">
      <section aria-labelledby="featured">
        <h1 id="featured">Featured</h1>
        <p class="lede">Each example runs live, with its parameters in a control panel. Open one to read its source, with and without the integration.</p>
        <div class="grid">
          @for (example of examples; track example.id) {
            <a class="card" [routerLink]="['/examples', example.id]">
              <span class="shot"><app-example-thumb [src]="example.thumbnail" /></span>
              <span class="meta">
                <span class="title">{{ example.title }}</span>
                <span class="arrow" aria-hidden="true">&rarr;</span>
              </span>
            </a>
          }
        </div>
      </section>
    </div>
  `,
  styles: `
    .gallery { padding-bottom: 3rem; }
    section { padding-top: 0.5rem; }
    h1 { margin: 0 0 0.75rem; font-size: 2.25rem; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2; color: var(--ex-title); }
    .lede { margin: 0 0 1.5rem; max-width: 42rem; font-size: 0.9375rem; line-height: 1.65; color: var(--ex-muted); }
    .grid { display: grid; grid-template-columns: 1fr; gap: 1rem; }
    @media (min-width: 601px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1200px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .card {
      display: flex;
      min-width: 0;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--ex-border);
      background: var(--ex-surface);
      color: inherit;
      text-decoration: none;
      transition: border-color 200ms, box-shadow 200ms;
    }
    .card:hover { border-color: color-mix(in srgb, var(--accent-600) 40%, transparent); box-shadow: var(--ex-shadow); }
    :host-context([data-theme='dark']) .card:hover { border-color: color-mix(in srgb, var(--accent-200) 50%, transparent); }
    .shot { display: block; aspect-ratio: 4 / 3; overflow: hidden; background: var(--ex-preview); }
    .shot app-example-thumb { transition: transform 300ms ease-out; }
    .card:hover .shot app-example-thumb { transform: scale(1.025); }
    .meta { display: flex; min-height: 3.75rem; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.75rem 1rem; }
    .title { font-size: 0.875rem; font-weight: 500; line-height: 1.25; color: var(--ex-title); }
    .arrow { flex: none; font-size: 1.125rem; color: var(--accent-600); transition: transform 200ms; }
    :host-context([data-theme='dark']) .arrow { color: var(--accent-200); }
    .card:hover .arrow { transform: translateX(2px); }
  `,
})
export class ExampleGallery {
  protected readonly examples = EXAMPLES;
}
