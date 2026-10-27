import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Icon } from '../../shell/icons';
import { Highlighter, plain, type CodeLanguage } from '../../shared/highlighter';

/** A code block in the TypeGPU docs style (Expressive Code): optional file title, copy button, Night Owl colors. */
@Component({
  selector: 'doc-code',
  imports: [Icon],
  template: `
    <figure class="frame" [class.titled]="title()">
      @if (title()) {
        <figcaption class="title">{{ title() }}</figcaption>
      }
      <div class="body" [innerHTML]="html()"></div>
      <button type="button" class="copy" (click)="copy()" aria-label="Copy to clipboard">
        <app-icon [name]="copied() ? 'check' : 'copy'" />
      </button>
      <span class="sr-only" role="status">{{ copied() ? 'Copied to clipboard' : '' }}</span>
    </figure>
  `,
  styles: `
    :host { display: block; margin-top: 1rem; }
    .frame { position: relative; margin: 0; background: var(--sl-color-gray-6); border: 1px solid color-mix(in srgb, #353452 75%, transparent); }
    :host-context([data-theme='light']) .frame { border-color: #d9dcec; background: #f7f8fe; }
    .title {
      padding: 0.45rem 1rem;
      border-bottom: 1px solid color-mix(in srgb, #353452 75%, transparent);
      font-family: var(--sl-font-mono);
      font-size: 0.8125rem;
      color: var(--sl-color-gray-3);
    }
    :host-context([data-theme='light']) .title { border-color: #d9dcec; }
    .body { overflow-x: auto; }
    .copy {
      position: absolute;
      top: 0.4rem;
      right: 0.4rem;
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 0.2rem;
      background: var(--sl-color-gray-6);
      color: var(--sl-color-white);
      font-size: 1rem;
      cursor: pointer;
      opacity: 0;
      transition: opacity 150ms, border-color 150ms;
    }
    .frame.titled .copy { top: 2.55rem; }
    .frame:hover .copy, .copy:focus-visible { opacity: 1; }
    .copy:hover { border-color: var(--sl-color-text-accent); }
    @media (hover: none) { .copy { opacity: 1; } }
  `,
})
export class CodeBlock {
  readonly code = input.required<string>();
  readonly lang = input<CodeLanguage>('typescript');
  readonly title = input<string>();

  private readonly highlighter = inject(Highlighter);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly highlighted = signal<string | undefined>(undefined);
  protected readonly copied = signal(false);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  // The HTML comes from our own code strings through Shiki, never from user input.
  protected readonly html = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(wrap(this.highlighted() ?? plain(trim(this.code())))));

  constructor() {
    effect((onCleanup) => {
      const code = trim(this.code());
      const lang = this.lang();
      let stale = false;
      onCleanup(() => (stale = true));
      void this.highlighter.html(code, lang, 'docs').then((html) => {
        if (!stale) this.highlighted.set(html);
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.resetTimer));
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(trim(this.code()));
      this.copied.set(true);
      clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard access can be denied; nothing to do.
    }
  }
}

const trim = (code: string) => code.replace(/^\n+|\s+$/g, '');
const wrap = (html: string) => html;
