// The generator uses the project's own copies of esbuild, Babel and unplugin-typegpu (resolved from the project root), so it follows the
// versions the project builds with. `versionsOf` only reads package.json files: `verify` needs no transform tooling.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const requireFrom = (root) => createRequire(join(root, 'package.json'));

function installedVersion(root, name) {
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
/** A digest of this tool's own source: a changed generator makes every generated file stale. */
function toolDigest() {
  if (toolCode) return toolCode;
  const dir = new URL('.', import.meta.url);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.mjs')).sort()) hash.update(name).update(readFileSync(new URL(name, dir)));
  return (toolCode = hash.digest('hex').slice(0, 12));
}

export const versionsOf = (root) => ({ tool: toolDigest(), typegpu: installedVersion(root, 'typegpu'), unplugin: installedVersion(root, 'unplugin-typegpu'), esbuild: installedVersion(root, 'esbuild'), babel: installedVersion(root, '@babel/core') });

export function loadDeps(root) {
  const require = requireFrom(root);
  const load = (name, hint) => {
    try {
      return require(name);
    } catch (error) {
      throw new Error(`typegpu-shaders needs "${name}" in your project but cannot load it. Install it: npm i -D ${hint ?? name}  (${error.message.split('\n')[0]})`, { cause: error });
    }
  };
  const plugin = load('unplugin-typegpu/babel');
  return { esbuild: load('esbuild'), babel: load('@babel/core', '@babel/core@^7.28.0'), typegpuBabel: plugin.default ?? plugin };
}
