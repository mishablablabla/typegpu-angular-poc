import { NgComponentOutlet } from '@angular/common';
import { Component, DestroyRef, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild, type ElementRef, type WritableSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { SearchService } from '../shell/search.service';
import type { Variant } from './example.model';
import { fileIn, isCanonical, resolveViewState, viewQuery, type ViewQuery } from './example-url-state';
import { ExamplesView } from './examples-view.service';
import { exampleSourceUrl } from './repository';
import { findExample } from './registry';
import { ControlPanel } from './ui/control-panel';
import { SourceViewer } from './ui/source-viewer';

/**
 * One example: the running scene beside its control panel, what the integration takes over, and the source of both implementations.
 *
 * Fullscreen is only a layout state of this same page: the scene, its canvas and the control panel stay the same elements
 * (a CSS class moves them), so nothing restarts and focus stays on the toggle button.
 */
@Component({
  selector: 'app-example-page',
  imports: [NgComponentOutlet, ControlPanel, SourceViewer, RouterLink],
  host: { '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    <!-- One item, tracked by id: another example gets a whole new view (no state or list items carried over), while changes inside
         one example (fullscreen, the viewer) keep it. -->
    @for (ex of current(); track ex.id) {
      <div class="example" [class.fullscreen]="view.fullscreen()">
        <!-- The heading comes first in the DOM (reading order) and is placed below the scene by the grid. -->
        @if (!view.fullscreen()) {
          <div class="text">
            <h1>{{ ex.title }}</h1>
            <p class="desc">{{ ex.description }}</p>
            <div class="tags">@for (tag of ex.tags; track tag) { <span class="tag">{{ tag }}</span> }</div>
          </div>
        }

        <div class="top" [class.app]="ex.app">
          <div class="preview" [class.app]="ex.app"><ng-container *ngComponentOutlet="scene(); inputs: sceneInputs()" /></div>
          <div class="panel" [class.floating]="view.fullscreen()" [class.collapsed]="view.fullscreen() && !controlsVisible()">
            <app-control-panel #panel [controls]="ex.controls" [params]="params()" [fullscreen]="view.fullscreen()" (fullscreenToggle)="toggleFullscreen()" (hide)="hideControls()" />
          </div>
          @if (view.fullscreen() && !controlsVisible()) {
            <button type="button" class="show-controls" #showControls (click)="showPanel()">Show controls</button>
          }
        </div>

        @if (!view.fullscreen()) {
          <a class="source-link" [href]="sourceUrl()" target="_blank" rel="noreferrer">Source on GitHub</a>

          <section class="takes" aria-labelledby="takes-title">
            <h2 id="takes-title">What the integration takes over in this example</h2>
            <ul>@for (item of ex.highlights; track item) { <li>{{ item }}</li> }</ul>
            <p class="note">Both versions are real, running components with the same behavior: switch below to read each one. The preview shows the version selected in the source viewer.</p>
          </section>

          <app-source-viewer
            [sources]="ex.sources"
            [variant]="variant()"
            [file]="file()"
            (variantChange)="setVariant($event)"
            (fileChange)="setFile($event)"
          />
        }
      </div>
    } @empty {
      <div class="missing">
        <h1>Example not found</h1>
        <p>There is no example called “{{ id() }}”. <a routerLink="/examples">Back to the examples</a>.</p>
      </div>
    }
  `,
  styles: `
    :host { display: block; container-type: inline-size; container-name: example; }
    .example {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'top' 'text' 'link' 'takes' 'viewer';
      gap: 1rem;
      max-width: 64rem;
      margin-inline: auto;
      padding-bottom: 2rem;
    }
    @container example (min-width: 38rem) {
      .example { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'top top' 'text link' 'takes takes' 'viewer viewer'; }
    }
    .top { grid-area: top; position: relative; display: flex; flex-direction: column; gap: 1rem; }
    @container example (min-width: 48rem) {
      .top { flex-direction: row; height: calc(100cqw - 19rem); max-height: 44rem; }
      .top.app { height: max(40rem, calc(100cqw - 19rem)); max-height: 48rem; }
      .panel { width: 18rem; flex: none; height: 100%; }
    }
    .preview {
      position: relative;
      display: block;
      aspect-ratio: 1;
      width: 100%;
      flex: 1;
      overflow: hidden;
      background: var(--ex-preview);
      border: 1px solid var(--ex-border);
    }
    @container example (min-width: 48rem) { .preview { aspect-ratio: auto; } }
    @container example (max-width: 47.99rem) { .preview.app { aspect-ratio: auto; height: 44rem; flex: none; } }
    .panel { min-height: 0; }
    @container example (max-width: 47.99rem) { .panel { max-height: 100cqw; } }
    .text { grid-area: text; display: flex; min-width: 0; flex-direction: column; gap: 1rem; padding-top: 1rem; }
    h1 { margin: 0; font-size: 2.25rem; font-weight: 600; line-height: 1.2; color: var(--ex-title); }
    .desc { margin: 0; font-size: 1rem; line-height: 1.65; color: var(--ex-muted); }
    .tags { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .tag { padding: 4px 12px; border-radius: 4px; background: var(--ex-chip); color: var(--ex-chip-text); font-size: 0.75rem; }
    .source-link {
      grid-area: link;
      align-self: start;
      justify-self: start;
      display: inline-flex;
      align-items: center;
      margin-top: 1rem;
      padding: 0.625rem 1.25rem;
      border: 1px solid var(--ex-border);
      background: var(--ex-button);
      color: var(--ex-button-text);
      font-size: 0.875rem;
      text-decoration: none;
    }
    .source-link:hover { border-color: var(--accent-200); }
    .takes { grid-area: takes; padding: 1rem 1.25rem; border: 1px solid var(--ex-border); background: var(--ex-surface); }
    app-source-viewer { grid-area: viewer; min-width: 0; }
    .takes h2 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; color: var(--ex-title); line-height: 1.4; }
    .takes ul { margin: 0; padding-inline-start: 1.25rem; font-size: 0.9375rem; line-height: 1.65; color: var(--ex-muted); }
    .takes .note { margin: 0.75rem 0 0; font-size: 0.8125rem; color: var(--ex-muted); }

    /* Fullscreen: the same elements, laid out over the whole window (more specific than the container rules above). */
    .example.fullscreen { position: fixed; inset: 0; z-index: 50; display: block; max-width: none; margin: 0; padding: 0; background: var(--ex-bg); }
    .example.fullscreen .top { position: absolute; inset: 0; display: block; height: auto; max-height: none; }
    .example.fullscreen .preview { position: absolute; inset: 0; width: auto; height: auto; aspect-ratio: auto; border: 0; }
    .example.fullscreen .panel.floating {
      position: absolute;
      right: 1rem;
      bottom: 1rem;
      z-index: 20;
      display: flex;
      width: 24rem;
      max-width: calc(100% - 2rem);
      height: auto;
      max-height: calc(100dvh - 2rem);
    }
    .example.fullscreen .panel.floating app-control-panel { width: 100%; }
    .example.fullscreen .panel.collapsed { display: none; }
    .show-controls { position: absolute; right: 1rem; bottom: 1rem; z-index: 20; padding: 0.625rem 1.25rem; border: 1px solid var(--ex-border); background: var(--ex-button); color: var(--ex-button-text); cursor: pointer; font-size: 0.875rem; }
    .missing { padding: 3rem 0; }
    .missing h1 { margin-bottom: 1rem; }
  `,
})
export class ExamplePage {
  protected readonly view = inject(ExamplesView);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly search = inject(SearchService);
  private readonly injector = inject(Injector);
  /** Only meaningful in fullscreen: the floating control panel is shown or tucked away. */
  protected readonly controlsVisible = signal(false);

  private readonly panel = viewChild<ControlPanel>('panel');
  private readonly showControls = viewChild<ElementRef<HTMLElement>>('showControls');

  protected readonly id = toSignal(this.route.paramMap.pipe(map((params) => params.get('id'))), { initialValue: this.route.snapshot.paramMap.get('id') });
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  protected readonly example = computed(() => findExample(this.id()));
  protected readonly current = computed(() => {
    const example = this.example();
    return example ? [example] : [];
  });
  /**
   * The selected implementation and file live in the URL only (`?variant=manual&file=...`): it is the one source of truth, so a view
   * can be shared, Back and Forward work, and another example always starts from the default (its link has no query).
   */
  private readonly viewState = computed(() => {
    const example = this.example();
    return example ? resolveViewState(example, this.query()) : { variant: 'integration' as Variant, file: undefined };
  });
  protected readonly variant = computed(() => this.viewState().variant);
  protected readonly file = computed(() => this.viewState().file);
  protected readonly sourceUrl = computed(() => {
    const example = this.example();
    return example ? exampleSourceUrl(example) : '';
  });
  /** New signals for every example, so parameters do not leak from one example to the next. */
  protected readonly params = computed(() => this.example()?.createParams() ?? {});
  protected readonly scene = computed(() => this.example()?.scenes[this.variant()] ?? null);
  /** Every control becomes an input of the scene with the same name. */
  protected readonly sceneInputs = computed(() => {
    const params = this.params();
    const inputs: Record<string, unknown> = Object.fromEntries(Object.entries(params).map(([key, signal]) => [key, signal()]));
    // Scenes that edit a control from inside (a list of machines, a chart range) get a setter for it.
    if (this.example()?.setsParams) inputs['setParam'] = (key: string, value: string | number | boolean) => (params[key] as WritableSignal<unknown> | undefined)?.set(value);
    return inputs;
  });

  constructor() {
    effect(() => {
      const example = this.example();
      this.title.setTitle(example ? `${example.title} | TypeGPU examples` : 'Example not found | TypeGPU');
    });

    // Invalid or stale values (an unknown variant, a file the variant does not have) are replaced in the URL, not silently kept.
    effect(() => {
      const example = this.example();
      const params = this.query();
      if (!example) return;
      const wanted = viewQuery(resolveViewState(example, params));
      if (!isCanonical(params, wanted)) untracked(() => this.navigate(wanted));
    });

    // Fullscreen belongs to this page: leaving it ends fullscreen (navigating to another path does too, see ExamplesView).
    inject(DestroyRef).onDestroy(() => this.view.fullscreen.set(false));
  }

  protected setVariant(variant: Variant): void {
    if (variant === this.variant()) return;
    // The file stays only if the other implementation has it too (the shader does; the component and the GPU root do not).
    const example = this.example();
    this.navigate({ variant: variant === 'manual' ? 'manual' : null, file: (example && fileIn(example, variant, this.file())) ?? null });
  }

  protected setFile(file: string): void {
    this.navigate({ variant: this.variant() === 'manual' ? 'manual' : null, file });
  }

  /** Changes the query of this page in place: no new history entry and no scrolling to the top. Other parameters are kept. */
  private navigate(view: ViewQuery): void {
    const others = Object.fromEntries(this.query().keys.filter((key) => key !== 'variant' && key !== 'file').map((key) => [key, this.query().getAll(key)]));
    void this.router.navigate([], { relativeTo: this.route, queryParams: { ...view, ...others }, replaceUrl: true, scroll: 'manual' });
  }

  protected toggleFullscreen(): void {
    const next = !this.view.fullscreen();
    if (next) this.controlsVisible.set(true);
    this.view.fullscreen.set(next);
  }

  protected hideControls(): void {
    this.controlsVisible.set(false);
    afterNextRender(() => this.showControls()?.nativeElement.focus(), { injector: this.injector });
  }

  protected showPanel(): void {
    this.controlsVisible.set(true);
    afterNextRender(() => this.panel()?.focusToggle(), { injector: this.injector });
  }

  /** Escape leaves fullscreen, unless something else (the search dialog) already used the key. */
  protected onEscape(event: Event): void {
    if (!this.view.fullscreen() || event.defaultPrevented || this.search.open()) return;
    this.view.fullscreen.set(false);
    afterNextRender(() => this.panel()?.focusToggle(), { injector: this.injector });
  }
}
