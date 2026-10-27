// Which files are shader modules, and which project modules they import. The closure is found by scanning import specifiers (not by
// bundling), so it is still available while a file has a syntax error in the middle of an edit. A commented-out import of an existing file
// adds a harmless extra module.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadTypeScript } from './deps.mjs';

// either kind of quote may appear inside the other kind (a file called it's.ts)
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(?:'([^'\n]+)'|"([^"\n]+)")/g;

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

/**
 * Import specifiers of a source text with the position of the specifier text itself. With the project's TypeScript (`root`) its own scanner
 * decides what an import is, so import-looking text in a string, a template literal or a comment after code is not one, and a file name
 * with a quote or a `#` in it is read right. Without TypeScript a regular expression runs on the text minus whole-line comments (which can
 * only find too much, never miss an import).
 */
export function specifiersOf(text, root) {
  const ts = root ? loadTypeScript(root) : undefined; // Node keeps the module and its lookups: this is cheap after the first file
  if (ts) {
    try {
      // `pos` is where the quoted specifier starts (at the quote); `end` is not reliable, so the closing quote is looked for (an escape can make the text longer than the name)
      return ts.preProcessFile(text, true, true).importedFiles.map((f) => {
        let end = f.pos + 1;
        while (end < text.length && text[end] !== text[f.pos] && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
        return { spec: f.fileName, start: f.pos + 1, end };
      });
    } catch {
      /* the scanner failed on this text: the expression below */
    }
  }
  return [...withoutCommentLines(text).matchAll(SPECIFIER)].map((m) => {
    const spec = m[1] ?? m[2];
    return { spec, start: m.index + m[0].length - spec.length - 1, end: m.index + m[0].length - 1 };
  });
}

/** The `.ts` file a relative specifier refers to, or undefined. `./x.js` means `./x.ts`. */
export function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return undefined;
  const literal = resolve(dirname(fromFile), spec); // a file may really be called `a#b.ts`
  const base = resolve(dirname(fromFile), spec.replace(/[?#].*$/, ''));
  const candidates = [literal, literal + '.ts', base, base + '.ts', join(base, 'index.ts')];
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
    for (const { spec } of specifiersOf(text, config.root)) {
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
 * Resolves the specifiers that are not relative and not under the generated-module alias the way TypeScript does with the project's
 * tsconfig (`paths`, `baseUrl`, `extends` chains). A specifier can only land in the project's own sources through `paths` or `baseUrl`, so
 * without those, and for a specifier no `paths` pattern matches (with no `baseUrl`), nothing is resolved at all: the usual package import
 * costs nothing. A tsconfig or TypeScript that cannot be loaded gives a resolver that finds nothing (the previous behaviour).
 * @returns {(spec: string, fromFile: string) => string | undefined} the resolved `.ts` file (real path), or undefined
 */
function createAliasResolver(config) {
  const none = () => undefined;
  if (!config.tsconfig) return none;
  try {
    const ts = loadTypeScript(config.root);
    if (!ts) return none;
    const host = { ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: () => {} }; // no file listing: only the options are wanted
    const options = ts.getParsedCommandLineOfConfigFile(config.tsconfig, {}, host)?.options;
    if (!options || (!options.paths && options.baseUrl === undefined)) return none;
    const patterns = Object.keys(options.paths ?? {}).map((pattern) => {
      const star = pattern.indexOf('*');
      return star < 0 ? (spec) => spec === pattern : (spec) => spec.length >= pattern.length - 1 && spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
    });
    const mayBeLocal = (spec) => options.baseUrl !== undefined || patterns.some((matches) => matches(spec));
    const cache = ts.createModuleResolutionCache(config.root, (name) => name, options);
    const memo = new Map(); // by specifier: `paths` and `baseUrl` do not depend on the importing file, and only they can land in the project
    return (spec, fromFile) => {
      if (!mayBeLocal(spec)) return undefined;
      if (!memo.has(spec)) {
        let found;
        try {
          const resolved = ts.resolveModuleName(spec, fromFile, options, ts.sys, cache).resolvedModule;
          if (resolved && /\.ts$/.test(resolved.resolvedFileName) && !resolved.resolvedFileName.endsWith('.d.ts')) {
            found = resolve(resolved.resolvedFileName);
            try {
              found = realpathSync(found);
            } catch {
              /* keep the path as TypeScript reported it */
            }
          }
        } catch {
          /* a specifier TypeScript cannot resolve is not ours to report */
        }
        memo.set(spec, found);
      }
      return memo.get(spec);
    };
  } catch {
    return none; // a broken tsconfig is reported by the build with its own message; here it only means no alias is known
  }
}

/**
 * Imports in application code (every `.ts` under src that is not a shader-package module) that will not work:
 *  - `stray`: a relative import of a shader-package module; the application would bundle the untransformed source;
 *  - `aliased`: the same through a tsconfig `paths` / `baseUrl` alias (`@app/x.gpu` for `src/app/x.gpu.ts`); `replacement` is the `@shaders/` specifier;
 *  - `unresolved`: an `@shaders/...` import that does not match a generated module;
 *  - `nested`: in a shader-package module, an `@shaders/...` import: shader modules import each other by relative paths (the generated folder
 *    is both the input and the output of the type check, which fails with TS7016 or TS5055 depending on whether it exists yet).
 *    `replacement` is the relative path to use.
 */
export function scanApplication(config, files) {
  const inside = new Set(files);
  const problems = [];
  const aliasTarget = createAliasResolver(config);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // removed while scanning
    }
    for (const { spec, start, end } of specifiersOf(text, config.root)) {
      if (!spec.startsWith(config.alias)) continue;
      const relativeSpec = relative(dirname(file), join(config.src, spec.slice(config.alias.length))).split(sep).join('/');
      problems.push({ kind: 'nested', file, spec, start, end, replacement: relativeSpec.startsWith('.') ? relativeSpec : `./${relativeSpec}` });
    }
  }
  for (const file of listTs(config.src, [config.out])) {
    if (inside.has(file) || file.endsWith('sources.generated.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const { spec, start, end } of specifiersOf(text, config.root)) {
      // `./x.gpu.ts?raw` and the like import the file as data (its text), not as code to bundle; but a file really called `a#b.ts` is code
      if (/[?#]/.test(spec) && !(spec.startsWith('.') && [spec, `${spec}.ts`].some((name) => isFile(resolve(dirname(file), name))))) continue;
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target && inside.has(target)) problems.push({ kind: 'stray', file, spec, start, end, replacement: aliasFor(config, target) });
      } else if (spec.startsWith(config.alias)) {
        const rest = spec.slice(config.alias.length);
        if (!isFile(join(config.out, rest + '.js'))) problems.push({ kind: 'unresolved', file, spec, start, end });
      } else {
        const target = aliasTarget(spec, file);
        if (target && inside.has(target)) problems.push({ kind: 'aliased', file, spec, start, end, replacement: aliasFor(config, target), target });
      }
    }
  }
  return problems;
}

/** Rewrite the `stray` and `aliased` problems to the generated-module alias. Returns the number of files changed. */
export function fixStray(problems) {
  const byFile = new Map();
  for (const problem of problems.filter((p) => p.kind === 'stray' || p.kind === 'aliased')) byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), problem]);
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
