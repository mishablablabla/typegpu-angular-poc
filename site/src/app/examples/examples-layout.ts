import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon } from '../shell/icons';
import { ExampleThumb } from './example-thumb';
import { ExamplesView } from './examples-view.service';
import { EXAMPLES } from './registry';

/** Frame of the examples section: the "Explore examples" panel (search and tag filter) beside the routed content. */
@Component({
  selector: 'app-examples-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, ExampleThumb],
  template: `
    <div class="page" [class.fullscreen]="view.fullscreen()">
      <div class="row">
        @if (!view.fullscreen() && view.menuShown()) {
          <aside class="menu" aria-label="Explore examples">
            <div class="menu-head">
              <h2>Explore examples</h2>
              <button type="button" class="close" (click)="closeMenu()" aria-label="Close examples menu"><app-icon name="close" /></button>
            </div>
            <div class="menu-body">
              <div class="search-row">
                <input type="search" class="search" placeholder="Search examples..." aria-label="Search examples" [value]="query()" (input)="query.set(searchBox.value)" #searchBox />
                <button type="button" class="filter" [class.active]="filterOpen() || selected().length > 0" (click)="filterOpen.set(!filterOpen())" [attr.aria-expanded]="filterOpen()" aria-controls="tag-filter">
                  <span>Filter</span>
                  @if (selected().length > 0) { <span class="badge">{{ selected().length }}</span> }
                  <app-icon name="chevron-down" class="caret" [class.flip]="filterOpen()" />
                </button>
                @if (filterOpen()) {
                  <div class="popover" id="tag-filter" role="group" aria-label="Filter by tag">
                    <div class="pop-head">
                      <span>Tags</span>
                      <button type="button" class="clear" [class.hidden]="selected().length === 0" (click)="selected.set([])">Clear all</button>
                    </div>
                    <div class="chips">
                      @for (tag of tags; track tag) {
                        <button type="button" class="chip" [class.on]="selected().includes(tag)" [attr.aria-pressed]="selected().includes(tag)" (click)="toggleTag(tag)">{{ tag }}</button>
                      }
                    </div>
                  </div>
                }
              </div>
              <ul class="list">
                @for (example of filtered(); track example.id) {
                  <li>
                    <a class="item" [routerLink]="['/examples', example.id]" routerLinkActive="current" ariaCurrentWhenActive="page" (click)="onPick()">
                      <span class="thumb"><app-example-thumb [src]="example.thumbnail" /></span>
                      <span class="name">{{ example.title }}</span>
                    </a>
                  </li>
                } @empty {
                  <li class="none">No examples match your search.</li>
                }
              </ul>
            </div>
          </aside>
        }
        <main class="content" id="main-content" tabindex="-1">
          @if (!view.fullscreen() && !view.menuShown()) {
            <button type="button" class="browse" #browse (click)="openMenu()">Browse examples</button>
          }
          <router-outlet />
        </main>
      </div>
      @if (!view.fullscreen()) {
        <footer class="footer">Showcase of the &#64;typegpu/angular integration. TypeGPU is developed by Software Mansion.</footer>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .page {
      position: relative;
      isolation: isolate;
      min-height: calc(100dvh - var(--sl-nav-height));
      overflow-x: clip;
      background: var(--ex-bg);
      color: var(--ex-title);
    }
    .page.fullscreen { position: fixed; inset: 0; z-index: 50; min-height: 0; }
    .row { display: flex; gap: 1.25rem; width: 100%; padding: 1.25rem 1rem; }
    @media (min-width: 601px) { .row { padding-inline: 1.5rem; } }
    @media (min-width: 1025px) { .row { padding: 2rem; } }
    .page.fullscreen .row { padding: 0; height: 100%; }
    .content { min-width: 0; flex: 1; }
    .menu {
      position: fixed;
      inset: var(--sl-nav-height) 0 0 0;
      z-index: 45;
      display: flex;
      flex-direction: column;
      background: var(--ex-surface);
      border: 1px solid var(--ex-border);
    }
    @media (min-width: 1025px) {
      .menu {
        position: sticky;
        inset: auto;
        top: 7rem;
        z-index: 10;
        width: 21rem;
        flex: none;
        max-height: calc(100dvh - 9rem);
        overflow: hidden;
      }
    }
    .menu-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1.25rem 1.25rem 1rem; }
    .menu-head h2 { margin: 0.25rem 0 0; font-size: 1.25rem; font-weight: 600; color: var(--ex-title); line-height: 1.3; }
    .close { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border: 0; background: none; cursor: pointer; color: var(--ex-title); font-size: 0.8rem; }
    .menu-body { min-height: 0; flex: 1; overflow-y: auto; padding: 0 1rem 0.75rem; }
    .search-row { position: relative; display: flex; gap: 0.5rem; margin-bottom: 0.75rem; position: sticky; top: 0; background: var(--ex-surface); padding-bottom: 0.25rem; z-index: 2; }
    .search {
      min-width: 0;
      flex: 1;
      padding: 0.625rem 1rem;
      border: 1px solid var(--ex-border);
      background: var(--ex-field);
      color: var(--ex-title);
      font-size: 0.875rem;
      outline: none;
    }
    .search:focus { border-color: var(--focus-ring); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 30%, transparent); }
    .filter {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--ex-border);
      background: var(--ex-hover);
      color: var(--ex-muted);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
    }
    .filter.active { border-color: var(--accent-600); color: var(--sl-color-text-accent); }
    .badge { padding: 1px 6px; background: linear-gradient(90deg, var(--gradient-purple-dark), var(--gradient-blue-dark)); color: #fff; font-size: 0.625rem; line-height: 1.2; }
    .caret { font-size: 0.75rem; transition: transform 150ms; }
    .caret.flip { transform: rotate(180deg); }
    .popover {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 30;
      margin-top: 0.5rem;
      padding: 0.75rem;
      background: var(--ex-panel);
      border: 1px solid var(--ex-border);
      box-shadow: var(--ex-shadow);
    }
    .pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; font-size: 0.75rem; font-weight: 500; color: var(--ex-muted); }
    .clear { padding: 2px 8px; border: 1px solid var(--ex-border); background: none; color: var(--ex-muted); font-size: 0.625rem; cursor: pointer; }
    .clear.hidden { visibility: hidden; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
    .chip { padding: 2px 10px; border: 0; background: var(--ex-chip); color: var(--ex-chip-text); font-size: 0.6875rem; font-weight: 500; cursor: pointer; }
    .chip:hover { background: var(--ex-current); }
    .chip.on { background: linear-gradient(90deg, var(--gradient-purple-dark), var(--gradient-blue-dark)); color: #fff; }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
    .item { display: flex; align-items: center; gap: 0.75rem; padding: 0.25rem; color: var(--ex-title); text-decoration: none; transition: background-color 150ms; }
    .item:hover { background: var(--ex-hover); }
    .item.current { background: var(--ex-current); }
    .thumb { width: 3.3rem; height: 3.3rem; flex: none; overflow: hidden; border: 1px solid var(--ex-border); }
    .name { min-width: 0; flex: 1; padding-inline-end: 0.5rem; font-size: 0.875rem; font-weight: 500; line-height: 1.3; }
    .none { padding: 2.5rem 1rem; border: 1px dashed var(--ex-border); text-align: center; font-size: 0.875rem; color: var(--ex-muted); }
    .browse { margin-bottom: 1rem; padding: 0.5rem 1.25rem; border: 1px solid var(--ex-border); background: var(--ex-button); color: var(--ex-button-text); font-size: 0.875rem; cursor: pointer; }
    .footer { padding: 0 1.5rem 1.5rem; text-align: center; font-size: 0.75rem; color: var(--ex-muted); }
  `,
})
export class ExamplesLayout {
  protected readonly view = inject(ExamplesView);
  protected readonly query = signal('');
  protected readonly filterOpen = signal(false);
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly tags = [...new Set(EXAMPLES.flatMap((example) => example.tags))].sort();

  protected readonly filtered = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const chosen = this.selected();
    return EXAMPLES.filter(
      (example) =>
        words.every((word) => `${example.title} ${example.tags.join(' ')}`.toLowerCase().includes(word)) &&
        chosen.every((tag) => example.tags.includes(tag)),
    );
  });

  protected toggleTag(tag: string): void {
    this.selected.update((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
  }

  private readonly injector = inject(Injector);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');
  private readonly browse = viewChild<ElementRef<HTMLButtonElement>>('browse');

  /** The menu replaces the button that opened it (and the other way round): focus follows, so keyboard users are not left on nothing. */
  protected openMenu(): void {
    this.view.menuShown.set(true);
    afterNextRender(() => this.searchBox()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeMenu(): void {
    this.view.menuShown.set(false);
    afterNextRender(() => this.browse()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onPick(): void {
    if (window.matchMedia('(max-width: 1024px)').matches) this.view.menuShown.set(false);
  }
}
