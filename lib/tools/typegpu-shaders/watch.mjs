// Rebuild after every change of a source file. One build at a time (changes during a build coalesce into one more), the output folder is
// never wiped (only pruned after a build), a module that fails is replaced by a stub that shows the error, and the next good build
// replaces the stub: recovery needs nothing but fixing the file.
import { readFileSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBuilder } from './build.mjs';
import { endBySignal } from './command.mjs';
import { outputProblems } from './check.mjs';
import { resolveConfig } from './config.mjs';
import { computeClosure } from './graph.mjs';
import { isStub } from './diagnostics.mjs';
import { endSession, newSessionId, registerSession } from './sessions.mjs';
import { removeInside } from './atomic.mjs';
import { importDiagnostics } from './imports.mjs';
import { outputsOf } from './manifest.mjs';

/**
 * @param {object} options see config.mjs
 * @param {{ onBuild?: (result: object, previous?: object) => void, onImports?: (problems: object[]) => void }} hooks `onImports`: the application
 *   imports a shader module by a relative path (it would bundle the untransformed source; nothing else notices in development); called when
 *   the set of such imports changes
 * @returns {{ config: object, ready: Promise<object>, settled(): Promise<object>, close(): void }} `ready` resolves with the first build's result;
 *   `settled()` resolves with the latest result once no build is running or queued.
 */
export function watchShaders(options = {}, hooks = {}) {
  // `handleSignals: false`: the caller (the `dev` command, which runs a child) ends the watcher itself, after its child has ended
  const { allowEmpty = false, handleSignals = true, ...configOptions } = options;
  const config = resolveConfig(configOptions);
  const builder = createBuilder(config);
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
    }
  }

  const schedule = () => {
    scheduled = true;
    clearTimeout(timer);
    timer = setTimeout(cycle, 40);
  };
  const watcher = watch(config.src, { recursive: true }, (_event, filename) => {
    if (closed || !filename || !String(filename).endsWith('.ts')) return;
    if (join(config.src, String(filename)).startsWith(config.out)) return;
    schedule();
  });
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
    clearTimeout(timer);
    watcher.close();
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
