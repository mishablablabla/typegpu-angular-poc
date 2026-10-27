import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './registry';
import { EXAMPLES_TREE, REPOSITORY_URL, exampleSourceUrl } from './repository';

// The repository exists, but `site/` is not committed to it yet, so the links 404 until it is. What can be checked now
// is that every link names a folder that is really there (and holds the files shown on the page), so they are right on day one.
const nodeFs = 'node:fs';
interface Fs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
}
const examplesDirectory = () => `${process.cwd()}/src/app/examples`;
// `process` is Node's; the specs run in Node (jsdom is only the DOM).
declare const process: { cwd(): string };

describe('the repository links', () => {
  it('have one base URL, used by every link', () => {
    expect(REPOSITORY_URL).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/);
    expect(EXAMPLES_TREE.startsWith(`${REPOSITORY_URL}/tree/`)).toBe(true);
    for (const example of EXAMPLES) expect(exampleSourceUrl(example).startsWith(`${REPOSITORY_URL}/`)).toBe(true);
  });

  it.each(EXAMPLES.map((example) => [example.id, example] as const))('%s links to a folder that exists and holds the example', async (_id, example) => {
    const fs = (await import(/* @vite-ignore */ nodeFs)) as Fs;
    const url = exampleSourceUrl(example);
    expect(url).toBe(`${EXAMPLES_TREE}/${example.folder}`);
    const path = url.slice(EXAMPLES_TREE.length + 1);
    expect(fs.existsSync(`${examplesDirectory()}/${path}`), `${path} is a folder of src/app/examples`).toBe(true);
    const files = fs.readdirSync(`${examplesDirectory()}/${path}`);
    expect(files, 'the example definition sits in its folder').toContain(`${example.folder}.example.ts`);
    // Every file the page shows lives in this folder, or is the shared GPU root.
    for (const source of [...example.sources.integration, ...example.sources.manual]) {
      const inFolder = fs.existsSync(`${examplesDirectory()}/${path}/${source.path}`);
      const shared = source.path === 'manual-gpu.ts' && fs.existsSync(`${examplesDirectory()}/manual/manual-gpu.ts`);
      expect(inFolder || shared, `${source.path} of ${example.id}`).toBe(true);
    }
  });

  it('does not use the id as the folder where they differ (THE CORE lives in core/)', () => {
    const core = EXAMPLES.find((example) => example.id === 'the-core')!;
    expect(exampleSourceUrl(core)).toMatch(/\/core$/);
    expect(new Set(EXAMPLES.map((example) => example.folder)).size).toBe(EXAMPLES.length);
  });
});
