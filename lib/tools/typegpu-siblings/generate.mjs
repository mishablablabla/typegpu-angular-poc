// The generator. For every shader module `x.gpu.ts` it writes `x.gpu.generated.js` (the module transformed by unplugin-typegpu, with relative
// imports of other shader modules pointing at their generated siblings) and `x.gpu.generated.d.ts` (a facade that re-exports the types of
// `x.gpu.ts`). Every generated file starts with a header: the hash of what it was made from and of its own body. So whether a file is
// current is a question about that one file and its source: `inspect` answers it without a manifest, a session or any state.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { loadDeps, versionsOf } from './deps.mjs';
import { formatDiagnostic, fromTransform, stubModule } from './diagnostics.mjs';
import { HEADER, cleanTemps, outputsOf, readOwned, removeGenerated, scan, writeGenerated } from './files.mjs';
import { generatedSpecifier, importProblems, resolveAmong, specifiersOf } from './imports.mjs';

export { formatDiagnostic };
const digest = (...parts) => parts.reduce((hash, part) => hash.update(part).update('\0'), createHash('sha256')).digest('hex').slice(0, 16);

/** `export * from './x.gpu'` (and the default export when there is one). Static for a given source: it needs no build to exist. */
const facadeOf = (entry, source) => `${HEADER} facade\n// Types of ${basename(entry)}, for the generated module next to this file.\nexport * from './${basename(entry, '.ts')}';\n${/\bexport\s+default\b/.test(source) ? `export { default } from './${basename(entry, '.ts')}';\n` : ''}`;

/**
 * Where the files of every entry stand, from the sources and the files on disk only (no transform tooling is loaded):
 * `state`: 'fresh', 'missing', 'stale' (made from other sources or tool versions), 'edited' (the body is not what the header says),
 * 'failed' (a stub of a failed transform), 'foreign' (the name is taken by something that is not ours).
 */
export function inspect(config) {
  const found = scan(config);
  const versions = versionsOf(config.root);
  const known = new Set(found.ts);
  const entrySet = new Set(found.entries);
  const wanted = new Map(); // expected generated file -> entry
  const entries = found.entries.map((entry) => {
    const source = readFileSync(entry, 'utf8');
    const rewrites = specifiersOf(source).flatMap(({ spec }) => (resolveAmong(entry, spec, entrySet) ? [spec] : []));
    const hash = digest(JSON.stringify(versions), config.suffix, source, JSON.stringify(rewrites));
    const { js, dts } = outputsOf(entry);
    wanted.set(js.toLowerCase(), entry).set(dts.toLowerCase(), entry);
    const file = readOwned(js);
    const facade = readOwned(dts);
    let state = 'fresh';
    if (file?.foreign || facade?.foreign) state = 'foreign';
    else if (!file) state = 'missing';
    else if (file.source !== hash) state = 'stale';
    else if (digest(file.rest) !== file.body) state = 'edited';
    else if (file.status !== 'ok') state = 'failed';
    const facadeOk = facade?.text === facadeOf(entry, source);
    return { entry, source, hash, js, dts, state, facadeOk: state === 'foreign' ? true : facadeOk };
  });
  // generated files whose source is gone (deleted or renamed): ours, when they carry our header
  const orphans = found.generated.filter((path) => !wanted.has(path.toLowerCase()) && !readOwned(path)?.foreign);
  return { found, entries, orphans, problems: importProblems(config, { ts: found.ts, entries: found.entries }) };
}

/** What is wrong with the generated files and the imports, as `[{ code, file, text }]`; empty when everything is current and usable. */
export function verify(config) {
  const { entries, orphans, problems } = inspect(config);
  const rel = (path) => relative(config.root, path);
  const found = [...problems];
  for (const e of entries) {
    if (e.state !== 'fresh') {
      const text = { missing: 'has no generated sibling', stale: 'changed since its generated sibling was made', edited: 'its generated sibling was edited by hand', failed: 'its generated sibling is the stub of a failed transform', foreign: 'the name of its generated sibling is taken by a file that is not generated' }[e.state];
      found.push({ code: e.state, file: rel(e.entry), text });
    } else if (!e.facadeOk) found.push({ code: 'facade', file: rel(e.dts), text: 'the type facade is missing or not the expected one' });
  }
  for (const path of orphans) found.push({ code: 'orphan', file: rel(path), text: 'generated from a shader module that no longer exists' });
  return found;
}

