// Rebuild after every change of a source file. One build at a time (changes during a build coalesce into one more), the output folder is
// never wiped (only pruned after a build), a module that fails is replaced by a stub that shows the error, and the next good build
// replaces the stub: recovery needs nothing but fixing the file.
import { existsSync, readFileSync, watch as fsWatch } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBuilder } from './build.mjs';
import { endBySignal } from './command.mjs';
import { outputProblems } from './check.mjs';
import { resolveConfig } from './config.mjs';
import { computeClosure } from './graph.mjs';
import { isStub } from './diagnostics.mjs';
import { endSession, newSessionId, registerSession } from './sessions.mjs';
import { removeInside } from './atomic.mjs';
import { isSameOrInside } from './paths.mjs';
import { importDiagnostics } from './imports.mjs';
import { outputsOf } from './manifest.mjs';

/** Waits (ms) between the attempts to watch again after the watcher failed: bounded (about 6 s in all), then the failure is final. */
const REARM_BACKOFF = [100, 200, 400, 800, 1600, 3200];
/** A watcher that ran this long before it failed was not failing in a loop: the attempts start again. */
const STABLE_MS = 10_000;

/**
 * @param {object} options see config.mjs
 * @param {{ onBuild?: (result: object, previous?: object) => void, onImports?: (problems: object[]) => void, onWatchError?: (error: Error, info: { retrying: boolean }) => void }} hooks
 *   `onImports`: the application imports a shader module by a relative path (it would bundle the untransformed source; nothing else notices
 *   in development); called when the set of such imports changes. `onWatchError`: the file watcher failed (on Windows the watched folder being
 *   removed or renamed raises EPERM); called once per failure with `retrying: true` while the watcher is being re-armed, and once more with
 *   `retrying: false` if it could not be (then nothing is watched any more). Without it the message goes to the console.
 * @param {{ watch?: typeof fsWatch, backoff?: number[], builder?: object }} internals for tests only: the file watcher factory, the waits (ms) between attempts to arm it again, and the hooks of the builder (see build.mjs)
 * @returns {{ config: object, ready: Promise<object>, settled(): Promise<object>, close(): void }} `ready` resolves with the first build's result;
 *   `settled()` resolves with the latest result once no build is running or queued.
 */
