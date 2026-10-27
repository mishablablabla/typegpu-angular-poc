// The wrapper builders (builders/*.cjs) run by Angular's own Architect, with a fake "official" builder registered under the real name,
// so the order of events, the options handed on and the failure behaviour are observed exactly as the CLI would produce them.
import { Architect, createBuilder, type Builder } from '@angular-devkit/architect';
import { TestingArchitectHost } from '@angular-devkit/architect/testing';
import { logging, schema } from '@angular-devkit/core';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAD_SHADER, createProject, link, posix, SHADER, tsconfigWith, waitFor, type Project } from '../tools/typegpu-shaders/project';

const BUILDERS = join(__dirname, '..', '..', '..', 'builders');
const FIXTURES = join(__dirname, '..', 'fixtures', 'angular-build');
const load = (name: string): Builder => require(join(BUILDERS, `${name}.cjs`)) as Builder;
const stockSchema = (name: string) => JSON.parse(readFileSync(join(BUILDERS, 'schemas', `${name}.json`), 'utf8'));
const OWN = '@typegpu-poc/angular';

interface Call {
  /** Which official builder function was run. */
  builder: string;
  options: Record<string, any>;
  /** What the shader output looked like at the moment the official builder started. */
  manifest: boolean;
  wave: boolean;
}

let project: Project;
let calls: Call[];
let logs: { level: string; message: string }[];
let host: TestingArchitectHost;
let architect: Architect;
/** What the fake official builder does after recording the call. */
/** Lets a test park the wrapper inside its first asynchronous step (reading the project's metadata). */
let metadataGate: Promise<void> | undefined;
let metadataEntered = false;
let stockBehavior: (options: Record<string, any>, context: any) => AsyncGenerator<any> | Promise<any>;

/**
 * A stand-in for the project's `@angular/build`: the real option schemas (Angular 22.2.4), and the four functions the wrappers call,
 * which record the call and run `stockBehavior`. The rest of the project's node_modules is the package's own.
 */
function installFakeAngularBuild(exportsToSkip: string[] = []) {
  const modules = project.path('node_modules');
  rmSync(modules); // the symlink the helper made
  mkdirSync(join(modules, '@angular'), { recursive: true });
  const lib = join(__dirname, '..', '..', '..', 'node_modules');
  for (const entry of readdirSync(lib)) if (entry !== '@angular' && !entry.startsWith('.')) link(join(lib, entry), join(modules, entry));
  for (const entry of readdirSync(join(lib, '@angular'))) link(join(lib, '@angular', entry), join(modules, '@angular', entry));
  const build = join(modules, '@angular', 'build');
  for (const name of ['application', 'dev-server', 'unit-test', 'karma', 'extract-i18n']) {
    mkdirSync(join(build, 'src', 'builders', name), { recursive: true });
    copyFileSync(join(FIXTURES, `${name}.schema.json`), join(build, 'src', 'builders', name, 'schema.json'));
  }
  writeFileSync(join(build, 'package.json'), JSON.stringify({ name: '@angular/build', version: '22.2.4', main: 'src/index.js' }));
  const exported = { buildApplication: 'application', executeDevServerBuilder: 'dev-server', executeUnitTestBuilder: 'unit-test', executeKarmaBuilder: 'karma', executeExtractI18nBuilder: 'extract-i18n' } as Record<string, string>;
  const lines = Object.entries(exported)
    .filter(([fn]) => !exportsToSkip.includes(fn))
    .map(([fn, name]) => `exports.${fn} = (options, context) => globalThis.__shape(globalThis.__stock('${name}', options, context));`);
  writeFileSync(join(build, 'src', 'index.js'), lines.join('\n') + '\n');
  (globalThis as any).__shape = (outputs: unknown) => outputs; // what the official function returns: an AsyncIterable (as documented)
  (globalThis as any).__stock = async function* (builder: string, options: Record<string, any>, context: any) {
    calls.push({ builder, options, manifest: existsSync(project.path('shaders-dist/.manifest.json')), wave: existsSync(project.path('shaders-dist/wave.gpu.js')) });
    yield* (await stockBehavior(options, context)) as AsyncGenerator<any>;
  };
}

/** Registers a wrapper (and a scheduleBuilder-reachable fake official builder, for the fallback path). */
function setup(wrapper: string, stock: string, stockSchemaName: string, projectMetadata: Record<string, unknown> = { root: '', sourceRoot: 'src' }, exportsToSkip: string[] = []) {
  installFakeAngularBuild(exportsToSkip);
  host = new TestingArchitectHost(project.root, project.root, {
      getProjectMetadata: async () => {
        metadataEntered = true;
        await metadataGate;
        return projectMetadata;
      },
    } as never);
  host.addBuilder(`${OWN}:${wrapper}`, load(wrapper), 'wrapper', stockSchema(stockSchemaName));
  const fake = createBuilder(async function* (options: Record<string, any>, context: any) {
    calls.push({ builder: `scheduled:${stock}`, options, manifest: existsSync(project.path('shaders-dist/.manifest.json')), wave: existsSync(project.path('shaders-dist/wave.gpu.js')) });
    yield* (await stockBehavior(options, context)) as AsyncGenerator<any>;
  });
  host.addBuilder(stock, fake as Builder, 'fake official builder', JSON.parse(readFileSync(join(FIXTURES, `${stockSchemaName}.schema.json`), 'utf8')));
  host.addTarget({ project: 'app', target: 'build' }, `${OWN}:application`, { tsConfig: 'tsconfig.app.json' });
  architect = newArchitect();
}

function newArchitect() {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults); // what the CLI does for a third-party builder: every property without a value gets an empty one
  return new Architect(host, registry);
}

