// esbuild plugin for @angular-builders/custom-esbuild `plugins` option.
// Redirects imports of `*.gpu` / `*.gpu.ts` modules into a private namespace and runs
// unplugin-typegpu/babel on them (keeping TS syntax; esbuild strips types afterwards).
//
// Imports are resolved with esbuild's own resolver (`build.resolve`), so tsconfig `paths` / `baseUrl`,
// `./foo.gpu.js` -> `foo.gpu.ts` and `.ts` extension imports behave as in the rest of the app. The decision is
// made on the RESOLVED path: only files whose name really is `*.gpu.<ext>` are redirected (also when an alias such
// as `@shaders/noise` hides the `.gpu` in the specifier), so one file is one module however it is imported.
// Imports marked `external`, or resolving outside the file namespace, are never transformed.
// Transform failures are reported as esbuild errors with file, line and column. Set TYPEGPU_SHADERS_LOG=1 to
// log which imports were matched. Needs `@babel/core` and `unplugin-typegpu` installed in the app.
//
// After each build the plugin warns (esbuild warning with file, line and column) about a `'use gpu'` directive in a
// bundled project source that was NOT transformed: a file that is not named `*.gpu.<ext>`, or a `*.gpu.<ext>` file
// that was bundled through a path this plugin did not see. node_modules is not checked (prebuilt libraries such
// as @typegpu/noise are already transformed). The warning needs the esbuild metafile, which Angular's builders
// always request.
//
// Limitation: Web Workers are NOT supported. Angular's application builder bundles workers (`new Worker(new
// URL(...))`) in separate esbuild builds and does not pass user plugins to them, so a `*.gpu.ts` module imported
// from worker code is bundled untransformed (check-shader-bundle.mjs reports it). Keep shaders out of workers.
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath, sep } from 'node:path';
import { scanUseGpu } from './use-gpu-scan.mjs';

const NS = 'typegpu-shader';
const SKIP = Symbol.for('typegpu-shaders.skip');
// Angular's compiler plugin registers onLoad({ filter: /\.[cm]?[jt]sx?$/ }) WITHOUT a namespace, which in
// esbuild matches every namespace and runs first. A virtual path that does not end in a script extension
// avoids it; the real path is recovered in our onLoad.
const SUFFIX = '.typegpu-shader';
const EXTS = ['.ts', '.mts', '.js', '.mjs'];
const GPU_SPECIFIER = /\.gpu(\.[cm]?[jt]s)?$/;
const GPU_FILE = /\.gpu\.[cm]?[jt]s$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const NODE_MODULES = /(^|[\\/])node_modules[\\/]/;
// A bare specifier (`@shaders/noise`, `lib`, `~/x`) may be a tsconfig path alias; relative and absolute ones, URLs
// and `node:` imports cannot hide a `*.gpu.*` file (esbuild only appends an extension or `/index` to them).
const BARE_SPECIFIER = /^(?![./]|[a-zA-Z][\w+.-]*:)/;

function findFile(base) {
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  return undefined;
}

/** The package's own name and peer ranges (from its package.json next to `tools/`), for an accurate install hint. */
function packageInfo() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return { name: manifest.name, peers: manifest.peerDependencies ?? {} };
  } catch {
    return { name: undefined, peers: {} };
  }
}

function missingDependencyMessage(name, original) {
  const { name: packageName, peers } = packageInfo();
  const dev = ['@babel/core', 'unplugin-typegpu'].map((dep) => (peers[dep] ? `${dep}@${peers[dep]}` : dep));
  const required = ['@babel/core', 'unplugin-typegpu', 'typegpu'].filter((dep) => peers[dep]).map((dep) => `${dep}@${peers[dep]}`);
  return (
    `[typegpu-shaders] Cannot load "${name}", which the TypeGPU shader plugin needs. ` +
    (required.length ? `${packageName ?? 'This package'} requires ${required.join(', ')}. ` : '') +
    (packageName ? `Run \`ng add ${packageName}\` (it installs matching versions), or install them yourself: ` : 'Install them: ') +
    `npm i -D ${dev.join(' ')}  (original error: ${original})`
  );
}

