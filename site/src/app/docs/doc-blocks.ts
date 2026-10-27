import type { CodeLanguage } from '../shared/highlighter';

export interface DocHeading {
  id: string;
  title: string;
  level: 2 | 3;
}

/** The page content as data: prose is trusted static HTML (our own text), code is shown through the highlighter. */
export type DocBlock =
  | { kind: 'heading'; level: 2 | 3; id: string; text: string }
  | { kind: 'html'; html: string }
  | { kind: 'list'; ordered?: boolean; items: readonly string[] }
  | { kind: 'code'; code: string; lang?: CodeLanguage; title?: string }
  | { kind: 'tabs'; tabs: readonly { label: string; code: string; lang?: CodeLanguage }[] }
  | { kind: 'callout'; type: 'note' | 'tip' | 'caution' | 'danger'; title?: string; html: string }
  | { kind: 'table'; head: readonly string[]; rows: readonly (readonly string[])[] };

export const headingsOf = (blocks: readonly DocBlock[]): DocHeading[] =>
  blocks.flatMap((block) => (block.kind === 'heading' ? [{ id: block.id, title: block.text, level: block.level }] : []));

export const p = (html: string): DocBlock => ({ kind: 'html', html: `<p>${html}</p>` });
export const h2 = (id: string, text: string): DocBlock => ({ kind: 'heading', level: 2, id, text });
export const h3 = (id: string, text: string): DocBlock => ({ kind: 'heading', level: 3, id, text });
export const ul = (...items: string[]): DocBlock => ({ kind: 'list', items });
export const ol = (...items: string[]): DocBlock => ({ kind: 'list', ordered: true, items });
export const code = (source: string, lang: CodeLanguage = 'typescript', title?: string): DocBlock => ({ kind: 'code', code: source, lang, title });
export const callout = (type: 'note' | 'tip' | 'caution' | 'danger', html: string, title?: string): DocBlock => ({ kind: 'callout', type, html, title });
export const table = (head: readonly string[], ...rows: (readonly string[])[]): DocBlock => ({ kind: 'table', head, rows });
