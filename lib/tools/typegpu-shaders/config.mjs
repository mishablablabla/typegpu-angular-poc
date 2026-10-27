// Options of the shader prebuild: defaults, an optional `typegpu-shaders.config.json` in the project root, and CLI/API overrides (in that order).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { realExisting } from './atomic.mjs';
import { isInside, isSameOrInside } from './paths.mjs';

export const DEFAULTS = {
  /** Folder with the shader modules (and everything they import). Entry points are the files ending in `suffix`. */
  src: 'src',
  /** Where the transformed modules, declarations and the manifest are written. Git-ignore it. */
  out: 'shaders-dist',
  /** Entry points: files whose name ends with this. */
  suffix: '.gpu.ts',
  /** Prefix of the import specifier the application uses for the generated modules (add a tsconfig `paths` entry for it). */
  alias: '@shaders/',
};

export function resolveConfig(options = {}) {
  // A real path: esbuild reports real paths (macOS /var -> /private/var, symlinked checkouts), and every comparison here is by path.
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const file = options.config ? resolve(root, options.config) : join(root, 'typegpu-shaders.config.json');
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read ${relative(root, file)}: ${error.message}`);
    }
  } else if (options.config) {
    throw new Error(`Config file not found: ${options.config}`);
  }
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const merged = { ...DEFAULTS, ...fromFile, ...defined };
  const src = resolve(root, merged.src);
  // a real path (a symbolic link in the way is resolved), and inside the project: output elsewhere is never written or deleted
  const out = realExisting(resolve(root, merged.out));
  if (src === out) throw new Error('`src` and `out` must be different folders.');
  // A build deletes what it generated from `out`; a folder that holds the sources or the project is never a safe place for that.
  const holds = isSameOrInside;
  if (holds(out, src) || holds(out, root)) {
    throw new Error(`\`out\` (${relative(root, out) || '.'}) must not be, or contain, the project folder or \`src\`. Use a dedicated folder such as "shaders-dist".`);
  }
  if (!isInside(root, out)) throw new Error(`\`out\` (${out}) must be a folder inside the project (${root}), also after following symbolic links.`);
  if (!merged.suffix.startsWith('.') || !merged.suffix.endsWith('.ts')) throw new Error('`suffix` must look like ".gpu.ts".');
  if (!merged.alias.endsWith('/')) throw new Error('`alias` must end with "/" (for example "@shaders/").');
  const tsconfig = merged.tsconfig
    ? resolve(root, merged.tsconfig)
    : ['tsconfig.app.json', 'tsconfig.json'].map((name) => join(root, name)).find((path) => existsSync(path));
  return { root, src, out, suffix: merged.suffix, alias: merged.alias, tsconfig, configFile: existsSync(file) ? file : undefined };
}
