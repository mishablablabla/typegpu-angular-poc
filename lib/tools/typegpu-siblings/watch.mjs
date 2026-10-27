// Regenerate after every change of a source file (one run at a time; changes during a run coalesce into one more). A module that fails is
// replaced by a stub that shows the error in the page; the next good run replaces it. Nothing is cleaned up when the watcher ends: the stub
// carries its own status, and the next run (any process) regenerates it.
import { watch } from 'node:fs';
import { join } from 'node:path';
import { generate } from './generate.mjs';

/**
 * @param {{ onBuild?: (result: object, previous?: object) => void }} hooks
 * @returns {{ ready: Promise<object>, settled(): Promise<object>, close(): void }} `ready`: the first run's result.
 */
export function watchSiblings(config, hooks = {}) {
  let timer;
  let running = false;
  let pending = false;
  let closed = false;
  let scheduled = false;
  let last;

  async function cycle() {
    scheduled = false;
    if (running) return void (pending = true);
    running = true;
    try {
      do {
        pending = false;
        let result;
        try {
          result = await generate(config, { stubs: true });
        } catch (error) {
          result = { ok: false, built: 0, files: [], ms: 0, diagnostics: [{ source: 'config', text: String(error?.message ?? error) }] };
        }
        if (result.built || result.diagnostics.length || !last) hooks.onBuild?.(result, last); // a change in an application file that needs no run is not reported
        last = result;
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
    if (closed || !filename || !String(filename).endsWith('.ts') || String(filename).endsWith('.generated.d.ts')) return;
    schedule();
  });
  watcher.unref();
  const ready = cycle().then(() => last);
  return {
    ready,
    settled: () =>
      new Promise((resolve) => {
        const tick = () => (running || pending || scheduled ? setTimeout(tick, 10) : resolve(last));
        tick();
      }),
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}
