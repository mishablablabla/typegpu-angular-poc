'use strict';
// The wrapper builders: each one makes sure the project's TypeGPU shader modules are built and current (the `typegpu-shaders` tool,
// tools/typegpu-shaders), then runs the OFFICIAL Angular builder for the same target with the same options. Nothing of Angular's
// build is replaced or patched.
//
// Because the shader step is part of the builder, a bare `ng build`, `ng serve` or `ng test` (from a script, an IDE or CI) cannot
// bundle a shader that is older than its source.
//
// How the official builder is run: through the functions `@angular/build` exports for that purpose (`buildApplication`,
// `executeDevServerBuilder`, `executeUnitTestBuilder`, `executeKarmaBuilder`, `executeExtractI18nBuilder`; Angular marks them experimental), with options prepared
// exactly as the CLI prepares them for a builder named `@angular/build:*`: validated against the INSTALLED official schema, with its
// defaults and with undefined OBJECT defaults but no empty-array fillers (the CLI skips those for `@angular/build:` builders only; see
// `getArchitect(isAngularBuild)` in @angular/cli's architect-base-command-module.js, identical in Angular 20, 21 and 22). Going
// through `context.scheduleBuilder` instead would validate again with the array fillers of a third-party builder, which changes how
// the official builders behave (for example `reporters: []` makes `ng test` print nothing). `scheduleBuilder` stays as the fallback
// when the installed @angular/build does not export the function.
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const OWN = '@typegpu-poc/angular';
const TAG = '[typegpu-shaders]';

/**
 * Loads a package this one only borrows from the Angular CLI's own dependency tree. Under pnpm (strict node_modules) it is not
 * visible from here, so it is looked up from this package, from the process folder, and from the folders of the packages that
 * depend on it.
 */
function borrow(name, bases = []) {
  const attempts = [() => require(name)];
  for (const base of [process.cwd(), ...bases]) attempts.push(() => require(createRequire(join(base, 'noop.js')).resolve(name)));
  for (const via of ['@angular/cli', '@angular/build', '@angular-devkit/architect']) {
    attempts.push(() => {
      const manifest = createRequire(join(process.cwd(), 'noop.js')).resolve(`${via}/package.json`);
      return require(createRequire(manifest).resolve(name));
    });
  }
  let last;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`${OWN} needs "${name}" (a dependency of the Angular CLI) but cannot load it: ${last?.message}`);
}

const { createBuilder, targetFromTargetString } = borrow('@angular-devkit/architect');

const loadTool = () => import(pathToFileURL(join(__dirname, '..', 'tools', 'typegpu-shaders', 'index.mjs')).href);
let tool;

/** An Observable (as returned by `BuilderRun.output`) as an async iterator, without importing rxjs. */
function iterate(observable) {
  const queue = [];
  let wake;
  let done = false;
  let failure;
  const subscription = observable.subscribe({
    next: (value) => (queue.push(value), wake?.()),
    error: (error) => ((failure = { error }), (done = true), wake?.()),
    complete: () => ((done = true), wake?.()),
  });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (queue.length) yield queue.shift();
          else if (failure) throw failure.error;
          else if (done) return;
          else await new Promise((resolveWake) => (wake = resolveWake));
        }
      } finally {
        subscription.unsubscribe();
      }
    },
  };
}

/**
 * A logger that forwards to `logger` minus the warning the official builders print because the build target is a wrapper
 * (`The 'buildTarget' is configured to use '@typegpu-poc/angular:application', which is not supported`). A new logger is created and
 * filtered because child loggers of the official builder write to their parent's stream (overriding `warn` would not see them).
 */
function quietLogger(logger) {
  const Logger = logger.constructor;
  const filtered = new Logger(logger.name);
  filtered.subscribe((entry) => {
    if (entry.level === 'warn' && typeof entry.message === 'string' && entry.message.includes(OWN) && /not supported/.test(entry.message)) return;
    logger.next(entry);
  });
  return filtered;
}

/**
 * `src`, `tsconfig` and `out` of the project's shaders, from the workspace (nothing to configure for a standard layout).
 * `buildTarget`: the application build target whose project and tsconfig the shaders follow; by default the `build` target of the
 * project this target belongs to. The extract-i18n builder names its build target itself (`buildTarget`), so it passes that one.
 */
async function shaderOptions(context, buildTarget) {
  const options = { root: context.workspaceRoot };
  const project = buildTarget?.project ?? context.target?.project;
  if (!project) return options;
  const metadata = (await context.getProjectMetadata(project)) ?? {};
  const root = typeof metadata.root === 'string' ? metadata.root : '';
  const sourceRoot = typeof metadata.sourceRoot === 'string' ? metadata.sourceRoot : join(root, 'src');
  if (sourceRoot !== 'src') options.src = sourceRoot;
  // the shader output of a project is `<project root>/shaders-dist` (the workspace root for an application at the root)
  if (root) options.out = join(root, 'shaders-dist');
  try {
    const build = await context.getTargetOptions(buildTarget ?? { project, target: 'build' });
    if (typeof build.tsConfig === 'string' && build.tsConfig !== 'tsconfig.app.json') options.tsconfig = build.tsConfig;
  } catch {
    /* no build target: the tool's default */
  }
  return options;
}

