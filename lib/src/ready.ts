import {
  Directive,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  untracked,
  type EmbeddedViewRef,
} from '@angular/core';
import type { TgpuRoot } from 'typegpu';
import { TypeGpu, type TypeGpuState } from './type-gpu';

export interface TgpuReadyContext {
  /** The root of the content that is currently shown. */
  $implicit: TgpuRoot;
}

export interface TgpuReadyElseContext {
  /** Why there is no root: `idle`, `initializing`, `unsupported`, `failed` or `lost`. */
  $implicit: TypeGpuState;
}

/**
 * Shows its content only while the GPU root is ready, so that content may call `injectRoot()`.
 * When the root is lost the content is destroyed (all `DestroyRef` cleanups run); after
 * `TypeGpu.retry()` succeeds it is created again.
 *
 * ```html
 * <app-scene *tgpuReady="let root; else fallback" />
 * <ng-template #fallback let-state>@if (state.status === 'unsupported') {...}</ng-template>
 * ```
 */
@Directive({ selector: '[tgpuReady]' })
export class TgpuReady {
  readonly #template = inject<TemplateRef<TgpuReadyContext>>(TemplateRef);
  readonly #container = inject(ViewContainerRef);
  readonly #gpu = inject(TypeGpu);

  readonly else = input<TemplateRef<TgpuReadyElseContext> | undefined>(undefined, {
    alias: 'tgpuReadyElse',
  });

  static ngTemplateContextGuard(_dir: TgpuReady, _ctx: unknown): _ctx is TgpuReadyContext {
    return true;
  }

  constructor() {
    let shown: TgpuRoot | TypeGpuState | undefined;
    let view: EmbeddedViewRef<unknown> | undefined;

    effect(() => {
      const state = this.#gpu.state();
      const elseTemplate = this.else();
      // Ready content is keyed by root identity; anything else by the state object.
      const key = state.status === 'ready' ? state.root : state;

      untracked(() => {
        if (key === shown && state.status === 'ready') return;
        shown = key;
        view?.destroy();
        view = undefined;
        if (state.status === 'ready') {
          view = this.#container.createEmbeddedView(this.#template, { $implicit: state.root });
        } else if (elseTemplate) {
          view = this.#container.createEmbeddedView(elseTemplate, { $implicit: state });
        }
      });
    });
  }
}
