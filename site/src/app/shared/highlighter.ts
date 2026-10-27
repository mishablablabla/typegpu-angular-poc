import { Injectable } from '@angular/core';
import type { HighlighterCore } from 'shiki/core';

export type CodeLanguage = 'typescript' | 'html' | 'bash' | 'json' | 'css' | 'text';

/** Theme pairs: the documentation uses the Starlight code colors (Night Owl), the examples viewer the editor colors (Catppuccin). */
export const CODE_THEMES = {
  docs: { dark: 'night-owl', light: 'night-owl-light' },
  editor: { dark: 'catppuccin-mocha', light: 'github-light' },
} as const;

export type CodeThemeName = keyof typeof CODE_THEMES;

/** Loads Shiki on first use (a lazy chunk) and turns code into HTML whose colors follow the page theme through CSS variables. */
@Injectable({ providedIn: 'root' })
export class Highlighter {
  private instance: Promise<HighlighterCore> | undefined;

  private load(): Promise<HighlighterCore> {
    this.instance ??= (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
      return createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        themes: [
          import('shiki/themes/night-owl.mjs'),
          import('shiki/themes/night-owl-light.mjs'),
          import('shiki/themes/catppuccin-mocha.mjs'),
          import('shiki/themes/github-light.mjs'),
        ],
        langs: [import('shiki/langs/typescript.mjs'), import('shiki/langs/html.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/css.mjs')],
      });
    })();
    return this.instance;
  }

  async html(code: string, language: CodeLanguage, theme: CodeThemeName): Promise<string> {
    if (language === 'text') return plain(code);
    const highlighter = await this.load();
    return highlighter.codeToHtml(code, { lang: language, themes: CODE_THEMES[theme], defaultColor: false });
  }
}

export function plain(code: string): string {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre class="shiki"><code>${escaped
    .split('\n')
    .map((line) => `<span class="line">${line}</span>`)
    .join('\n')}</code></pre>`;
}
