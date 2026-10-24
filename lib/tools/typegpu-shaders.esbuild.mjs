// esbuild plugin for @angular-builders/custom-esbuild `plugins` option.
// Redirects imports of `*.gpu` / `*.gpu.ts` modules into a private namespace and runs
// unplugin-typegpu/babel on them (keeping TS syntax; esbuild strips types afterwards).
//
// Imports are resolved with esbuild's own resolver (`build.resolve`), so tsconfig `paths` / `baseUrl`,
// `./foo.gpu.js` -> `foo.gpu.ts` and `.ts` extension imports behave as in the rest of the app. Only resolved files
// whose name really is `*.gpu.<ext>` are redirected, so one file is one module however it is imported.
// Transform failures are reported as esbuild errors with file, line and column. Set TYPEGPU_SHADERS_LOG=1 to
// log which imports were matched. Needs `@babel/core` and `unplugin-typegpu` installed in the app.
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath } from 'node:path';

const NS = 'typegpu-shader';
const SKIP = Symbol.for('typegpu-shaders.skip');
// Angular's compiler plugin registers onLoad({ filter: /\.[cm]?[jt]sx?$/ }) WITHOUT a namespace, which in
// esbuild matches every namespace and runs first. A virtual path that does not end in a script extension
// avoids it; the real path is recovered in our onLoad.
const SUFFIX = '.typegpu-shader';
const EXTS = ['.ts', '.mts', '.js', '.mjs'];
const GPU_SPECIFIER = /\.gpu(\.[cm]?[jt]s)?$/;
const GPU_FILE = /\.gpu\.[cm]?[jt]s$/;

function findFile(base) {
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  return undefined;
}

let babel;
async function loadBabel() {
  if (babel) return babel;
  const load = async (name) => {
    try {
      return await import(name);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          `[typegpu-shaders] Cannot load "${name}", which the TypeGPU shader plugin needs. ` +
            `Install it in your app: npm i -D @babel/core unplugin-typegpu  (original error: ${error.message})`,
          { cause: error },
        );
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

    build.onResolve({ filter: GPU_SPECIFIER }, async (args) => {
      if (args.pluginData?.[SKIP]) return undefined; // our own build.resolve() call below
      const resolved = await build.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        resolveDir: args.resolveDir,
        namespace: args.namespace === NS ? 'file' : args.namespace,
        with: args.with,
        pluginData: { [SKIP]: true },
      });
      let path;
      if (!resolved.errors.length && !resolved.external && resolved.namespace === 'file') path = resolved.path;
      // fallback: previous behaviour for relative/absolute specifiers esbuild could not resolve (.mts etc.)
      else if (/^(\.|\/)/.test(args.path)) path = findFile(resolvePath(args.resolveDir, args.path));
      log('onResolve', args.path, '->', path ?? 'not a gpu file', `(kind=${args.kind})`);
      if (!path || !GPU_FILE.test(path)) return undefined;
      return { path: path + SUFFIX, namespace: NS, watchFiles: [path] };
    });

    build.onLoad({ filter: /.*/, namespace: NS }, async (args) => {
      const realPath = args.path.slice(0, -SUFFIX.length);
      const code = await readFile(realPath, 'utf8');
      const { transformAsync, typegpuBabel } = await loadBabel(); // cached
      let out;
      try {
        out = await transformAsync(code, {
          filename: realPath,
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
  },
};
