// The file watcher itself: what it ignores (a sibling folder is not the output folder), and what happens when it fails (Windows raises
// EPERM on the watcher when the watched folder is removed or renamed; an unhandled 'error' event would end the Angular process).
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ES module without types
import { endSession, registerSession } from '../../../../tools/typegpu-shaders/sessions.mjs';
// @ts-expect-error plain ES module without types
import { buildShaders, resolveConfig, watchShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { BAD_SHADER, createProject, SHADER, waitFor, type Project } from './project';

type Result = { ok: boolean; diagnostics: { text: string }[] };
type Listener = (event: string, filename: string) => void;

let project: Project;
let watcher: { ready: Promise<Result>; settled(): Promise<Result>; close(): void } | undefined;
beforeEach(() => {
  project = createProject();
});
afterEach(async () => {
  watcher?.close();
  await watcher?.settled();
  watcher = undefined;
  vi.restoreAllMocks();
  project.dispose();
});

/** A stand-in for `fs.watch`: every call is recorded, and a test can emit events on any of the watchers. */
class FakeWatcher extends EventEmitter {
  closed = false;
  constructor(readonly listener: Listener) {
    super();
  }
  close() {
    this.closed = true;
  }
}
const fakeWatch = () => {
  const made: FakeWatcher[] = [];
  const watch = (_dir: string, _options: unknown, listener: Listener) => {
    const fake = new FakeWatcher(listener);
    made.push(fake);
    return fake;
  };
  return { made, watch };
};
const errorOf = (code: string) => Object.assign(new Error(`${code}: operation not permitted, watch '${project.path('src')}'`), { code });

describe('a sibling folder of the output folder is not the output folder', () => {
  // `out` inside `src` is allowed; the watcher ignores what a build writes there. A prefix test also ignored `generated-old`.
  it('an edit in src/generated-old/ (the output is src/generated/) rebuilds', async () => {
    project.write('src/generated-old/dep.ts', 'export const DEP = 1;\n');
    project.write('src/wave.gpu.ts', `import { DEP } from './generated-old/dep';\n${SHADER}\nexport const dep = DEP;\n`);
    const results: Result[] = [];
    const seen: string[] = []; // what the operating system reported: the failure message must say whether the event never came or was ignored
    const watchLogged = (dir: string, options: object, listener: Listener) => fsWatch(dir, options, (event, filename) => {
      seen.push(`${event}:${filename}`);
      listener(event, filename as string);
    });
    watcher = watchShaders({ root: project.root, out: 'src/generated' }, { onBuild: (result: Result) => results.push(result) }, { watch: watchLogged });
    await watcher!.ready;
    expect(results[0]).toMatchObject({ ok: true });
    expect(project.read('src/generated/generated-old/dep.js')).toContain('DEP = 1');
    seen.length = 0;
    project.write('src/generated-old/dep.ts', 'export const DEP = 2;\n');
    try {
      await waitFor(() => project.read('src/generated/generated-old/dep.js').includes('DEP = 2'), 'the rebuild after an edit next to the output folder');
    } catch (error) {
      throw new Error(`${(error as Error).message}; events after the edit: ${JSON.stringify(seen)}; builds: ${results.length}; last result: ${JSON.stringify(results.at(-1))}`);
    }
  });
});

describe('the file watcher fails', () => {
  const start = (extra: { backoff?: number[] } = {}, hooks: Record<string, unknown> = {}) => {
    const fake = fakeWatch();
    const reports: { error: Error; retrying: boolean }[] = [];
    const results: Result[] = [];
    watcher = watchShaders({ root: project.root }, { onBuild: (r: Result) => results.push(r), onWatchError: (error: Error, { retrying }: { retrying: boolean }) => reports.push({ error, retrying }), ...hooks }, { watch: fake.watch, backoff: [5, 5, 5, 5], ...extra });
    return { ...fake, reports, results };
  };

  it("has an 'error' listener (an unhandled 'error' event would throw and end the process)", async () => {
    const { made } = start();
    await watcher!.ready;
    expect(made).toHaveLength(1);
    expect(made[0]!.listenerCount('error')).toBeGreaterThan(0);
    expect(() => made[0]!.emit('error', errorOf('EPERM'))).not.toThrow();
  });

  it('reports once, closes the broken watcher, and arms a new one that rebuilds on a change', async () => {
    const { made, reports, results } = start();
    await watcher!.ready;
    made[0]!.emit('error', errorOf('EPERM'));
    made[0]!.emit('error', errorOf('EPERM')); // an error repeats until the watcher is closed
    expect(made[0]!.closed).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ retrying: true });
    expect(reports[0]!.error).toMatchObject({ code: 'EPERM' });
    await waitFor(() => made.length === 2, 'the watcher to be armed again');
    expect(made[1]!.closed).toBe(false);
    expect(reports).toHaveLength(1); // a successful re-arm is not reported again
    const before = results.length;
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    made[1]!.listener('change', 'wave.gpu.ts');
    await waitFor(() => results.length > before, 'a rebuild by the new watcher');
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.cos(x)');
    expect(made[0]!.listenerCount('change')).toBe(0);
  });

  it('what changed while nothing was watched is built when the watcher is back', async () => {
    const { made, results } = start();
    await watcher!.ready;
    made[0]!.emit('error', errorOf('EPERM'));
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.tan(x) * SCALE')); // no event for this one: nobody listens
    const before = results.length;
    await waitFor(() => results.length > before, 'the build after the watcher came back');
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.tan(x)');
  });

  it('waits for the folder to exist again: attempts with back-off, then watches again', async () => {
    const { made, reports } = start({ backoff: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] });
    await watcher!.ready;
    const away = join(project.root, 'src-away');
    renameSync(project.path('src'), away); // what happens to the folder (a branch switch, a refactoring)
    made[0]!.emit('error', errorOf('EPERM'));
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(made).toHaveLength(1); // nothing to watch yet: no watcher is made for a missing folder
    expect(reports).toHaveLength(1);
    renameSync(away, project.path('src'));
    await waitFor(() => made.length === 2, 'the watcher after the folder is back');
    expect(reports).toHaveLength(1);
  });

  it('gives up after the bounded attempts: reported a second and last time as final, no timer left, close() still works', async () => {
    const { made, reports } = start({ backoff: [5, 5, 5] });
    await watcher!.ready;
    rmSync(project.path('src'), { recursive: true });
    made[0]!.emit('error', errorOf('EPERM'));
    await waitFor(() => reports.length === 2, 'the final report');
    expect(reports.map((r) => r.retrying)).toEqual([true, false]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reports).toHaveLength(2);
    expect(made).toHaveLength(1);
    expect(() => watcher!.close()).not.toThrow();
  });

  it('closing during the back-off cancels the attempt', async () => {
    const { made } = start({ backoff: [40] });
    await watcher!.ready;
    made[0]!.emit('error', errorOf('EPERM'));
    watcher!.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(made).toHaveLength(1);
  });

  it('without a hook the failure goes to the console (never silent)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeWatch();
    watcher = watchShaders({ root: project.root }, {}, { watch: fake.watch, backoff: [5] });
    await watcher!.ready;
    fake.made[0]!.emit('error', errorOf('EPERM'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('EPERM');
  });

  it('a first attempt that fails (no source folder at all) still throws at once, as before', () => {
    const fake = fakeWatch();
    rmSync(project.path('src'), { recursive: true });
    expect(() => watchShaders({ root: project.root }, {}, { watch: fake.watch })).toThrow(/does not exist|ENOENT/);
    expect(fake.made).toHaveLength(0);
  });
});