let babel;
async function loadBabel() {
  if (babel) return babel;
  const load = async (name) => {
    try {
      return await import(name);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
        throw new Error(missingDependencyMessage(name, error.message), { cause: error });
      }
      throw error;
    }
  };
  const [core, plugin] = await Promise.all([load('@babel/core'), load('unplugin-typegpu/babel')]);
  babel = { transformAsync: core.transformAsync, typegpuBabel: plugin.default };
  return babel;
}

/** Convert a Babel / unplugin-typegpu failure into an esbuild message. */
function toEsbuildError(error, realPath, code) {
  const file = relative(process.cwd(), realPath);
  // Babel prefixes `<abs file>: ` and (for parse errors) appends ` (line:col)` and a code frame.
  let text = String(error?.message ?? error)
    .split('\n\n')[0]
    .replace(realPath + ': ', '')
    .replace(/ \(\d+:\d+\)(:)?$/, '');
  const loc = error?.loc;
  const message = { pluginName: 'typegpu-shaders', text, detail: error };
  if (loc && typeof loc.line === 'number') {
    const lineText = code.split(/\r?\n/)[loc.line - 1] ?? '';
    message.location = { file, line: loc.line, column: loc.column, length: 1, lineText };
  } else {
    // unplugin-typegpu errors (e.g. "Unsupported JS functionality: TryStatement") carry no position:
    // name the file in the text and list the candidate 'use gpu' functions instead of inventing a location.
    const lines = code.split(/\r?\n/);
    const where = lines.flatMap((l, i) => (/['"]use gpu['"]/.test(l) ? [i + 1] : []));
    message.text = `${file}: ${text}`;
    message.notes = [
      {
        text:
          "Raised by unplugin-typegpu while transpiling a 'use gpu' function in this file" +
          (where.length ? ` ('use gpu' directives at line ${where.join(', ')}).` : '.'),
      },
    ];
  }
  return message;
}

export default {
  name: 'typegpu-shaders',
  async setup(build) {
    // fail at build start (not at the first shader) when a peer dependency is missing
    await loadBabel();
    const log = process.env.TYPEGPU_SHADERS_LOG ? (...a) => console.log('[typegpu-shaders]', ...a) : () => {};
    // esbuild resolves to real paths, so the workspace root must be a real path too (macOS /var -> /private/var, symlinked checkouts)
    const workspace = () => {
      const dir = build.initialOptions.absWorkingDir ?? process.cwd();
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    };

    // Resolved path (or null) per importing directory + specifier, for the current build only.
    const resolved = new Map();
    build.onStart(() => resolved.clear());

    const redirect = async (args, named) => {
      if (args.pluginData?.[SKIP]) return undefined; // our own build.resolve() call below
      const namespace = args.namespace === NS ? 'file' : args.namespace;
      if (!named && namespace !== 'file') return undefined;

      const key = `${args.resolveDir}\0${args.path}`;
      let path = resolved.get(key);
      if (path === undefined) {
        const result = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          namespace,
          with: args.with,
          pluginData: { [SKIP]: true },
        });
        path = null;
        if (!result.errors.length && !result.external && result.namespace === 'file') path = result.path;
        // fallback: previous behaviour for relative/absolute specifiers esbuild could not resolve (.mts etc.)
        else if (named && /^(\.|\/)/.test(args.path)) path = findFile(resolvePath(args.resolveDir, args.path)) ?? null;
        resolved.set(key, path);
        if (named || (path && GPU_FILE.test(path))) log('onResolve', args.path, '->', path ?? 'not a gpu file', `(kind=${args.kind})`);
      }
      if (!path || !GPU_FILE.test(path)) return undefined;
      return { path: path + SUFFIX, namespace: NS, watchFiles: [path] };
    };
    // 1. specifiers that name a gpu module (`./noise.gpu`, `./noise.gpu.js`, `@x/noise.gpu`)
    build.onResolve({ filter: GPU_SPECIFIER }, (args) => redirect(args, true));
    // 2. bare specifiers that may be a tsconfig path alias hiding the `.gpu` (`@shaders/noise`). esbuild applies
    // `paths` only to the app's own files, so imports made from inside node_modules are skipped without a second
    // resolution; the rest is resolved once per directory and specifier. Relative specifiers never reach this callback.
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (GPU_SPECIFIER.test(args.path) || !BARE_SPECIFIER.test(args.path)) return undefined;
      if (args.kind === 'entry-point' || NODE_MODULES.test(args.importer)) return undefined;
      return redirect(args, false);
    });

    build.onLoad({ filter: /.*/, namespace: NS }, async (args) => {
      const realPath = args.path.slice(0, -SUFFIX.length);
      const code = await readFile(realPath, 'utf8');
      const { transformAsync, typegpuBabel } = await loadBabel(); // cached
      let out;
      try {
        out = await transformAsync(code, {
          filename: realPath,
          // The map's `sources` entry: workspace-relative like every other module in the bundle, so two
          // `noise.gpu.ts` in different folders stay distinguishable in DevTools and stack traces.
          sourceFileName: relative(workspace(), realPath).split(sep).join('/'),
          babelrc: false,
          configFile: false,
          sourceType: 'module',
          sourceMaps: 'inline',
          plugins: [typegpuBabel],
          parserOpts: { plugins: ['typescript'] },
          generatorOpts: { retainLines: false },
        });
      } catch (error) {
        return { errors: [toEsbuildError(error, realPath, code)], watchFiles: [realPath] };
      }
      log('onLoad', realPath, 'meta writes:', (out.code.match(/__TYPEGPU_META__ \?\?=/g) ?? []).length);
      return {
        contents: out.code,
        loader: /\.[cm]?ts$/.test(realPath) ? 'ts' : 'js',
        resolveDir: dirname(realPath),
        watchFiles: [realPath],
      };
    });

    // Warn about `'use gpu'` directives in bundled project sources that did not go through the transform.
    // (An onLoad hook cannot see them: Angular's own onLoad for script files runs first and handles them.)
    const scanned = new Map(); // path -> { stamp, directives }
    build.onEnd(async (result) => {
      const inputs = result.metafile?.inputs;
      if (!inputs) return;
      const base = workspace();
      for (const key of Object.keys(inputs)) {
        // Transformed modules are keyed `typegpu-shader:<path>`; other namespaces (`angular:...`) carry a prefix too.
        if (!SCRIPT_FILE.test(key) || /^[A-Za-z][\w-]+:/.test(key) || NODE_MODULES.test(key)) continue;
        const path = resolvePath(base, key);
        let info;
        try {
          const stats = await stat(path);
          const stamp = `${stats.mtimeMs}:${stats.size}`;
          info = scanned.get(path);
          if (info?.stamp !== stamp) {
            const text = await readFile(path, 'utf8');
            const directives = text.includes('use gpu') ? scanUseGpu(text).filter((d) => !d.transformed) : [];
            info = { stamp, text: directives.length ? text : '', directives };
            scanned.set(path, info);
          }
        } catch {
          continue; // virtual or removed input
        }
        // Angular merges the metafile of worker bundles into the main one: say so when the file went into a worker.
        const worker = Object.entries(result.metafile.outputs ?? {}).find(
          ([out, meta]) => /(^|[\\/])worker-[^\\/]*$/.test(out) && info.directives.length > 0 && key in (meta.inputs ?? {}),
        )?.[0];
        for (const directive of info.directives) {
          const lineText = info.text.split(/\r?\n/)[directive.line - 1] ?? '';
          const isGpu = GPU_FILE.test(key);
          const text = worker
            ? `A 'use gpu' directive in code bundled for a Web Worker (${worker}) was not transformed: Angular's application builder does not pass user plugins to worker bundles.`
            : isGpu
              ? "This *.gpu module has a 'use gpu' directive but was bundled without the TypeGPU transform: it was reached through an import the shader plugin did not match."
              : "A 'use gpu' directive in a file that is not named *.gpu.ts: it is not transformed and will fail at runtime.";
          const note = worker
            ? 'Web Workers are not supported for shaders: keep *.gpu modules out of code a worker imports.'
            : isGpu
              ? 'Check that the import resolves to this file (tsconfig paths), or run with TYPEGPU_SHADERS_LOG=1 to see what the plugin matched.'
              : `Move the shader into a module named like ${key.replace(/\.[cm]?[jt]sx?$/, (ext) => `.gpu${ext}`).split('/').pop()}; only *.gpu.ts / *.gpu.js modules are transformed.`;
          result.warnings.push({
            id: 'typegpu-shaders-untransformed',
            pluginName: 'typegpu-shaders',
            text,
            location: { file: key, line: directive.line, column: directive.column - 1, length: 'use gpu'.length + 2, lineText },
            notes: [{ text: note }],
            detail: undefined,
          });
        }
      }
    });
  },
};