async function run(target: string, options: Record<string, unknown> = {}) {
  const logger = new logging.Logger('test');
  logger.subscribe((entry) => logs.push({ level: entry.level, message: entry.message }));
  host.addTarget({ project: 'app', target }, `${OWN}:${{ build: 'application', serve: 'dev-server', test: 'unit-test', 'extract-i18n': 'extract-i18n' }[target]}`, options as never);
  const scheduled = await architect.scheduleTarget({ project: 'app', target }, {}, { logger });
  // `result` is the FIRST output; `finished` settles when the run is over (the official builder ended or the run was stopped)
  const finished = new Promise<void>((resolve) => scheduled.output.subscribe({ complete: () => resolve(), error: () => resolve() }));
  return { scheduled, result: await scheduled.result, finished };
}

const ok = async function* () {
  yield { success: true };
};

beforeEach(() => {
  project = createProject();
  calls = [];
  logs = [];
  metadataGate = undefined;
  metadataEntered = false;
  stockBehavior = ok;
});
afterEach(() => project.dispose());

describe('application wrapper: the shaders are current before the official builder runs', () => {
  it('builds missing shader output first, then runs the official builder with the same options', async () => {
    setup('application', '@angular/build:application', 'application');
    expect(project.exists('shaders-dist')).toBe(false);
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json', outputHashing: 'all' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ manifest: true, wave: true }); // already there when the official builder started
    expect(calls[0]!.options).toMatchObject({ tsConfig: 'tsconfig.app.json', outputHashing: 'all' });
  });

  it('rebuilds a shader edited since the last build (a stale output is never handed on)', async () => {
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.cos(x)');
    expect(calls).toHaveLength(2);
  });

  it('skips the build when the output is current (fast path), and still runs the official builder', async () => {
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    const before = statSync(project.path('shaders-dist/.manifest.json')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    logs.length = 0;
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(statSync(project.path('shaders-dist/.manifest.json')).mtimeMs).toBe(before);
    expect(logs.some((l) => l.message.includes('modules'))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('a shader that cannot be transformed fails the build with its file and the candidate lines, and the official builder never runs', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('the shader build failed');
    expect(calls).toHaveLength(0);
    const text = logs.map((l) => l.message).join('\n');
    expect(posix(text)).toContain('src/wave.gpu.ts');
    expect(text).toContain('TryStatement');
    expect(text).toMatch(/directives at line/);
  });

  it('a syntax error and a type error fail it the same way, with line and column', async () => {
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = ;\n');
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(posix(logs.map((l) => l.message).join('\n'))).toMatch(/src\/model\.ts:2:\d+ - error/);
    expect(calls).toHaveLength(0);
  });

  it('refuses to build when application code imports a shader module by a relative path (it would bundle the raw source), even when the output is current', async () => {
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    calls.length = 0;
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(logs.map((l) => l.message).join('\n')).toContain("Import '@shaders/wave.gpu' instead");
    expect(calls).toHaveLength(0);
  });

  it('refuses to build when a shader module is imported through a tsconfig paths alias, before the official builder (and its bundling) runs, with the import that works', async () => {
    project.write('tsconfig.app.json', tsconfigWith({ paths: { '@app/*': ['./src/app/*'], '@shaders/*': ['./shaders-dist/*'] } }));
    project.write('src/app/canvas.gpu.ts', SHADER.replace("'./model'", "'../model'"));
    project.write('src/app/canvas.ts', `import { wave } from '@app/canvas.gpu';\nexport const x = wave;\n`);
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('imported in a way that cannot work');
    const text = posix(logs.map((l) => l.message).join('\n'));
    expect(text).toContain("'@app/canvas.gpu'");
    expect(text).toContain("Import '@shaders/app/canvas.gpu' instead");
    expect(calls).toHaveLength(0); // the official builder, which bundles, never started
  });

  it('an @shaders import that matches nothing fails the build before Angular reports an unresolved module', async () => {
    project.write('src/app/typo.ts', `import { wave } from '@shaders/wave.gpuu';\nexport const x = wave;\n`);
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(logs.map((l) => l.message).join('\n')).toContain("'@shaders/wave.gpuu' does not match a generated shader module");
  });

  it('a project without shader modules builds as before and nothing is written', async () => {
    project.remove('src/wave.gpu.ts');
    project.write('src/app/main.ts', 'export const used = 1;\n'); // an application that imports no `@shaders/...` module (one that does fails: see ownership.spec)
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(project.exists('shaders-dist')).toBe(false);
  });

  it('a build that bundled an untransformed shader fails even though the official builder succeeded', async () => {
    stockBehavior = async function* () {
      mkdirSync(project.path('dist/app/browser'), { recursive: true });
      writeFileSync(project.path('dist/app/browser/main.js'), "const f = (x) => { 'use gpu'; return x; };\n");
      yield { success: true };
    };
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json', outputPath: 'dist/app' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not transformed');
    expect(logs.map((l) => l.message).join('\n')).toContain('main.js');
  });

  it('says so when it cannot find the build output to check (a check that looks at nothing proves nothing)', async () => {
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json', outputPath: 'dist/nowhere' });
    expect(result.success).toBe(true);
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message).join('\n')).toContain('was not found where this build writes it');
  });

  it('an SSR project has its server directory checked too', async () => {
    stockBehavior = async function* () {
      mkdirSync(project.path('dist/app/browser'), { recursive: true });
      mkdirSync(project.path('dist/app/server'), { recursive: true });
      writeFileSync(project.path('dist/app/browser/main.js'), 'export const a = 1;\n');
      writeFileSync(project.path('dist/app/server/main.server.mjs'), "const f = (x) => { 'use gpu'; return x; };\n");
      yield { success: true };
    };
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json', outputPath: 'dist/app', server: 'src/main.server.ts' });
    expect(result.success).toBe(false);
  });

  it('a clean bundle passes the check (and without a `server` option only the browser directory is looked at)', async () => {
    stockBehavior = async function* () {
      mkdirSync(project.path('dist/app/browser'), { recursive: true });
      mkdirSync(project.path('dist/app/server'), { recursive: true });
      writeFileSync(project.path('dist/app/browser/main.js'), 'export const a = 1;\n');
      writeFileSync(project.path('dist/app/server/main.server.mjs'), "const f = (x) => { 'use gpu'; return x; };\n");
      yield { success: true };
    };
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json', outputPath: 'dist/app' });
    expect(result.success).toBe(true);
  });

  it('the failure of the official builder is passed on untouched', async () => {
    stockBehavior = async function* () {
      yield { success: false, error: 'esbuild said no' };
    };
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result).toMatchObject({ success: false, error: 'esbuild said no' });
  });
});

