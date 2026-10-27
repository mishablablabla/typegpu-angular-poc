import { Injectable, computed, signal } from '@angular/core';
import type { SearchEntry } from './search-index';

export type { SearchEntry };

/** The site search: an in-memory filter over the page headings and the examples. The index loads on first use. */
@Injectable({ providedIn: 'root' })
export class SearchService {
  readonly open = signal(false);
  readonly query = signal('');
  private readonly index = signal<readonly SearchEntry[]>([]);

  readonly results = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return this.index()
      .filter((entry) => words.every((word) => `${entry.title} ${entry.hint}`.toLowerCase().includes(word)))
      .slice(0, 12);
  });

  /** What had focus when the dialog opened: it gets focus back when the dialog is dismissed. */
  private opener: HTMLElement | null = null;

  show(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.query.set('');
    this.open.set(true);
    if (this.index().length === 0) void import('./search-index').then((module) => this.index.set(module.SEARCH_INDEX));
  }

  /** Closes the dialog; `restoreFocus: false` when the caller moves focus somewhere else (a result was chosen). */
  hide(restoreFocus = true): void {
    if (!this.open()) return;
    this.open.set(false);
    const opener = this.opener;
    this.opener = null;
    if (restoreFocus && opener?.isConnected) opener.focus();
  }
}
