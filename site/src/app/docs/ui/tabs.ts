import { Component, input, signal } from '@angular/core';
import { CodeBlock } from './code-block';
import type { CodeLanguage } from '../../shared/highlighter';

let nextTabsId = 0;

export interface TabbedCode {
  label: string;
  code: string;
  lang?: CodeLanguage;
}

/** Tabbed code, like the package-manager tabs of the TypeGPU docs (underline on the active tab). */
@Component({
  selector: 'doc-tabs',
  imports: [CodeBlock],
  template: `
    <div class="tabs" role="tablist" (keydown)="onKey($event)">
      @for (tab of tabs(); track tab.label; let i = $index) {
        <button
          type="button"
          role="tab"
          class="tab"
          [id]="uid + '-tab-' + i"
          [attr.aria-selected]="active() === i"
          [attr.aria-controls]="uid + '-panel'"
          [attr.tabindex]="active() === i ? 0 : -1"
          (click)="active.set(i)"
        >{{ tab.label }}</button>
      }
    </div>
    @let current = tabs()[active()];
    @if (current) {
      <div role="tabpanel" [id]="uid + '-panel'" [attr.aria-labelledby]="uid + '-tab-' + active()">
        <doc-code [code]="current.code" [lang]="current.lang ?? 'bash'" />
      </div>
    }
  `,
  styles: `
    :host { display: block; margin-top: 1rem; }
    .tabs { display: flex; border-bottom: 2px solid var(--sl-color-gray-5); overflow-x: auto; }
    .tab {
      margin-bottom: -2px;
      padding: 0.3rem 1.25rem;
      border: 0;
      border-bottom: 2px solid transparent;
      background: none;
      color: var(--sl-color-gray-3);
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
    }
    .tab[aria-selected='true'] { color: var(--sl-color-white); border-bottom-color: var(--sl-color-text-accent); }
    doc-code { margin-top: 0; }
    .tab:focus-visible { outline-offset: -2px; }
  `,
})
export class DocTabs {
  readonly tabs = input.required<readonly TabbedCode[]>();
  protected readonly active = signal(0);
  protected readonly uid = `doc-tabs-${nextTabsId++}`;

  /** Arrow keys (and Home/End) move between the tabs and select, as in the ARIA tabs pattern. */
  protected onKey(event: KeyboardEvent): void {
    const count = this.tabs().length;
    const current = this.active();
    const next = event.key === 'ArrowRight' ? (current + 1) % count : event.key === 'ArrowLeft' ? (current - 1 + count) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    this.active.set(next);
    document.getElementById(`${this.uid}-tab-${next}`)?.focus();
  }
}
