import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';
import type { Subject } from 'rxjs';
import { ExamplesView } from './examples-view.service';

afterEach(() => TestBed.resetTestingModule());

/** The service with a router that is "at" `current`; `navigateTo` announces a navigation the way the router does. */
function setup(current: string) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const router = TestBed.inject(Router);
  Object.defineProperty(router, 'url', { configurable: true, get: () => current });
  const view = TestBed.inject(ExamplesView);
  const navigateTo = (url: string) => (router.events as unknown as Subject<NavigationStart>).next(new NavigationStart(1, url));
  return { view, navigateTo };
}

describe('ExamplesView fullscreen', () => {
  it('ends when a navigation goes to another path (a link, Back, the search), even if the page is not destroyed', () => {
    const { view, navigateTo } = setup('/examples/life');
    view.fullscreen.set(true);
    navigateTo('/examples');
    expect(view.fullscreen()).toBe(false);

    view.fullscreen.set(true);
    navigateTo('/examples/the-core');
    expect(view.fullscreen()).toBe(false);

    view.fullscreen.set(true);
    navigateTo('/docs/ecosystem/typegpu-angular#setup');
    expect(view.fullscreen()).toBe(false);
  });

  it('stays when only the query or the fragment changes (the source viewer, an anchor)', () => {
    const { view, navigateTo } = setup('/examples/life?variant=manual');
    view.fullscreen.set(true);
    navigateTo('/examples/life');
    navigateTo('/examples/life?variant=manual&file=life.gpu.ts');
    navigateTo('/examples/life#top');
    expect(view.fullscreen()).toBe(true);
  });

  it('puts the marker on the document while it is on (the header hides) and takes it off again', async () => {
    const { view } = setup('/examples/life');
    TestBed.flushEffects();
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(false);
    view.fullscreen.set(true);
    TestBed.flushEffects();
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(true);
    view.fullscreen.set(false);
    TestBed.flushEffects();
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(false);
  });
});
