import { Component, DestroyRef, Injector, afterNextRender, computed, effect, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Icon } from '../../shell/icons';
import { Highlighter, plain } from '../../shared/highlighter';
import type { SourceFile, Variant } from '../example.model';

/** Non-blank, non-comment lines: what a reader has to read and maintain. */
const ROOT_FILE = 'manual-gpu.ts';

export function countCodeLines(code: string): number {
  let inBlock = false;
  let count = 0;
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    count++;
  }
  return count;
}

let nextViewerId = 0;

const LABELS: Record<Variant, string> = { integration: 'With integration', manual: 'Without integration' };

/**
 * The source viewer of the examples page: file tabs like the TypeGPU examples, and on top a two-option radio
 * switch that swaps the shown files between the implementation with the integration and the one without it.
 */
@Component({
  selector: 'app-source-viewer',
  imports: [Icon],
  template: `
    <section class="viewer" aria-label="Source code">
      <div class="switch-bar">
        <span class="switch-label" id="impl-label">Implementation</span>
        <!-- Native radio buttons: one tab stop, arrow keys move the choice, and the group is announced as such. -->
        <div class="radios" role="radiogroup" aria-labelledby="impl-label">
          @for (option of options; track option) {
            <label class="radio" [class.on]="variant() === option" [title]="detail(option)">
              <input type="radio" class="sr-only" [name]="groupName" [value]="option" [checked]="variant() === option" (change)="variantChange.emit(option)" />
              <span class="dot" aria-hidden="true"></span>
              <span class="text">{{ labels[option] }}</span>
              <span class="count">{{ lines(option) }} lines</span>
            </label>
          }
        </div>
      </div>

      <div class="note">
        <p>
          Lines counted: the component file of each version (<code>{{ componentFile('integration') }}</code>, <code>{{ componentFile('manual') }}</code>), non-blank and
          non-comment. Not counted: the shader and the shared application files (model, uniforms, panel), which are identical in both versions,
          @if (rootLines() > 0) {
            <code>manual-gpu.ts</code> ({{ rootLines() }} lines, the GPU root every manual component shares and you write once per application),
          }
          and the library itself.
        </p>
        <p>
          The manual versions behave exactly like the integrated ones, so they hand-roll what the integration does: dirty-checking caches
          (<code>sent</code>, in the larger examples) that stand in for <code>from</code>, a <code>commit()</code> that mirrors state into the template, cleanup and the
          frame loop. Plainer hand-written code would be shorter and would not behave the same: read the difference as indicative, not as a measure.
        </p>
      </div>

      <div class="tabs-bar">
        <div class="tabs" role="tablist" aria-label="Files" (keydown)="onTabKey($event)">
          @for (file of files(); track file.path; let i = $index) {
            <button
              type="button"
              role="tab"
              class="tab"
              [id]="tabId(i)"
              [class.on]="file.path === currentPath()"
              [attr.aria-selected]="file.path === currentPath()"
              [attr.aria-controls]="panelId"
              [attr.tabindex]="file.path === currentPath() ? 0 : -1"
              (click)="fileChange.emit(file.path)"
            >{{ file.path }}</button>
          }
        </div>
      </div>

      <div class="code-wrap">
        <div class="code" role="tabpanel" [id]="panelId" [attr.aria-labelledby]="tabId(currentIndex())" tabindex="0" [innerHTML]="html()"></div>
        <button type="button" class="copy" (click)="copy()" aria-label="Copy file to clipboard">
          <app-icon [name]="copied() ? 'check' : 'copy'" />
        </button>
        <span class="sr-only" role="status">{{ copied() ? 'Copied to clipboard' : '' }}</span>
      </div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .viewer { border: 1px solid var(--ex-border); background: var(--ex-code-bg); overflow: hidden; }
    .switch-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem 1rem;
      padding: 0.6rem 0.75rem;
      background: var(--ex-surface);
      border-bottom: 1px solid var(--ex-border);
    }
    .switch-label { font-size: 0.8125rem; font-weight: 500; color: var(--ex-muted); }
    .radios { display: inline-flex; border: 1px solid var(--ex-border); background: var(--ex-field); }
    .radio {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.85rem;
      border: 0;
      background: transparent;
      color: var(--ex-muted);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 150ms, color 150ms;
    }
    .radio + .radio { border-inline-start: 1px solid var(--ex-border); }
    .radio:hover { color: var(--ex-title); }
    .radio:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .radio.on { background: var(--ex-tab-active); color: var(--ex-title); box-shadow: inset 0 -2px 0 var(--accent-600); }
    .dot {
      flex: none;
      width: 0.85rem;
      height: 0.85rem;
      border: 2px solid var(--ex-tab-text);
      border-radius: 9999px;
      position: relative;
    }
    .radio.on .dot { border-color: var(--accent-600); }
    .radio.on .dot::after { content: ''; position: absolute; inset: 2px; border-radius: 9999px; background: linear-gradient(135deg, var(--gradient-purple), var(--gradient-blue)); }
    .count { font-family: var(--sl-font-mono); font-size: 0.6875rem; }
    .note { padding: 0.4rem 0.75rem; background: var(--ex-surface); border-bottom: 1px solid var(--ex-border); font-size: 0.75rem; line-height: 1.5; color: var(--ex-muted); }
    .note p { margin: 0; }
    .note p + p { margin-top: 0.4rem; }
    .note code { font-family: var(--sl-font-mono); }
    .tabs-bar { display: flex; height: 2.5rem; align-items: stretch; background: var(--ex-tab-bar); border-bottom: 1px solid var(--ex-border); }
    .tabs { display: flex; min-width: 0; flex: 1; overflow-x: auto; }
    .tab {
      flex: none;
      height: 100%;
      padding: 2px 1rem 1px;
      border: 0;
      border-bottom: 2px solid transparent;
      background: var(--ex-tab-bar);
      color: var(--ex-tab-text);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: color 150ms;
    }
    .tab:hover { color: var(--ex-title); }
    .tab.on { background: var(--ex-tab-active); color: var(--ex-title); border-bottom-color: var(--accent-600); }
    .code-wrap { position: relative; }
    .code { height: 32rem; max-height: 70vh; overflow: auto; background: var(--ex-code-bg); }
    .code:focus-visible { outline-offset: -2px; }
    .tab:focus-visible { outline-offset: -2px; }
    .copy {
      position: absolute;
      top: 0.5rem;
      right: 1.1rem;
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      padding: 0;
      border: 1px solid var(--ex-border);
      background: var(--ex-surface);
      color: var(--ex-title);
      cursor: pointer;
      opacity: 0.75;
    }
    .copy:hover { opacity: 1; border-color: var(--accent-200); }
  `,
})
export class SourceViewer {
  readonly sources = input.required<Record<Variant, readonly SourceFile[]>>();
  readonly variant = input.required<Variant>();
  readonly file = input<string | undefined>(undefined);
  readonly variantChange = output<Variant>();
  readonly fileChange = output<string>();

