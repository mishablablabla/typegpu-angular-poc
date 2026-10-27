import { headingsOf } from '../docs/doc-blocks';
import { ANGULAR_DOCS_ROUTE } from '../docs/docs-nav';
import { ANGULAR_DOC } from '../docs/pages/angular-docs';
import { EXAMPLES } from '../examples/registry';

export interface SearchEntry {
  group: 'Documentation' | 'Examples';
  title: string;
  hint: string;
  route: string;
  fragment?: string;
}

export const SEARCH_INDEX: readonly SearchEntry[] = [
  ...headingsOf(ANGULAR_DOC).map<SearchEntry>((heading) => ({
    group: 'Documentation',
    title: heading.title,
    hint: '@typegpu/angular',
    route: ANGULAR_DOCS_ROUTE,
    fragment: heading.id,
  })),
  ...EXAMPLES.map<SearchEntry>((example) => ({
    group: 'Examples',
    title: example.title,
    hint: example.tags.join(', '),
    route: `/examples/${example.id}`,
  })),
];
