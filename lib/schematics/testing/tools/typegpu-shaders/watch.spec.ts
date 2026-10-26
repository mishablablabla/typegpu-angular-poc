// Watch mode: rebuilds after a change, shows a failure instead of continuing with stale output, recovers when the file is fixed.
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { checkShaders, watchShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { BAD_SHADER, createProject, posix, SHADER, waitFor, type Project } from './project';

type Result = { ok: boolean; diagnostics: { source: string; file?: string; text: string }[] };

let project: Project;
let results: Result[];
let watcher: { ready: Promise<Result>; settled(): Promise<Result>; close(): void };
const start = async () => {
  watcher = watchShaders({ root: project.root }, { onBuild: (result: Result) => results.push(result) });
  await watcher.ready;
};
/** Wait for the next finished build, whatever its result. */
async function nextBuild(action: () => void) {
  const before = results.length;
  action();
  await waitFor(() => results.length > before, 'a rebuild');
  // a write can arrive as more than one file event: give the later ones time to arrive, then wait until nothing is running or queued
  await new Promise((resolve) => setTimeout(resolve, 100));
  return watcher.settled();
}

beforeEach(() => {
  project = createProject();
  results = [];
});
afterEach(() => {
  watcher?.close();
  project.dispose();
});

describe('watch', () => {
  it('builds first, then rebuilds a shader after an edit (incremental)', async () => {
    await start();
    expect(results[0]).toMatchObject({ ok: true });
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('SCALE');
    const result = await nextBuild(() => project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE')));
    expect(result.ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.cos(x)');
    expect(checkShaders({ root: project.root }).ok).toBe(true); // the manifest follows
  });

  it('rebuilds when a plain module a shader imports changes', async () => {
    await start();
    await nextBuild(() => project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 42;\n'));
    expect(project.read('shaders-dist/model.js')).toContain('SCALE = 42');
  });

  it('picks up a new module imported by a shader, and removes the output of a deleted one, without a restart', async () => {
    await start();
    project.write('src/helper.ts', 'export const H = 7;\n');
    await nextBuild(() => project.write('src/wave.gpu.ts', `import { H } from './helper';\n${SHADER}\nexport const h = H;\n`));
    expect(project.exists('shaders-dist/helper.js')).toBe(true);
    await nextBuild(() => project.write('src/wave.gpu.ts', SHADER));
    expect(project.exists('shaders-dist/helper.js')).toBe(false);
  });

  it('a transformation failure is shown at once: the module becomes a banner-and-throw stub naming the problem; good modules stay', async () => {
    await start();
    const goodModel = project.read('shaders-dist/model.js');
    const result = await nextBuild(() => project.write('src/wave.gpu.ts', BAD_SHADER));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ text: expect.stringContaining('TryStatement') });
    expect(posix(result.diagnostics[0].file)).toBe('src/wave.gpu.ts');
    const stub = project.read('shaders-dist/wave.gpu.js');
    expect(stub).toContain('typegpu-shaders-error'); // the banner element
    expect(stub).toMatch(/src(\/|\\+)wave\.gpu\.ts/); // a JS string literal: the Windows separator is escaped
    await expect(project.import('shaders-dist/wave.gpu.js')).rejects.toThrow(/TryStatement/); // nothing runs on stale output
    expect(project.read('shaders-dist/model.js')).toBe(goodModel);
    // and `check` agrees that this is not a usable build
    expect(checkShaders({ root: project.root }).problems.map((p: { code: string }) => p.code)).toContain('failed');
  });

  it('closing the watcher while a shader is still broken removes its stub, so a plain build after the session fails instead of bundling it', async () => {
    await start();
    await nextBuild(() => project.write('src/wave.gpu.ts', BAD_SHADER));
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(true); // the stub, while the session runs
    watcher.close();
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
    expect(project.exists('shaders-dist/model.js')).toBe(true);
    expect(checkShaders({ root: project.root }).problems.map((p: { code: string }) => p.code)).toContain('failed');
  });

  it('recovers when the shader is fixed: the real module is back, the manifest is ok, and the stub is gone', async () => {
    await start();
    await nextBuild(() => project.write('src/wave.gpu.ts', BAD_SHADER));
    const result = await nextBuild(() => project.write('src/wave.gpu.ts', SHADER));
    expect(result.ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('typegpu-shaders-error');
    const { wave } = await project.import('shaders-dist/wave.gpu.js');
    expect(wave).toBeDefined();
    expect(checkShaders({ root: project.root }).ok).toBe(true);
  });

  it('a syntax error while typing (a plain module) is shown the same way and recovers', async () => {
    await start();
    const result = await nextBuild(() => project.write('src/model.ts', 'export const SCALE = ;\n'));
    expect(result.ok).toBe(false);
    expect(posix(result.diagnostics.find((d) => d.source === 'syntax')!.file)).toBe('src/model.ts');
    await expect(project.import('shaders-dist/model.js')).rejects.toThrow(/src[\\/]model.ts/);
    await nextBuild(() => project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 3;\n'));
    expect((await project.import('shaders-dist/model.js')).SCALE).toBe(3);
  });

  it('survives many quick edits: one build at a time, the last write wins', async () => {
    await start();
    const before = results.length;
    for (let i = 0; i < 6; i++) project.write('src/model.ts', `export const state = { count: 0 };\nexport const SCALE = ${100 + i};\n`);
    await waitFor(() => project.read('shaders-dist/model.js').includes('SCALE = 105'), 'the last edit');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(results.length).toBeGreaterThan(before);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('does not wipe the output folder: files that did not change are left as they were', async () => {
    await start();
    const { statSync } = await import('node:fs');
    const before = statSync(project.path('shaders-dist/model.js')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await nextBuild(() => project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE')));
    expect(project.exists('shaders-dist/model.js')).toBe(true);
    // esbuild rewrites the files it is given; what matters is that the folder was never emptied in between (it is read by a running dev server)
    expect(statSync(project.path('shaders-dist/model.js')).mtimeMs).toBeGreaterThanOrEqual(before);
  });
});

describe('watch: only a change in what the shaders are built from rebuilds them', () => {
  const mtimes = () => Object.fromEntries(readdirSync(project.path('shaders-dist')).filter((name) => !name.startsWith('.')).map((name) => [name, statSync(project.path('shaders-dist', name)).mtimeMs]));

  it('saving a file no shader imports (any component, any service) builds nothing and rewrites nothing, so the dev server does not rebuild for it', async () => {
    await start();
    const before = mtimes();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 3; i++) {
      project.write('src/app/main.ts', `import { wave } from '@shaders/wave.gpu';\nexport const used = [wave, ${i}];\n`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await watcher.settled();
    }
    expect(results).toHaveLength(1);
    expect(mtimes()).toEqual(before);
  });

  it('a file that is only imported by a shader module does rebuild it', async () => {
    await start();
    const result = await nextBuild(() => project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 5;\n'));
    expect(result.ok).toBe(true);
    expect(project.read('shaders-dist/model.js')).toContain('SCALE = 5');
  });
});

describe('watch: what is visible, and when it is reported', () => {
  // The intermittent failure of the dev-server builder test: esbuild used to write the JavaScript itself, in its own process, and the report
  // came after the declarations were emitted: in one rebuild of ten the new output was visible 100 to 260 ms before the build was reported
  // (measured with a 1 ms poll). Everything that reacts to a changed file (a test, a dev server, an IDE) then sees a change whose
  // diagnostics are not out yet. Files are now written in the same synchronous step that ends in the report.
  it('a changed output is never visible before the build that wrote it has been reported', async () => {
    const texts = [BAD_SHADER, SHADER, SHADER.replace('std.sin', 'std.cos'), BAD_SHADER, SHADER.replace('std.sin', 'std.tan'), SHADER.replace('std.sin', 'std.abs')];
    let reportedAt: number | undefined;
    watcher = watchShaders({ root: project.root }, { onBuild: () => (reportedAt = performance.now()) });
    await watcher.ready;
    const early: number[] = [];
    for (let round = 0; round < 30; round++) {
      reportedAt = undefined;
      const before = readFileSync(project.path('shaders-dist/wave.gpu.js'), 'utf8');
      project.write('src/wave.gpu.ts', `${texts[round % texts.length]}\n// ${round}\n`);
      let seenAt = 0;
      for (;;) {
        if (readFileSync(project.path('shaders-dist/wave.gpu.js'), 'utf8') !== before) {
          seenAt = performance.now();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await waitFor(() => reportedAt !== undefined, 'the report');
      if (reportedAt! - seenAt > 3) early.push(Math.round(reportedAt! - seenAt));
      await watcher.settled();
    }
    expect(early).toEqual([]);
  }, 90_000);
});

describe('watch: a shader module imported by a relative path (the dev server would bundle its raw source, and nothing else notices)', () => {
  it('is reported when it is there at the start, and when it is introduced later, once each', async () => {
    project.write('src/app/early.ts', `import { wave } from '../wave.gpu';\nexport const early = wave;\n`);
    const imports: { file: string; text: string }[][] = [];
    watcher = watchShaders({ root: project.root }, { onBuild: (result: Result) => results.push(result), onImports: (problems: { file: string; text: string }[]) => imports.push(problems) });
    await watcher.ready;
    expect(imports).toHaveLength(1);
    expect(posix(imports[0]![0]!.file)).toBe('src/app/early.ts');
    expect(imports[0]![0]!.text).toContain("Import '@shaders/wave.gpu' instead");

    // an `@shaders/...` import that matches nothing is not reported here: Angular itself fails to resolve it, with its own message
    project.write('src/app/typo.ts', `import { nope } from '@shaders/nope.gpu';\nexport const typo = nope;\n`);
    project.write('src/app/late.ts', `import { wave } from '../wave.gpu';\nexport const late = wave;\n`);
    await waitFor(() => imports.length === 2, 'the second report');
    expect(imports[1]!.map((p) => posix(p.file)).sort()).toEqual(['src/app/early.ts', 'src/app/late.ts']);

    project.write('src/app/late.ts', `export const late = 1;\n`); // fixing one changes the set again; a save that changes nothing reports nothing
    await waitFor(() => imports.length === 3, 'the report after the fix');
    expect(imports[2]!.map((p) => p.file)).toEqual(['src/app/early.ts']);
    project.write('src/app/other.ts', `export const other = 1;\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await watcher.settled();
    expect(imports).toHaveLength(3);
  });
});

describe('watch: closing', () => {
  it('removes the stub of a module that was never fixed, but not a real module another build wrote in the meantime', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    await start();
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error');
    project.write('shaders-dist/wave.gpu.js', 'export const wave = 1; // built by `ng build` in a second terminal\n');
    watcher.close();
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('second terminal');

    await start(); // the shader is still broken: the build writes its stub again
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error');
    watcher.close();
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
  });

  it('removes the stub when the process exits without closing the watcher (Ctrl-C ends the Angular CLI that way)', () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const tool = pathToFileURL(join(__dirname, '../../../../tools/typegpu-shaders/index.mjs')).href;
    const script = `import { watchShaders } from ${JSON.stringify(tool)};\nconst w = watchShaders({ root: ${JSON.stringify(project.root)} });\nawait w.ready;\nconsole.log('stub written');\nprocess.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.stdout).toContain('stub written');
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
  });

  // Windows cannot deliver SIGINT to a child process: `kill('SIGINT')` ends it at once, without running its handlers (a Ctrl-C typed in a
  // console does run them). Not testable there with a spawned child; see QA_FINDINGS.md (W2).
  it.skipIf(process.platform === 'win32')('removes the stub on Ctrl-C (SIGINT), and the process still ends by the signal', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const tool = pathToFileURL(join(__dirname, '../../../../tools/typegpu-shaders/index.mjs')).href;
    const script = `import { watchShaders } from ${JSON.stringify(tool)};\nconst w = watchShaders({ root: ${JSON.stringify(project.root)} });\nawait w.ready;\nconsole.log('stub written');\nsetInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let printed = '';
    child.stdout.on('data', (chunk) => (printed += chunk));
    await waitFor(() => printed.includes('stub written'), 'the watcher in the child process');
    const ended = new Promise<string | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGINT');
    expect(await ended).toBe('SIGINT');
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
  });
});