function report(context, result, previous) {
  if (result.empty) return;
  if (result.diagnostics.length) {
    for (const d of result.diagnostics) context.logger.error(`${TAG} ${tool.formatDiagnostic(d)}`);
    context.logger.error(`${TAG} ${result.diagnostics.length} error(s).`);
  } else if (!result.skipped) {
    context.logger.info(`${TAG} ${result.files?.length ?? 0} modules${result.ms !== undefined ? ` (${result.ms} ms)` : ''}${previous && !previous.ok ? ' - recovered' : ''}`);
  }
}

// ---------- the official builder: its schema, its function, its options ----------

/** The installed @angular/build (resolved from the workspace). */
function angularBuild(context) {
  const manifest = createRequire(join(context.workspaceRoot, 'noop.js')).resolve('@angular/build/package.json');
  return { directory: dirname(manifest), exports: require(createRequire(manifest).resolve('@angular/build')) };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The schema of the installed official builder, or undefined (then the options are handed on as they are). */
function installedSchema(directory, stock) {
  const file = join(directory, 'src', 'builders', stock.split(':')[1], 'schema.json');
  return existsSync(file) ? readJson(file) : undefined;
}

const isEmpty = (value) =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(isEmpty)); // `{ statements: [] }` is a filler too

/**
 * Drops the empty values the CLI filled in for this wrapper's schema (a union of three Angular majors, filled like any third-party
 * builder's: arrays and nested objects too). An empty value the project set itself is kept, and so is an option the installed
 * builder does not know but that has a real value (a typo, or an option of another major), so the official builder reports it.
 */
function optionsFor(options, raw) {
  return Object.fromEntries(Object.entries(withoutUndefined(options)).filter(([key, value]) => !(isEmpty(value) && !(key in raw))));
}

/**
 * The CLI's filler leaves keys with the value `undefined` at every depth (`ssr: { entry, platform: undefined, experimentalPlatform:
 * undefined }`); a schema with `additionalProperties: false` counts such a key, so the major that does not know `platform` rejected it.
 */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([key, v]) => [key, withoutUndefined(v)]));
  return value;
}

/** `options` validated against `schema` as the CLI validates a stock builder's options: its defaults and object fillers, no empty-array fillers. */
async function validateAgainst(context, directory, schema, options) {
  const core = borrow('@angular-devkit/core', [dirname(require.resolve('@angular-devkit/architect/package.json', { paths: [process.cwd(), directory] }))]);
  const registry = new core.json.schema.CoreSchemaRegistry();
  registry.addPostTransform(core.json.schema.transforms.addUndefinedObjectDefaults);
  registry.useXDeprecatedProvider((message) => context.logger.warn(message));
  const validate = await registry.compile(schema);
  const { data, success, errors } = await validate(options);
  if (!success) throw new core.json.schema.SchemaValidationException(errors);
  return data;
}

/** The options as the official builder gets them from the CLI. */
async function stockOptions(context, directory, stock, options, raw) {
  const filtered = optionsFor(options, raw);
  const schema = installedSchema(directory, stock);
  // `ng generate web-worker` adds `webWorkerTsConfig` to a test target whose builder is not the stock one; the official unit-test builder
  // does not know it (the build target carries the worker configuration), so the wrapper accepts and drops it
  if (schema && !schema.properties?.webWorkerTsConfig) delete filtered.webWorkerTsConfig;
  return schema ? validateAgainst(context, directory, schema, filtered) : filtered;
}

/** Warns when the installed Angular builder has options that this package's copy of its schema lacks (the CLI would reject them as flags). */
function warnOnSchemaDrift(context, schema, stock, schemaFile) {
  if (!schema) return;
  const ours = Object.keys(readJson(schemaFile).properties ?? {});
  const missing = Object.keys(schema.properties ?? {}).filter((key) => !ours.includes(key));
  if (missing.length) {
    context.logger.warn(`${OWN} knows the options of ${stock} for Angular 20 to 22 only; the installed version also has: ${missing.join(', ')}. They cannot be used as command-line flags until this package is updated (set them in angular.json, which the Angular builder still validates).`);
  }
}

const EXPORTS = {
  '@angular/build:application': 'buildApplication',
  '@angular/build:dev-server': 'executeDevServerBuilder',
  '@angular/build:unit-test': 'executeUnitTestBuilder',
  '@angular/build:karma': 'executeKarmaBuilder',
  '@angular/build:extract-i18n': 'executeExtractI18nBuilder',
};
const STOCK_OF = Object.fromEntries(Object.keys(EXPORTS).map((stock) => [`${OWN}:${stock.split(':')[1]}`, stock]));

