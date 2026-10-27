import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'starlight-theme'; // the TypeGPU docs use the same key

/** Light/dark theme stored on `<html data-theme>` (set before first paint by index.html). */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

  set(theme: Theme): void {
    const html = document.documentElement;
    html.classList.add('no-transition');
    html.dataset['theme'] = theme;
    this.theme.set(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage can be blocked; the theme still applies for this visit
    }
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('no-transition')));
  }
}
