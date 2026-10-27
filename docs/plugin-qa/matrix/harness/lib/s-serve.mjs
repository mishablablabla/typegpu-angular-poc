// S10 ng serve, S11 concurrency, S12 interruption.
import fs from 'node:fs';
import { freshApp, M0, mk, shaderSrc } from './app.mjs';
import { R, said, tail, startServe, servedMark } from './kit.mjs';
import { until, sleep, hashTree, diffHashes, listTree } from './util.mjs';

const SHADER = 'src/app/my-canvas/my-canvas.gpu.ts';
const DEADLINE = 30000;

export async function s10(c, variant) {
  const app = await freshApp(c);
  const env = variant === 'a' ? {} : { CI: null, NG_BUILD_CACHE: null }; // b: CI unset, build cache at its default (enabled outside CI)
  const s = await startServe(app, { env, tag: 'serve' });
  if (!s.up) {
    const out = s.proc.text;
    await s.proc.stop();
    return R(s.proc.code !== null && s.proc.code !== 0 ? 'LOUD' : 'ERROR', `no HTTP 200 within the deadline (exit ${s.proc.code}): ${tail(out, 5)}`);
  }
  const m0 = await servedMark(s.port, M0);
  const from = s.proc.text.length;
  app.write(SHADER, shaderSrc({ mark: mk(71) }));
  const r = await until(async () => { const m = await servedMark(s.port, mk(71)); return m.transformed && !(await servedMark(s.port, M0)).present; }, { timeout: DEADLINE, step: 300 });
  const told = s.proc.text.slice(from);
  await s.proc.stop();
  const detail = `env ${variant === 'a' ? 'default (CI=1)' : 'CI unset, cache default'}; first 200 after ${s.ms}ms; served main bundle transformed M0: ${m0.transformed} (raw ${m0.raw}, ast ${m0.ast}); after the edit the served bundle follows: ${r.ok} (${r.ms}ms)`;
  if (!m0.transformed) return R(said(s.proc.text, 'use gpu') ? 'LOUD' : 'SILENT-WRONG', detail);
  if (r.ok) return R('CORRECT', detail);
  return R(said(told, 'error') ? 'LOUD' : 'SILENT-WRONG', detail + ` | served stale (new marker raw=${(await servedMark(s.port, mk(71))).raw})`);
}

async function baseline(app) {
  const b = await app.build([], { tag: 'sequential-baseline' });
  const h = hashTree(app.dist);
  app.rm('dist');
  return { code: b.code, h };
}

