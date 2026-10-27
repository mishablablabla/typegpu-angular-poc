// Which module a relative import names, and the two ways an import can defeat the generator: application code that imports a shader
// module (`./x.gpu`) instead of its generated sibling (`./x.gpu.generated`), and a module a shader imports that needs the transform but is
// not a shader module (`'use gpu'` in a file that is not named `*.gpu.ts`).
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** A `'use gpu'` directive, or a `tgpu.fn(...)`-style call whose callback the transform gives its metadata (a heuristic: nothing else needs it to run). */
const NEEDS_TRANSFORM = /['"]use gpu['"]|\btgpu\b(?:\s*\[\s*['"]~unstable['"]\s*\])?\s*\.\s*(?:fn|computeFn|vertexFn|fragmentFn)\s*\(/;
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** The text with whole-line comments blanked (same offsets); comments after code and the text of strings are not recognised without a lexer. */
function withoutCommentLines(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      const comment = inBlock || trimmed.startsWith('//') || trimmed.startsWith('/*');
      if (inBlock || trimmed.startsWith('/*')) inBlock = !line.includes('*/', inBlock ? 0 : line.length - trimmed.length + 2);
      return comment ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/** Import specifiers of a source text, with the offset of the match. */
export const specifiersOf = (text) => [...withoutCommentLines(text).matchAll(SPECIFIER)].map((m) => ({ spec: m[2], at: m.index }));

/** The `.ts` file a relative specifier refers to among `known` (a Set of absolute paths), or undefined. `./x.js` means `./x.ts`. */
export function resolveAmong(from, spec, known) {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec.replace(/[?#].*$/, ''));
  return [base, base + '.ts', base.replace(/\.[cm]?js$/, '.ts')].find((candidate) => known.has(candidate));
}

/** `import type ...` and `export type ...` are erased: they never bundle the module. */
const typeOnly = (text, at) => /^(import|export)\s+type\b/.test(text.slice(Math.max(text.lastIndexOf('import', at), text.lastIndexOf('export', at))).slice(0, 24));

/** The new specifier for an import of an entry: `./x.gpu`, `./x.gpu.js` and `./x.gpu.ts` all become `./x.gpu.generated`. */
export const generatedSpecifier = (spec, suffix) => spec.replace(new RegExp(`${suffix.slice(0, -3).replace(/\./g, '\\.')}(\\.[cm]?[jt]s)?$`), `${suffix.slice(0, -3)}.generated`);

/** Problems with imports in the sources: `[{ code: 'stray' | 'closure', file, text }]`. */
export function importProblems(config, { ts, entries }) {
  const known = new Set(ts);
  const entrySet = new Set(entries);
  const problems = [];
  const rel = (path) => relative(config.root, path);
  // modules a shader imports (transitively) that need the transform but are not shader modules
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!entrySet.has(file) && NEEDS_TRANSFORM.test(withoutCommentLines(text))) {
      problems.push({ code: 'closure', file: rel(file), text: `contains 'use gpu' code or a tgpu.fn(...) function but is not a "*${config.suffix}" module, so it is not transformed. Rename it to "*${config.suffix}" and import its generated sibling.` });
    }
    for (const { spec } of specifiersOf(text)) {
      const target = resolveAmong(file, spec, known);
      if (target && !seen.has(target)) (seen.add(target), queue.push(target));
    }
  }
  // application code that imports a shader module itself (it would bundle the untransformed source)
  for (const file of ts) {
    if (entrySet.has(file)) continue; // imports between shader modules are rewritten by the generator
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { spec, at } of specifiersOf(text)) {
      if (/[?#]/.test(spec) || typeOnly(text, at)) continue; // `?raw` imports data, `import type` is erased
      const target = resolveAmong(file, spec, entrySet);
      if (target) problems.push({ code: 'stray', file: rel(file), text: `imports the shader module '${spec}', so the untransformed source would be bundled. Import '${generatedSpecifier(spec, config.suffix)}' instead.` });
    }
  }
  return problems;
}
