// Accessibility smoke tests at the DOM level: landmarks, headings, labels, live regions and focus management. They cannot judge
// colors or focus rings (CSS is not computed in jsdom); they keep the structure that assistive technology reads from regressing.
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import { ANGULAR_DOCS_ROUTE } from './docs/docs-nav';
import { DocTabs } from './docs/ui/tabs';
import { allowConsole } from './testing/console-gate';
import { bootApp, pressKey, type BootedApp } from './testing/app-harness';
import { ExamplesView } from './examples/examples-view.service';
import { EXAMPLES } from './examples/registry';
import { installBrowserStubs, type BrowserStubs } from './examples/testing/example-env';
import { installFakeGpu, type FakeGpu } from './examples/testing/example-gpu';
import { createExampleRoot } from './examples/testing/example-root';

let frames: ManualAnimationFrames;
let stubs: BrowserStubs | undefined;
let gpu: FakeGpu | undefined;

beforeEach(() => {
  frames = installManualAnimationFrames();
});
afterEach(() => {
  TestBed.resetTestingModule();
  frames.restore();
  gpu?.restore();
  stubs?.restore();
  gpu = stubs = undefined;
});

const headings = (app: BootedApp) => [...app.el.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => Number(heading.tagName[1]));

describe('landmarks and the skip link', () => {
  it.each([ANGULAR_DOCS_ROUTE, '/examples', '/examples/life', '/no/such/page'])('%s has the skip link first and one main landmark it leads to', async (url) => {
    const app = await bootApp(url);
    const skip = app.el.querySelector<HTMLAnchorElement>('a.skip-link')!;
    expect(skip).not.toBeNull();
    expect(app.el.querySelector('a, button, input, select')).toBe(skip); // the first thing in tab order
    const target = skip.getAttribute('href')!.slice(1);
    const mains = app.el.querySelectorAll('main');
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).toBe(target);
    expect(mains[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('moves focus to the content when used, without leaving the page', async () => {
    const app = await bootApp('/examples/life');
    const url = app.router.url;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    app.el.querySelector('a.skip-link')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(app.el.querySelector('main'));
    expect(app.router.url).toBe(url);
  });
});

describe('headings', () => {
  it.each([ANGULAR_DOCS_ROUTE, '/examples', '/examples/life', '/examples/the-core', '/examples/nope', '/no/such/page'])('%s has exactly one h1, and it is the first heading', async (url) => {
    const app = await bootApp(url);
    const levels = headings(app);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
  });

  it('never skips a level on the example page', async () => {
    const app = await bootApp('/examples/life');
    const levels = headings(app);
    levels.forEach((level, index) => expect(level - (levels[index - 1] ?? 0), `heading ${index}`).toBeLessThanOrEqual(1));
  });
});

describe('the examples', () => {
  it.each(EXAMPLES.map((example) => [example.id, example.title] as const))('%s draws a canvas that is an image with a name, and has no unnamed controls', async (id, title) => {
    stubs = installBrowserStubs();
    gpu = installFakeGpu(true);
    gpu.queue.push(createExampleRoot());
    const app = await bootApp(`/examples/${id}`);
    for (let i = 0; i < 20 && !app.el.querySelector('canvas'); i++) await app.settle();
    const canvas = app.el.querySelector('canvas')!;
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toMatch(new RegExp(title.split(' ')[0]!, 'i'));
    expect(canvas.textContent!.trim().length, 'fallback text').toBeGreaterThan(10);
    for (const control of app.el.querySelectorAll('app-control-panel button, app-control-panel input, app-control-panel select')) {
      const named = control.getAttribute('aria-label') || (control as HTMLElement).textContent?.trim() || (control.id && app.el.querySelector(`label[for="${control.id}"]`)) || control.closest('label');
      expect(named, `${control.tagName} ${control.id}`).toBeTruthy();
    }
  });

  it('says "the GPU is starting" as a status, and "not available" as an alert', async () => {
    const app = await bootApp('/examples/life'); // no WebGPU in jsdom
    const alert = app.el.querySelector('.gpu-notice')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('WebGPU is not available');
    expect(alert.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull(); // a notice is not a heading
  });

  it('shows a spinner with a status text while the GPU starts', async () => {
    // A GPU that never answers: the scene stays in its "starting" state.
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { getPreferredCanvasFormat: () => 'bgra8unorm', requestAdapter: () => new Promise(() => undefined) } });
    try {
      const app = await bootApp('/examples/life');
      const spinner = app.el.querySelector('.gpu-spinner')!;
      expect(spinner).not.toBeNull();
      expect(spinner.getAttribute('role')).toBe('status');
      expect(spinner.textContent!.trim().length).toBeGreaterThan(0);
    } finally {
      delete (navigator as unknown as Record<string, unknown>)['gpu'];
    }
  });

  it('puts the recoverable failures in alerts with their button inside', async () => {
    stubs = installBrowserStubs();
    gpu = installFakeGpu(true);
    gpu.queue.push(new Error('adapter request failed'));
    allowConsole(/adapter request failed/); // the failure is reported once, as it should be
    const app = await bootApp('/examples/life');
    for (let i = 0; i < 20 && !app.el.querySelector('.gpu-notice'); i++) await app.settle();
    const alert = app.el.querySelector('.gpu-notice')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('GPU initialization failed');
    expect(alert.querySelector('button')!.textContent).toBe('Retry');
  });
});

describe('controls with state', () => {
  it('the theme buttons say which one is pressed, in the header and in the menu', async () => {
    const app = await bootApp('/examples');
    const pressed = () => [...app.el.querySelectorAll('app-site-header .theme button')].map((button) => button.getAttribute('aria-pressed'));
    const before = pressed();
    expect(before.sort()).toEqual(['false', 'true']);
    (app.el.querySelector('app-site-header .theme button[aria-pressed=false]') as HTMLButtonElement).click();
    await app.settle();
    expect(pressed().sort()).toEqual(['false', 'true']);
    expect([...app.el.querySelectorAll('app-site-header .theme button')].map((button) => button.getAttribute('aria-pressed'))).not.toEqual(before);
    document.documentElement.dataset['theme'] = 'dark';
  });

  it('the filter button says whether the filter is open, and the tag chips whether they are on', async () => {
    const app = await bootApp('/examples');
    TestBed.inject(ExamplesView).menuShown.set(true);
    await app.settle();
    const filter = app.el.querySelector<HTMLButtonElement>('button.filter')!;
    expect(filter.getAttribute('aria-expanded')).toBe('false');
    filter.click();
    await app.settle();
    expect(filter.getAttribute('aria-expanded')).toBe('true');
    expect(app.el.querySelector('#' + filter.getAttribute('aria-controls'))).not.toBeNull();
    const chips = [...app.el.querySelectorAll<HTMLButtonElement>('button.chip')];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
    chips[0]!.click();
    await app.settle();
    expect(app.el.querySelectorAll<HTMLButtonElement>('button.chip')[0]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('the navigation menu is a disclosure, not an unmanaged modal: expanded state, no aria-modal, Escape closes and returns focus', async () => {
    const app = await bootApp('/examples');
    const button = app.el.querySelector<HTMLButtonElement>('button.menu-button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.focus();
    button.click();
    await app.settle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = app.el.querySelector('app-mobile-nav')!;
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.querySelector('[aria-modal]')).toBeNull();
    expect(menu.querySelector('[role=dialog]')).toBeNull();
    expect(menu.querySelector('nav[aria-label]')).not.toBeNull();

    pressKey(document, 'Escape');
    await app.settle();
    expect(app.el.querySelector('app-mobile-nav')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('the examples menu hands focus over when it opens and closes', async () => {
    const app = await bootApp('/examples');
    const view = TestBed.inject(ExamplesView);
    view.menuShown.set(false);
    await app.settle();
    const browse = app.el.querySelector<HTMLButtonElement>('button.browse')!;
    browse.focus();
    browse.click();
    await app.settle();
    await app.settle();
    expect(document.activeElement).toBe(app.el.querySelector('input.search'));
    app.el.querySelector<HTMLButtonElement>('aside.menu button.close')!.click();
    await app.settle();
    await app.settle();
    expect(document.activeElement).toBe(app.el.querySelector('button.browse'));
  });
});

describe('docs tabs', () => {
  it('are a tablist with a roving tabindex, a labelled tabpanel and arrow keys', async () => {
    const fixture = TestBed.createComponent(DocTabs);
    fixture.componentRef.setInput('tabs', [
      { label: 'npm', code: 'npm install x' },
      { label: 'pnpm', code: 'pnpm add x' },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    expect(buttons.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    const panel = root.querySelector('[role=tabpanel]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(buttons[0]!.id);
    for (const tab of buttons) expect(tab.getAttribute('aria-controls')).toBe(panel.id);

    pressKey(buttons[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(buttons[1]!.getAttribute('aria-selected')).toBe('true');
    expect(buttons.map((tab) => tab.tabIndex)).toEqual([-1, 0]);
    expect(document.activeElement).toBe(buttons[1]);
    expect(root.querySelector('[role=tabpanel]')!.getAttribute('aria-labelledby')).toBe(buttons[1]!.id);
  });
});