describe('the official builder and the options it is given', () => {
  it('runs the function @angular/build exports for it (not a second validation by Architect)', async () => {
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(calls.map((c) => c.builder)).toEqual(['application']);
  });

  it('hands over exactly what the CLI hands an official unit-test builder: its defaults and object fillers, and NO empty-array fillers (reporters: [] would silence the test output)', async () => {
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    await run('test', { tsConfig: 'tsconfig.spec.json', watch: false });
    // the options a real `ng test` (Angular 22.2.4, stock builder) was observed to receive, plus the tsConfig set here
    expect(calls[0]!.options).toEqual({
      tsConfig: 'tsconfig.spec.json',
      watch: false,
      runner: 'vitest',
      runnerConfig: false,
      include: ['**/*.spec.ts', '**/*.test.ts'],
      debug: false,
      splitting: true,
      coverageThresholds: {},
      coverageWatermarks: {},
      listTests: false,
      dumpVirtualFiles: false,
    });
  });

  it('keeps what the project set itself, also an empty list', async () => {
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    await run('test', { tsConfig: 'tsconfig.spec.json', watch: false, include: [], reporters: ['verbose'] });
    expect(calls[0]!.options).toMatchObject({ include: [], reporters: ['verbose'] });
  });

  it('accepts `webWorkerTsConfig` on the test target (`ng generate web-worker` adds it) and does not hand it to the official unit-test builder, which rejects it', async () => {
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    const { result } = await run('test', { tsConfig: 'tsconfig.spec.json', watch: false, webWorkerTsConfig: 'tsconfig.worker.json' });
    expect(result.success).toBe(true);
    expect(calls[0]!.options).not.toHaveProperty('webWorkerTsConfig');
    expect(calls[0]!.options).toMatchObject({ tsConfig: 'tsconfig.spec.json' });
  });

  it('an option no schema knows is rejected before anything runs, as for the official builder', async () => {
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    await expect(run('test', { tsConfig: 'tsconfig.spec.json', watch: false, notAnOption: 'x' })).rejects.toThrow(/notAnOption|additional/i);
    expect(calls).toHaveLength(0);
  });

  it('an invalid option fails the run with the official builder\'s own schema error', async () => {
    setup('application', '@angular/build:application', 'application');
    const { scheduled } = await run('build', { tsConfig: 'tsconfig.app.json', outputHashing: 'sometimes' }).catch((error: Error) => ({ scheduled: undefined, result: error }));
    expect(scheduled).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('the official builder receives the target of the project (it needs the project name)', async () => {
    let seen: any;
    stockBehavior = async function* (_options, context) {
      seen = context.target;
      yield { success: true };
    };
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(seen).toMatchObject({ project: 'app', target: 'build' });
  });

  it('drops the warning the official unit-test builder prints because the build target is a wrapper, and only that', async () => {
    stockBehavior = async function* (_options, context) {
      context.logger.warn(`The 'buildTarget' is configured to use '${OWN}:application', which is not supported. Unexpected behavior.`);
      context.logger.createChild('child').warn('Something else worth reading.');
      yield { success: true };
    };
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    await run('test', { tsConfig: 'tsconfig.spec.json', watch: false });
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual(['Something else worth reading.']);
  });

  it('falls back to Architect (scheduleBuilder) when the installed @angular/build does not export the function', async () => {
    setup('application', '@angular/build:application', 'application', { root: '', sourceRoot: 'src' }, ['buildApplication']);
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.builder)).toEqual(['scheduled:@angular/build:application']);
  });

  it('says so when it has to fall back to Architect: the official builder then gets empty-array defaults, which can change its behaviour', async () => {
    setup('application', '@angular/build:application', 'application', { root: '', sourceRoot: 'src' }, ['buildApplication']);
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message).join('\n')).toMatch(/does not export buildApplication.*Architect/);
  });

  it.each([
    ['an Observable', (outputs: AsyncIterable<unknown>) => require('rxjs').from(outputs)],
    ['a Promise of the outputs', (outputs: AsyncIterable<unknown>) => Promise.resolve(outputs)],
  ])('copes with an official function that returns %s instead of an AsyncIterable', async (_name, shape) => {
    setup('application', '@angular/build:application', 'application');
    (globalThis as any).__shape = shape;
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(true);
  });

  it('works without @angular/build in the workspace? no: it says what is missing instead of failing obscurely', async () => {
    setup('application', '@angular/build:application', 'application');
    rmSync(project.path('node_modules/@angular/build'), { recursive: true });
    await expect(run('build', { tsConfig: 'tsconfig.app.json' })).rejects.toThrow(/@angular\/build/);
  });
});