describe('a file that cannot be removed does not crash the build that prunes it', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('prune reports it as a diagnostic, and the next build removes it', async () => {
    project.write('src/sub/b.gpu.ts', 'export const b = 1;\n');
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    project.remove('src/sub/b.gpu.ts');
    mkdirSync(project.path('shaders-dist/sub'), { recursive: true });
    chmodSync(project.path('shaders-dist/sub'), 0o555); // the file stays: nothing can be unlinked in a folder like this
    try {
      const result = await buildShaders({ root: project.root });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((d: { text: string }) => /Could not remove sub[\\/]b\.gpu\.js/.test(d.text))).toBe(true);
      expect(project.exists('shaders-dist/sub/b.gpu.js')).toBe(true);
      // still on the manifest's list: without that no later build would know it is the tool's to remove
      expect(JSON.parse(project.read('shaders-dist/.manifest.json')).generated).toContain('sub/b.gpu.js');
    } finally {
      chmodSync(project.path('shaders-dist/sub'), 0o755);
    }
    const again = await buildShaders({ root: project.root });
    expect(again.ok).toBe(true);
    expect(project.exists('shaders-dist/sub/b.gpu.js')).toBe(false);
  });
});

describe('session records that cannot be removed', () => {
  // Windows: a record that something has open cannot be removed; POSIX: a folder without write permission does the same. The question the
  // function answers (is another session alive?) must still be answered right, and one's own record that stays is not another session.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('endSession still answers whether another live session exists, and does not count its own stuck record', () => {
    const config = resolveConfig({ root: project.root });
    const folder = join(config.out, '.tmp', 'sessions');
    const mine = `${process.pid}-901`;
    registerSession(config, mine);
    chmodSync(folder, 0o555); // nothing in it can be removed
    try {
      expect(endSession(config, mine)).toBe(false); // nobody else: the record that stays is our own
    } finally {
      chmodSync(folder, 0o755);
    }
    writeFileSync(join(folder, `${process.ppid}-1`), ''); // a live process (this one's parent) has a session too
    chmodSync(folder, 0o555);
    try {
      expect(endSession(config, mine)).toBe(true);
    } finally {
      chmodSync(folder, 0o755);
    }
  });
});

describe('closing while a rebuild is running', () => {
  // Found by the flake loop (ownership.spec, 1 run in 15): the build that was running when `close` was called wrote its stub afterwards,
  // and registered a session record again; nothing removed either, so the stub outlived the watcher.
  it('removes the stub that build writes, and leaves no session record', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const fake = fakeWatch();
    let release!: () => void;
    let gate: Promise<void> | undefined; // set while a build is to be held up right after it has read its sources
    let entered = false;
    const builder = {
      afterSnapshot: async () => {
        entered = true;
        await gate;
      },
    };
    watcher = watchShaders({ root: project.root }, {}, { watch: fake.watch, builder });
    await watcher!.ready;
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error');
    gate = new Promise<void>((resolve) => (release = resolve));
    entered = false;
    project.write('src/wave.gpu.ts', `${BAD_SHADER}\n// edited\n`); // a rebuild is needed
    fake.made[0]!.listener('change', 'wave.gpu.ts');
    await waitFor(() => entered, 'the rebuild to be running');
    watcher!.close(); // the build is in flight
    release();
    await watcher!.settled();
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
    expect(project.exists('shaders-dist/.tmp/sessions') ? readdirSync(project.path('shaders-dist/.tmp/sessions')) : []).toEqual([]);
  });
});
