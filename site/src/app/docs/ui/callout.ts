import { Component, input } from '@angular/core';

/** A Starlight-style aside: note, tip, caution or danger. */
@Component({
  selector: 'doc-callout',
  template: `
    <aside class="aside" [attr.data-type]="type()">
      <p class="title">{{ title() || defaultTitle() }}</p>
      <div class="content"><ng-content /></div>
    </aside>
  `,
  styles: `
    :host { display: block; margin-top: 1rem; }
    .aside {
      padding: 1rem;
      border-inline-start: 0.25rem solid var(--aside-color);
      background: var(--aside-low);
      color: var(--sl-color-white);
    }
    .aside[data-type='note'] { --aside-color: var(--sl-color-note); --aside-low: var(--sl-color-note-low); --aside-high: var(--sl-color-note-high); }
    .aside[data-type='tip'] { --aside-color: var(--sl-color-tip); --aside-low: var(--sl-color-tip-low); --aside-high: var(--sl-color-tip-high); }
    .aside[data-type='caution'] { --aside-color: var(--sl-color-caution); --aside-low: var(--sl-color-caution-low); --aside-high: var(--sl-color-caution-high); }
    .aside[data-type='danger'] { --aside-color: var(--sl-color-danger); --aside-low: var(--sl-color-danger-low); --aside-high: var(--sl-color-danger-high); }
    .title {
      margin: 0;
      color: var(--aside-high);
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      line-height: 1.5;
    }
    .content { margin-top: 0.4rem; font-size: 0.9375rem; line-height: 1.65; }
    .content > :first-child { margin-top: 0; }
    .content > * + * { margin-top: 0.6rem; }
  `,
})
export class Callout {
  readonly type = input<'note' | 'tip' | 'caution' | 'danger'>('note');
  readonly title = input<string>();

  protected defaultTitle(): string {
    return { note: 'Note', tip: 'Tip', caution: 'Caution', danger: 'Danger' }[this.type()];
  }
}
