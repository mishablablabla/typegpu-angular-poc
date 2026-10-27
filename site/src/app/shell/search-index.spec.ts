import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples/registry';
import { ANGULAR_DOC } from '../docs/pages/angular-docs';
import { headingsOf } from '../docs/doc-blocks';
import { SEARCH_INDEX } from './search-index';

describe('the search index', () => {
  it('lists every example once, linking to its page', () => {
    const entries = SEARCH_INDEX.filter((entry) => entry.group === 'Examples');
    expect(entries.map((entry) => entry.route)).toEqual(EXAMPLES.map((example) => `/examples/${example.id}`));
  });

  it('lists every documentation heading with its anchor', () => {
    const headings = headingsOf(ANGULAR_DOC);
    const entries = SEARCH_INDEX.filter((entry) => entry.group === 'Documentation');
    expect(entries.map((entry) => entry.fragment)).toEqual(headings.map((heading) => heading.id));
    expect(new Set(entries.map((entry) => entry.fragment)).size).toBe(entries.length);
  });
});
