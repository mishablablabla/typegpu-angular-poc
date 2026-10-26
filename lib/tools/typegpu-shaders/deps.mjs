// The tool uses the project's own copies of esbuild, TypeScript, Babel and unplugin-typegpu (so it follows the versions the project builds
// with), resolved from the project root. Nothing here depends on Angular.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOOL_PACKAGE = new URL('../../package.json', import.meta.url);

export function toolVersion() {
  try {
    const manifest = JSON.parse(readFileSync(TOOL_PACKAGE, 'utf8'));
    return `${manifest.name}@${manifest.version}`;
  } catch {
    return 'typegpu-shaders@unknown';
  }
}

function requireFrom(root) {
  return createRequire(join(root, 'package.json'));
}

/** The version of an installed package, or undefined. Does not load it. */
export function installedVersion(root, name) {
  try {
    let dir = dirname(requireFrom(root).resolve(name));
    for (let i = 0; i < 8; i++, dir = dirname(dir)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const json = JSON.parse(readFileSync(manifest, 'utf8'));
        if (json.name === name) return json.version;
      }
    }
  } catch {
    /* not installed */
  }
  return undefined;
}

let toolCode;
/** A digest of the tool's own source: the package version stays the same across builds of this package, the code does not. */
function toolCodeDigest() {
  if (toolCode) return toolCode;
  const dir = new URL('.', import.meta.url);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort()) hash.update(name).update(readFileSync(new URL(name, dir)));
  return (toolCode = hash.digest('hex').slice(0, 16));
}

export function versionsOf(root) {
  return {
    tool: `${toolVersion()}+${toolCodeDigest()}`,
    typegpu: installedVersion(root, 'typegpu'),
    unplugin: installedVersion(root, 'unplugin-typegpu'),
    esbuild: installedVersion(root, 'esbuild'),
    typescript: installedVersion(root, 'typescript'),
    babel: installedVersion(root, '@babel/core'),
  };
}

const HINTS = {
  esbuild: 'esbuild',
  typescript: 'typescript',
  '@babel/core': '@babel/core@^7.28.0',
  'unplugin-typegpu/babel': 'unplugin-typegpu',
};

function load(require, name) {
  try {
    return require(name);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        `typegpu-shaders needs "${name}" in your project but cannot load it. Install it: npm i -D ${HINTS[name] ?? name}  (original error: ${error.message.split('\n')[0]})`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function loadDeps(root) {
  const require = requireFrom(root);
  const esbuild = load(require, 'esbuild');
  const ts = load(require, 'typescript');
  const babel = load(require, '@babel/core');
  const plugin = load(require, 'unplugin-typegpu/babel');
  return { esbuild, ts, transformAsync: babel.transformAsync, typegpuBabel: plugin.default ?? plugin };
}

/** The project's TypeScript, or undefined when it is not installed or cannot be loaded (callers that only need it for a check degrade without it). */
export function loadTypeScript(root) {
  try {
    return requireFrom(root)('typescript');
  } catch {
    return undefined;
  }
}
