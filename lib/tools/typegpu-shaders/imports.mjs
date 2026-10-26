// Problems with the application's imports of shader modules, as diagnostics (shared by the one-shot ensure and by watch mode).
import { relative } from 'node:path';
import { scanApplication } from './graph.mjs';

/**
 * Imports in application code that would bundle an untransformed shader (`stray`: a shader module imported by a relative path;
 * `aliased`: by a tsconfig `paths` / `baseUrl` alias), and with `unresolved` also `@shaders/...` imports that match no generated module.
 */
export function importDiagnostics(config, files, { unresolved }) {
  return scanApplication(config, files)
    .filter((problem) => unresolved || problem.kind !== 'unresolved')
    .map((problem) => ({
      source: 'import',
      file: relative(config.root, problem.file),
      text:
        problem.kind === 'stray'
          ? `'${problem.spec}' is a shader module imported by a relative path: the untransformed source would be bundled. Import '${problem.replacement}' instead (\`typegpu-shaders check --fix-imports\` rewrites it).`
          : problem.kind === 'aliased'
            ? `'${problem.spec}' is a shader module (${relative(config.root, problem.target)}) imported through a tsconfig paths/baseUrl alias: the untransformed source would be bundled. Import '${problem.replacement}' instead (\`typegpu-shaders check --fix-imports\` rewrites it).`
            : `'${problem.spec}' does not match a generated shader module in ${relative(config.root, config.out)}.`,
    }));
}