export async function s11(c, kind) {
  const app = await freshApp(c);
  if (kind === 'a') { // two ng build at once
    const base = await baseline(app);
    const p1 = app.startNg(['build'], { tag: 'build-1' }), p2 = app.startNg(['build'], { tag: 'build-2' });
    const timer = setTimeout(() => { p1.kill(); p2.kill(); }, 240000);
    await Promise.all([p1.exited, p2.exited]);
    clearTimeout(timer);
    const d = diffHashes(base.h, hashTree(app.dist));
    const m = app.mark(M0);
    const detail = `exits ${p1.code}/${p2.code}; output vs sequential build: ${d.length ? d.slice(0, 5).join('; ') : 'identical'} (${Object.keys(base.h).length} files); marker transformed ${m.transformed}`;
    if (p1.code === 0 && p2.code === 0) return d.length || !m.transformed ? R('SILENT-WRONG', detail) : R('CORRECT', detail);
    return R('LOUD', detail + ' | ' + tail(p1.code ? p1.text : p2.text, 4));
  }
  if (kind === 'b') { // ng build while ng serve runs
    const base = await baseline(app);
    const s = await startServe(app, { tag: 'serve' });
    if (!s.up) { await s.proc.stop(); return R('ERROR', 'serve did not come up: ' + tail(s.proc.text, 4)); }
    const b = await app.build([], { tag: 'build-while-serving' });
    const d = diffHashes(base.h, hashTree(app.dist));
    const served0 = await servedMark(s.port, M0);
    app.write(SHADER, shaderSrc({ mark: mk(81) }));
    const f = await until(async () => (await servedMark(s.port, mk(81))).transformed, { timeout: DEADLINE, step: 300 });
    const b2 = await app.build([], { tag: 'build-after-edit' });
    const m2 = app.mark(mk(81));
    const alive = s.proc.code === null;
    await s.proc.stop();
    const detail = `build while serving exit ${b.code}, output vs sequential: ${d.length ? d.slice(0, 4).join('; ') : 'identical'}; server still served M0 transformed: ${served0.transformed}; after an edit the server follows: ${f.ok}; a later build has the new marker: ${m2.transformed} (exit ${b2.code}); server alive: ${alive}`;
    const wrong = d.length || !served0.transformed || !f.ok || !m2.transformed;
    if (b.code !== 0 || b2.code !== 0) return R('LOUD', detail + ' | ' + tail(b.code ? b.text : b2.text, 4));
    return wrong ? R('SILENT-WRONG', detail) : R('CORRECT', detail);
  }
  // c: two ng serve on one workspace
  const s1 = await startServe(app, { tag: 'serve-1' });
  const s2 = await startServe(app, { tag: 'serve-2' });
  const ups = [s1.up, s2.up];
  const m1 = s1.up ? await servedMark(s1.port, M0) : {}, m2 = s2.up ? await servedMark(s2.port, M0) : {};
  app.write(SHADER, shaderSrc({ mark: mk(82) }));
  const f1 = await until(async () => s1.up && (await servedMark(s1.port, mk(82))).transformed, { timeout: DEADLINE, step: 300 });
  const f2 = await until(async () => s2.up && (await servedMark(s2.port, mk(82))).transformed, { timeout: DEADLINE, step: 300 });
  const t1 = s1.proc.text, t2 = s2.proc.text;
  await s1.proc.stop(); await s2.proc.stop();
  const detail = `up ${ups}; M0 served transformed ${m1.transformed}/${m2.transformed}; after an edit both follow: ${f1.ok}/${f2.ok} (${f1.ms}/${f2.ms}ms)`;
  if (ups.every(Boolean) && m1.transformed && m2.transformed && f1.ok && f2.ok) return R('CORRECT', detail);
  const msg = said(t1 + t2, 'error', 'EADDRINUSE', 'already');
  return R(msg ? 'LOUD' : 'SILENT-WRONG', detail + ' | ' + tail(!s2.up ? t2 : t1, 4));
}

// ---- S12: kill a one-off build at 0.5 s, 1.5 s, 3 s, then rebuild ------------------------------------------------------
export async function s12(c) {
  const app = await freshApp(c);
  const strays = (dir) => listTree(dir, { skipTop: ['dist', '.angular', 'node_modules'] });
  const wipe = () => ['dist', '.angular', 'shaders-dist'].forEach((d) => app.exists(d) && app.rm(d));
  const b0 = await app.build([], { tag: 'baseline' });
  const L0 = strays(app.dir);
  const H0b = hashTree(app.dist);
  const results = [];
  let worst = 'CORRECT';
  for (const variant of ['cold', 'edit']) {
    for (const at of [500, 1000, 1500, 3000]) {
      app.write(SHADER, shaderSrc({ mark: M0 }));
      let target = M0;
      if (variant === 'cold') wipe();
      else { await app.build([], { tag: `refresh-${at}` }); target = mk(90 + at / 100); app.write(SHADER, shaderSrc({ mark: target })); app.rm('dist'); }
      const p = app.startNg(['build'], { tag: `killed-${variant}-${at}` });
      await sleep(at); // the injected fault: an interrupt at a fixed offset (not a wait to prove a negative)
      const wasAlive = p.code === null;
      await p.kill('SIGKILL');
      const b = await app.build([], { tag: `rebuild-${variant}-${at}` });
      const chk = await app.check();
      const m = app.mark(target);
      const L1 = strays(app.dir);
      const added = L1.filter((x) => !L0.includes(x)), removed = L0.filter((x) => !L1.includes(x));
      const hashDiff = variant === 'cold' ? diffHashes(H0b, hashTree(app.dist)) : [];
      const bad = b.code !== 0 || chk.code !== 0 || !m.transformed || added.length || removed.length || hashDiff.length;
      results.push(`${variant}@${at}ms (killed while alive: ${wasAlive}): rebuild exit ${b.code}, check ${chk.code}, marker transformed ${m.transformed}, stray files +${added.length}/-${removed.length}${added.length ? ' [' + added.slice(0, 3).join(',') + ']' : ''}, output diff vs baseline ${variant === 'cold' ? hashDiff.length : 'n/a'}`);
      if (bad) worst = b.code !== 0 ? 'LOUD' : 'SILENT-WRONG';
    }
  }
  return R(worst, `baseline exit ${b0.code}; ${results.join(' | ')}`);
}