export function watchShaders(options = {}, hooks = {}, internals = {}) {
  const watch = internals.watch ?? fsWatch;
  const backoff = internals.backoff ?? REARM_BACKOFF;
  // `handleSignals: false`: the caller (the `dev` command, which runs a child) ends the watcher itself, after its child has ended
  const { allowEmpty = false, handleSignals = true, ...configOptions } = options;
  const config = resolveConfig(configOptions);
  const builder = createBuilder(config, internals.builder);
  let timer;
  let running = false;
  let pending = false;
  let closed = false;
  let last;
  let scheduled = false;

  /** The generated files match the sources as they are now (and were written by the last build). */
  function isCurrent() {
    const { entries, files } = computeClosure(config);
    return entries.length > 0 && outputProblems(config, files).problems.length === 0;
  }

  const sessionId = newSessionId();
  let reportedImports = '[]';
  /** A relative import of a shader module in application code is silent otherwise: the dev server would bundle the raw source. */
  function reportImports() {
    try {
      const problems = importDiagnostics(config, computeClosure(config).files, { unresolved: false });
      const key = JSON.stringify(problems);
      if (key === reportedImports) return;
      reportedImports = key;
      hooks.onImports?.(problems);
    } catch {
      /* a file was removed or half written while it was read: the next change looks again */
    }
  }

  async function cycle() {
    scheduled = false;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        let result;
        try {
          // Every `.ts` file of the application triggers this; only a change in what the shaders are built from needs a build. (Rebuilding
          // anyway would rewrite nothing, but it costs a TypeScript program per save of any component.)
          if (last?.ok && !last.empty && isCurrent()) {
            reportImports();
            continue;
          }
          result = await builder.run({ stubs: true, allowEmpty });
        } catch (error) {
          result = { ok: false, status: 'error', files: [], entries: [], ms: 0, diagnostics: [{ source: 'config', text: String(error?.message ?? error) }] };
        }
        if (result.stubbed?.length) registerSession(config, sessionId); // this session now has stubs that its page shows: others must not delete them
        hooks.onBuild?.(result, last);
        last = result;
        reportImports();
      } while (pending && !closed);
    } finally {
      running = false;
      // closed while this build ran (a late file event, a save a moment before the end): it has written its stubs after `close` removed the
      // ones of the build before it, and nobody else will remove them
      if (closed) removeOwnStubs();
    }
  }

  const schedule = () => {
    scheduled = true;
    clearTimeout(timer);
    timer = setTimeout(cycle, 40);
  };
  // Windows raises an 'error' event (EPERM) on the watcher when the watched folder is removed or renamed (a branch switch, `git clean`, an
  // IDE refactoring); an 'error' event nobody listens to throws and ends the whole process (the Angular CLI). The watcher is closed, and
  // armed again once the folder exists, with a bounded back-off.
  let watcher;
  let rearmTimer;
  let attempts = 0;
  let armedAt = 0;
  let armedOnce = false;
  const onFileEvent = (_event, filename) => {
    if (closed || !filename || !String(filename).endsWith('.ts')) return;
    if (isSameOrInside(config.out, join(config.src, String(filename)))) return; // output written by a build (not a sibling folder that only starts with the same name)
    schedule();
  };
  const reportWatchError = (error, retrying) => {
    if (hooks.onWatchError) hooks.onWatchError(error, { retrying });
    else console.error(`[typegpu-shaders] ${retrying ? 'the file watcher failed, trying to watch again' : 'the file watcher failed and could not be restarted: changes are no longer built'}: ${error?.message ?? error}`);
  };
  function arm() {
    rearmTimer = undefined;
    if (closed) return;
    let failed = false;
    try {
      if (!existsSync(config.src)) throw Object.assign(new Error(`${config.src} does not exist`), { code: 'ENOENT' });
      const current = watch(config.src, { recursive: true }, onFileEvent);
      watcher = current;
      armedAt = Date.now();
      armedOnce = true;
      current.on('error', (error) => {
        if (failed || current !== watcher) return; // one report per watcher (an error can repeat until it is closed)
        failed = true;
        onWatcherError(error, current);
      });
      if (attempts > 0) schedule(); // what changed while nothing was watching is found by the build (a no-op when nothing relevant changed)
    } catch (error) {
      if (!armedOnce) throw error; // the first attempt fails as it always did (no source folder at all): the caller learns it at once
      onWatcherError(error, watcher);
    }
  }
  function onWatcherError(error, broken) {
    if (closed) return;
    try {
      broken?.close();
    } catch {
      /* already closed */
    }
    watcher = undefined;
    // a watcher that ran for a while had a life of its own: its failure starts a new series of attempts
    if (armedAt && Date.now() - armedAt > STABLE_MS) attempts = 0;
    armedAt = 0;
    const retrying = attempts < backoff.length;
    if (attempts === 0 || !retrying) reportWatchError(error, retrying);
    if (!retrying) return;
    rearmTimer = setTimeout(arm, backoff[attempts++]);
  }
  arm();
  // Ctrl-C ends the Angular CLI without stopping its builders (measured: no `exit` event either), so the stubs are also cleaned up on a
  // signal; the signal is then passed on (our listener would otherwise take away its default action, ending the process).
  // Windows has no POSIX signals: a console Ctrl-C arrives as SIGINT, Ctrl-Break as SIGBREAK, closing the console as SIGHUP (it ends the
  // process some seconds later, whatever the handler does). `process.kill(process.pid, 'SIGINT' | 'SIGTERM')` ends the process at once there.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onExit = () => close();
  // one listener per signal (it knows its own name: an event emitted by hand, as the tests do, carries no argument)
  const onSignal = Object.fromEntries(
    signals.map((signal) => [
      signal,
      () => {
        close();
        if (process.listenerCount(signal) === 0) endBySignal(signal);
      },
    ]),
  );
  process.once('exit', onExit);
  if (handleSignals) for (const signal of signals) process.once(signal, onSignal[signal]);
  const ready = cycle().then(() => last);
  return {
    config,
    ready,
    settled: () =>
      new Promise((resolve) => {
        const tick = () => (running || pending || scheduled ? setTimeout(tick, 10) : resolve(last));
        tick();
      }),
    /**
     * Stop watching. A module that is still a stub (the shader was never fixed) is removed: a stub is for a running dev server, and a
     * plain `ng build` after the session must fail on the missing module instead of bundling an error banner. Only a stub is removed:
     * another process (a build in a second terminal) may have written the real module meanwhile.
     */
    close,
  };

  function close() {
    process.off('exit', onExit);
    for (const signal of signals) process.off(signal, onSignal[signal]);
    closed = true;
    scheduled = false; // `settled()` then resolves as soon as the build that is running (if any) has ended
    clearTimeout(timer);
    clearTimeout(rearmTimer);
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    removeOwnStubs();
  }

  /** Ends this session's record, and removes the stubs of the last build unless another live session may be showing them. (Safe to repeat.) */
  function removeOwnStubs() {
    // another live session may be showing the same stub (its page, its banner): the last one to end removes it
    if (endSession(config, sessionId)) return;
    for (const path of last?.stubbed ?? []) {
      const [js, map] = outputsOf(config, path).filter((name) => name.endsWith('.js') || name.endsWith('.js.map'));
      try {
        if (!isStub(readFileSync(resolve(config.out, js), 'utf8'))) continue;
      } catch {
        continue; // already gone
      }
      // Windows: a file that something else has open (an indexer, a virus scanner, the dev server reading it) cannot be removed at that moment
      for (const output of [js, map]) {
        try {
          removeInside(config.out, resolve(config.out, output));
        } catch {
          /* the next session (or a build) prunes it; a failure here must not stop the clean-up of the others, nor throw out of a signal handler */
        }
      }
    }
  }
}