/**
 * The context the official builder runs with. Besides the quieter logger it must see the build target the way it would for a stock
 * target: the official dev-server and unit-test builders read the build target's options themselves and validate them against the
 * schema of the builder the target NAMES. That is a wrapper, whose schema the CLI fills like any third-party builder's, with empty
 * arrays; `conditions: []` is truthy, so Angular would drop its default resolve conditions (`module`, `development`/`production`) from
 * the dev-server and test bundles (and only from those). So the builder name is reported as the stock one, and options are validated
 * against the installed official schema with object defaults only, exactly as the CLI does for a stock run.
 */
function officialContext(context, directory) {
  return Object.create(context, {
    logger: { value: quietLogger(context.logger) },
    getBuilderNameForTarget: {
      value: async (target) => {
        const name = await context.getBuilderNameForTarget(target);
        return STOCK_OF[name] ?? name;
      },
    },
    validateOptions: {
      value: async (options, builderName) => {
        const stock = STOCK_OF[builderName] ?? builderName;
        const schema = typeof stock === 'string' && stock.startsWith('@angular/build:') ? installedSchema(directory, stock) : undefined;
        return schema ? validateAgainst(context, directory, schema, options) : context.validateOptions(options, builderName);
      },
    },
  });
}

/** Runs the official builder; the result is an async iterable of its outputs. */
async function runStock(context, exported, stock, forStock, wrapperContext) {
  const execute = exported[EXPORTS[stock]];
  if (typeof execute === 'function') return asIterable(await execute(forStock, wrapperContext));
  // fallback: an @angular/build that does not export the function: the documented way, with its validation (and array fillers)
  context.logger.warn(
    `${TAG} the installed @angular/build does not export ${EXPORTS[stock]}; running ${stock} through the Angular Architect instead. Its options are then validated with empty-array defaults, which can change the behaviour of the official builder (for example, no test output). Please report this.`,
  );
  const run = await context.scheduleBuilder(stock, forStock, { target: context.target, logger: wrapperContext.logger });
  context.addTeardown(() => run.stop());
  return iterate(run.output);
}

/** The outputs of the official builder as an async iterable, whatever it returned (Angular documents an AsyncIterable; an Observable or a Promise are tolerated). */
function asIterable(result) {
  if (result && typeof result[Symbol.asyncIterator] === 'function') return result;
  if (result && typeof result.subscribe === 'function') return iterate(result);
  return (async function* () {
    const value = await result;
    if (value && typeof value[Symbol.asyncIterator] === 'function') yield* value;
    else if (value !== undefined) yield value;
  })();
}

// ---------- after the build ----------

/** Where the application build writes its JavaScript: `outputPath` as a string or `{ base, browser, server }`, the SSR server bundle when there is one. */
function outputDirectories(context, options) {
  const outputPath = options.outputPath;
  let base = `dist/${context.target?.project ?? ''}`;
  let browser = 'browser';
  let server = 'server';
  if (typeof outputPath === 'string') base = outputPath;
  else if (outputPath && typeof outputPath === 'object') {
    if (typeof outputPath.base === 'string') base = outputPath.base;
    if (typeof outputPath.browser === 'string') browser = outputPath.browser;
    if (typeof outputPath.server === 'string') server = outputPath.server;
  }
  const dir = (leaf) => resolve(context.workspaceRoot, base, leaf);
  const dirs = [dir(browser)];
  if (typeof options.server === 'string' && options.server !== '') dirs.push(dir(server));
  return dirs.filter((path) => existsSync(path));
}

/**
 * After a successful build: no `'use gpu'` directive in the bundle may be untransformed (the shipped checker, tools/check-shader-bundle.mjs).
 * The shader build and the import checks make that impossible in the supported setup; this catches the case where something else went wrong.
 * @returns {string | undefined} what the checker printed, when it found something
 */
