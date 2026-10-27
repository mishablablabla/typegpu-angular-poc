#!/usr/bin/env node
// One harness, both modes. See README.md.
//   node harness/matrix.mjs --mode plugin|prebuild|both --angular 22|21|20 --tgz <abs> --work <dir> [--only S01,S05] [--out results.jsonl] [--keep] [--fixtures-only]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256, rmUnder } from './lib/util.mjs';
import { ensureBase, ensureReady, ensureCli } from './lib/app.mjs';
import { expected } from './lib/expectations.mjs';
import { noteFor } from './lib/notes.mjs';
import * as B from './lib/s-basic.mjs';
import * as W from './lib/s-watch.mjs';
import * as V from './lib/s-serve.mjs';
import * as M from './lib/s-misuse.mjs';
import { s24 } from './lib/s-browser.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node >= 22 required'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const modes = arg('mode', 'both') === 'both' ? ['plugin', 'prebuild'] : [arg('mode')];
const angular = Number(arg('angular', 22));
const tgzSrc = arg('tgz'), workArg = arg('work');
if (!tgzSrc || !workArg || !path.isAbsolute(tgzSrc) || modes.some((m) => !['plugin', 'prebuild'].includes(m))) { console.error('usage: node harness/matrix.mjs --mode plugin|prebuild|both --angular 22|21|20 --tgz <abs path> --work <dir> [--only S01,S05] [--out results.jsonl] [--keep] [--fixtures-only]'); process.exit(2); }
const work = path.resolve(workArg);
const only = arg('only', null)?.split(',').map((s) => s.trim().toLowerCase());
const keep = !!arg('keep', false);
const out = path.resolve(arg('out', path.join(work, `results-a${angular}.jsonl`)));
fs.mkdirSync(path.join(work, 'pkg'), { recursive: true });
const tgz = path.join(work, 'pkg', path.basename(tgzSrc));
if (!fs.existsSync(tgz) || sha256(fs.readFileSync(tgz)) !== sha256(fs.readFileSync(tgzSrc))) fs.copyFileSync(tgzSrc, tgz);
const w = { work, root: path.join(work, `a${angular}`), evRoot: path.join(work, 'ev', `a${angular}`), tgz, angular };
fs.mkdirSync(w.root, { recursive: true });

const platform = `${process.platform}-${process.arch} node ${process.versions.node}`;
// id, title, function. Several rows per brief scenario where it lists sub-cases (each sub-case runs in its own copy of the app).
const SCENARIOS = [
  ['S01', 'clean setup: ng add, ng generate, wire the component', B.s01],
  ['S02', 'first dev and prod build + bundle check', B.s02],
  ['S03', 'determinism, production: cold vs warm vs cold', (c) => B.s03(c, 'production')],
  ['S03d', 'determinism, development: cold vs warm vs cold', (c) => B.s03(c, 'development')],
  ['S04a', 'watch: shader edit', (c) => W.s04(c, 'a')],
  ['S04b', 'watch: helper-only edit', (c) => W.s04(c, 'b')],
  ['S04c', 'watch: 20 edits in 2 s', (c) => W.s04(c, 'c')],
  ['S05a', 'watch: syntax error, then fix', (c) => W.s05(c, 'a')],
  ['S05b', 'watch: try/catch (unsupported JS), then fix', (c) => W.s05(c, 'b')],
  ['S06a', 'watch: delete a shader and its import', (c) => W.s06(c, 'a')],
  ['S06b', 'watch: rename a shader + import, edit after', (c) => W.s06(c, 'b')],
  ['S06c', 'watch: case-only rename + import, edit after', (c) => W.s06(c, 'c')],
  ['S07', '3 shader modules + shared helper + shader importing a shader', M.s07],
  ['S07-relative', 'import form: relative', (c) => M.s07form(c, 'relative')],
  ['S07-js', 'import form: .js extension', (c) => M.s07form(c, 'js')],
  ['S07-alias', 'import form: tsconfig alias', (c) => M.s07form(c, 'alias')],
  ['S07-barrel', 'import form: barrel', (c) => M.s07form(c, 'barrel')],
  ['S07-dynamic', 'import form: dynamic import()', (c) => M.s07form(c, 'dynamic')],
  ['S08', 'ng test --watch=false: shader resolves to WGSL with the markers', B.s08],
  ['S09', 'SSR: build, run the server, GET /', B.s09],
  ['S10a', 'ng serve (default env, CI=1): serve, edit, follow', (c) => V.s10(c, 'a')],
  ['S10b', 'ng serve (CI unset, cache default): serve, edit, follow', (c) => V.s10(c, 'b')],
  ['S11a', 'two ng build at once', (c) => V.s11(c, 'a')],
  ['S11b', 'ng build while ng serve runs', (c) => V.s11(c, 'b')],
  ['S11c', 'two ng serve on one workspace', (c) => V.s11(c, 'c')],
  ['S12', 'kill a build at 0.5/1/1.5/3 s (cold and edited), rebuild', V.s12],
  ['S13', 'installed tarball is byte-identical, bins work', B.s13],
  ['S14a', 'plugin missing from the production configuration only', (c) => M.s14(c, 'a')],
  ['S14b', 'stock dev-server next to the mode\'s build', (c) => M.s14(c, 'b')],
  ['S14c', 'stock unit-test target', (c) => M.s14(c, 'c')],
  ['S15', 'stale artifact: stock application builder swapped in', M.s15],
  ['S16', 'fileReplacements of a *.gpu.ts shader (production)', (c) => M.s16(c, 'a')],
  ['S16b', 'fileReplacements on the generated module (prebuild workaround)', (c) => M.s16(c, 'b')],
  ['S17a', 'watch: edit with the previous mtime restored', (c) => W.s17(c, 'a')],
  ['S17b', 'watch: edit with mtime set to 2020-01-01', (c) => W.s17(c, 'b')],
  ['S17c', 'one-off warm build after an mtime-preserving edit', (c) => W.s17(c, 'c')],
  ['S18a', 'watch: delete then recreate an imported shader module', (c) => W.s18(c, 'a')],
  ['S18b', 'watch: create the missing file of a failed import', (c) => W.s18(c, 'b')],
  ['S19a', 'misspelled directive on a standalone helper', (c) => M.s19(c, 'a')],
  ['S19b', 'directive inside a plain .ts file', (c) => M.s19(c, 'b')],
  ['S19c', 'file not named *.gpu.ts imported with .gpu', (c) => M.s19(c, 'c')],
  ['S19d', 'shader importing an Angular component', (c) => M.s19(c, 'd')],
  ['S20a', 'package in node_modules shipping *.gpu.js', (c) => M.s20(c, 'a')],
  ['S20b', 'package in node_modules shipping sloppy-mode *.gpu.cjs', (c) => M.s20(c, 'b')],
  ['S20c', 'workspace library *.gpu.ts through tsconfig paths', (c) => M.s20(c, 'c')],
  ['S21', 'Angular drift: ng update 21 -> 22', M.s21],
  ...['space', 'hash', 'squote', 'dquote', 'unicode', 'suffix'].map((k) => [`S22-${k}`, `adversarial shader file name (${k})`, (c) => M.s22(c, k)]),
  ['S23', 'diagnostics sample', M.s23],
  ['S24', 'browser: canvas has > 1000 unique colours', s24],
];