/** A Babel plugin that points imports of shader modules at their generated siblings (the AST: strings and comments are never touched). */
const rewriteImports = (config, entry, entrySet) => ({ types: t }) => ({
  name: 'typegpu-siblings-imports',
  visitor: {
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(path) {
      const source = path.node.source;
      if (source && resolveAmong(entry, source.value, entrySet)) source.value = generatedSpecifier(source.value, config.suffix);
    },
    CallExpression(path) {
      const [arg] = path.node.arguments;
      if (path.node.callee.type === 'Import' && t.isStringLiteral(arg) && resolveAmong(entry, arg.value, entrySet)) arg.value = generatedSpecifier(arg.value, config.suffix);
    },
  },
});

/** The generated JavaScript of one entry, or throws what Babel / esbuild say. */
async function transform(config, deps, entry, source, entrySet) {
  const name = basename(entry);
  const out = await deps.babel.transformAsync(source, {
    filename: entry,
    sourceFileName: name,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    sourceMaps: 'inline',
    plugins: [deps.typegpuBabel, rewriteImports(config, entry, entrySet)],
    parserOpts: { plugins: ['typescript'] },
  });
  const js = await deps.esbuild.transform(out.code, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: 'inline', sourcefile: name, sourcesContent: true });
  return `// Generated from ${name} by typegpu-siblings. Do not edit: it is overwritten, and the build refuses a file that was edited.\n${js.code}`;
}

const compose = (status, hash, body) => `${HEADER} status=${status} source=${hash} body=${digest(body)}\n${body}`;

/**
 * Bring every generated file up to date. `stubs`: a module that fails to transform is replaced by a stub that shows the error in the page
 * (a dev server); without it the generated file of a failed module is removed, so nothing can bundle an older version of it.
 * Resolves `{ ok, skipped?, built, files, diagnostics, ms }`; it does not throw for errors in shaders.
 */
export async function generate(config, { stubs = false } = {}) {
  const started = performance.now();
  const state = inspect(config);
  const diagnostics = state.problems.map((p) => ({ source: 'import', file: p.file, text: p.text }));
  for (const path of state.orphans) removeGenerated(config, path);
  cleanTemps(state.found.temps);
  const entries = state.entries.map((e) => e.entry);
  const todo = state.entries.filter((e) => e.state !== 'fresh' || !e.facadeOk);
  if (!entries.length) return { ok: diagnostics.length === 0, skipped: 'empty', empty: true, built: 0, files: [], diagnostics, ms: 0 };
  const guard = (fn) => {
    try {
      fn();
    } catch (error) {
      if (error?.code !== 'UNSAFE_OUTPUT') throw error;
      if (!diagnostics.some((d) => d.text === error.message)) diagnostics.push({ source: 'config', text: error.message });
    }
  };
  let deps;
  const entrySet = new Set(entries);
  for (const e of todo) {
    guard(() => writeGenerated(config, e.dts, facadeOf(e.entry, e.source)));
    if (e.state === 'fresh') continue;
    try {
      deps ??= loadDeps(config.root);
      const body = await transform(config, deps, e.entry, e.source, entrySet);
      guard(() => writeGenerated(config, e.js, compose('ok', e.hash, body)));
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND' || /needs "/.test(error?.message ?? '')) throw error;
      const diagnostic = fromTransform(error, e.entry, e.source, config.root);
      diagnostics.push(diagnostic);
      guard(() => (stubs ? writeGenerated(config, e.js, compose('error', e.hash, stubModule(formatDiagnostic(diagnostic)))) : removeGenerated(config, e.js)));
    }
  }
  return { ok: diagnostics.length === 0, skipped: todo.length ? undefined : 'fresh', built: todo.length, files: entries, diagnostics, ms: Math.round(performance.now() - started) };
}