describe('dev-server wrapper: shaders are rebuilt while the server runs', () => {
  /** An official dev server that stays up until the test lets it end. */
  function serverThatStays() {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    return stop;
  }

  it('builds first, keeps rebuilding on every edit, shows a failing shader as a stub, recovers, and stops watching when the server ends', async () => {
    const stop = serverThatStays();
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build:development' });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    expect(calls[0]).toMatchObject({ manifest: true, wave: true });

    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');

    // Wait for what is asserted, the log, not for the file: the output can change before the build is reported (esbuild wrote it in
    // its own process, and the report waits for the declarations; with the earlier tool that gap was 100 to 260 ms in one rebuild of ten,
    // which made this test fail now and then).
    project.write('src/wave.gpu.ts', BAD_SHADER);
    await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('typegpu-shaders-error'), 'the stub');
    await waitFor(() => logs.some((l) => l.message.includes('TryStatement')), 'the error report');

    project.write('src/wave.gpu.ts', SHADER);
    await waitFor(() => !project.read('shaders-dist/wave.gpu.js').includes('typegpu-shaders-error'), 'recovery');
    await waitFor(() => logs.some((l) => l.message.includes('recovered')), 'the recovery report');

    stop();
    const { result, finished } = await running;
    expect(result.success).toBe(true);
    await finished;
    // the watcher is closed with the server: a later edit is not built, and the stub of an unfixed shader would have been removed
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.tan(x) * SCALE'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('std.tan(x)');
  });

  it('starts the dev server even when the first build fails (the page shows the error), and removes the stub when the session ends', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const stop = serverThatStays();
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build:development' });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error');
    stop();
    await (await running).finished;
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false); // a bare ng build afterwards must fail, not bundle the stub
  });

  it('picks up the first shader of a project that had none', async () => {
    project.remove('src/wave.gpu.ts');
    const stop = serverThatStays();
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build:development' });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    expect(project.exists('shaders-dist')).toBe(false);
    project.write('src/wave.gpu.ts', SHADER);
    await waitFor(() => project.exists('shaders-dist/wave.gpu.js'), 'the new shader');
    stop();
    await (await running).finished;
  });
});

describe('the dev server and a relative import of a shader module', () => {
  it('says so in the terminal (the official builder would silently bundle the raw, untransformed source)', async () => {
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build' });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    expect(logs.filter((l) => l.level === 'error').map((l) => l.message).join('\n')).toContain("Import '@shaders/wave.gpu' instead");
    stop();
    await (await running).finished;
  });
});

describe('the dev server and a shader module imported through a tsconfig paths alias', () => {
  it('says so in the terminal (nothing else would: the page just has no canvas)', async () => {
    project.write('tsconfig.app.json', tsconfigWith({ paths: { '@app/*': ['./src/app/*'], '@shaders/*': ['./shaders-dist/*'] } }));
    project.write('src/app/canvas.gpu.ts', SHADER.replace("'./model'", "'../model'"));
    project.write('src/app/canvas.ts', `import { wave } from '@app/canvas.gpu';\nexport const x = wave;\n`);
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build' });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    const errors = posix(logs.filter((l) => l.level === 'error').map((l) => l.message).join('\n'));
    expect(errors).toContain("'@app/canvas.gpu'");
    expect(errors).toContain("Import '@shaders/app/canvas.gpu' instead");
    stop();
    await (await running).finished;
  });
});

