import type { ExampleDefinition } from './example.model';

/** The one place that says where the showcase's source lives (the repository exists; `site/` has to be committed there for the links to resolve). Change it when the repository moves. */
export const REPOSITORY_URL = 'https://github.com/mishablablabla/typegpu-angular-poc';

/** Where the examples are in the repository (the branch and the path of `site/src/app/examples`). */
export const EXAMPLES_TREE = `${REPOSITORY_URL}/tree/main/site/src/app/examples`;

/** The "Source on GitHub" link of an example: its folder, which is not always its id. */
export const exampleSourceUrl = (example: Pick<ExampleDefinition, 'folder'>): string => `${EXAMPLES_TREE}/${example.folder}`;
