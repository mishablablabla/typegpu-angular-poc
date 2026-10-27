// Options of the sibling generator: `src` (folder with the shader modules) and `suffix` (entry points), from the optional
// `typegpu-shaders.config.json` in the project root and from the arguments.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export function resolveConfig(options = {}) {
  const root = realpathSync(resolve(options.root ?? process.cwd())); // esbuild, Node and TypeScript report real paths: compare real paths
  const file = join(root, 'typegpu-shaders.config.json');
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read typegpu-shaders.config.json: ${error.message}`);
    }
  }
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const merged = { src: 'src', suffix: '.gpu.ts', ...fromFile, ...defined };
  if (!merged.suffix.startsWith('.') || !merged.suffix.endsWith('.ts')) throw new Error('`suffix` must look like ".gpu.ts".');
  const src = existsSync(resolve(root, merged.src)) ? realpathSync(resolve(root, merged.src)) : resolve(root, merged.src);
  if (!src.startsWith(root + sep)) throw new Error(`\`src\` (${src}) must be a folder inside the project (${root}), also after following symbolic links.`);
  return { root, src, suffix: merged.suffix };
}
