// Scenarios that run `ng build --watch -c development` and read the output: S04, S05, S06, S17, S18.
import fs from 'node:fs';
import path from 'node:path';
import { freshApp, M0, H0, mk, shaderSrc, helperSrc } from './app.mjs';
import { R, said, tail, startWatch } from './kit.mjs';
import { until, sleep } from './util.mjs';

const SHADER = 'src/app/my-canvas/my-canvas.gpu.ts';
const HELPER = 'src/app/my-canvas/helper.ts';
const DEADLINE = 30000;

/** Common start: fresh app, watch running, first output has M0. Returns {app, w} or a ready-made failure result. */
async function begin(c, extra = {}) {
  const app = await freshApp(c);
  extra.before?.(app);
  const w = await startWatch(app, M0);
  if (!w.ready) {
    const out = w.proc.text;
    await w.proc.stop();
    const m = app.mark(M0);
    return { fail: w.died && w.proc.code !== 0 ? R('LOUD', `watch died at start (exit ${w.proc.code}): ${tail(out, 5)}`) : R(m.rawOnly ? 'SILENT-WRONG' : 'ERROR', `first watch output has no transformed M0 within 90 s (raw=${m.raw}, ast=${m.ast})`) };
  }
  return { app, w };
}
const finish = async (w, res) => { await w.proc.stop(); return res; };

export async function s04(c, kind) {
  const b = await begin(c);
  if (b.fail) return b.fail;
  const { app, w } = b;
  const from = w.proc.text.length;
  let ok;
  const t0 = Date.now();
  if (kind === 'a') {
    app.write(SHADER, shaderSrc({ mark: mk(1) }));
    ok = () => { const m = app.mark(mk(1)); return m.transformed && !app.mark(M0).present; };
  } else if (kind === 'b') {
    app.write(HELPER, helperSrc(mk(2)));
    ok = () => app.mark(mk(2)).present && !app.mark(H0).present && app.mark(M0).transformed;
  } else {
    for (let i = 1; i <= 20; i++) { app.write(SHADER, shaderSrc({ mark: mk(100 + i) })); await sleep(100); }
    ok = () => app.mark(mk(120)).transformed && ![...Array(19)].some((_, i) => app.mark(mk(101 + i)).present) && !app.mark(M0).present;
  }
  const r = await until(ok, { timeout: DEADLINE, step: 150 });
  const told = w.proc.text.slice(from);
  const detail = `first output ${w.ms}ms; edit (${kind === 'a' ? 'shader' : kind === 'b' ? 'helper only' : '20 edits in 2 s'}) reached the output: ${r.ok} after ${r.ms + (kind === 'c' ? 2000 : 0)}ms`;
  if (r.ok) return finish(w, R('CORRECT', detail));
  const m = app.mark(kind === 'a' ? mk(1) : kind === 'b' ? mk(2) : mk(120));
  return finish(w, said(told, 'error') ? R('LOUD', detail + ' | ' + tail(told, 4)) : R('SILENT-WRONG', `${detail}; output still has the old marker (M0 present: ${app.mark(M0).present}); new marker raw=${m.raw} ast=${m.ast}; nothing printed`));
}

