import { Component, inject, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DocsSidebar } from '../docs/docs-sidebar';
import { ANGULAR_DOCS_ROUTE } from '../docs/docs-nav';
import { Icon } from './icons';
import { ThemeService } from './theme.service';

/** The navigation drawer below 800px: main links, the documentation tree, theme switch. */
@Component({
  selector: 'app-mobile-nav',
  imports: [RouterLink, DocsSidebar, Icon],
  template: `
    <nav class="drawer" aria-label="Navigation menu">
      <a class="main" [routerLink]="docsRoute" (click)="navigated.emit()">Docs</a>
      <a class="main" routerLink="/examples" (click)="navigated.emit()">Examples</a>
      <div class="tree"><app-docs-sidebar (navigated)="navigated.emit()" /></div>
      <div class="foot">
        <div class="theme" role="group" aria-label="Color theme">
          <button type="button" [class.on]="theme.theme() === 'light'" (click)="theme.set('light')" [attr.aria-pressed]="theme.theme() === 'light'" aria-label="Light theme"><app-icon name="sun" /></button>
          <button type="button" [class.on]="theme.theme() === 'dark'" (click)="theme.set('dark')" [attr.aria-pressed]="theme.theme() === 'dark'" aria-label="Dark theme"><app-icon name="moon" /></button>
        </div>
      </div>
    </nav>
  `,
  styles: `
    .drawer {
      position: fixed;
      inset: var(--sl-nav-height) 0 0 0;
      z-index: 39;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      overflow-y: auto;
      padding: 1rem;
      background: var(--sl-color-bg);
      border-top: 1px solid var(--header-border);
    }
    @media (min-width: 800px) { .drawer { display: none; } }
    .main {
      padding: 0.625rem 0.75rem;
      color: var(--link-header);
      font-weight: 500;
      text-decoration: none;
    }
    .tree { margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--sl-color-hairline); }
    .foot { margin-top: auto; padding-top: 1rem; border-top: 1px solid var(--sl-color-hairline); display: flex; justify-content: flex-end; }
    .theme { display: grid; grid-template-columns: 1fr 1fr; width: 5rem; height: 2.5rem; border: 1px solid var(--link-header); overflow: hidden; }
    .theme button { display: grid; place-items: center; border: 0; background: none; cursor: pointer; font-size: 1.125rem; color: var(--link-header); }
    .theme button.on { background: var(--link-header); color: var(--sl-color-bg); }
  `,
})
export class MobileNav {
  protected readonly theme = inject(ThemeService);
  protected readonly docsRoute = ANGULAR_DOCS_ROUTE;
  readonly navigated = output<void>();
}