  protected readonly options: readonly Variant[] = ['integration', 'manual'];
  protected readonly labels = LABELS;
  protected readonly files = computed(() => this.sources()[this.variant()]);
  /** The requested file if this variant has it, otherwise the first one (the same shader file exists in both). */
  protected readonly current = computed(() => this.files().find((file) => file.path === this.file()) ?? this.files()[0]!);
  protected readonly currentPath = computed(() => this.current().path);
  protected readonly copied = signal(false);
  protected readonly currentIndex = computed(() => Math.max(0, this.files().indexOf(this.current())));

  private readonly uid = `source-viewer-${nextViewerId++}`;
  protected readonly groupName = `${this.uid}-variant`;
  protected readonly panelId = `${this.uid}-panel`;

  private readonly injector = inject(Injector);
  private readonly highlighter = inject(Highlighter);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly highlighted = signal<{ code: string; html: string } | undefined>(undefined);
  private timer: ReturnType<typeof setTimeout> | undefined;

  // Our own sources through Shiki, never user input.
  protected readonly html = computed<SafeHtml>(() => {
    const code = this.current().code;
    const done = this.highlighted();
    return this.sanitizer.bypassSecurityTrustHtml(markNumbered(done?.code === code ? done.html : plain(code.trimEnd())));
  });

  constructor() {
    effect((onCleanup) => {
      const code = this.current().code;
      let stale = false;
      onCleanup(() => (stale = true));
      void this.highlighter.html(code.trimEnd(), 'typescript', 'editor').then((html) => {
        if (!stale) this.highlighted.set({ code, html });
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected tabId(index: number): string {
    return `${this.uid}-tab-${index}`;
  }

  /** The tab a keyboard user is on moves with the arrow keys (and Home/End) and selects the file at once, like the tabs pattern in the ARIA practices. */
  protected onTabKey(event: KeyboardEvent): void {
    const files = this.files();
    const last = files.length - 1;
    const current = this.currentIndex();
    const next = event.key === 'ArrowRight' ? (current + 1) % files.length : event.key === 'ArrowLeft' ? (current - 1 + files.length) % files.length : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    this.fileChange.emit(files[next]!.path);
    afterNextRender(() => document.getElementById(this.tabId(next))?.focus(), { injector: this.injector });
  }

  /** The path of the tab that holds the component itself (the first one). */
  protected componentFile(variant: Variant): string {
    return this.sources()[variant][0]!.path;
  }

  /** Lines of the shown files, the shader excluded: both versions share it, so it says nothing about the difference. */
  protected lines(variant: Variant): number {
    return this.sources()[variant].filter((file) => !file.path.endsWith('.gpu.ts') && !file.shared && file.path !== ROOT_FILE).reduce((sum, file) => sum + countCodeLines(file.code), 0);
  }

  /** Lines of the hand-written GPU root: shown with the manual version, written once per application. */
  protected readonly rootLines = computed(() => {
    const root = this.sources().manual.find((file) => file.path === ROOT_FILE);
    return root ? countCodeLines(root.code) : 0;
  });

  protected detail(variant: Variant): string {
    const files = this.sources()[variant].filter((file) => !file.path.endsWith('.gpu.ts') && !file.shared && file.path !== ROOT_FILE).map((file) => file.path);
    return `${LABELS[variant]}: ${files.join(', ')}. Counts non-blank, non-comment lines; the shader, the shared application files and manual-gpu.ts are not included.`;
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.current().code);
      this.copied.set(true);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard access can be denied; nothing to do.
    }
  }
}

const markNumbered = (html: string) => html.replace('<pre class="shiki', '<pre class="shiki numbered');
