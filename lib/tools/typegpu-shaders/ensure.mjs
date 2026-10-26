// What a build tool needs from the shader prebuild: make sure the generated package is current before the application is built.
// Used by the Angular builders (builders/*.cjs); has no Angular dependency itself.
import { createBuilder } from './build.mjs';
import { outputProblems } from './check.mjs';
import { resolveConfig } from './config.mjs';
import { computeClosure } from './graph.mjs';
import { importDiagnostics } from './imports.mjs';
import { removeGenerated } from './manifest.mjs';
import { watchShaders } from './watch.mjs';

/**
 * One-shot: returns when `config.out` is current for the sources, building it if it is not.
 * `{ ok, skipped?, built?, diagnostics }`. No shader modules is ok (`skipped: 'empty'`). Imports that would bundle an untransformed
 * shader are errors even when the output is current.
 */
export async function ensureShaders(options = {}) {
  const config = resolveConfig(options);
  const { entries, files } = computeClosure(config);
  if (entries.length === 0) {
    // no shader module (any more): the output of earlier ones must not stay importable, and an application that still imports it fails
    removeGenerated(config);
    const dangling = importDiagnostics(config, [], { unresolved: true });
    return dangling.length ? { ok: false, diagnostics: dangling } : { ok: true, skipped: 'empty', diagnostics: [] };
  }
  const stray = importDiagnostics(config, files, { unresolved: false });
  if (stray.length) return { ok: false, diagnostics: stray };
  // fresh when nothing but application imports is wrong (those were checked above and are rechecked after a build)
  if (outputProblems(config, files).problems.length === 0) {
    const unresolved = importDiagnostics(config, files, { unresolved: true });
    return { ok: unresolved.length === 0, skipped: 'fresh', diagnostics: unresolved };
  }
  const result = await createBuilder(config).run({ stubs: false });
  const unresolved = result.ok ? importDiagnostics(config, files, { unresolved: true }) : [];
  return { ok: result.ok && unresolved.length === 0, built: true, ms: result.ms, files: result.files, diagnostics: [...result.diagnostics, ...unresolved] };
}

/** Watch mode: rebuild on every change; a failing module shows its error in the page (see watch.mjs). Nothing is an error before the first shader exists. */
export function watchEnsure(options = {}, hooks = {}) {
  return watchShaders({ ...options, allowEmpty: true }, hooks);
}