const BAD = {
  a: { what: 'syntax error', src: (m) => shaderSrc({ mark: m }).replace('const k =', 'const k = ;;( ') },
  b: { what: 'try/catch (unsupported JS)', src: (m) => shaderSrc({ mark: m, bodyExtra: '    try { const z = 1; } catch (e) { const y = 2; }\n' }) },
};
export async function s05(c, kind) {
  const b = await begin(c);
  if (b.fail) return b.fail;
  const { app, w } = b;
  const from = w.proc.text.length;
  app.write(SHADER, BAD[kind].src(mk(5)));
  // while broken: wait (deadline) for a message that names the shader file
  const named = await until(() => said(w.proc.text.slice(from), 'my-canvas.gpu'), { timeout: 25000, step: 200 });
  const msg = w.proc.text.slice(from);
  const during = app.mark(M0); // is the last good output still there?
  const duringBroken = app.mark(mk(5));
  let phaseA;
  if (named.ok) phaseA = 'LOUD';
  else if (during.transformed && !duringBroken.present) phaseA = 'CORRECT';
  else phaseA = 'SILENT-WRONG';
  const mid = w.proc.text.length;
  app.write(SHADER, shaderSrc({ mark: mk(6) }));
  const fixed = await until(() => app.mark(mk(6)).transformed, { timeout: DEADLINE, step: 200 });
  const detail = `broken (${BAD[kind].what}): message naming the shader ${named.ok ? `after ${named.ms}ms` : 'none'} [${tail(msg, 3).replace(/\s+/g, ' ').slice(0, 160)}]; last good output kept: ${during.transformed}; after the fix the new marker is in the output: ${fixed.ok} (${fixed.ms}ms)`;
  const cat = !fixed.ok ? 'SILENT-WRONG' : phaseA;
  return finish(w, R(cat, detail + (fixed.ok ? '' : ' (no recovery after the fix)')));
}

// ---- S06 delete / rename / case-only rename ----------------------------------------------------------------------------
function addX(app, mark) {
  app.write('src/app/x.gpu.ts', shaderSrc({ mark, helper: false }));
  app.useShader('x', 'app/x.gpu');
}
export async function s06(c, kind) {
  let X = mk(31);
  const b = await begin(c, { before: (app) => addX(app, X) });
  if (b.fail) return b.fail;
  const { app, w } = b;
  const up = await until(() => app.mark(X).transformed, { timeout: DEADLINE });
  if (!up.ok) return finish(w, R('SILENT-WRONG', `module x.gpu never reached the output (raw=${app.mark(X).raw})`));
  const steps = [];
  let ok = false;
  if (kind === 'a') { // delete the shader and its import
    app.unuse('x');
    app.rm('src/app/x.gpu.ts');
    const r = await until(() => !app.mark(X).present && app.mark(M0).transformed, { timeout: DEADLINE });
    ok = r.ok; steps.push(`delete: output follows ${r.ok} (${r.ms}ms)`);
  } else if (kind === 'b') { // rename + import updated, then edit
    const fromR = w.proc.text.length;
    fs.renameSync(app.p('src/app/x.gpu.ts'), app.p('src/app/y.gpu.ts'));
    app.useShader('x', 'app/y.gpu');
    await w.proc.waitFor(/generation complete|\[ERROR\]|error/i, DEADLINE, fromR); // a rebuild must have happened after the rename
    const r1 = await until(() => app.mark(X).transformed && app.mark(X).ast === 1, { timeout: DEADLINE });
    X = mk(32);
    app.write('src/app/y.gpu.ts', shaderSrc({ mark: X, helper: false }));
    const r2 = await until(() => app.mark(X).transformed && !app.mark(mk(31)).present, { timeout: DEADLINE });
    ok = r1.ok && r2.ok; steps.push(`rename: marker once in output ${r1.ok} (${r1.ms}ms)`, `edit after rename follows ${r2.ok} (${r2.ms}ms)`);
  } else { // case-only rename Y.gpu.ts, then edit
    const fromR = w.proc.text.length;
    fs.renameSync(app.p('src/app/x.gpu.ts'), app.p('src/app/xtmp.gpu.ts')); // two-step rename so that case-insensitive and sensitive file systems behave the same
    fs.renameSync(app.p('src/app/xtmp.gpu.ts'), app.p('src/app/X.gpu.ts'));
    app.useShader('x', 'app/X.gpu');
    await w.proc.waitFor(/generation complete|\[ERROR\]|error/i, DEADLINE, fromR);
    const r1 = await until(() => app.mark(X).transformed && app.mark(X).ast === 1, { timeout: DEADLINE });
    X = mk(33);
    app.write('src/app/X.gpu.ts', shaderSrc({ mark: X, helper: false }));
    const r2 = await until(() => app.mark(X).transformed && !app.mark(mk(31)).present, { timeout: DEADLINE });
    ok = r1.ok && r2.ok; steps.push(`case rename: output follows ${r1.ok} (${r1.ms}ms)`, `edit afterwards follows ${r2.ok} (${r2.ms}ms)`);
  }
  const told = tail(w.proc.text, 4).replace(/\s+/g, ' ').slice(0, 200);
  if (ok) return finish(w, R('CORRECT', steps.join('; ')));
  return finish(w, R(said(w.proc.text, 'error') ? 'LOUD' : 'SILENT-WRONG', `${steps.join('; ')}; output kept old state; last output: ${told}`));
}

