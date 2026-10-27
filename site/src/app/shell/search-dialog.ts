import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { focusMain, trapTab } from '../shared/focus';
import { Icon } from './icons';
import { SearchService, type SearchEntry } from './search.service';

@Component({
  selector: 'app-search-dialog',
  imports: [Icon],
  host: { '(document:keydown)': 'onDocumentKey($event)' },
  template: `
    @if (search.open()) {
      <div class="backdrop" (click)="search.hide()"></div>
      <div #dialog class="dialog" role="dialog" aria-modal="true" aria-label="Search" tabindex="-1" (keydown)="onDialogKey($event)">
        <div class="field">
          <app-icon name="search" class="lead" />
          <input
            #input
            type="search"
            role="combobox"
            placeholder="Search the documentation and examples"
            aria-label="Search the documentation and examples"
            aria-autocomplete="list"
            aria-controls="search-results"
            [attr.aria-expanded]="search.results().length > 0"
            [attr.aria-activedescendant]="activeId()"
            autocomplete="off"
            [value]="search.query()"
            (input)="onInput($any($event.target).value)"
          />
          <button type="button" class="cancel" (click)="search.hide()">Cancel</button>
        </div>
        <!-- The options are not focusable: focus stays in the field and the arrow keys move "aria-activedescendant" (combobox pattern). -->
        @if (search.results().length > 0) {
          <ul class="results" id="search-results" role="listbox" aria-label="Search results">
            @for (entry of search.results(); track $index; let i = $index) {
              <li
                role="option"
                class="option"
                [id]="optionId(i)"
                [class.on]="i === selected()"
                [attr.aria-selected]="i === selected()"
                (mousedown)="$event.preventDefault()"
                (click)="go(entry)"
                (mouseenter)="selected.set(i)"
              >
                <span class="group">{{ entry.group }}</span>
                <span class="entry">{{ entry.title }}</span>
                <span class="hint">{{ entry.hint }}</span>
              </li>
            }
          </ul>
        } @else if (search.query().trim()) {
          <p class="none">No results for “{{ search.query() }}”.</p>
        } @else {
          <p class="none">Type to search the &#64;typegpu/angular page and the examples.</p>
        }
        <div class="sr-only" role="status">{{ summary() }}</div>
      </div>
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 60; background: #16181da8; }
    .dialog {
      position: fixed;
      z-index: 61;
      top: 10vh;
      left: 50%;
      width: min(40rem, calc(100vw - 2rem));
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      transform: translateX(-50%);
      background: var(--sl-color-gray-6);
      border: 1px solid var(--sl-color-hairline);
      box-shadow: 0 25px 60px rgb(0 0 0 / 0.5);
    }
    .field { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--sl-color-hairline); }
    .lead { font-size: 1.1rem; color: var(--sl-color-gray-3); }
    input {
      flex: 1;
      min-width: 0;
      border: 0;
      background: none;
      color: var(--sl-color-white);
      font-size: 1rem;
      outline: none;
    }
    .cancel { border: 0; background: none; color: var(--sl-color-text-accent); cursor: pointer; font-size: 0.875rem; }
    .results { list-style: none; margin: 0; padding: 0.5rem; overflow-y: auto; }
    .option {
      display: grid;
      grid-template-columns: 7.5rem 1fr auto;
      align-items: baseline;
      gap: 0.75rem;
      width: 100%;
      padding: 0.55rem 0.75rem;
      color: var(--sl-color-white);
      text-align: start;
      cursor: pointer;
    }
    @media (max-width: 600px) { .option { grid-template-columns: 1fr; gap: 0.1rem; } }
    .option.on { background: var(--sl-color-text-accent); color: var(--sl-color-text-invert); }
    .dialog:focus { outline: none; }
    .group { font-size: 0.75rem; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
    .hint { font-size: 0.8125rem; opacity: 0.7; }
    .none { margin: 0; padding: 1rem 1.25rem; color: var(--sl-color-gray-3); font-size: 0.9375rem; }
  `,
})
export class SearchDialog {
  protected readonly search = inject(SearchService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  protected readonly selected = signal(0);

  protected readonly activeId = computed(() => (this.search.results().length > 0 ? this.optionId(this.selected()) : null));
  protected readonly summary = computed(() => {
    if (!this.search.query().trim()) return '';
    const count = this.search.results().length;
    return count === 0 ? 'No results' : count === 1 ? '1 result' : `${count} results`;
  });

  constructor() {
    effect(() => {
      this.input()?.nativeElement.focus();
    });
  }

  protected optionId(index: number): string {
    return `search-option-${index}`;
  }

  protected onInput(value: string): void {
    this.search.query.set(value);
    this.selected.set(0);
  }

  protected go(entry: SearchEntry): void {
    // Focus moves to the new page's content, not back to the opener.
    this.search.hide(false);
    void this.router.navigate([entry.route], { fragment: entry.fragment }).then(() => focusMain());
  }

  /** Ctrl/Cmd+K opens and closes the dialog from anywhere. Every other key is handled by the dialog itself (below). */
  protected onDocumentKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (this.search.open()) this.search.hide();
      else this.search.show();
    }
  }

  /** Bound to the dialog element, not the document: only keys pressed inside it count, so Enter on a button elsewhere never opens a result. */
  protected onDialogKey(event: KeyboardEvent): void {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const results = this.search.results();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.search.hide();
    } else if (event.key === 'Tab') {
      trapTab(event, dialog);
    } else if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      this.select(Math.min(results.length - 1, this.selected() + 1));
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      this.select(Math.max(0, this.selected() - 1));
    } else if (event.key === 'Enter' && event.target === this.input()?.nativeElement && !event.isComposing && results[this.selected()]) {
      // Only the field activates the highlighted result; a focused button (Cancel) keeps its own meaning.
      event.preventDefault();
      this.go(results[this.selected()]!);
    }
  }

  private select(index: number): void {
    this.selected.set(index);
    afterNextRender(() => document.getElementById(this.optionId(index))?.scrollIntoView?.({ block: 'nearest' }), { injector: this.injector });
  }
}
