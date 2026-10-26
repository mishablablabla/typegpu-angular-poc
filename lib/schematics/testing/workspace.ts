// Test helpers (not shipped): build workspaces with Angular's own schematics and run ours against the BUILT collection.
import { type UnitTestTree, SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** `dist/schematics/collection.json`: the output of `npm run build:schematics`, i.e. what the package ships. */
export const COLLECTION = join(here, '..', '..', 'dist', 'schematics', 'collection.json');
const ANGULAR_COLLECTION = join(dirname(require.resolve('@schematics/angular/package.json')), 'collection.json');

export function ours(): SchematicTestRunner {
  if (!existsSync(COLLECTION)) {
    throw new Error(`${COLLECTION} is missing: run "npm run build:schematics" (npm run test:schematics does it).`);
  }
  return new SchematicTestRunner('@typegpu-poc/angular', COLLECTION);
}

/** A workspace like `ng new` creates it, with the given applications (the first one at the workspace root). */
export async function workspaceWith(applications: string[] = ['app'], angularVersion = '22.0.0', firstAtRoot = true): Promise<UnitTestTree> {
  const angular = new SchematicTestRunner('@schematics/angular', ANGULAR_COLLECTION);
  let tree = await angular.runSchematic('workspace', { name: 'ws', version: angularVersion, newProjectRoot: 'projects' });
  for (const [index, name] of applications.entries()) {
    tree = await angular.runSchematic(
      'application',
      { name, projectRoot: index === 0 && firstAtRoot ? '' : `projects/${name}`, style: 'css', routing: false, skipInstall: true },
      tree,
    );
  }
  return tree;
}

export const readJson = (tree: UnitTestTree, path: string) => JSON.parse(tree.readText(path)) as Record<string, any>;

export function editJson(tree: UnitTestTree, path: string, edit: (json: Record<string, any>) => void): void {
  const json = readJson(tree, path);
  edit(json);
  tree.overwrite(path, JSON.stringify(json, null, 2) + '\n');
}

/** Runs ng-add and returns the resulting tree. */
export async function ngAdd(tree: UnitTestTree, options: { project?: string } = {}): Promise<UnitTestTree> {
  return ours().runSchematic('ng-add', options, tree);
}
