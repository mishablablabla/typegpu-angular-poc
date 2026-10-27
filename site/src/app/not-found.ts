import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ANGULAR_DOCS_ROUTE } from './docs/docs-nav';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <main class="page" id="main-content" tabindex="-1">
      <h1>Page not found</h1>
      <p>This showcase has two sections: the <a [routerLink]="docs">@typegpu/angular documentation</a> and the <a routerLink="/examples">examples</a>. Other TypeGPU topics live on the official docs site.</p>
    </main>
  `,
  styles: `
    .page { max-width: 40rem; margin: 5rem auto; padding-inline: 1.5rem; }
    h1 { color: var(--sl-color-white); font-size: 2.625rem; font-weight: 600; line-height: 1.2; margin: 0 0 1rem; }
  `,
})
export class NotFound {
  protected readonly docs = ANGULAR_DOCS_ROUTE;
}
