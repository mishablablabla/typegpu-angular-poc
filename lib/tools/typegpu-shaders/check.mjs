// Is the generated package usable for the sources as they are now? Needs no esbuild/TypeScript, so it is cheap enough for every CI step.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { versionsOf } from './deps.mjs';
import { computeClosure, fixStray, scanApplication } from './graph.mjs';
import { computeHash, diskDigest, outputsOf, readManifest } from './manifest.mjs';
import { formatDiagnostic } from './diagnostics.mjs';
import { resolveConfig } from './config.mjs';

/** @returns {{ ok: boolean, problems: { code: 'missing'|'failed'|'stale'|'incomplete'|'stray'|'unresolved'|'empty', message: string }[], fixed: number, config: object }} */
export function checkShaders(options = {}, { fixImports = false } = {}) {
  const config = resolveConfig(options);
  const problems = [];
  const { entries, files } = computeClosure(config);
  const rel = (path) => relative(config.root, path);

  if (entries.length === 0) {
    problems.push({ code: 'empty', message: `No shader modules found: no file under ${rel(config.src)} ends with "${config.suffix}".` });
    return { ok: false, problems, fixed: 0, config };
  }

  let fixed = 0;
  let application = scanApplication(config, files);
  if (fixImports && application.some((p) => p.kind === 'stray')) {
    fixed = fixStray(application);
    application = scanApplication(config, files);
  }

  const { manifest, problems: output } = outputProblems(config, files);
  problems.push(...output);

  for (const problem of application) {
    if (problem.kind === 'unresolved' && !manifest) continue; // everything is unresolved before the first build; the missing manifest already says so
    const text = readableSpecifier(problem);
    problems.push(
      problem.kind === 'stray'
        ? { code: 'stray', message: `${rel(problem.file)}: imports the shader module '${problem.spec}' by a relative path, so the untransformed source would be bundled. Import '${problem.replacement}' instead (or run with --fix-imports).` }
        : { code: 'unresolved', message: `${rel(problem.file)}: ${text} does not match a generated module in ${rel(config.out)}.` },
    );
  }
  return { ok: problems.length === 0, problems, fixed, config };
}

/**
 * What is wrong with the generated files themselves (not with the application's imports): never built (`missing`), the last build failed
 * (`failed`), the sources changed since (`stale`), files absent or not the ones the last build wrote (`incomplete`). Empty: current.
 */
export function outputProblems(config, files) {
  const problems = [];
  const rebuild = 'Run `typegpu-shaders build` (or start the build through `typegpu-shaders run -- <command>`).';
  const rel = (path) => relative(config.root, path);
  const manifest = readManifest(config);
  if (!manifest) {
    problems.push({ code: 'missing', message: `${rel(config.out)} has no manifest: the shader package was never built, or was deleted. ${rebuild}` });
    return { manifest, problems };
  }
  if (manifest.status === 'error') {
    const first = (manifest.errors ?? []).slice(0, 3).map((d) => '  ' + formatDiagnostic(d).split('\n')[0]).join('\n');
    problems.push({ code: 'failed', message: `The last shader build failed (${manifest.errors?.length ?? 0} error(s)); its output must not be used.\n${first}\n${rebuild}` });
  }
  const current = manifest.hash === computeHash(config, files, versionsOf(config.root));
  if (!current) {
    problems.push({ code: 'stale', message: `${rel(config.out)} is STALE: the shader sources (or the typegpu / unplugin-typegpu versions) changed since the last build. ${rebuild}` });
  }
  const absent = files.flatMap((file) => outputsOf(config, file).filter((name) => /\.(js|d\.ts)$/.test(name))).filter((name) => !existsSync(join(config.out, name)));
  if (absent.length) problems.push({ code: 'incomplete', message: `${absent.length} generated file(s) are missing (${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}). ${rebuild}` });
  else if (current && manifest.status === 'ok' && manifest.outputs !== diskDigest(config, files)) {
    problems.push({ code: 'incomplete', message: `The generated files in ${rel(config.out)} are not the ones the last build wrote (another build was writing at the same time, one was interrupted, or a file was edited). ${rebuild}` });
  }
  return { manifest, problems };
}

const readableSpecifier = (problem) => `'${problem.spec}'`;
