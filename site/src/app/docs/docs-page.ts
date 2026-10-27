import { DestroyRef, Component, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { Icon } from '../shell/icons';
import { DocsSidebar } from './docs-sidebar';
import type { DocHeading } from './doc-blocks';

/**
 * The documentation page frame (Starlight layout): fixed sidebar, title panel, content panel and the
 * "On this page" list on the right, which collapses into a bar under the header on narrow screens.
 */
@Component({
  selector: 'app-docs-page',
  imports: [DocsSidebar, Icon],
  template: `
    <aside class="sidebar" aria-label="Documentation" #sidebar>
      <app-docs-sidebar />
    </aside>

    <main class="main" id="main-content" tabindex="-1">
      <div class="mobile-toc">
        <button type="button" class="toc-toggle" (click)="tocOpen.set(!tocOpen())" [attr.aria-expanded]="tocOpen()">
          <span>On this page</span>
          <app-icon name="chevron-right" class="chev" [class.open]="tocOpen()" />
        </button>
        <span class="toc-current">{{ currentTitle() }}</span>
        @if (tocOpen()) {
          <nav class="toc-drop" aria-label="On this page">
            <ul>
              @for (heading of headings(); track heading.id) {
                <li [class.sub]="heading.level === 3"><a [href]="'#' + heading.id" (click)="tocOpen.set(false)">{{ heading.title }}</a></li>
              }
            </ul>
          </nav>
        }
      </div>

      <div class="grid">
        <div class="center">
          <div class="panel title-panel"><h1 id="_top">{{ title() }}</h1></div>
          <div class="panel body-panel sl-markdown-content"><ng-content /></div>
        </div>
        <aside class="toc" aria-label="On this page">
          <p class="toc-title">On this page</p>
          <ul>
            <li><a href="#_top" [class.current]="activeId() === '_top'">Overview</a></li>
            @for (heading of headings(); track heading.id) {
              <li [class.sub]="heading.level === 3">
                <a [href]="'#' + heading.id" [class.current]="activeId() === heading.id">{{ heading.title }}</a>
              </li>
            }
          </ul>
        </aside>
      </div>
    </main>
  `,
  styles: `
    :host { display: block; }
    .sidebar {
      display: none;
      position: fixed;
      z-index: 15;
      top: var(--sl-nav-height);
      bottom: 0;
      inset-inline-start: 0;
      width: var(--sl-sidebar-width);
      padding: 1rem 1rem 3rem;
      overflow-y: auto;
      background: var(--sl-color-bg-sidebar);
      border-inline-end: 1px solid var(--sl-color-hairline);
    }
    @media (min-width: 800px) {
      .sidebar { display: block; }
      .main { margin-inline-start: var(--sl-sidebar-width); }
    }
    .mobile-toc {
      position: sticky;
      top: var(--sl-nav-height);
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 1rem;
      background: var(--sl-color-bg-nav);
      border-bottom: 1px solid var(--sl-color-hairline);
    }
    @media (min-width: 1152px) { .mobile-toc { display: none; } }
    .toc-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.8rem;
      border: 1px solid var(--sl-color-hairline);
      border-radius: 0.5rem;
      background: var(--sl-color-gray-6);
      color: var(--sl-color-gray-2);
      font-size: 0.875rem;
      cursor: pointer;
    }
    .chev { transition: transform 150ms; }
    .chev.open { transform: rotate(90deg); }
    .toc-current { font-size: 0.875rem; color: var(--sl-color-white); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .toc-drop {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 60vh;
      overflow-y: auto;
      padding: 0.5rem 1rem 1rem;
      background: var(--sl-color-bg-nav);
      border-bottom: 1px solid var(--sl-color-hairline);
    }
    .toc-drop ul, .toc ul { list-style: none; margin: 0; padding: 0; }
    .toc-drop a { display: block; padding: 0.3rem 0.5rem; color: var(--sl-color-text-accent); font-size: 0.875rem; text-decoration: none; }
    .toc-drop .sub a { padding-inline-start: 1.5rem; }
    .grid { display: block; }
    @media (min-width: 1152px) {
      .grid { display: grid; grid-template-columns: minmax(0, 1fr) 22.5rem; max-width: 71.25rem; margin-inline: auto; }
    }
    .panel { padding: 1.5rem 1rem; }
    @media (min-width: 601px) { .panel { padding-inline: 2.25rem; } }
    .title-panel { padding-top: 1.5rem; border-bottom: 1px solid var(--sl-color-hairline); }
    .title-panel h1 {
      margin: 1rem 0 0;
      color: var(--sl-color-white);
      font-size: 2.625rem;
      font-weight: 600;
      line-height: 1.2;
    }
    @media (max-width: 600px) { .title-panel h1 { font-size: 2.2rem; } }
    .body-panel { padding-top: 1.5rem; padding-bottom: 5rem; }
    .toc {
      display: none;
      position: sticky;
      top: var(--sl-nav-height);
      height: calc(100vh - var(--sl-nav-height));
      align-self: start;
      overflow-y: auto;
      padding: 1.5rem 1.5rem 3rem 2.5rem;
      border-inline-start: 1px solid var(--sl-color-hairline);
    }
    @media (min-width: 1152px) { .toc { display: block; } }
    .toc-title { margin: 0 0 0.6rem; padding-inline: 0.5rem; color: var(--sl-color-white); font-size: 1rem; font-weight: 600; }
    .toc a {
      display: block;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      color: var(--sl-color-gray-3);
      font-size: 0.8125rem;
      line-height: 1.25;
      text-decoration: none;
    }
    :host-context([data-theme='dark']) .toc a { color: #8788aa; }
    .toc a:hover { color: var(--sl-color-white); }
    .toc .sub a { padding-inline-start: 1.5rem; }
    .toc a.current { color: var(--sl-color-text-accent); }
  `,
})
export class DocsPage {
  readonly title = input.required<string>();
  readonly headings = input.required<readonly DocHeading[]>();

  private readonly sidebar = viewChild.required<ElementRef<HTMLElement>>('sidebar');
  protected readonly tocOpen = signal(false);
  protected readonly activeId = signal('_top');
  protected readonly currentTitle = computed(() => this.headings().find((heading) => heading.id === this.activeId())?.title ?? 'Overview');

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      // Show the current page in the sidebar, as Starlight does.
      const side = this.sidebar().nativeElement;
      const current = side.querySelector<HTMLElement>('.current');
      if (current) side.scrollTop = current.offsetTop - side.clientHeight / 2;

      const visible = new Set<string>();
      const ids = ['_top', ...this.headings().map((heading) => heading.id)];
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
          }
          // The first heading (in page order) that is inside the reading band wins.
          const first = ids.find((id) => visible.has(id));
          if (first) this.activeId.set(first);
        },
        { rootMargin: '-90px 0px -60% 0px' },
      );
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element) observer.observe(element);
      }
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
