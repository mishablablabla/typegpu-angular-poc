// The search dialog: opened with Ctrl+K, a modal combobox. Keys count only inside it, focus is trapped and comes back, and the
// ARIA roles describe what is on screen.
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, pressKey, type BootedApp } from '../testing/app-harness';
import { SEARCH_INDEX } from './search-index';

afterEach(() => TestBed.resetTestingModule());

const dialog = (app: BootedApp) => app.el.querySelector<HTMLElement>('app-search-dialog .dialog');
const input = (app: BootedApp) => app.el.querySelector<HTMLInputElement>('app-search-dialog input')!;
const options = (app: BootedApp) => [...app.el.querySelectorAll<HTMLElement>('app-search-dialog [role=option]')];

async function type(app: BootedApp, query: string): Promise<void> {
  input(app).value = query;
  input(app).dispatchEvent(new Event('input', { bubbles: true }));
  await app.settle();
}

/** Opens the dialog the way a user does (Ctrl+K), waits for the index, and types. */
async function openWith(app: BootedApp, query: string): Promise<void> {
  pressKey(document, 'k', { ctrlKey: true });
  await app.settle();
  await new Promise((resolve) => setTimeout(resolve, 20)); // the index loads lazily
  await type(app, query);
}

describe('the search dialog', () => {
  it('opens and closes with Ctrl+K (and Cmd+K) from anywhere, and focuses the field', async () => {
    const app = await bootApp('/examples');
    expect(dialog(app)).toBeNull();
    pressKey(document, 'k', { ctrlKey: true });
    await app.settle();
    expect(dialog(app)).not.toBeNull();
    expect(document.activeElement).toBe(input(app));
    pressKey(input(app), 'k', { ctrlKey: true });
    await app.settle();
    expect(dialog(app)).toBeNull();
    pressKey(document, 'K', { metaKey: true });
    await app.settle();
    expect(dialog(app)).not.toBeNull();
  });

  it('finds examples and headings', async () => {
    const app = await bootApp('/examples');
    await openWith(app, 'risk');
    expect(options(app).map((option) => option.textContent)).toEqual([expect.stringContaining('Risk field')]);
    await type(app, 'destroys');
    expect(options(app).length).toBeGreaterThan(0);
  });

  describe('keys', () => {
    it('Arrow keys move the highlighted result, and Enter in the field opens exactly that one', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const found = options(app);
      expect(found.length).toBeGreaterThan(1);
      expect(found[0]!.getAttribute('aria-selected')).toBe('true');
      expect(input(app).getAttribute('aria-activedescendant')).toBe(found[0]!.id);

      pressKey(input(app), 'ArrowDown');
      await app.settle();
      expect(options(app)[1]!.getAttribute('aria-selected')).toBe('true');
      expect(options(app)[0]!.getAttribute('aria-selected')).toBe('false');
      expect(input(app).getAttribute('aria-activedescendant')).toBe(found[1]!.id);
      pressKey(input(app), 'ArrowUp');
      pressKey(input(app), 'ArrowUp');
      await app.settle();
      expect(input(app).getAttribute('aria-activedescendant')).toBe(found[0]!.id);

      pressKey(input(app), 'ArrowDown');
      await app.settle();
      const entry = SEARCH_INDEX.filter((candidate) => `${candidate.title} ${candidate.hint}`.toLowerCase().includes('angular'))[1]!;
      const event = pressKey(input(app), 'Enter');
      await app.settle();
      expect(event.defaultPrevented).toBe(true);
      expect(app.router.url).toBe(entry.fragment ? `${entry.route}#${entry.fragment}` : entry.route);
      expect(dialog(app)).toBeNull();
    });

    it('clicking a result opens that one', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const third = options(app)[2]!;
      third.click();
      await app.settle();
      expect(dialog(app)).toBeNull();
      expect(app.router.url).not.toBe('/examples');
    });

    it('Escape closes it and gives focus back to what had it', async () => {
      const app = await bootApp('/examples');
      const opener = app.el.querySelector<HTMLButtonElement>('button.search')!;
      opener.focus();
      opener.click();
      await app.settle();
      expect(dialog(app)).not.toBeNull();
      const event = pressKey(input(app), 'Escape');
      await app.settle();
      expect(event.defaultPrevented).toBe(true);
      expect(dialog(app)).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it('ignores Enter, Arrow keys and Escape pressed outside the dialog', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const outside = app.el.querySelector<HTMLButtonElement>('button.search')!;
      outside.focus();
      const url = app.router.url;

      const enter = pressKey(outside, 'Enter');
      pressKey(outside, 'ArrowDown');
      pressKey(document.body, 'Escape');
      pressKey(document.body, 'Enter');
      await app.settle();
      expect(enter.defaultPrevented).toBe(false);
      expect(app.router.url).toBe(url);
      expect(dialog(app)).not.toBeNull();
      expect(options(app)[0]!.getAttribute('aria-selected')).toBe('true');
    });

    it('does not open a result with Enter while a button inside the dialog has focus', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const cancel = app.el.querySelector<HTMLButtonElement>('app-search-dialog .cancel')!;
      cancel.focus();
      pressKey(cancel, 'Enter');
      await app.settle();
      expect(app.router.url).toBe('/examples');
    });
  });

  describe('focus', () => {
    it('is trapped: Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const cancel = app.el.querySelector<HTMLButtonElement>('app-search-dialog .cancel')!;
      expect(document.activeElement).toBe(input(app));

      const back = pressKey(input(app), 'Tab', { shiftKey: true });
      expect(back.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(cancel);

      const forward = pressKey(cancel, 'Tab');
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input(app));

      // In the middle the browser moves focus itself.
      expect(pressKey(input(app), 'Tab').defaultPrevented).toBe(false);
    });

    it('returns to the page content (not the opener) after a result was chosen', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'risk');
      pressKey(input(app), 'Enter');
      await app.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(app.router.url).toBe('/examples/risk-field');
      expect(document.activeElement).toBe(app.el.querySelector('main#main-content'));
    });
  });

  describe('accessibility', () => {
    it('is a modal dialog with a combobox that controls a listbox of options, one of them active', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'angular');
      const root = dialog(app)!;
      expect(root.getAttribute('role')).toBe('dialog');
      expect(root.getAttribute('aria-modal')).toBe('true');
      expect(root.getAttribute('aria-label')).toBeTruthy();

      const field = input(app);
      expect(field.getAttribute('role')).toBe('combobox');
      expect(field.getAttribute('aria-expanded')).toBe('true');
      expect(field.getAttribute('aria-autocomplete')).toBe('list');
      const list = app.el.querySelector<HTMLElement>('#' + field.getAttribute('aria-controls'))!;
      expect(list.getAttribute('role')).toBe('listbox');
      expect(root.contains(list)).toBe(true);

      const found = options(app);
      expect(found.length).toBeGreaterThan(1);
      for (const option of found) {
        expect(option.parentElement).toBe(list); // options are the listbox's children, not wrappers of buttons
        expect(option.querySelector('button')).toBeNull();
        expect(option.id).toBeTruthy();
      }
      expect(new Set(found.map((option) => option.id)).size).toBe(found.length);
      expect(found.filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
      expect(field.getAttribute('aria-activedescendant')).toBe(found.find((option) => option.getAttribute('aria-selected') === 'true')!.id);
      expect(list.querySelectorAll(':scope > :not([role=option])')).toHaveLength(0);
    });

    it('has no listbox and says so when nothing matches, and announces the number of results', async () => {
      const app = await bootApp('/examples');
      await openWith(app, 'zzzz-nothing');
      expect(app.el.querySelector('app-search-dialog [role=listbox]')).toBeNull();
      expect(input(app).getAttribute('aria-expanded')).toBe('false');
      expect(input(app).hasAttribute('aria-activedescendant')).toBe(false);
      expect(dialog(app)!.textContent).toContain('No results');
      expect(app.el.querySelector('app-search-dialog [role=status]')!.textContent).toContain('No results');

      await type(app, 'risk');
      expect(app.el.querySelector('app-search-dialog [role=status]')!.textContent?.trim()).toBe('1 result');
    });
  });
});
