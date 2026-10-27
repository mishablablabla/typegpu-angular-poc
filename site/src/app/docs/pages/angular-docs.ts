import { Component, ElementRef, inject } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';
import { DocTabs } from '../ui/tabs';
import { DocsPage } from '../docs-page';
import { headingsOf, type DocBlock } from '../doc-blocks';
import { ANGULAR_DOC_START } from './angular-content-start';
import { ANGULAR_DOC_MIDDLE } from './angular-content-middle';
import { ANGULAR_DOC_END } from './angular-content-end';

export const ANGULAR_DOC: readonly DocBlock[] = [...ANGULAR_DOC_START, ...ANGULAR_DOC_MIDDLE, ...ANGULAR_DOC_END];

/** `Ecosystem → @typegpu/angular`: the one documentation page implemented in this showcase. */
@Component({
  selector: 'app-angular-docs',
  imports: [DocsPage, CodeBlock, DocTabs, Callout],
  host: { '(click)': 'onClick($event)' },
  template: `
    <app-docs-page title="@typegpu/angular" [headings]="headings">
      @for (block of blocks; track $index) {
        @switch (block.kind) {
          @case ('heading') {
            @if (block.level === 2) {
              <div class="heading-wrapper"><h2 [id]="block.id">{{ block.text }}</h2><a class="anchor" [href]="'#' + block.id" [attr.aria-label]="'Link to ' + block.text">#</a></div>
            } @else {
              <div class="heading-wrapper"><h3 [id]="block.id">{{ block.text }}</h3><a class="anchor" [href]="'#' + block.id" [attr.aria-label]="'Link to ' + block.text">#</a></div>
            }
          }
          @case ('html') { <div [innerHTML]="trust(block.html)"></div> }
          @case ('list') {
            @if (block.ordered) {
              <ol>@for (item of block.items; track $index) { <li [innerHTML]="trust(item)"></li> }</ol>
            } @else {
              <ul>@for (item of block.items; track $index) { <li [innerHTML]="trust(item)"></li> }</ul>
            }
          }
          @case ('code') { <doc-code [code]="block.code" [lang]="block.lang ?? 'typescript'" [title]="block.title" /> }
          @case ('tabs') { <doc-tabs [tabs]="block.tabs" /> }
          @case ('callout') { <doc-callout [type]="block.type" [title]="block.title"><span [innerHTML]="trust(block.html)"></span></doc-callout> }
          @case ('table') {
            <table>
              <thead><tr>@for (cell of block.head; track $index) { <th>{{ cell }}</th> }</tr></thead>
              <tbody>
                @for (row of block.rows; track $index) {
                  <tr>@for (cell of row; track $index) { <td [innerHTML]="trust(cell)"></td> }</tr>
                }
              </tbody>
            </table>
          }
        }
      }
    </app-docs-page>
  `,
})
export class AngularDocs {
  protected readonly blocks = ANGULAR_DOC;
  protected readonly headings = headingsOf(ANGULAR_DOC);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The strings are this site's own prose, never user input. */
  protected trust(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  /** Links to page headings are plain `#id` links inside HTML strings: route them as fragments (the page has a base href). */
  protected onClick(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href');
    if (!link || !href?.startsWith('#') || !this.host.nativeElement.contains(link)) return;
    event.preventDefault();
    void this.router.navigate([], { fragment: href.slice(1) });
  }
}
