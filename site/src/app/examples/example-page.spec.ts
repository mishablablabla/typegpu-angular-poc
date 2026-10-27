// The example page as a user meets it: URL state (variant and file), fullscreen, the not-found view. Run through the real routes
// and the real layout; without WebGPU unless a test installs the fake one (the scene then shows its "not available" notice).
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import { SearchService } from '../shell/search.service';
import { bootApp, pressKey, type BootedApp } from '../testing/app-harness';
import { ExamplesView } from './examples-view.service';
import { exampleSourceUrl } from './repository';
import { findExample } from './registry';
import { installBrowserStubs, type BrowserStubs } from './testing/example-env';
import { installFakeGpu, type FakeGpu } from './testing/example-gpu';
import { createExampleRoot } from './testing/example-root';

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

const radios = (app: BootedApp) => [...app.el.querySelectorAll<HTMLInputElement>('app-source-viewer input[type=radio]')];
const tabs = (app: BootedApp) => [...app.el.querySelectorAll<HTMLButtonElement>('app-source-viewer [role=tab]')];
const selectedTab = (app: BootedApp) => tabs(app).find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent?.trim();
const checkedVariant = (app: BootedApp) => (radios(app)[1]!.checked ? 'manual' : radios(app)[0]!.checked ? 'integration' : 'none');
const toggle = (app: BootedApp) => app.el.querySelector<HTMLButtonElement>('app-control-panel button.wide')!;
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('URL state of the source viewer', () => {
  it('starts with the integrated version, its first file and no query', async () => {
    const app = await bootApp('/examples/life');
    expect(checkedVariant(app)).toBe('integration');
    expect(selectedTab(app)).toBe('life.integrated.ts');
    expect(app.router.url).toBe('/examples/life');
  });

  it('keeps a valid deep link', async () => {
    const app = await bootApp('/examples/life?variant=manual&file=manual-gpu.ts');
    expect(checkedVariant(app)).toBe('manual');
    expect(selectedTab(app)).toBe('manual-gpu.ts');
    expect(app.router.url).toBe('/examples/life?variant=manual&file=manual-gpu.ts');
  });

  it('replaces an invalid variant and an unknown file in the URL instead of keeping them', async () => {
    const app = await bootApp('/examples/life?variant=bogus&file=nope.ts');
    expect(checkedVariant(app)).toBe('integration');
    expect(selectedTab(app)).toBe('life.integrated.ts');
    expect(app.router.url).toBe('/examples/life');
  });

  it('replaces a file of the other implementation, and an explicit default variant', async () => {
    const stale = await bootApp('/examples/life?file=manual-gpu.ts');
    expect(stale.router.url).toBe('/examples/life');
    expect(selectedTab(stale)).toBe('life.integrated.ts');
    TestBed.resetTestingModule();

    const wrongVariant = await bootApp('/examples/life?variant=manual&file=life.integrated.ts');
    expect(wrongVariant.router.url).toBe('/examples/life?variant=manual');
    expect(selectedTab(wrongVariant)).toBe('life.manual.ts');
    TestBed.resetTestingModule();

    const explicit = await bootApp('/examples/life?variant=integration');
    expect(explicit.router.url).toBe('/examples/life');
  });

  it('adds no history entries when it normalizes or when the user switches: Back leaves the example', async () => {
    const app = await bootApp('/examples');
    await app.go('/examples/life?variant=bogus&file=nope.ts');
    expect(app.router.url).toBe('/examples/life');
    radios(app)[1]!.click();
    await app.settle();
    tabs(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual&file=life.gpu.ts');

    TestBed.inject(Location).back();
    await wait();
    await app.settle();
    expect(app.router.url).toBe('/examples');
  });

  it('follows the viewer: choosing a variant and a file changes the URL, choosing the other variant drops the file', async () => {
    const app = await bootApp('/examples/life');
    radios(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual');
    tabs(app)[2]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual&file=manual-gpu.ts');
    expect(selectedTab(app)).toBe('manual-gpu.ts');

    // manual-gpu.ts is not part of the integrated version: the file is dropped.
    radios(app)[0]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life');
    expect(selectedTab(app)).toBe('life.integrated.ts');
  });

  it('keeps a file both implementations have (the shader) when the implementation changes', async () => {
    const app = await bootApp('/examples/life?file=life.gpu.ts');
    expect(selectedTab(app)).toBe('life.gpu.ts');
    radios(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual&file=life.gpu.ts');
    expect(selectedTab(app)).toBe('life.gpu.ts');
    radios(app)[0]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?file=life.gpu.ts');
    expect(selectedTab(app)).toBe('life.gpu.ts');
  });

  it('starts every other example from the default, whatever was chosen on the previous one', async () => {
    const app = await bootApp('/examples/life');
    radios(app)[1]!.click();
    await app.settle();
    tabs(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual&file=life.gpu.ts');

    await app.go('/examples/the-core');
    expect(app.router.url).toBe('/examples/the-core');
    expect(checkedVariant(app)).toBe('integration');
    expect(selectedTab(app)).toBe('core.integrated.ts');
    expect(app.el.querySelector('h1')?.textContent).toBe('THE CORE');
  });

  it('works with Back and Forward: the viewer follows the history', async () => {
    const app = await bootApp('/examples');
    await app.go('/examples/life');
    radios(app)[1]!.click(); // replaces the entry: Back goes to the gallery, not to a half-state
    await app.settle();
    await app.go('/examples/the-core');
    const location = TestBed.inject(Location);

    location.back();
    await wait();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual');
    expect(checkedVariant(app)).toBe('manual');

    location.back();
    await wait();
    await app.settle();
    expect(app.router.url).toBe('/examples');

    location.forward();
    await wait();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual');
    expect(checkedVariant(app)).toBe('manual');
  });

  it('asks the router to replace the entry and not to scroll when the viewer changes the URL (so the page does not jump to the top)', async () => {
    const app = await bootApp('/examples/life');
    await app.go('/examples/the-core');
    const extras = () => app.router.lastSuccessfulNavigation()?.extras;
    expect(extras()?.scroll).toBeUndefined(); // an ordinary navigation scrolls

    radios(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/the-core?variant=manual');
    expect(extras()?.scroll).toBe('manual');
    expect(extras()?.replaceUrl).toBe(true);

    tabs(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/the-core?variant=manual&file=core.gpu.ts');
    expect(extras()?.scroll).toBe('manual');
    expect(extras()?.replaceUrl).toBe(true);
  });

  it('keeps other query parameters, and writes variant before file', async () => {
    const app = await bootApp('/examples/life?utm=a&file=life.gpu.ts');
    radios(app)[1]!.click();
    await app.settle();
    expect(app.router.url).toBe('/examples/life?variant=manual&file=life.gpu.ts&utm=a');
  });
});

describe('example not found', () => {
  it('shows a clear view with its own title, throws nothing and keeps the layout', async () => {
    const app = await bootApp('/examples/nope');
    expect(app.el.querySelector('h1')?.textContent).toBe('Example not found');
    expect(app.el.textContent).toContain('nope');
    expect(app.el.querySelector('a[href="/examples"]')).not.toBeNull();
    expect(document.title).toBe('Example not found | TypeGPU');
    expect(app.el.querySelector('app-source-viewer')).toBeNull();
    expect(app.router.url).toBe('/examples/nope');
  });

  it('leaves the not-found state when a real example is opened', async () => {
    const app = await bootApp('/examples/nope');
    await app.go('/examples/life');
    expect(app.el.querySelector('h1')?.textContent).toBe('Game of Life');
    expect(document.title).toBe('Game of Life | TypeGPU examples');
  });
});

describe('source link', () => {
  it.each(['life', 'the-core', 'matrix'])('points %s at its folder in the repository', async (id) => {
    const app = await bootApp(`/examples/${id}`);
    const link = app.el.querySelector<HTMLAnchorElement>('a.source-link')!;
    expect(link.getAttribute('href')).toBe(exampleSourceUrl(findExample(id)!));
    expect(link.getAttribute('href')).toMatch(new RegExp(`/examples/${findExample(id)!.folder}$`));
  });
});

describe('fullscreen', () => {
  async function bootWithGpu(url: string) {
    stubs = installBrowserStubs();
    gpu = installFakeGpu(true);
    gpu.queue.push(createExampleRoot());
    const app = await bootApp(url);
    for (let i = 0; i < 20 && !app.el.querySelector('canvas'); i++) await app.settle();
    return app;
  }

  it('is a layout state of the same page: the canvas, the scene and the toggle are the same elements, and focus stays on the toggle', async () => {
    const app = await bootWithGpu('/examples/life');
    const canvas = app.el.querySelector('canvas');
    expect(canvas).not.toBeNull();
    const button = toggle(app);
    button.focus();
    expect(app.el.querySelector('h1')).not.toBeNull();

    button.click();
    await app.settle();
    const view = TestBed.inject(ExamplesView);
    expect(view.fullscreen()).toBe(true);
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(true);
    expect(app.el.querySelector('.example')!.classList.contains('fullscreen')).toBe(true);
    expect(app.el.querySelector('canvas')).toBe(canvas);
    expect(toggle(app)).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.textContent?.trim()).toBe('Exit fullscreen');
    expect(app.el.querySelector('h1')).toBeNull(); // the description and the source are not part of the fullscreen view

    toggle(app).click();
    await app.settle();
    expect(view.fullscreen()).toBe(false);
    expect(app.el.querySelector('canvas')).toBe(canvas);
    expect(document.activeElement).toBe(button);
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(false);
    expect(app.el.querySelector('h1')).not.toBeNull();
  });

  it('keeps the scene state across the toggle (the same running scene, not a new one)', async () => {
    const root = createExampleRoot();
    stubs = installBrowserStubs();
    gpu = installFakeGpu(true);
    gpu.queue.push(root);
    const app = await bootApp('/examples/life');
    for (let i = 0; i < 20 && root.stats.draws === 0; i++) {
      await app.settle();
      frames.flush();
    }
    const resources = root.fake.resources.length;
    const live = root.fake.liveResources();
    toggle(app).click();
    await app.settle();
    toggle(app).click();
    await app.settle();
    expect(root.fake.resources.length).toBe(resources); // nothing was created again
    expect(root.fake.liveResources()).toBe(live); // and nothing was destroyed
    expect(gpu.starts()).toBe(1);
  });

  it('ends on Escape, puts focus back on the toggle, and does nothing when fullscreen is off', async () => {
    const app = await bootApp('/examples/life');
    const view = TestBed.inject(ExamplesView);
    const event = pressKey(document, 'Escape');
    expect(view.fullscreen()).toBe(false);
    expect(event.defaultPrevented).toBe(false);

    toggle(app).click();
    await app.settle();
    expect(view.fullscreen()).toBe(true);
    pressKey(document.body, 'Escape');
    await app.settle();
    expect(view.fullscreen()).toBe(false);
    expect(document.activeElement).toBe(toggle(app));
  });

  it('does not end when Escape was used for something else (the search dialog, or a handler that took the key)', async () => {
    const app = await bootApp('/examples/life');
    const view = TestBed.inject(ExamplesView);
    toggle(app).click();
    await app.settle();

    TestBed.inject(SearchService).show();
    await app.settle();
    const input = app.el.querySelector<HTMLInputElement>('app-search-dialog input')!;
    pressKey(input, 'Escape');
    await app.settle();
    expect(app.el.querySelector('app-search-dialog .dialog')).toBeNull();
    expect(view.fullscreen()).toBe(true);

    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    await app.settle();
    expect(view.fullscreen()).toBe(true);

    pressKey(document, 'Escape');
    await app.settle();
    expect(view.fullscreen()).toBe(false);
  });

  it('is reset when the route leaves the example (Back included)', async () => {
    const app = await bootApp('/examples');
    await app.go('/examples/life');
    const view = TestBed.inject(ExamplesView);
    toggle(app).click();
    await app.settle();
    expect(view.fullscreen()).toBe(true);

    TestBed.inject(Location).back();
    await wait();
    await app.settle();
    expect(app.router.url).toBe('/examples');
    expect(view.fullscreen()).toBe(false);
    expect(document.documentElement.hasAttribute('data-examples-fullscreen')).toBe(false);
    expect(app.el.querySelector('app-site-header')).not.toBeNull();
    expect(getComputedStyle(app.el.querySelector('app-site-header')!).display).not.toBe('none');
    expect(app.el.querySelector('.gallery')).not.toBeNull();
  });

  it('is reset when the page is destroyed, without any navigation', async () => {
    const app = await bootApp('/examples/life');
    const view = TestBed.inject(ExamplesView);
    toggle(app).click();
    await app.settle();
    expect(view.fullscreen()).toBe(true);
    app.fixture.destroy();
    expect(view.fullscreen()).toBe(false);
  });

  it('is reset when another example is opened, and survives a query-only change', async () => {
    const app = await bootApp('/examples/life');
    const view = TestBed.inject(ExamplesView);
    toggle(app).click();
    await app.settle();
    await app.router.navigate([], { queryParams: { variant: null }, queryParamsHandling: 'merge', replaceUrl: true });
    await app.settle();
    expect(view.fullscreen()).toBe(true);

    await app.go('/examples/the-core');
    expect(view.fullscreen()).toBe(false);
  });

  it('tucks the controls away and brings them back with focus where the user is', async () => {
    const app = await bootApp('/examples/life');
    toggle(app).click();
    await app.settle();
    const hide = app.el.querySelector<HTMLButtonElement>('app-control-panel .small')!;
    hide.click();
    await app.settle();
    await app.settle();
    const show = app.el.querySelector<HTMLButtonElement>('.show-controls')!;
    expect(show).not.toBeNull();
    expect(document.activeElement).toBe(show);
    expect(app.el.querySelector('.panel')!.classList.contains('collapsed')).toBe(true);

    show.click();
    await app.settle();
    await app.settle();
    expect(app.el.querySelector('.show-controls')).toBeNull();
    expect(document.activeElement).toBe(toggle(app));
  });
});