// ---- S17 mtime-preserving edits -----------------------------------------------------------------------------------------
// a: the file gets the new content and its previous mtime back; b: the new content and mtime 2020-01-01. Same size as before (the worst case
// for size+mtime keyed caches). A plain non-shader module (ctl.ts) gets the same treatment as a CONTROL, to tell a shader-integration problem
// from the Angular watcher's own behaviour.
const CTL = (v) => `export const CTL = ${v};\n(globalThis as Record<string, unknown>)['__ctl'] = CTL;\n`;
export async function s17(c, kind) {
  if (kind === 'c') return s17oneOff(c);
  const b = await begin(c, { before: (app) => { app.write('src/app/ctl.ts', CTL('0.5111')); app.edit('src/main.ts', (t) => `import './app/ctl';\n${t}`); } });
  if (b.fail) return b.fail;
  const { app, w } = b;
  const trick = async (rel, text, when) => {
    const prev = fs.statSync(app.p(rel));
    app.write(rel, text);
    fs.utimesSync(app.p(rel), prev.atime, when ?? prev.mtime);
  };
  const when = kind === 'a' ? null : new Date('2020-01-01T00:00:00Z');
  const label = kind === 'a' ? 'restored mtime' : 'mtime 2020-01-01';
  const marker = mk(kind === 'a' ? 41 : 42);
  await trick(SHADER, shaderSrc({ mark: marker }), when);
  const r = await until(() => app.mark(marker).transformed, { timeout: DEADLINE });
  const detail = `${label}: shader output follows ${r.ok} (${r.ms}ms)`;
  if (r.ok) return finish(w, R('CORRECT', detail));
  const sawRebuild = /Changes detected/.test(w.proc.text);
  await trick('src/app/ctl.ts', CTL('0.5112'), when); // control: plain module, same trick
  const ctl = await until(() => app.mark('0.5112').present, { timeout: 15000 });
  return finish(w, R(said(w.proc.text, 'error') ? 'LOUD' : 'SILENT-WRONG', `${detail}; the watcher reported "Changes detected": ${sawRebuild}; CONTROL (plain non-shader module, same trick) follows: ${ctl.ok}${ctl.ok ? '' : ' => the Angular watcher itself ignores such edits, not specific to shaders'}`));
}
async function s17oneOff(c) {
  const app = await freshApp(c);
  const parts = [];
  const b1 = await app.build(['-c', 'development'], { tag: 'build1' });
  let ok = b1.code === 0 && app.mark(M0).transformed;
  for (const [name, when] of [['restored mtime', null], ['mtime 2020-01-01', new Date('2020-01-01T00:00:00Z')]]) {
    const prev = fs.statSync(app.p(SHADER));
    const marker = name === 'restored mtime' ? mk(43) : mk(44);
    app.write(SHADER, shaderSrc({ mark: marker }));
    fs.utimesSync(app.p(SHADER), prev.atime, when ?? prev.mtime);
    const b = await app.build(['-c', 'development'], { tag: `build-${name}` });
    const m = app.mark(marker);
    parts.push(`${name}: warm one-off build exit ${b.code}, new marker transformed ${m.transformed}`);
    if (!m.transformed) { ok = false; if (b.code === 0) parts.push(`(old marker still present: ${app.mark(M0).present || app.mark(mk(43)).present})`); }
  }
  return ok ? R('CORRECT', parts.join('; ')) : R('SILENT-WRONG', parts.join('; ') + ' (stale output, exit 0, nothing said)');
}