function bundleProblem(context, options) {
  const dirs = outputDirectories(context, options);
  if (!dirs.length) {
    // not silent: a check that finds nothing to check proves nothing
    context.logger.warn(`${TAG} the build output was not found where this build writes it, so it was not checked for untransformed shader code. Run: typegpu-check-bundle <output directory>`);
    return undefined;
  }
  try {
    execFileSync(process.execPath, [join(__dirname, '..', 'tools', 'check-shader-bundle.mjs'), '--allow-empty', ...dirs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return undefined;
  } catch (error) {
    return String(error.stderr || error.stdout || error.message).trim();
  }
}

/**
 * Whether the terminal is interactive, as `@angular/build` decides it (src/utils/tty.js, identical in Angular 20, 21 and 22): the
 * official unit-test builder watches by default only then, and runs once in CI, in a pipe or with `NG_FORCE_TTY=false`.
 */
function isTTY() {
  const force = process.env['NG_FORCE_TTY'];
  if (force !== undefined) return force !== '0' && force.toUpperCase() !== 'FALSE';
  const ci = process.env['CI'];
  return !!process.stdout.isTTY && !(ci !== undefined && ci !== '0' && ci.toUpperCase() !== 'FALSE');
}

/**
 * @param {{ stock: string, schema: string, kind: 'build' | 'serve' | 'test' | 'extract-i18n', watching: (options: object) => boolean }} spec
 *   `stock`: the official builder to run; `watching`: whether this run keeps going and should rebuild shaders on change. It must agree
 *   with the official builder's own decision: a run that the official builder ends after one build must not be watched (a shader error
 *   would then show as a stub in the output instead of failing the command).
 */
function wrap({ stock, schema, kind, watching }) {
  return createBuilder(async function* (options, context) {
    // A stop (Ctrl-C, `run.stop()`) only runs the teardowns registered so far and then ends the run: whatever is started later would
    // never be told to stop. So the teardown is registered first, and nothing is started once it has run.
    let cancelled = false;
    let watcher;
    context.addTeardown(() => {
      cancelled = true;
      watcher?.close();
    });
    tool = await loadTool();
    // `ng extract-i18n` bundles the application itself (the official builder does not schedule the application target, so the
    // application wrapper never runs): the shader step is this one, for the project and tsconfig of the build target it names
    // (`buildTarget`, default: this project's `build` target, as for the official builder).
    const buildTarget = kind === 'extract-i18n' && context.target ? targetFromTargetString(options.buildTarget || ':', context.target.project, 'build') : undefined;
    const config = await shaderOptions(context, buildTarget);
    const official = angularBuild(context);
    const officialSchema = installedSchema(official.directory, stock);
    // what the project itself sets for this target (angular.json options and the chosen configuration)
    const raw = context.target ? await context.getTargetOptions(context.target) : {};
    warnOnSchemaDrift(context, officialSchema, stock, resolve(__dirname, 'schemas', schema));
    if (cancelled) return;

    let shadersActive = false;
    try {
      // The shader phase reports its own failures (a folder that cannot be written, a dependency of the tool that is missing) as a failed run
      // with the tool's name on it, instead of the CLI's "An unhandled exception occurred". The official builder's own failures are not touched.
      let failure;
      try {
        if (watching(options)) {
          // Development: rebuild on every change; a shader that fails shows its error in the page and recovers when it is fixed.
          watcher = tool.watchEnsure(config, {
            onBuild: (result, previous) => report(context, result, previous),
            onImports: (problems) => problems.forEach((d) => context.logger.error(`${TAG} ${tool.formatDiagnostic(d)}`)),
          });
          await watcher.ready;
        } else {
          const result = await tool.ensureShaders(config);
          report(context, result);
          shadersActive = result.skipped !== 'empty';
          if (!result.ok) {
            const importsOnly = result.diagnostics.length > 0 && result.diagnostics.every((d) => d.source === 'import');
            failure = `${TAG} ${importsOnly ? 'a shader module is imported in a way that cannot work' : 'the shader build failed'}; ${kind === 'extract-i18n' ? 'no messages were extracted' : 'the application was not built'} (see the errors above).`;
          }
        }
      } catch (error) {
        const where = ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? ` (a folder of the shader step is not writable: ${error.code})` : '';
        failure = `${TAG} the shader step failed${where}: ${error?.message ?? error}`;
      }
      if (failure) {
        yield { success: false, error: failure };
        return;
      }
      if (cancelled) return;

      const forStock = await stockOptions(context, official.directory, stock, options, raw);
      const outputs = await runStock(context, official.exports, stock, forStock, officialContext(context, official.directory));

      // A finished (not watching) application build is checked once more: no untransformed shader may be in the output. Only then is an
      // output held back (to be the last); a server or a watch must pass every output on at once (`ng e2e` waits for the first one).
      const checkBundle = kind === 'build' && !watching(options) && shadersActive;
      if (!checkBundle) {
        yield* outputs;
        return;
      }
      let held;
      for await (const output of outputs) {
        if (held) yield held;
        held = output;
      }
      if (held) {
        const problem = held.success ? bundleProblem(context, options) : undefined;
        if (problem) {
          context.logger.error(`${TAG} ${problem}`);
          yield { ...held, success: false, error: `${TAG} the build contains shader code that was not transformed (see above).` };
        } else yield held;
      }
    } finally {
      // also when the official builder ends by itself or fails: the watcher must not outlive the run
      watcher?.close();
    }
  });
}

module.exports = { wrap, isTTY, iterate, quietLogger, shaderOptions, optionsFor, targetFromTargetString };
