// Which files are shader modules, and which project modules they import. The closure is found by scanning import specifiers (not by
// bundling), so it is still available while a file has a syntax error in the middle of an edit. A commented-out import of an existing file
// adds a harmless extra module.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** Every `.ts` file under `dir` (not declarations, not node_modules, not the folders in `skip`). */
export function listTs(dir, skip = []) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (skip.includes(path) || name === 'node_modules') continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

export function findEntries(config) {
  return listTs(config.src, [config.out]).filter((path) => path.endsWith(config.suffix) && !/\.spec\.ts$/.test(path));
}

/**
 * The text with whole-line comments blanked (same offsets): a line that starts with `//`, a block comment that starts a line, and the lines
 * of such a block. A comment after code, and the text of strings, are not recognised without a lexer; blanking only what is certain can
 * hide nothing that is an import.
 */
function withoutCommentLines(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      let comment = inBlock || trimmed.startsWith('//') || trimmed.startsWith('/*');
      if (inBlock || trimmed.startsWith('/*')) {
        const from = inBlock ? 0 : line.length - trimmed.length + 2;
        inBlock = !line.includes('*/', from);
      }
      return comment ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/** Import specifiers of a source text with their position of the specifier text itself (not those in whole-line comments). */
export function specifiersOf(text) {
  return [...withoutCommentLines(text).matchAll(SPECIFIER)].map((m) => ({ spec: m[2], start: m.index + m[0].length - m[2].length - 1, end: m.index + m[0].length - 1 }));
}

/** The `.ts` file a relative specifier refers to, or undefined. `./x.js` means `./x.ts`. */
export function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), spec.replace(/[?#].*$/, ''));
  const candidates = [base, base + '.ts', join(base, 'index.ts')];
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.[cm]?js$/, '.ts'));
  return candidates.find(isFile);
}

/** The shader entry points and every project module they import, transitively. */
export function computeClosure(config) {
  const entries = findEntries(config);
  const closure = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // removed while scanning
    }
    for (const { spec } of specifiersOf(text)) {
      const target = resolveRelative(file, spec);
      if (target && target.endsWith('.ts') && !closure.has(target)) {
        closure.add(target);
        queue.push(target);
      }
    }
  }
  return { entries, files: [...closure].sort() };
}

/** The specifier the application uses for a module of the shader package. */
export function aliasFor(config, file) {
  return config.alias + relative(config.src, file).replace(/\.ts$/, '').split(sep).join('/');
}

/**
 * Imports in application code (every `.ts` under src that is not a shader-package module) that will not work:
 *  - `stray`: a relative import of a shader-package module; the application would bundle the untransformed source;
 *  - `unresolved`: an `@shaders/...` import that does not match a generated module.
 */
export function scanApplication(config, files) {
  const inside = new Set(files);
  const problems = [];
  for (const file of listTs(config.src, [config.out])) {
    if (inside.has(file) || file.endsWith('sources.generated.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const { spec, start, end } of specifiersOf(text)) {
      if (/[?#]/.test(spec)) continue; // `./x.gpu.ts?raw` and the like import the file as data (its text), not as code to bundle
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target && inside.has(target)) problems.push({ kind: 'stray', file, spec, start, end, replacement: aliasFor(config, target) });
      } else if (spec.startsWith(config.alias)) {
        const rest = spec.slice(config.alias.length);
        if (!isFile(join(config.out, rest + '.js'))) problems.push({ kind: 'unresolved', file, spec, start, end });
      }
    }
  }
  return problems;
}

/** Rewrite the `stray` problems to the alias. Returns the number of files changed. */
export function fixStray(problems) {
  const byFile = new Map();
  for (const problem of problems.filter((p) => p.kind === 'stray')) byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), problem]);
  let changed = 0;
  for (const [file, list] of byFile) {
    if (lstatSync(file).isSymbolicLink()) continue; // writing through a link would change a file somewhere else
    changed++;
    let text = readFileSync(file, 'utf8');
    for (const { start, end, replacement } of list.sort((a, b) => b.start - a.start)) text = text.slice(0, start) + replacement + text.slice(end);
    writeFileSync(file, text);
  }
  return changed;
}
