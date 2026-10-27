// Programmatic API of the shader prebuild (the same functions the `typegpu-shaders` command uses).
import { resolveConfig } from './config.mjs';
import { createBuilder } from './build.mjs';

export { resolveConfig, DEFAULTS } from './config.mjs';
export { checkShaders } from './check.mjs';
export { watchShaders } from './watch.mjs';
export { formatDiagnostic } from './diagnostics.mjs';

/**
 * Build the shader package once. Resolves with `{ ok, diagnostics, files, ms }`; it does not throw for errors in shaders.
 * With `stubs: false` (default) a module that failed leaves no output behind; the manifest then says `error`.
 */
export async function buildShaders(options = {}, { stubs = false } = {}) {
  return createBuilder(resolveConfig(options)).run({ stubs });
}
export { ensureShaders, watchEnsure } from './ensure.mjs';
