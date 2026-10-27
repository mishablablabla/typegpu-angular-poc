// Boots the whole app shell (header, routed page, search dialog) in jsdom with the real routes, for specs about behavior that spans
// components: URL state, fullscreen, the search dialog, accessibility. The code highlighter is replaced by plain text (Shiki is
// large and none of these specs is about colors), and the browser APIs jsdom lacks are given inert stand-ins.
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';
import { App } from '../app';
import { routes } from '../app.routes';
import { Highlighter, plain } from '../shared/highlighter';

export interface BootedApp {
  fixture: ComponentFixture<App>;
  router: Router;
  /** The root element of the app. */
  el: HTMLElement;
  /** Lets navigation, effects, timers and change detection finish. */
  settle(): Promise<void>;
  /** Navigates and settles. */
  go(url: string): Promise<void>;
}

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Call once per test, before anything is created. `url` is the first page. */
export async function bootApp(url: string): Promise<BootedApp> {
  vi.stubGlobal('IntersectionObserver', InertObserver);
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), { provide: Highlighter, useValue: { html: (code: string) => Promise.resolve(plain(code)) } }],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  // A bootstrapped app does this itself; a test that creates the root component has to ask, or Back and Forward are not heard.
  router.setUpLocationChangeListener();
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fixture.detectChanges();
  };
  const go = async (target: string) => {
    await router.navigateByUrl(target);
    await settle();
  };
  await go(url);
  return { fixture, router, el: fixture.nativeElement as HTMLElement, settle, go };
}

/** Dispatches a key on `target` the way the browser does (bubbling, cancelable). Returns the event. */
export function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
