// resolveToolPaths on real directories: hoisted node_modules (npm/yarn/pnpm workspaces), pnpm-style symlinks,
// hand-corrected paths, a package without its tools. `ownTools` stands in for the installed package's tools folder.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, resolveToolPaths } from './tool-paths';

const PACKAGE = '@typegpu-poc/angular';
const PLUGIN = 'typegpu-shaders.esbuild.mjs';
const CHECK = 'check-shader-bundle.mjs';

let base: string;
beforeEach(() => (base = mkdtempSync(join(tmpdir(), 'tool-paths-'))));
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A directory standing in for the installed package's `tools/`. */
function installedTools(at: string): string {
  const tools = join(at, 'tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, PLUGIN), '// plugin\n');
  writeFileSync(join(tools, CHECK), '// check\n');
  return tools;
}
const nodeModulesOf = (dir: string) => join(dir, 'node_modules', ...PACKAGE.split('/'));

describe('resolveToolPaths', () => {
  it('uses the conventional paths without a real workspace (virtual tree)', () => {
    const tools = resolveToolPaths(undefined);
    expect(tools.plugin).toBe(`node_modules/${PACKAGE}/tools/${PLUGIN}`);
    expect(tools.check).toBe(`node_modules/${PACKAGE}/tools/${CHECK}`);
    expect(tools.isPlugin(`./${tools.plugin}`)).toBe(true);
    expect(tools.isPlugin({ path: tools.plugin })).toBe(true);
    expect(tools.isPlugin('other.mjs')).toBe(false);
    expect(tools.isPlugin(undefined)).toBe(false);
  });

  it('finds the package in the workspace root node_modules', () => {
    const own = installedTools(nodeModulesOf(base));
    const tools = resolveToolPaths(base, '', own);
    expect(tools.plugin).toBe(`node_modules/${PACKAGE}/tools/${PLUGIN}`);
    expect(tools.check).toBe(`node_modules/${PACKAGE}/tools/${CHECK}`);
  });

  it('finds hoisted dependencies: an app in packages/web with node_modules at the monorepo root', () => {
    const own = installedTools(nodeModulesOf(base));
    const web = join(base, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    const tools = resolveToolPaths(web, '', own);
    expect(tools.plugin).toBe(`../../node_modules/${PACKAGE}/tools/${PLUGIN}`);
    expect(tools.check).toBe(`../../node_modules/${PACKAGE}/tools/${CHECK}`);
    // a workspace at the repo root with the application in packages/web (project root), node_modules in the application folder
    const own2 = installedTools(nodeModulesOf(join(web, 'nested')));
    mkdirSync(join(web, 'nested'), { recursive: true });
    expect(resolveToolPaths(base, 'packages/web/nested', own2).plugin).toBe(`packages/web/nested/node_modules/${PACKAGE}/tools/${PLUGIN}`);
  });

  it('keeps the node_modules path of a symlinked (pnpm-style) install instead of the store path', () => {
    const store = join(base, '.pnpm', 'angular@0.0.1', 'node_modules', ...PACKAGE.split('/'));
    const own = installedTools(store);
    mkdirSync(join(base, 'node_modules', '@typegpu-poc'), { recursive: true });
    symlinkSync(store, nodeModulesOf(base), 'dir');
    const tools = resolveToolPaths(base, '', own);
    expect(tools.plugin).toBe(`node_modules/${PACKAGE}/tools/${PLUGIN}`);
    expect(existsSync(join(base, tools.plugin))).toBe(true);
  });

  it('falls back to the location the schematic runs from when there is no node_modules entry', () => {
    const own = installedTools(join(base, 'vendor', 'angular'));
    mkdirSync(join(base, 'app'), { recursive: true });
    const tools = resolveToolPaths(join(base, 'app'), '', own);
    expect(tools.plugin).toBe(`../vendor/angular/tools/${PLUGIN}`);
  });

  it('fails with a clear message when the package has no tools', () => {
    expect(() => resolveToolPaths(base, '', join(base, 'missing-tools'))).toThrow(
      new RegExp(`${PACKAGE.replace('/', '\\/')} is installed without its tools.*Reinstall`),
    );
  });

  it('accepts any configured path that resolves to the plugin file, not only the one it would write', () => {
    const own = installedTools(nodeModulesOf(base));
    const web = join(base, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    const tools = resolveToolPaths(web, '', own);
    const real = `../../node_modules/${PACKAGE}/tools/${PLUGIN}`;
    expect(tools.isPlugin(real)).toBe(true);
    expect(tools.isPlugin(`./${real}`)).toBe(true);
    expect(tools.isPlugin({ path: real })).toBe(true);
    expect(tools.isPlugin(`../../node_modules/${PACKAGE}/tools/../tools/${PLUGIN}`)).toBe(true); // another spelling of the same file
    expect(tools.isPlugin(join(base, 'node_modules', ...PACKAGE.split('/'), 'tools', PLUGIN))).toBe(true); // absolute
    expect(tools.isPlugin(`node_modules/${PACKAGE}/tools/${PLUGIN}`)).toBe(false); // the conventional path does not exist here
    expect(tools.isPlugin(`../../node_modules/${PACKAGE}/tools/${CHECK}`)).toBe(false); // another file
    // a copy of the plugin elsewhere is a different file
    cpSync(join(own, PLUGIN), join(web, 'my-copy.mjs'));
    expect(tools.isPlugin('my-copy.mjs')).toBe(false);
  });
});

describe('stale paths (dependencies moved after ng add)', () => {
  it('recognises a path of the shape ng add writes that points at nothing, and repairs the script', () => {
    const own = installedTools(nodeModulesOf(base));
    const web = join(base, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    const tools = resolveToolPaths(web, '', own);
    const stale = `node_modules/${PACKAGE}/tools/${PLUGIN}`;
    expect(tools.isStalePlugin(stale)).toBe(true);
    expect(tools.isStalePlugin(`./${stale}`)).toBe(true);
    expect(tools.isStalePlugin({ path: `./${stale}` })).toBe(true);
    expect(tools.isStalePlugin(`../../node_modules/${PACKAGE}/tools/${PLUGIN}`)).toBe(false); // the real one
    expect(tools.isStalePlugin('tools/my-plugin.mjs')).toBe(false); // not ours
    expect(tools.isStalePlugin(`vendor/node_modules/${PACKAGE}/tools/${CHECK}`)).toBe(false); // another file
    // an existing file at a differently-shaped location is not stale
    mkdirSync(join(web, 'node_modules', ...PACKAGE.split('/'), 'tools'), { recursive: true });
    writeFileSync(join(web, stale), '// local copy');
    expect(tools.isStalePlugin(stale)).toBe(false);

    const script = `ng build && node node_modules/${PACKAGE}/tools/${CHECK} dist/app/browser`;
    expect(tools.repairCheckScript(`ng build && node ../../node_modules/${PACKAGE}/tools/${CHECK} dist/x`)).toBe(`ng build && node ../../node_modules/${PACKAGE}/tools/${CHECK} dist/x`);
    expect(tools.repairCheckScript('echo mine')).toBe('echo mine');
    rmSync(join(web, 'node_modules'), { recursive: true });
    expect(tools.repairCheckScript(script)).toBe(`ng build && node ../../node_modules/${PACKAGE}/tools/${CHECK} dist/app/browser`);
  });

  it('never calls anything stale on a virtual file system', () => {
    const tools = resolveToolPaths(undefined);
    expect(tools.isStalePlugin(`../x/node_modules/${PACKAGE}/tools/${PLUGIN}`)).toBe(false);
    expect(tools.repairCheckScript(`node ../x/node_modules/${PACKAGE}/tools/${CHECK}`)).toBe(`node ../x/node_modules/${PACKAGE}/tools/${CHECK}`);
  });
});

describe('findWorkspaceRoot', () => {
  it('finds the nearest angular.json upwards, optionally only one with the expected content', () => {
    const app = join(base, 'packages', 'web');
    mkdirSync(join(app, 'src', 'app'), { recursive: true });
    writeFileSync(join(app, 'angular.json'), '{"a":1}');
    expect(findWorkspaceRoot(join(app, 'src', 'app'))).toBe(app);
    expect(findWorkspaceRoot(join(app, 'src', 'app'), '{"a":1}')).toBe(app);
    expect(findWorkspaceRoot(join(app, 'src', 'app'), '{"a":2}')).toBeUndefined();
    expect(findWorkspaceRoot(base, '{"a":1}')).toBeUndefined();
  });
});
