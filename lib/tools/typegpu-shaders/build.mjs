// One build of the shader package: the closure of shader modules is transformed file by file (esbuild + unplugin-typegpu's Babel plugin, source
// maps composed), declarations come from the TypeScript API, stale outputs are pruned, and a manifest records what was built from what.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { isInside } from './paths.mjs';
import { cleanTmp, removeInside, writeIfChanged } from './atomic.mjs';
import { loadDeps, versionsOf } from './deps.mjs';
import { computeClosure } from './graph.mjs';
import { exportNames, formatDiagnostic, fromEsbuild, fromTransform, fromTypeScript, isStub, stubModule } from './diagnostics.mjs';
import { claimOutputs, computeHash, digestOf, outputsOf, prune, readManifest, removeGenerated, SCHEMA, writeManifest } from './manifest.mjs';

/** `hooks` exist for tests only (no CLI or builder option reaches them): `afterSnapshot()` runs once the sources of a build have been read. */
export function createBuilder(config, hooks = {}) {
  const { esbuild, ts, transformAsync, typegpuBabel } = loadDeps(config.root);
  let program; // the previous TypeScript program, so later builds reuse what did not change
  let typeOptions;

  function parseTypeOptions() {
    const base = config.tsconfig
      ? ts.getParsedCommandLineOfConfigFile(config.tsconfig, {}, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (d) => {
            throw new Error(`${config.tsconfig}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
          },
        })?.options ?? {}
      : {};
    return {
      ...base,
      declaration: true,
      declarationMap: true,
      emitDeclarationOnly: true,
      noEmit: false,
      incremental: false,
      composite: false,
      tsBuildInfoFile: undefined,
      sourceMap: false,
      inlineSourceMap: false,
      outDir: config.out,
      rootDir: config.src,
    };
  }

  /** Declarations for every module, plus the type errors of the shader sources. `write(path, text)` stores one emitted file. */
  function emitTypes(files, write, snapshot) {
    typeOptions ??= parseTypeOptions();
    // the sources come from the snapshot the hash was taken from, not from disk: an edit while this runs must not end up in the output
    const host = ts.createCompilerHost(typeOptions, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const readFile = host.readFile.bind(host);
    host.readFile = (file) => snapshot.get(resolve(file))?.toString('utf8') ?? readFile(file);
    host.getSourceFile = (file, languageVersion, ...rest) => {
      const bytes = snapshot.get(resolve(file));
      return bytes ? ts.createSourceFile(file, bytes.toString('utf8'), languageVersion, true) : getSourceFile(file, languageVersion, ...rest);
    };
    program = ts.createProgram({ rootNames: files, options: typeOptions, host, oldProgram: program });
    program.emit(undefined, (fileName, text) => write(fileName, text), undefined, true);
    const seen = new Set();
    return ts
      .getPreEmitDiagnostics(program)
      .filter((d) => !d.file || isInside(config.src, d.file.fileName))
      .map((d) => fromTypeScript(ts, d, config.root))
      .filter((d) => !seen.has(JSON.stringify(d)) && seen.add(JSON.stringify(d)));
  }

  /** JavaScript (and source maps) for every module, not yet stored. A module that cannot be transformed gets a stub (and an entry in `failures`). */
  async function emitJs(files, failures, snapshot) {
    const plugin = {
      name: 'typegpu-shaders',
      setup(build) {
        build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (!isInside(config.src, path) || path.endsWith('.d.ts')) return undefined;
          const known = failures.get(path);
          const code = (snapshot.get(path) ?? readFileSync(path)).toString('utf8');
          if (known) return { contents: stubModule(formatDiagnostic(known), exportNames(ts, code, path)), loader: 'js' };
          if (!/use gpu|tgpu|typegpu/.test(code)) return { contents: code, loader: 'ts' };
          try {
            const out = await transformAsync(code, {
              filename: path,
              // relative to the module itself: esbuild resolves a source map's `sources` against the input file's folder
              sourceFileName: path.slice(path.lastIndexOf(sep) + 1),
              babelrc: false,
              configFile: false,
              sourceType: 'module',
              sourceMaps: 'inline',
              plugins: [typegpuBabel],
              parserOpts: { plugins: ['typescript'] },
            });
            return { contents: out.code, loader: 'ts', watchFiles: [path] };
          } catch (error) {
            const diagnostic = fromTransform(error, path, code, config.root);
            failures.set(path, diagnostic);
            return { contents: stubModule(formatDiagnostic(diagnostic), exportNames(ts, code, path)), loader: 'js' };
          }
        });
      },
    };
    // A syntax error in a plain module (no `'use gpu'`) fails esbuild itself: stub that module too and go again.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // `write: false`: the caller stores the files (atomically, and only when they changed), not esbuild
        const { outputFiles } = await esbuild.build({
          absWorkingDir: config.root,
          entryPoints: files,
          outdir: config.out,
          outbase: config.src,
          bundle: false,
          write: false,
          format: 'esm',
          target: 'es2022',
          sourcemap: true,
          sourcesContent: true,
          logLevel: 'silent',
          plugins: [plugin],
        });
        return outputFiles;
      } catch (error) {
        let added = 0;
        for (const message of error?.errors ?? []) {
          const diagnostic = fromEsbuild(message, config.root);
          const path = diagnostic.file && resolve(config.root, diagnostic.file);
          if (path && files.includes(path) && !failures.has(path)) {
            failures.set(path, diagnostic);
            added++;
          }
        }
        if (!added) throw error;
      }
    }
  }

  /**
   * @param {{ stubs?: boolean, allowEmpty?: boolean }} options `stubs`: leave a stub module (error banner and a throw on import in a page; placeholder exports on a server) for a module that failed, so a
   *   running dev server shows the failure. Without it (a plain build) the outputs of failed modules are removed, so nothing can bundle them.
   *   `allowEmpty`: a project without shader modules is a success (nothing is built), not an error.
   */
  async function run({ stubs = false, allowEmpty = false } = {}) {
    const started = performance.now();
    const { entries, files } = computeClosure(config);
    const versions = versionsOf(config.root);
    const diagnostics = [];
    const failures = new Map();
    /** What this build left in `out`, by name: the digest in the manifest is of exactly these bytes. */
    const written = new Map();
    // the last shader module is gone: its output must not stay importable
    /** Generated files that could not be removed: they stay on the manifest's list, or no later build would know to remove them. */
    const stuck = [];
    const keepStuck = (failures) => {
      for (const { name, ...diagnostic } of failures) {
        if (name) stuck.push(name);
        diagnostics.push(diagnostic);
      }
    };
    if (entries.length === 0) keepStuck(removeGenerated(config));
    if (entries.length === 0 && allowEmpty) {
      const status = diagnostics.length ? 'error' : 'ok'; // an error only when the output of the removed modules could not be removed
      return { ok: !diagnostics.length, status, empty: true, entries, files, diagnostics, stubbed: [], ms: 0, hash: undefined };
    }
    if (entries.length === 0) {
      diagnostics.push({ source: 'config', text: `No shader modules found: no file under ${config.src} ends with "${config.suffix}".` });
      return finish({ files, hash: undefined });
    }
    // Every file is read ONCE; the hash, the JavaScript and the declarations all come from these bytes, so the manifest describes exactly what
    // was built even when the sources change (and change back) meanwhile.
    const snapshot = new Map();
    for (const file of files) {
      try {
        snapshot.set(file, readFileSync(file));
      } catch {
        /* removed since the closure was scanned: the next change builds again */
      }
    }
    const hash = computeHash(config, [...snapshot.keys()], versions, (file) => snapshot.get(file));
    await hooks.afterSnapshot?.();
    const outside = files.filter((file) => !isInside(config.src, file));
    if (outside.length) {
      for (const file of outside) diagnostics.push({ source: 'config', file: relative(config.root, file), text: 'A shader module imports a module outside the source folder: shader modules and what they import must be under src (nothing is built; it would be written outside the output folder).' });
      return finish({ files: files.filter((file) => !outside.includes(file)), hash: undefined });
    }
    const keep = new Set(files.flatMap((file) => outputsOf(config, file)));
    cleanTmp(config.out);
    const previous = readManifest(config);
    claimOutputs(config, previous, keep); // before the first file is written: what this build may leave behind is on record
    const store = (path, data) => {
      const name = relative(config.out, path);
      if (!keep.has(name) || !isInside(config.out, path)) return; // never a file outside the output folder
      try {
        writeIfChanged(config.out, path, data);
      } catch (error) {
        if (error?.code !== 'UNSAFE_OUTPUT') throw error;
        if (!diagnostics.some((d) => d.text === error.message)) diagnostics.push({ source: 'config', text: error.message });
        return;
      }
      written.set(name, Buffer.from(data));
    };
    // JavaScript first: it is what a running dev server needs to show the change, and it is quick; the TypeScript program takes longer.
    let compiled = [];
    try {
      compiled = (await emitJs(files, failures, snapshot)) ?? [];
    } catch (error) {
      diagnostics.push({ source: 'config', text: `Transform failed: ${String(error?.errors?.[0]?.text ?? error?.message ?? error)}` });
    }
    const failedOutputs = new Set([...failures.keys()].flatMap((path) => outputsOf(config, path).filter((name) => name.endsWith('.js') || name.endsWith('.js.map'))));
    // A plain build does not write the stubs of failed modules (and a stub that is already there is another run's, for its dev server: it is
    // left alone); what an earlier good build left for them is removed, so nothing can bundle a stale module. A watch writes the stubs.
    for (const file of compiled) if (stubs || !failedOutputs.has(relative(config.out, file.path))) store(file.path, file.contents);
    try {
      diagnostics.push(...emitTypes(files, store, snapshot));
    } catch (error) {
      diagnostics.push({ source: 'config', text: `Declaration emit failed: ${error.message}` });
    }
    diagnostics.push(...failures.values());
    if (!stubs) {
      for (const name of failedOutputs) {
        if (!isStubOutput(name)) removeInside(config.out, resolve(config.out, name));
      }
    }
    // What goes is judged by the sources as they are NOW, not only by this build's closure: another build (a dev server) may have added a
    // module since this one read its sources, and its output is not this build's to delete.
    keepStuck(prune(config, [...new Set([...files, ...computeClosure(config).files])], previous));
    return finish({ files, hash });

    /** Whether the generated module behind `name` (a `.js` or its `.js.map`) is the stub of a failed module. */
    function isStubOutput(name) {
      try {
        return isStub(readFileSync(resolve(config.out, name.replace(/\.map$/, '')), 'utf8'));
      } catch {
        return false;
      }
    }

    /** `[name, bytes]` of every output of the closure: the bytes this build wrote, else what is on disk. */
    function outputBytes(built) {
      const entries = [];
      for (const name of built.flatMap((file) => outputsOf(config, file))) {
        if (written.has(name)) entries.push([name, written.get(name)]);
        else
          try {
            entries.push([name, readFileSync(resolve(config.out, name))]);
          } catch {
            /* not there */
          }
      }
      return entries;
    }

    function finish({ files: built, hash: builtHash }) {
      const status = diagnostics.length ? 'error' : 'ok';
      writeManifest(config, {
        schema: SCHEMA,
        status,
        hash: builtHash,
        outputs: digestOf(outputBytes(built)),
        generated: [...new Set([...built.flatMap((file) => outputsOf(config, file)).filter((name) => existsSync(resolve(config.out, name))), ...stuck])].sort(),
        stubs: stubs && failures.size > 0,
        files: built.map((file) => file.slice(config.root.length + 1)),
        errors: diagnostics.slice(0, 20),
      });
      const stubbed = stubs ? [...failures.keys()] : [];
      return { ok: status === 'ok', status, entries, files: built, diagnostics, stubbed, ms: Math.round(performance.now() - started), hash: builtHash };
    }
  }

  return { run };
}