const rows = [];
async function runScenario(mode, [id, title, fn]) {
  const ev = path.join(w.evRoot, mode, id);
  fs.rmSync(ev, { recursive: true, force: true });
  fs.mkdirSync(ev, { recursive: true });
  const c = { id, mode, angular, platform, w, ev, apps: [] };
  const t0 = Date.now();
  let r;
  try {
    r = await Promise.race([fn(c), new Promise((_, rej) => setTimeout(() => rej(new Error('scenario timeout 20 min')), 20 * 60 * 1000))]);
  } catch (e) {
    r = { category: 'ERROR', detail: `harness error: ${e.stack?.split('\n').slice(0, 4).join(' | ')}` };
  }
  for (const a of c.apps) { await a.cleanup().catch(() => {}); }
  const exp = expected(id, mode, angular);
  let status = exp.includes(r.category) ? 'pass' : 'fail';
  if (r.category === 'N/A' && !exp.includes('N/A')) status = 'skip';
  if (r.category === 'ERROR') status = 'error';
  const row = { id, mode, angular, platform, status, category: r.category, expected: exp.join('|'), title, detail: r.detail, note: noteFor(id, mode), evidence: ev, ms: Date.now() - t0 };
  fs.appendFileSync(out, JSON.stringify(row) + '\n');
  rows.push(row);
  console.log(`${row.status.toUpperCase().padEnd(5)} ${mode.padEnd(8)} ${id.padEnd(13)} ${row.category.padEnd(12)} (want ${row.expected}) ${(row.ms / 1000).toFixed(1)}s`);
  console.log(`      ${String(row.detail).slice(0, 260)}`);
  if (!keep) for (const a of c.apps) { try { rmUnder(work, path.dirname(a.dir)); } catch {} }
  return row;
}

fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.meta.json', JSON.stringify({ platform, angular, modes, tgzSha256: sha256(fs.readFileSync(tgz)), expectationsSha256: sha256(fs.readFileSync(fileURLToPath(new URL('./lib/expectations.mjs', import.meta.url)))), started: new Date().toISOString(), cpus: os.cpus().length, load: os.loadavg() }, null, 1));
if (!fs.existsSync(out)) fs.writeFileSync(out, '');
await ensureCli(w);
await ensureBase(w);
if (!only || only.some((s) => s.startsWith('s09'))) await ensureBase(w, { ssr: true });
if (arg('fixtures-only', false)) { console.log('fixtures ready (cli, base, base-ssr)'); process.exit(0); }
for (const mode of modes) {
  const c0 = { mode, angular, w, ev: path.join(w.evRoot, mode, 'fixture'), apps: [] };
  console.log(`\n== ${mode}, Angular ${angular}, ${platform}`);
  for (const sc of SCENARIOS) {
    const id = sc[0].toLowerCase();
    if (only && !only.some((o) => id === o || id.startsWith(o + '-') || (o.length === 3 && id.startsWith(o)))) continue;
    await runScenario(mode, sc);
  }
}
console.log('\nID            mode     category     want                 status  ms');
for (const r of rows) console.log(`${r.id.padEnd(13)} ${r.mode.padEnd(8)} ${r.category.padEnd(12)} ${r.expected.padEnd(20)} ${r.status.padEnd(6)} ${r.ms}`);
const n = (s) => rows.filter((r) => r.status === s).length;
console.log(`\npass ${n('pass')}  fail ${n('fail')}  skip ${n('skip')}  error ${n('error')}  of ${rows.length}`);
process.exit(n('error') ? 3 : 0);
