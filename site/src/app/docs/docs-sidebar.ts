import { NgTemplateOutlet } from '@angular/common';
import { Component, output, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../shell/icons';
import { DOCS_NAV, isGroup, type NavItem } from './docs-nav';

/** The documentation navigation tree: collapsible groups, the active page highlighted. */
@Component({
  selector: 'app-docs-sidebar',
  imports: [NgTemplateOutlet, RouterLink, RouterLinkActive, Icon],
  template: `
    <ul class="top">
      @for (entry of nav; track entry.label) {
        @if (isGroup(entry)) {
          <li>
            <button type="button" class="group" [attr.aria-expanded]="isOpen(entry.label)" (click)="toggle(entry.label)">
              <span>{{ entry.label }}</span>
              <app-icon name="chevron-down" class="caret" [class.closed]="!isOpen(entry.label)" />
            </button>
            @if (isOpen(entry.label)) {
              <ul class="items">
                @for (item of entry.items; track item.label) {
                  <li><ng-container *ngTemplateOutlet="link; context: { $implicit: item }" /></li>
                }
              </ul>
            }
          </li>
        } @else {
          <li><ng-container *ngTemplateOutlet="link; context: { $implicit: entry }" /></li>
        }
      }
    </ul>

    <ng-template #link let-item>
      @if (item.route) {
        <a class="item" [routerLink]="item.route" routerLinkActive="current" ariaCurrentWhenActive="page" (click)="navigated.emit()">
          {{ item.label }}
          @if (item.badge) { <span class="badge" [attr.data-kind]="item.badge">{{ item.badge }}</span> }
        </a>
      } @else {
        <a class="item external" [href]="item.external" target="_blank" rel="noreferrer" title="Opens the official TypeGPU documentation (not part of this showcase)">
          {{ item.label }}
          @if (item.badge) { <span class="badge" [attr.data-kind]="item.badge">{{ item.badge }}</span> }
          <app-icon name="external" class="ext" />
        </a>
      }
    </ng-template>
  `,
  styles: `
    ul { list-style: none; margin: 0; padding: 0; }
    .top > li { margin-top: 0.4rem; }
    .group {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      padding: 0.2rem 0.5rem;
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--sl-color-white);
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.4;
      text-align: start;
    }
    .caret { font-size: 1rem; color: var(--sl-color-gray-3); transition: transform 150ms; }
    .caret.closed { transform: rotate(-90deg); }
    .items {
      margin: 0.25rem 0 0.5rem 0.5rem;
      padding-inline-start: 0.5rem;
      border-inline-start: 1px solid var(--sl-color-hairline);
    }
    .item {
      display: block;
      padding: 0.3rem 0.5rem;
      color: var(--sl-color-gray-2);
      font-size: 0.875rem;
      line-height: 1.4;
      text-decoration: none;
      border-radius: 4px;
    }
    .top > li > .item { color: var(--sl-color-white); font-weight: 600; font-size: 1rem; padding: 0.3rem 0.5rem; }
    .item:hover { color: var(--sl-color-white); }
    .item.current {
      background: var(--sl-color-text-accent);
      color: var(--sl-color-text-invert);
      font-weight: 600;
    }
    .ext { font-size: 0.7rem; opacity: 0; margin-inline-start: 0.3rem; vertical-align: -0.05em; transition: opacity 120ms; }
    .item.external:hover .ext { opacity: 0.8; }
    .badge {
      position: relative;
      isolation: isolate;
      display: inline-block;
      margin-inline-start: 0.4rem;
      top: -1px;
      font-family: var(--sl-font-mono);
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.3;
      color: color-mix(in srgb, var(--sl-color-text) 70%, transparent);
    }
    :host-context([data-theme='dark']) .badge { color: rgb(255 255 255 / 0.7); }
    .badge::before {
      position: absolute;
      z-index: -1;
      inset: 0.1rem;
      border-radius: 0.2rem;
      background: var(--badge-color, var(--accent-600));
      content: '';
      filter: blur(0.1rem);
      opacity: 0.2;
    }
    :host-context([data-theme='dark']) .badge::before { opacity: 0.385; }
    .badge[data-kind='new'] { --badge-color: hsl(234, 100%, 60%); }
    .badge[data-kind='experimental'] { --badge-color: var(--accent-600); }
    .item.current .badge { color: rgb(0 0 0 / 0.7); }
    :host-context([data-theme='light']) .item.current .badge { color: rgb(255 255 255 / 0.8); }
  `,
})
export class DocsSidebar {
  protected readonly nav = DOCS_NAV;
  protected readonly isGroup = isGroup;
  readonly navigated = output<void>();
  private readonly closed = signal<ReadonlySet<string>>(new Set());

  protected isOpen(label: string): boolean {
    return !this.closed().has(label);
  }

  protected toggle(label: string): void {
    const next = new Set(this.closed());
    if (!next.delete(label)) next.add(label);
    this.closed.set(next);
  }
}

export type { NavItem };
