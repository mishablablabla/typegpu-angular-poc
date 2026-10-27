import { Injectable, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';

const pathOf = (url: string): string => url.split(/[?#]/)[0]!;

/** State shared by the examples layout and the example page: the side menu and fullscreen mode. */
@Injectable({ providedIn: 'root' })
export class ExamplesView {
  readonly menuShown = signal(typeof window !== 'undefined' && window.innerWidth >= 1025);
  /** Fullscreen is a layout state of the example page only: it never survives leaving it (see the router subscription below). */
  readonly fullscreen = signal(false);

  constructor() {
    effect(() => {
      document.documentElement.toggleAttribute('data-examples-fullscreen', this.fullscreen());
    });
    // Any navigation to another path (Back, a link, the search) ends fullscreen. A query-only change (the source viewer's
    // `?variant=` and `?file=`) stays on the same page and does not.
    const router = inject(Router);
    router.events
      .pipe(
        filter((event): event is NavigationStart => event instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        if (pathOf(event.url) !== pathOf(router.url)) this.fullscreen.set(false);
      });
  }
}
