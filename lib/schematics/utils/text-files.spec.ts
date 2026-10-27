// keepFormatting: what a schematic may not change in the line endings of the files it edits.
import { type Rule, type Tree, callRule } from '@angular-devkit/schematics';
import { HostTree } from '@angular-devkit/schematics';
import { lastValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { keepFormatting } from './text-files';

const context = {} as never;
const run = async (files: Record<string, string>, edit: (tree: Tree) => void) => {
  const tree = new HostTree();
  for (const [path, text] of Object.entries(files)) tree.create(path, text);
  const rule: Rule = (host) => {
    edit(host);
    return host;
  };
  const result = (await lastValueFrom(callRule(keepFormatting(rule), tree, context))) as Tree;
  return (path: string) => result.readText(path);
};

describe('keepFormatting: line endings', () => {
  // Angular's workspace writer takes the platform's line ending (CRLF on Windows) for a file that has no line break to copy it from.
  it('a file without any CR is still without one after an edit that writes CRLF', async () => {
    const read = await run({ 'angular.json': '{"version":1}', '.gitignore': 'dist\n' }, (tree) => {
      tree.overwrite('angular.json', '{\r\n  "version": 1\r\n}\r\n');
      tree.overwrite('.gitignore', 'dist\r\nshaders-dist\r\n');
    });
    expect(read('angular.json')).toBe('{\n  "version": 1\n}\n');
    expect(read('.gitignore')).toBe('dist\nshaders-dist\n');
  });

  it('a CRLF file stays CRLF throughout, also where the edit wrote LF', async () => {
    const read = await run({ '.gitignore': 'dist\r\n' }, (tree) => tree.overwrite('.gitignore', 'dist\r\nshaders-dist\n'));
    expect(read('.gitignore')).toBe('dist\r\nshaders-dist\r\n');
  });

  it('files that are not tracked are not touched', async () => {
    const read = await run({ 'other.txt': 'a\n' }, (tree) => tree.overwrite('other.txt', 'a\r\nb\r\n'));
    expect(read('other.txt')).toBe('a\r\nb\r\n');
  });
});
