// ng add --shaders siblings (experimental, hidden): the same wrapper builders, a config file that selects the sibling generator, no tsconfig edit.
import { describe, expect, it } from 'vitest';
import { ours, readJson, workspaceWith } from '../testing/workspace';

const PKG = '@typegpu-poc/angular';
const target = (tree: Awaited<ReturnType<typeof workspaceWith>>, name: string) => readJson(tree, 'angular.json')['projects']['app']['architect'][name];
const add = (tree: Awaited<ReturnType<typeof workspaceWith>>) => ours().runSchematic('ng-add', { shaders: 'siblings' }, tree);

describe('ng add --shaders siblings', () => {
  it('moves the targets to the wrapper builders, selects the generator in the config file, ignores the generated files, and leaves tsconfig alone', async () => {
    const before = await workspaceWith();
    const tsconfig = before.readText('tsconfig.json');
    const tree = await add(before);
    expect(target(tree, 'build').builder).toBe(`${PKG}:application`);
    expect(target(tree, 'serve').builder).toBe(`${PKG}:dev-server`);
    expect(JSON.parse(tree.readText('typegpu-shaders.config.json'))).toEqual({ mode: 'siblings' });
    expect(tree.readText('.gitignore')).toMatch(/^\*\.gpu\.generated\.\*$/m);
    expect(tree.readText('.gitignore')).not.toMatch(/shaders-dist/);
    expect(tree.readText('tsconfig.json')).toBe(tsconfig);
  });

  it('is idempotent', async () => {
    const once = await add(await workspaceWith());
    const files = Object.fromEntries(once.files.map((f) => [f, once.read(f)!.toString('base64')]));
    const twice = await add(once);
    expect(Object.fromEntries(twice.files.map((f) => [f, twice.read(f)!.toString('base64')]))).toEqual(files);
  });

  it('the component generator then imports the generated sibling by a relative path', async () => {
    const tree = await ours().runSchematic('component', { name: 'my-canvas' }, await add(await workspaceWith()));
    expect(tree.readText('src/app/my-canvas/my-canvas.ts')).toContain("from './my-canvas.gpu.generated'");
  });
});