describe('which runs keep the shaders rebuilt', () => {
  /** An official builder that stays up until `stop()`; returns it. */
  function staysUp() {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    return stop;
  }
  const edited = (marker: string) => SHADER.replace('std.sin(x) * SCALE', `std.${marker}(x) * SCALE`);

  it('`ng build --watch` rebuilds on every edit, like the dev server; a build without --watch does not watch', async () => {
    const stop = staysUp();
    setup('application', '@angular/build:application', 'application');
    const running = run('build', { tsConfig: 'tsconfig.app.json', watch: true });
    await waitFor(() => calls.length === 1, 'the build to start');
    project.write('src/wave.gpu.ts', edited('cos'));
    await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');
    stop();
    await (await running).finished;
  });

  it('an application build that is not watching leaves the output alone while it runs', async () => {
    const stop = staysUp();
    setup('application', '@angular/build:application', 'application');
    const running = run('build', { tsConfig: 'tsconfig.app.json', watch: false });
    await waitFor(() => calls.length === 1, 'the build to start');
    project.write('src/wave.gpu.ts', edited('cos'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('std.cos(x)');
    stop();
    await (await running).finished;
  });

  it('tests watch the shaders in an interactive terminal unless --watch=false, and with --watch (the official builder decides whether the test run itself watches)', async () => {
    const previous = process.env['NG_FORCE_TTY'];
    process.env['NG_FORCE_TTY'] = 'true';
    try {
      const stop = staysUp();
      setup('unit-test', '@angular/build:unit-test', 'unit-test');
      const running = run('test', { tsConfig: 'tsconfig.spec.json' });
      await waitFor(() => calls.length === 1, 'the tests to start');
      project.write('src/wave.gpu.ts', edited('cos'));
      await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');
      stop();
      await (await running).finished;
    } finally {
      if (previous === undefined) delete process.env['NG_FORCE_TTY'];
      else process.env['NG_FORCE_TTY'] = previous;
    }
  });

  it('`--watch` watches even when the terminal is not interactive (CI)', async () => {
    const previous = process.env['NG_FORCE_TTY'];
    process.env['NG_FORCE_TTY'] = 'false';
    try {
      const stop = staysUp();
      setup('unit-test', '@angular/build:unit-test', 'unit-test');
      const running = run('test', { tsConfig: 'tsconfig.spec.json', watch: true });
      await waitFor(() => calls.length === 1, 'the tests to start');
      project.write('src/wave.gpu.ts', edited('cos'));
      await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');
      stop();
      await (await running).finished;
    } finally {
      if (previous === undefined) delete process.env['NG_FORCE_TTY'];
      else process.env['NG_FORCE_TTY'] = previous;
    }
  });

  it('`--watch=false` tests do not watch', async () => {
    const stop = staysUp();
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    const running = run('test', { tsConfig: 'tsconfig.spec.json', watch: false });
    await waitFor(() => calls.length === 1, 'the tests to start');
    project.write('src/wave.gpu.ts', edited('cos'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('std.cos(x)');
    stop();
    await (await running).finished;
  });
});

describe('dev-server --no-watch', () => {
  it('serves one build: the shaders are built once, not watched, and a failing shader fails the command', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const running = run('serve', { buildTarget: 'app:build', watch: false });
    await waitFor(() => calls.length === 1, 'the dev server to start');
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('std.cos(x)');
    stop();
    await (await running).finished;
    calls.length = 0;
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const failed = await run('serve', { buildTarget: 'app:build', watch: false });
    expect(failed.result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('what the message says', () => {
  it('an import that cannot work is not reported as a failed shader build', async () => {
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('imported in a way that cannot work');
    expect(result.error).not.toContain('the shader build failed');
  });
});

describe('a failing shader step is a failed run with a message of its own (L3/E8), not the CLI\'s "An unhandled exception occurred"', () => {
  it('a shader output location that cannot be written (a file where the folder must be) ends the run with the tool\'s name and the reason, and the official builder never runs', async () => {
    project.write('shaders-dist', 'not a folder'); // the build cannot create its output here: ENOTDIR/EEXIST on every platform and for every user (chmod would not bind root or Windows)
    setup('application', '@angular/build:application', 'application');
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^\[typegpu-shaders\] the shader step failed/);
    expect(result.error).toMatch(/ENOTDIR|EEXIST|not a directory/i);
    expect(calls).toHaveLength(0);
  });

  it('a dependency of the tool that is missing (esbuild) says so', async () => {
    setup('application', '@angular/build:application', 'application');
    rmSync(project.path('node_modules', 'esbuild')); // the project\'s own copy: the tool needs it to bundle the shader modules
    const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('[typegpu-shaders] the shader step failed');
    expect(result.error).toMatch(/esbuild/);
    expect(calls).toHaveLength(0);
  });

  it('a read-only output folder is named as not writable (skipped where the file system does not enforce it: Windows, root)', async (context) => {
    setup('application', '@angular/build:application', 'application');
    mkdirSync(project.path('shaders-dist'));
    chmodSync(project.path('shaders-dist'), 0o555);
    try {
      writeFileSync(project.path('shaders-dist', 'probe'), '');
      context.skip(); // the write worked: this user or platform ignores the mode
    } catch {
      /* enforced */
    }
    try {
      const { result } = await run('build', { tsConfig: 'tsconfig.app.json' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('the shader step failed');
      expect(result.error).toMatch(/EACCES|EPERM/);
    } finally {
      chmodSync(project.path('shaders-dist'), 0o755);
    }
    expect(calls).toHaveLength(0);
  });

  it('the failure of the official builder is still passed on as it is (the shader step did not fail)', async () => {
    stockBehavior = async function* () {
      throw new Error('esbuild exploded');
    };
    setup('application', '@angular/build:application', 'application');
    const { result, finished } = await run('build', { tsConfig: 'tsconfig.app.json' }).catch((error) => ({ result: { success: false, error: String(error?.message ?? error) }, finished: Promise.resolve() }));
    await finished;
    expect(result.success).toBe(false);
    expect(String(result.error ?? '')).not.toContain('the shader step failed');
  });
});

describe('karma wrapper (no behavioural test existed: lane D mutants that ran the wrong stock builder survived)', () => {
  const karma = (options: Record<string, unknown>) => {
    host.addTarget({ project: 'app', target: 'test' }, `${OWN}:karma`, options as never);
    return architect.scheduleTarget({ project: 'app', target: 'test' }, {}, { logger: Object.assign(new logging.Logger('karma'), {}) });
  };

  it('runs the official karma builder after a one-shot shader build, and a failing shader fails the run before it starts', async () => {
    setup('karma', '@angular/build:karma', 'karma');
    const run1 = await karma({ tsConfig: 'tsconfig.spec.json', watch: false });
    expect((await run1.result).success).toBe(true);
    expect(calls.map((c) => c.builder)).toEqual(['karma']);
    expect(calls[0]).toMatchObject({ manifest: true, wave: true });
    project.write('src/wave.gpu.ts', BAD_SHADER);
    calls.length = 0;
    const run2 = await karma({ tsConfig: 'tsconfig.spec.json', watch: false });
    expect((await run2.result).success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('karma watches by default (its own default is watch: true), and --watch=false does not', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true };
      await stopped;
    };
    setup('karma', '@angular/build:karma', 'karma');
    const watching = await karma({ tsConfig: 'tsconfig.spec.json' });
    await waitFor(() => calls.length === 1, 'karma to start');
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');
    stop();
    await watching.result;
  });
});

describe('the drift warning: the installed Angular builder has options this package\'s schema copy lacks', () => {
  it('names them and says how to set them', async () => {
    setup('application', '@angular/build:application', 'application');
    const schemaFile = project.path('node_modules/@angular/build/src/builders/application/schema.json');
    const installed = JSON.parse(readFileSync(schemaFile, 'utf8'));
    installed.properties.brandNewOption = { type: 'string' };
    writeFileSync(schemaFile, JSON.stringify(installed));
    await run('build', { tsConfig: 'tsconfig.app.json' });
    const warning = logs.filter((l) => l.level === 'warn').map((l) => l.message).join('\n');
    expect(warning).toContain('brandNewOption');
    expect(warning).toContain('angular.json');
  });

  it('is silent when the installed builder has nothing new', async () => {
    setup('application', '@angular/build:application', 'application');
    await run('build', { tsConfig: 'tsconfig.app.json' });
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message).join('\n')).not.toContain('knows the options');
  });
});

describe('isTTY follows @angular/build (src/utils/tty.js)', () => {
  const { isTTY } = require(join(BUILDERS, 'delegate.cjs')) as { isTTY: () => boolean };
  const saved = { force: process.env['NG_FORCE_TTY'], ci: process.env['CI'], tty: process.stdout.isTTY };
  const set = (force: string | undefined, ci: string | undefined, tty: boolean) => {
    for (const [key, value] of [['NG_FORCE_TTY', force], ['CI', ci]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value);
    Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  };
  afterEach(() => set(saved.force, saved.ci, !!saved.tty));

  it.each([
    [undefined, undefined, true, true],
    [undefined, undefined, false, false],
    [undefined, 'true', true, false],
    [undefined, '1', true, false],
    [undefined, '0', true, true],
    [undefined, 'false', true, true],
    ['true', 'true', false, true],
    ['1', undefined, false, true],
    ['false', undefined, true, false],
    ['0', undefined, true, false],
  ])('NG_FORCE_TTY=%s CI=%s stdout.isTTY=%s -> %s', (force, ci, tty, expected) => {
    set(force, ci, tty);
    expect(isTTY()).toBe(expected);
  });
});

describe('where the bundle scan looks', () => {
  const dirtyBuild = (leaf: string) =>
    async function* () {
      mkdirSync(project.path(leaf), { recursive: true });
      writeFileSync(project.path(leaf, 'main.js'), "const f = (x) => { 'use gpu'; return x; };\n");
      yield { success: true };
    };

  it('the default output location (dist/<project>/browser)', async () => {
    stockBehavior = dirtyBuild('dist/app/browser');
    setup('application', '@angular/build:application', 'application');
    expect((await run('build', { tsConfig: 'tsconfig.app.json' })).result.success).toBe(false);
  });

  it('an `outputPath` object with its own browser folder, an empty browser folder, and a server folder', async () => {
    stockBehavior = dirtyBuild('out/web');
    setup('application', '@angular/build:application', 'application');
    expect((await run('build', { tsConfig: 'tsconfig.app.json', outputPath: { base: 'out', browser: 'web' } })).result.success).toBe(false);
    stockBehavior = dirtyBuild('out2');
    expect((await run('build', { tsConfig: 'tsconfig.app.json', outputPath: { base: 'out2', browser: '' } })).result.success).toBe(false);
    stockBehavior = dirtyBuild('out3/srv');
    expect((await run('build', { tsConfig: 'tsconfig.app.json', outputPath: { base: 'out3', server: 'srv' }, server: 'src/main.server.ts' })).result.success).toBe(false);
  });
});

describe('test wrapper', () => {
  it('builds the shaders once when not watching, and fails the run on a shader error', async () => {
    setup('unit-test', '@angular/build:unit-test', 'unit-test');
    const ok1 = await run('test', { tsConfig: 'tsconfig.spec.json', watch: false });
    expect(ok1.result.success).toBe(true);
    expect(calls[0]).toMatchObject({ manifest: true, wave: true });
    project.write('src/wave.gpu.ts', BAD_SHADER);
    calls.length = 0;
    const failed = await run('test', { tsConfig: 'tsconfig.spec.json', watch: false });
    expect(failed.result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/** Schedules a target without waiting for its first output. */
async function start(target: string, options: Record<string, unknown> = {}) {
  const logger = new logging.Logger('test');
  logger.subscribe((entry) => logs.push({ level: entry.level, message: entry.message }));
  host.addTarget({ project: 'app', target }, `${OWN}:${{ build: 'application', serve: 'dev-server', test: 'unit-test', 'extract-i18n': 'extract-i18n' }[target]}`, options as never);
  return architect.scheduleTarget({ project: 'app', target }, {}, { logger });
}

describe('what the official builder sees of the build target (it validates the target\'s options itself)', () => {
  // `ng serve` and `ng test` do not run the application wrapper: the official dev-server / unit-test builder reads the build target's
  // options and validates them against the schema of the builder NAMED by the target. That is the wrapper, and the CLI fills a
  // third-party builder's schema with empty arrays; `conditions: []` is truthy, so Angular then drops its default resolve conditions
  // (`module`, `development`/`production`) from the dev and test bundles only.
  async function seenByOfficialBuilder(wrapper: string, stock: string, schemaName: string, target: string, options: Record<string, unknown>) {
    let seen: { name: string; options: Record<string, any> } | undefined;
    stockBehavior = async function* (_options, context) {
      const buildTarget = { project: 'app', target: 'build' };
      const name = await context.getBuilderNameForTarget(buildTarget);
      seen = { name, options: await context.validateOptions(await context.getTargetOptions(buildTarget), name) };
      yield { success: true };
    };
    setup(wrapper, stock, schemaName);
    await run(target, options);
    return seen!;
  }

  it('dev-server: the build target\'s options are validated like a stock target\'s: no `conditions: []` filler', async () => {
    const seen = await seenByOfficialBuilder('dev-server', '@angular/build:dev-server', 'dev-server', 'serve', { buildTarget: 'app:build' });
    expect(seen.options['conditions']).toBeUndefined();
    expect(seen.options.security).toEqual({ autoCsp: false });
    expect(seen.options.stylePreprocessorOptions).toEqual({ includePaths: [], sass: {} });
  });

  it('unit-test: the same, and the build target is the official application builder as far as the official builder can tell', async () => {
    const seen = await seenByOfficialBuilder('unit-test', '@angular/build:unit-test', 'unit-test', 'test', { tsConfig: 'tsconfig.spec.json', watch: false });
    expect(seen.name).toBe('@angular/build:application');
    expect(seen.options['conditions']).toBeUndefined();
  });

  it('what the project sets on the build target is kept', async () => {
    let seen: Record<string, any> | undefined;
    stockBehavior = async function* (_options, context) {
      const buildTarget = { project: 'app', target: 'build' };
      seen = await context.validateOptions(await context.getTargetOptions(buildTarget), await context.getBuilderNameForTarget(buildTarget));
      yield { success: true };
    };
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    host.addTarget({ project: 'app', target: 'build' }, `${OWN}:application`, { tsConfig: 'tsconfig.app.json', conditions: ['custom'] });
    await run('serve', { buildTarget: 'app:build' });
    expect(seen).toMatchObject({ conditions: ['custom'] });
  });
});

describe('lifecycle', () => {
  it('a consumer waiting for the first output of a dev server gets it while the server keeps running (ng e2e, Cypress and friends)', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    stockBehavior = async function* () {
      yield { success: true, baseUrl: 'http://localhost:4200/' };
      await stopped;
    };
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const scheduled = await start('serve', { buildTarget: 'app:build' });
    const first = await Promise.race([scheduled.result, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
    expect(first).toMatchObject({ success: true, baseUrl: 'http://localhost:4200/' });
    stop();
    await scheduled.stop();
  });

  it('a run stopped before the official builder has started never starts it (it would never be told to stop)', async () => {
    let release!: () => void;
    metadataGate = new Promise<void>((resolve) => (release = resolve));
    setup('dev-server', '@angular/build:dev-server', 'dev-server');
    const scheduled = await start('serve', { buildTarget: 'app:build' });
    await waitFor(() => metadataEntered, 'the wrapper to start');
    await scheduled.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls).toHaveLength(0);
    expect(project.exists('shaders-dist')).toBe(false); // not even the shaders were built for a run that is over
  });

  it('one-shot `ng test` without --watch: not watching when the terminal is not interactive (the official builder runs once), so a failing shader fails the command', async () => {
    const previous = process.env['NG_FORCE_TTY'];
    process.env['NG_FORCE_TTY'] = 'false';
    try {
      project.write('src/wave.gpu.ts', BAD_SHADER);
      setup('unit-test', '@angular/build:unit-test', 'unit-test');
      const { result } = await run('test', { tsConfig: 'tsconfig.spec.json' });
      expect(result.success).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env['NG_FORCE_TTY'];
      else process.env['NG_FORCE_TTY'] = previous;
    }
  });

  it('`ng test --ui` always watches (the official builder ignores --no-watch then)', async () => {
    const previous = process.env['NG_FORCE_TTY'];
    process.env['NG_FORCE_TTY'] = 'false';
    try {
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => (stop = resolve));
      stockBehavior = async function* () {
        yield { success: true };
        await stopped;
      };
      setup('unit-test', '@angular/build:unit-test', 'unit-test');
      const running = run('test', { tsConfig: 'tsconfig.spec.json', ui: true, watch: false });
      await waitFor(() => calls.length === 1, 'the tests to start');
      project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
      await waitFor(() => project.read('shaders-dist/wave.gpu.js').includes('std.cos(x)'), 'the edit to be rebuilt');
      stop();
      await (await running).finished;
    } finally {
      if (previous === undefined) delete process.env['NG_FORCE_TTY'];
      else process.env['NG_FORCE_TTY'] = previous;
    }
  });
});

describe('extract-i18n wrapper: ng extract-i18n bundles the application itself, so the shaders must be current first', () => {
  /** The official `executeExtractI18nBuilder` resolves with ONE result (a Promise), not an AsyncIterable: the stand-in does the same. */
  const asPromise = async (outputs: AsyncIterable<unknown>) => {
    for await (const output of outputs) return output;
  };
  const extract = (options: Record<string, unknown> = { buildTarget: 'app:build' }) => run('extract-i18n', options);
  const setupExtract = () => {
    setup('extract-i18n', '@angular/build:extract-i18n', 'extract-i18n');
    (globalThis as any).__shape = asPromise;
  };

  it('from a clean checkout (no shader output) builds the shaders first: the official builder starts with the output in place and gets the same options', async () => {
    setupExtract();
    expect(project.exists('shaders-dist')).toBe(false);
    const { result } = await extract({ buildTarget: 'app:build', format: 'json', outputPath: 'src/locale' });
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.builder)).toEqual(['extract-i18n']);
    expect(calls[0]).toMatchObject({ manifest: true, wave: true });
    expect(calls[0]!.options).toMatchObject({ buildTarget: 'app:build', format: 'json', outputPath: 'src/locale' });
  });

  it('a stale shader output is rebuilt before extraction (the output the official builder sees is current, not the one a previous build left)', async () => {
    let seen = '';
    stockBehavior = async function* () {
      seen = project.read('shaders-dist/wave.gpu.js');
      yield { success: true };
    };
    setupExtract();
    await extract();
    expect(seen).toContain('std.sin(x)');
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await extract();
    expect(seen).toContain('std.cos(x)');
    expect(seen).not.toContain('std.sin(x)');
    expect(calls).toHaveLength(2);
  });

  it('a shader that cannot be transformed fails the command with the same diagnostics as a build, and the official builder never runs (no "Extraction Complete" from a stale output)', async () => {
    setupExtract();
    await extract(); // a good output is on disk now: the broken source must still not be extracted from it
    calls.length = 0;
    logs.length = 0;
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const { result } = await extract();
    expect(result.success).toBe(false);
    expect(result.error).toContain('the shader build failed');
    expect(result.error).toContain('no messages were extracted');
    expect(calls).toHaveLength(0);
    const text = logs.map((l) => l.message).join('\n');
    expect(posix(text)).toContain('src/wave.gpu.ts');
    expect(text).toContain('TryStatement');
  });

  it('a relative import of a shader module fails it as for a build, and the official builder never runs', async () => {
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    setupExtract();
    const { result } = await extract();
    expect(result.success).toBe(false);
    expect(logs.map((l) => l.message).join('\n')).toContain("Import '@shaders/wave.gpu' instead");
    expect(calls).toHaveLength(0);
  });

  it('the options are validated against the official schema and given its defaults, with no empty-array fillers', async () => {
    setupExtract();
    await extract();
    expect(calls[0]!.options).toEqual({ buildTarget: 'app:build', format: 'xlf', progress: true });
  });

  it('an invalid option is rejected before anything runs, as for the official builder', async () => {
    setupExtract();
    await expect(extract({ buildTarget: 'app:build', format: 'docx' })).rejects.toThrow(/format|allowed values/i);
    expect(calls).toHaveLength(0);
    expect(project.exists('shaders-dist')).toBe(false);
  });

  it('an unknown option is rejected before anything runs, as for the official builder', async () => {
    setupExtract();
    await expect(extract({ buildTarget: 'app:build', notAnOption: 1 })).rejects.toThrow(/notAnOption|additional/i);
    expect(calls).toHaveLength(0);
    expect(project.exists('shaders-dist')).toBe(false);
  });

  it('a malformed buildTarget is rejected before anything runs', async () => {
    setupExtract();
    await expect(extract({ buildTarget: 'not a target' })).rejects.toThrow(/buildTarget|pattern/i);
    expect(calls).toHaveLength(0);
  });

  it('a project without shader modules extracts as before and nothing is written', async () => {
    project.remove('src/wave.gpu.ts');
    project.write('src/app/main.ts', 'export const used = 1;\n');
    setupExtract();
    const { result } = await extract();
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(project.exists('shaders-dist')).toBe(false);
  });

  it('is never a watch: the shader build runs once and the run ends with the official builder', async () => {
    setupExtract();
    const { finished } = await extract();
    await finished;
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.sin(x)'); // nothing rebuilt it
  });

  it('does not scan a bundle (it writes none): a missing output folder is not warned about', async () => {
    setupExtract();
    await extract();
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('passes the failure of the official builder on untouched', async () => {
    stockBehavior = async function* () {
      yield { success: false, error: 'Extraction Failed' };
    };
    setupExtract();
    const { result } = await extract();
    expect(result).toMatchObject({ success: false, error: 'Extraction Failed' });
  });

  it('the official builder gets the target of the project, and sees the build target as the stock application builder (it validates the build target\'s options itself)', async () => {
    let seen: { target: unknown; name: string; options: Record<string, any> } | undefined;
    stockBehavior = async function* (_options, context) {
      const buildTarget = { project: 'app', target: 'build' };
      const name = await context.getBuilderNameForTarget(buildTarget);
      seen = { target: context.target, name, options: await context.validateOptions(await context.getTargetOptions(buildTarget), name) };
      yield { success: true };
    };
    setupExtract();
    await extract();
    expect(seen!.target).toMatchObject({ project: 'app', target: 'extract-i18n' });
    expect(seen!.name).toBe('@angular/build:application');
    expect(seen!.options['conditions']).toBeUndefined(); // the CLI's empty-array filler of a third-party builder is not there
  });

  it('the shaders follow the build target the options name: its tsconfig (with its configuration), not a default', async () => {
    // a tsconfig under which the project has a type error (an unused local): the result shows which tsconfig the shader build used
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 3;\nconst unused = 1;\n');
    project.write('tsconfig.alt.json', JSON.stringify({ extends: './tsconfig.app.json', compilerOptions: { noUnusedLocals: true } }));
    setupExtract();
    host.addTarget({ project: 'app', target: 'build', configuration: 'alt' }, `${OWN}:application`, { tsConfig: 'tsconfig.alt.json' });
    const fine = await extract({ buildTarget: 'app:build' });
    expect(fine.result.success).toBe(true);
    project.remove('shaders-dist');
    calls.length = 0;
    architect = newArchitect(); // an Architect keeps the options of a target it has run: a new one for the other options
    const alt = await extract({ buildTarget: 'app:build:alt' });
    expect(alt.result.success).toBe(false);
    expect(posix(logs.map((l) => l.message).join('\n'))).toMatch(/src\/model\.ts:3:\d+ - error/);
    expect(calls).toHaveLength(0);
  });

  it('an application in projects/<name>: the shader output goes to the project folder', async () => {
    const nested = createProject({
      'projects/shop/src/model.ts': 'export const state = { count: 0 };\nexport const SCALE = 3;\n',
      'projects/shop/src/wave.gpu.ts': SHADER,
      'projects/shop/tsconfig.app.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'preserve', moduleResolution: 'bundler', skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }),
    });
    project.dispose();
    project = nested;
    project.remove('src');
    setup('extract-i18n', '@angular/build:extract-i18n', 'extract-i18n', { root: 'projects/shop', sourceRoot: 'projects/shop/src' });
    (globalThis as any).__shape = asPromise;
    host.addTarget({ project: 'app', target: 'build' }, `${OWN}:application`, { tsConfig: 'projects/shop/tsconfig.app.json' });
    const { result } = await extract();
    expect(result.success).toBe(true);
    expect(project.exists('projects/shop/shaders-dist/wave.gpu.js')).toBe(true);
    expect(project.exists('shaders-dist')).toBe(false);
  });

  it('falls back to Architect (scheduleBuilder) when the installed @angular/build does not export the function, and says so', async () => {
    setup('extract-i18n', '@angular/build:extract-i18n', 'extract-i18n', { root: '', sourceRoot: 'src' }, ['executeExtractI18nBuilder']);
    const { result } = await extract();
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.builder)).toEqual(['scheduled:@angular/build:extract-i18n']);
    expect(logs.filter((l) => l.level === 'warn').map((l) => l.message).join('\n')).toMatch(/does not export executeExtractI18nBuilder.*Architect/);
  });
});

describe('layouts', () => {
  it('an application in projects/<name>: the source root and the output folder follow the project', async () => {
    const nested = createProject({
      'projects/shop/src/model.ts': 'export const state = { count: 0 };\nexport const SCALE = 3;\n',
      'projects/shop/src/wave.gpu.ts': SHADER,
      'projects/shop/tsconfig.app.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'preserve', moduleResolution: 'bundler', skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }),
    });
    project.dispose();
    project = nested;
    project.remove('src');
    setup('application', '@angular/build:application', 'application', { root: 'projects/shop', sourceRoot: 'projects/shop/src' });
    const { result } = await run('build', { tsConfig: 'projects/shop/tsconfig.app.json' });
    expect(result.success).toBe(true);
    expect(project.exists('projects/shop/shaders-dist/wave.gpu.js')).toBe(true);
    expect(project.exists('shaders-dist')).toBe(false);
  });
});
