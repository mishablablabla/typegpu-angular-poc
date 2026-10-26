// ng add / ng generate against a REAL directory layout: the schematic finds the workspace on disk (nearest angular.json
// upwards from the working directory, as the CLI does) and resolves where the package is installed. The unit specs in
// index.spec.ts run on virtual trees and use the conventional `node_modules/...` path.
// Uses process.chdir (vitest's default `forks` pool allows it).
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTION, editJson, ngAdd, ours, readJson, workspaceWith } from '../testing/workspace';

const PACKAGE_DIR = dirname(dirname(COLLECTION)); // lib/dist: the package as ng-packagr lays it out
const PLUGIN_FILE = 'tools/typegpu-shaders.esbuild.mjs';
const originalCwd = process.cwd();

let repo: string;
let web: string;

beforeAll(() => {
  // `npm run build:schematics` alone does not create dist/tools (ng-packagr does); the real package always has it.
  if (!existsSync(join(PACKAGE_DIR, 'tools'))) cpSync(join(PACKAGE_DIR, '..', 'tools'), join(PACKAGE_DIR, 'tools'), { recursive: true });
});
beforeEach(() => {
  // an npm-workspaces layout: package.json with workspaces at the root, the application in packages/web,
  // every dependency hoisted to the root node_modules (here: just our package, linked to the built one)
  repo = mkdtempSync(join(tmpdir(), 'ng-add-real-'));
  web = join(repo, 'packages', 'web');
  mkdirSync(web, { recursive: true });
  mkdirSync(join(repo, 'node_modules', '@typegpu-poc'), { recursive: true });
  symlinkSync(PACKAGE_DIR, join(repo, 'node_modules', '@typegpu-poc', 'angular'), 'dir');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }));
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repo, { recursive: true, force: true });
});
afterAll(() => process.chdir(originalCwd));

/** The tree the CLI would hand the schematic when run from `cwd`, with angular.json also on disk at `web`. */
async function workspaceOnDisk(cwd = web) {
  const tree = await workspaceWith();
  writeFileSync(join(web, 'angular.json'), tree.readText('angular.json'));
  process.chdir(cwd);
  return tree;
}
const HOISTED = `../../node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`;
const plugins = (tree: Awaited<ReturnType<typeof workspaceWith>>) => readJson(tree, 'angular.json').projects.app.architect.build.options.plugins;