// ---- S18 delete then recreate; create the missing file of a failed import ------------------------------------------------
// A plain non-shader module (ctlmod.ts, imported by uses-ctl.ts) gets the same treatment in the same run as a CONTROL.
const CM = (v) => `export const CM = ${v};\n`;
const useCtl = (app, spec) => { app.write('src/app/uses-ctl.ts', `import { CM } from '${spec}';\n(globalThis as Record<string, unknown>)['__cm'] = CM;\n`); app.edit('src/main.ts', (t) => (t.includes('uses-ctl') ? t : `import './app/uses-ctl';\n${t}`)); };
export async function s18(c, kind) {
  if (kind === 'a') {
    const X = mk(61);
    const b = await begin(c, { before: (app) => { addX(app, X); app.write('src/app/ctlmod.ts', CM('0.5121')); useCtl(app, './ctlmod'); } });
    if (b.fail) return b.fail;
    const { app, w } = b;
    const up = await until(() => app.mark(X).transformed && app.mark('0.5121').present, { timeout: DEADLINE });
    app.rm('src/app/x.gpu.ts');
    app.rm('src/app/ctlmod.ts');
    const from = w.proc.text.length;
    const loud = await until(() => said(w.proc.text.slice(from), 'x.gpu'), { timeout: 15000 });
    const Y = mk(62);
    app.write('src/app/x.gpu.ts', shaderSrc({ mark: Y, helper: false })); // recreated with a new marker, importers NOT touched
    app.write('src/app/ctlmod.ts', CM('0.5122'));
    const r = await until(() => app.mark(Y).transformed && !app.mark(X).present, { timeout: DEADLINE });
    const ctl = r.ok ? { ok: 'n/a' } : await until(() => app.mark('0.5122').present, { timeout: 5000 });
    const detail = `initial ok ${up.ok}; after delete a message naming x.gpu: ${loud.ok}; after recreating the file (importer untouched) the output has the new marker: ${r.ok} (${r.ms}ms)${r.ok ? '' : `; CONTROL (plain module deleted and recreated the same way) follows: ${ctl.ok}`}`;
    return finish(w, r.ok ? R('CORRECT', detail) : R(said(w.proc.text, 'error') ? 'LOUD' : 'SILENT-WRONG', detail + ' | needs another save'));
  }
  // b: the importers reference files that do not exist yet; start watching (initial build fails), then create them
  const Z = mk(63);
  const app = await freshApp(c);
  app.useShader('z', 'app/z.gpu'); // z.gpu.ts is missing
  useCtl(app, './missing-ctl'); // control: a missing plain module
  const proc = app.startNg(['build', '--watch', '-c', 'development'], { tag: 'watch-missing' });
  const loud = await proc.waitFor(/z\.gpu/i, 90000);
  app.write('src/app/z.gpu.ts', shaderSrc({ mark: Z, helper: false }));
  app.write('src/app/missing-ctl.ts', CM('0.5123'));
  const r = await until(() => app.mark(Z).transformed, { timeout: DEADLINE });
  const ctl = await until(() => app.mark('0.5123').present, { timeout: r.ok ? 15000 : 5000 });
  const detail = `a message naming the missing z.gpu appeared: ${loud}; after creating the missing shader (importer untouched) the output has it: ${r.ok} (${r.ms}ms); CONTROL (missing plain module created the same way) follows: ${ctl.ok}`;
  let res;
  if (r.ok) res = R('CORRECT', detail);
  else {
    app.write('src/app/uses-z.ts', app.read('src/app/uses-z.ts') + '\n'); // does a save of the importer fix it?
    const r2 = await until(() => app.mark(Z).transformed, { timeout: DEADLINE });
    res = R(loud ? 'LOUD' : 'SILENT-WRONG', `${detail}; after saving the importer: ${r2.ok}`);
  }
  await proc.stop();
  return res;
}
