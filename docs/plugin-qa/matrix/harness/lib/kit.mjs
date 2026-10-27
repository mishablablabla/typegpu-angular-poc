// Small shared pieces for scenarios.
import path from 'node:path';
import { Proc, freePort, httpGet, until, sleep, stripAnsi } from './util.mjs';
import { markerState } from './app.mjs';

export const said = (text, ...needles) => needles.some((n) => text.toLowerCase().includes(String(n).toLowerCase()));
export const tail = (text, n = 12) => text.trim().split(/\r?\n/).slice(-n).join('\n');
export const head = (text, n = 12) => text.trim().split(/\r?\n/).slice(0, n).join('\n');
export const R = (category, detail, more = {}) => ({ category, detail, ...more });

/**
 * Generic classification of one "build and look at the artifact" outcome.
 *  exit0: the build exited 0.  transformed: the artifact has the shader transformed with the right marker.
 *  signals: {build?: bool (build failed or warned about the shader), check?: bool (bundle check failed), test?: bool, serve?: bool} -- anything that told the user.
 */
export function classify({ exit0, transformed, signals = {} }) {
  const told = Object.entries(signals).filter(([, v]) => v).map(([k]) => k);
  if (!exit0) return { category: 'LOUD', told: ['build-failed', ...told] };
  if (transformed) return { category: 'CORRECT', told };
  return told.length ? { category: 'LOUD', told } : { category: 'SILENT-WRONG', told };
}

/** Files served by a running dev server: index.html scripts plus the chunks they import (one JS text per file). */
export async function fetchServed(port) {
  const base = `http://localhost:${port}`;
  const idx = await httpGet(`${base}/`);
  if (idx.status !== 200) return { status: idx.status, files: [] };
  const seen = new Map();
  const queue = [...idx.body.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
  while (queue.length && seen.size < 40) {
    const rel = queue.shift().replace(/^\.?\//, '');
    if (seen.has(rel)) continue;
    const r = await httpGet(`${base}/${rel}`);
    seen.set(rel, r.status === 200 ? r.body : '');
    for (const m of r.body.matchAll(/["']\.\/((?:chunk|main)[-\w]*\.js)["']/g)) queue.push(m[1]);
  }
  return { status: idx.status, files: [...seen].map(([rel, text]) => ({ rel, text })) };
}
export async function servedMark(port, m) {
  const s = await fetchServed(port);
  return { status: s.status, ...markerState(s.files, m) };
}

/** Start `ng serve` on a free port and wait (deadline) for the first HTTP 200. */
export async function startServe(app, { env, tag = 'serve', extra = [], timeout = 120000 } = {}) {
  const port = await freePort();
  const proc = app.startNg(['serve', '--port', String(port), ...extra], { env, tag });
  const t0 = Date.now();
  const r = await until(async () => (proc.code !== null ? 'dead' : (await httpGet(`http://localhost:${port}/`)).status === 200), { timeout, step: 300 });
  return { proc, port, up: r.value === true, ms: Date.now() - t0 };
}

/** Start `ng build --watch -c development` and wait until `mark` is in the output. */
export async function startWatch(app, mark, { tag = 'watch', args = ['-c', 'development'], timeout = 90000 } = {}) {
  const proc = app.startNg(['build', '--watch', ...args], { tag });
  const r = await until(() => app.mark(mark).transformed || proc.code !== null, { timeout, step: 250 });
  return { proc, ready: app.mark(mark).transformed, ms: r.ms, died: proc.code !== null };
}
export { path, sleep, stripAnsi, until, httpGet, Proc };