describe('ng add in an npm-workspaces layout (app in packages/web, dependencies hoisted to the root)', () => {
  it('writes the real, hoisted path for the plugin and for the check script, and both files exist there', async () => {
    const after = await ngAdd(await workspaceOnDisk());
    expect(plugins(after)).toEqual([HOISTED]);
    const script: string = readJson(after, 'package.json').scripts['check:shaders'];
    expect(script).toBe(`ng build --configuration production && node ../../node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs dist/app/browser`);
    expect(existsSync(join(web, plugins(after)[0]))).toBe(true);
    expect(existsSync(join(web, script.split(' ')[6]!))).toBe(true);
  });

  it('works from a subfolder of the workspace, like the CLI', async () => {
    mkdirSync(join(web, 'src', 'app'), { recursive: true });
    const after = await ngAdd(await workspaceOnDisk(join(web, 'src', 'app')));
    expect(plugins(after)).toEqual([HOISTED]);
  });

  it('is idempotent, and does not duplicate a path the user corrected by hand (another spelling of the same file)', async () => {
    const once = await ngAdd(await workspaceOnDisk());
    writeFileSync(join(web, 'angular.json'), once.readText('angular.json'));
    const twice = await ngAdd(once);
    expect(plugins(twice)).toEqual([HOISTED]);

    for (const spelling of [`./${HOISTED}`, `../../node_modules/@typegpu-poc/angular/tools/../${PLUGIN_FILE}`, join(repo, 'node_modules/@typegpu-poc/angular', PLUGIN_FILE)]) {
      const tree = await workspaceWith();
      editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = [spelling]));
      writeFileSync(join(web, 'angular.json'), tree.readText('angular.json'));
      const after = await ngAdd(tree);
      expect(plugins(after), spelling).toEqual([spelling]);
    }
  });

  it('lets ng generate accept the hoisted path, and refuses the conventional one, which does not exist in this layout', async () => {
    const configured = await ngAdd(await workspaceOnDisk());
    writeFileSync(join(web, 'angular.json'), configured.readText('angular.json')); // what `ng add` saved
    const tree = await ours().runSchematic('component', { name: 'my-canvas' }, configured);
    expect(tree.exists('/src/app/my-canvas/my-canvas.gpu.ts')).toBe(true);

    editJson(configured, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = [`node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`]));
    writeFileSync(join(web, 'angular.json'), configured.readText('angular.json'));
    await expect(ours().runSchematic('component', { name: 'other' }, configured)).rejects.toThrow(/not set up for TypeGPU shaders/);
  });

  it('repairs a plugin path and a check script written for a flat install after the dependencies moved to the root (stale), instead of leaving a dead entry', async () => {
    const stale = 'node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs';
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      const build = json.projects.app.architect.build;
      build.options.plugins = ['tools/mine.mjs', stale];
      build.configurations.production.plugins = [{ path: `./${stale}`, options: { a: 1 } }];
    });
    editJson(tree, 'package.json', (pkg) => {
      pkg.scripts['check:shaders'] = 'ng build --configuration production && node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs dist/app/browser --allow-empty';
      pkg.scripts['other'] = 'node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs x';
    });
    writeFileSync(join(web, 'angular.json'), tree.readText('angular.json'));
    process.chdir(web);
    const runner = ours();
    const logs: string[] = [];
    runner.logger.subscribe((entry) => logs.push(entry.message));
    const after = await runner.runSchematic('ng-add', {}, tree);
    const build = readJson(after, 'angular.json').projects.app.architect.build;
    expect(build.options.plugins).toEqual(['tools/mine.mjs', HOISTED]); // replaced in place, not duplicated
    expect(build.configurations.production.plugins).toEqual([{ path: HOISTED, options: { a: 1 } }]);
    const scripts = readJson(after, 'package.json').scripts;
    expect(scripts['check:shaders']).toBe(`ng build --configuration production && node ../../node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs dist/app/browser --allow-empty`);
    expect(logs.join('\n')).toMatch(/Replaced the plugin path "node_modules\/@typegpu-poc\/angular\/tools\/typegpu-shaders.esbuild.mjs".*file not found/);
    expect(scripts['other']).toContain('node node_modules/@typegpu-poc'); // only the check:shaders script is ours to fix
  });

  it('does not touch an entry that exists, even when its path is written differently', async () => {
    // a flat install exists next to the hoisted one: both are real files; only a MISSING file counts as stale
    mkdirSync(join(web, 'node_modules', '@typegpu-poc', 'angular', 'tools'), { recursive: true });
    writeFileSync(join(web, 'node_modules', '@typegpu-poc', 'angular', PLUGIN_FILE), '// other copy\n');
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = [`node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`]));
    writeFileSync(join(web, 'angular.json'), tree.readText('angular.json'));
    process.chdir(web);
    const after = await ngAdd(tree);
    expect(plugins(after)).toEqual([`node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`, HOISTED]); // the other copy exists: kept; ours added
  });

  it('uses the real node_modules path for a flat install in the workspace root', async () => {
    mkdirSync(join(repo, 'node_modules', '@typegpu-poc'), { recursive: true });
    mkdirSync(join(web, 'node_modules', '@typegpu-poc'), { recursive: true });
    symlinkSync(PACKAGE_DIR, join(web, 'node_modules', '@typegpu-poc', 'angular'), 'dir');
    const after = await ngAdd(await workspaceOnDisk());
    expect(plugins(after)).toEqual([`node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`]); // nearest install wins
  });

  it('removes options from the schema of the custom-esbuild that is already installed, not from a guess', async () => {
    const schemaDir = join(repo, 'node_modules', '@angular-builders', 'custom-esbuild', 'dist', 'unit-test');
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(join(schemaDir, 'schema.json'), JSON.stringify({ properties: { buildTarget: {}, tsConfig: {}, reporters: {}, shinyNewOption: {} } }));
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test.options = { shinyNewOption: 1, watch: false, runner: 'vitest' }));
    writeFileSync(join(web, 'angular.json'), tree.readText('angular.json'));
    process.chdir(web);
    const options = readJson(await ngAdd(tree), 'angular.json').projects.app.architect.test.options;
    expect(options.shinyNewOption).toBe(1); // in the installed schema
    expect(options.watch).toBeUndefined(); // not in it
    expect(options.runner).toBeUndefined();
  });

  it('falls back to conventional paths when the working directory is not the edited workspace (virtual tree)', async () => {
    process.chdir(repo); // a directory without that angular.json
    expect(plugins(await ngAdd(await workspaceWith()))).toEqual([`node_modules/@typegpu-poc/angular/${PLUGIN_FILE}`]);
  });
});
