import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { SchematicsException } from '@angular-devkit/schematics';
import { CHECK_TOOL_PATH, PACKAGE_NAME, PLUGIN_PATH } from './constants';

const PLUGIN_FILE = 'typegpu-shaders.esbuild.mjs';
const CHECK_FILE = 'check-shader-bundle.mjs';

/** The package's own `tools/` directory: from `<package>/schematics/utils/` it is two levels up (also in `dist/`). */
const OWN_TOOLS = join(__dirname, '..', '..', 'tools');

/**
 * Where the shader plugin and the bundle check are, as paths relative to the workspace root (the form angular.json
 * and package.json scripts use), and how to recognise a configured path as "the plugin".
 */
export interface ToolPaths {
  /** Path of the plugin to write into `plugins`, relative to the workspace root, with `/` separators. */
  readonly plugin: string;
  /** Path of the bundle check for the `check:shaders` script. */
  readonly check: string;
  /** Does this angular.json `plugins` entry (a string or `{ path }`) point at the plugin file? */
  isPlugin(entry: unknown): boolean;
  /**
   * Is this entry a path into this package's `tools/` that no longer exists (the dependencies moved, e.g. to a hoisted
   * node_modules after a later install at the repository root)? Only decided on a real file system.
   */
  isStalePlugin(entry: unknown): boolean;
  /** `script` with every stale path to the bundle check replaced by the real one; unchanged when none is stale. */
  repairCheckScript(script: string): string;
}

/**
 * The directory of the workspace the schematic is changing, on the real file system: the nearest directory at or above
 * `from` whose angular.json is the one being edited (same text as `angularJson`, when given). The Angular CLI runs a
 * schematic with the workspace root as the virtual tree's root, from any folder inside it. Undefined when there is no
 * such directory, i.e. when the tree is virtual (unit tests).
 */
export function findWorkspaceRoot(from: string = process.cwd(), angularJson?: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of ['angular.json', '.angular.json']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      if (angularJson === undefined) return dir;
      try {
        if (readFileSync(file, 'utf8') === angularJson) return dir;
      } catch {
        // unreadable: keep looking
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const toPosix = (path: string) => path.split(sep).join('/');
const clean = (path: string) => posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '');

/**
 * Finds the tool files for the workspace at `workspaceRoot`.
 *
 * On a real file system the paths are resolved, not assumed: starting at the application's folder and walking up,
 * the first `node_modules/<package>/tools/<file>` that is the very file this schematic ships with is used. That
 * covers dependencies hoisted to a parent folder (npm/yarn/pnpm workspaces, an app in `packages/web`), and pnpm's
 * symlinked `node_modules`. If no such `node_modules` entry exists, the path of the file the schematic runs from is
 * used. Throws when the package does not contain the files.
 *
 * Without a real workspace (`workspaceRoot` undefined: a virtual tree, as in unit tests) the conventional
 * `node_modules/<package>/tools/...` paths are returned.
 */
export function resolveToolPaths(workspaceRoot: string | undefined, projectRoot = '', ownTools: string = OWN_TOOLS): ToolPaths {
  if (workspaceRoot === undefined) return conventional();
  const root = resolve(workspaceRoot);

  const locate = (file: string): { path: string; real: string } => {
    const own = join(ownTools, file);
    const ownReal = real(own);
    if (!ownReal) {
      throw new SchematicsException(
        `${PACKAGE_NAME} is installed without its tools: ${own} does not exist. Reinstall the package (for example: npm install ${PACKAGE_NAME}) and run the schematic again.`,
      );
    }
    for (let dir = resolve(root, projectRoot); ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', PACKAGE_NAME, 'tools', file);
      if (real(candidate) === ownReal) return { path: toPosix(relative(root, candidate)), real: ownReal };
      if (dirname(dir) === dir) break;
    }
    return { path: toPosix(relative(root, own)), real: ownReal };
  };

  const plugin = locate(PLUGIN_FILE);
  const check = locate(CHECK_FILE);
  const exists = (path: string) => existsSync(isAbsolute(path) ? path : resolve(root, path));
  const isPlugin = (entry: unknown) => {
    const path = entryPath(entry);
    if (path === undefined) return false;
    if (clean(path) === plugin.path) return true;
    const target = isAbsolute(path) ? path : resolve(root, path);
    return real(target) === plugin.real;
  };
  return {
    plugin: plugin.path,
    check: check.path,
    isPlugin,
    isStalePlugin: (entry) => {
      const path = entryPath(entry);
      return path !== undefined && !isPlugin(entry) && new RegExp(`^${toolPathSource(PLUGIN_FILE)}$`).test(clean(path)) && !exists(path);
    },
    repairCheckScript: (script) =>
      script.replace(new RegExp(toolPathSource(CHECK_FILE), 'g'), (token) => (token === check.path || exists(token) ? token : check.path)),
  };
}

/** Regexp source for a path ending in `node_modules/<package>/tools/<file>` (no whitespace in it): the shape `ng add` writes. */
function toolPathSource(file: string): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `(?:[^\\s"']*/)?node_modules/${escape(PACKAGE_NAME)}/tools/${escape(file)}`;
}

function conventional(): ToolPaths {
  return {
    plugin: PLUGIN_PATH,
    check: CHECK_TOOL_PATH,
    isPlugin: (entry) => {
      const path = entryPath(entry);
      return path !== undefined && clean(path) === PLUGIN_PATH;
    },
    isStalePlugin: () => false, // nothing can be said about a virtual file system
    repairCheckScript: (script) => script,
  };
}

function entryPath(entry: unknown): string | undefined {
  const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : undefined;
}
