// Watch-mode check of the shader pipeline, run against an app that `ng add` has configured
// (for example acceptance/work-22/demo after scripts/acceptance-clean-consumer.sh):
//   node scripts/verify-shader-watch.mjs acceptance/work-22/demo [trials]
// Starts `ng build --watch -c development`, edits shader modules and records what the watcher does.
// It restores src/main.ts and removes its probe files at the end. Prints a table; exits 1 if an expectation fails
// (documented behaviours that are limitations are expectations too, so a change in them is noticed).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(process.argv[2] ?? '.');
const trials = Number(process.argv[3] ?? 4);
const src = (...p) => join(app, 'src', ...p);
const dist = join(app, 'dist', 'demo', 'browser');
const main = src('main.ts');
const results = [];
let failed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundle = () => readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
};

function startWatcher() {
  const child = spawn('npx', ['ng', 'build', '--watch', '--configuration', 'development'], { cwd: app, detached: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
  const state = { events: [], output: '', child };
  const onData = (chunk) => {
    const text = chunk.toString();
    state.output += text;
    for (const m of text.matchAll(/Application bundle generation (complete|failed)/g)) state.events.push({ type: m[1], at: Date.now(), index: state.output.length });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return state;
}
const stop = (w) => { try { process.kill(-w.child.pid, 'SIGKILL'); } catch {} };
/** Waits until a build event after `seen` events arrives; resolves to it, or undefined on timeout. */
async function nextEvent(w, seen, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (w.events.length > seen) return w.events[seen];
    await sleep(100);
  }
  return undefined;
}

const original = readFileSync(main, 'utf8');
const files = { helper: src('shaders', 'probe-helper.ts'), probe: src('shaders', 'probe.gpu.ts'), second: src('shaders', 'second.gpu.ts') };
const probeSource = (k, bad = false) =>
  bad ? 'export const probe = ;\n' : `import { HELPER } from './probe-helper';\nexport const probe = (x: number) => {\n  'use gpu';\n  return x * ${k} + HELPER;\n};\n`;
const setMain = (extra) => writeFileSync(main, original + extra);
const cleanup = () => {
  writeFileSync(main, original);
  for (const f of Object.values(files)) rmSync(f, { force: true });
  rmSync(src('shaders', 'late.gpu.ts'), { force: true });
};
process.on('exit', cleanup);

mkdirSync(src('shaders'), { recursive: true });
writeFileSync(files.helper, 'export const HELPER = 5001;\n');
writeFileSync(files.probe, probeSource(7001));
setMain("\nimport { probe } from './shaders/probe.gpu';\nconsole.log(probe(1));\n");

const w = startWatcher();
try {
  const first = await nextEvent(w, 0, 90000);
  record('initial watch build completes', first?.type === 'complete');
  await sleep(4000);
  record('initial bundle has the shader constant and the helper', bundle().includes('7001') && bundle().includes('5001'));

  let n = w.events.length;
  writeFileSync(files.probe, probeSource(7002));
  let ev = await nextEvent(w, n);
  record('edit of a shader constant rebuilds', ev?.type === 'complete', ev ? '' : 'no rebuild in 30 s');
  record('  ...and the bundle is fresh (7002 in, 7001 out)', bundle().includes('7002') && !bundle().includes('7001'));

  n = w.events.length;
  const outputBefore = w.output.length;
  writeFileSync(files.probe, probeSource(0, true));
  ev = await nextEvent(w, n);
  const errorText = w.output.slice(outputBefore);
  record('a syntax error makes the rebuild fail', ev?.type === 'failed');
  record('  ...and the message names the shader file with line and column', /probe\.gpu\.ts:\d+:\d+/.test(errorText), (errorText.match(/probe\.gpu\.ts:\d+:\d+/) ?? [''])[0]);
  record('  ...and the previous bundle stays in dist (stale until fixed, like any Angular error)', bundle().includes('7002'));

  n = w.events.length;
  writeFileSync(files.probe, probeSource(7003));
  ev = await nextEvent(w, n);
  record('fixing the error rebuilds with fresh output (7003 in, 7002 out)', ev?.type === 'complete' && bundle().includes('7003') && !bundle().includes('7002'));

  n = w.events.length;
  writeFileSync(files.helper, 'export const HELPER = 5002;\n');
  ev = await nextEvent(w, n);
  record('edit of a plain helper imported by a shader rebuilds', ev?.type === 'complete' && bundle().includes('5002') && !bundle().includes('5001'));

  n = w.events.length;
  writeFileSync(files.second, "export const second = (x: number) => {\n  'use gpu';\n  return x * 8001;\n};\n");
  setMain("\nimport { probe } from './shaders/probe.gpu';\nimport { second } from './shaders/second.gpu';\nconsole.log(probe(1), second(1));\n");
  ev = await nextEvent(w, n);
  record('adding a new *.gpu.ts module and importing it rebuilds and transforms it', ev?.type === 'complete' && bundle().includes('8001'));

  n = w.events.length;
  rmSync(files.second);
  setMain("\nimport { probe } from './shaders/probe.gpu';\nconsole.log(probe(1));\n");
  ev = await nextEvent(w, n);
  record('removing the import and the file rebuilds without the shader', ev?.type === 'complete' && !bundle().includes('8001'));

  // limitation: a file that did not exist when a resolve failed does not trigger a rebuild when it appears
  n = w.events.length;
  setMain("\nimport { probe } from './shaders/probe.gpu';\nimport { late } from './shaders/late.gpu';\nconsole.log(probe(1), late(1));\n");
  ev = await nextEvent(w, n);
  record('importing a *.gpu file that does not exist fails with "Could not resolve"', ev?.type === 'failed' && /Could not resolve "\.\/shaders\/late\.gpu"/.test(w.output));
  n = w.events.length;
  writeFileSync(src('shaders', 'late.gpu.ts'), "export const late = (x: number) => {\n  'use gpu';\n  return x * 9001;\n};\n");
  ev = await nextEvent(w, n, 12000);
  record('LIMITATION holds: creating that file afterwards does not rebuild by itself', ev === undefined, ev ? 'it rebuilt' : 'no rebuild in 12 s');
  n = w.events.length;
  setMain("\nimport { probe } from './shaders/probe.gpu';\nimport { late } from './shaders/late.gpu';\nconsole.log(probe(1), late(1));\n");
  ev = await nextEvent(w, n);
  record('  ...editing the importer rebuilds', ev?.type === 'complete', ev ? ev.type : 'no rebuild in 30 s');
  record('  ...and the late module is in the bundle, transformed', bundle().includes('9001'));
} finally {
  stop(w);
  cleanup();
}

// Is the first edit right after the initial build ever lost? It was seen once and has not been reproduced.
for (const kind of ['shader (*.gpu.ts)', 'plain helper (no plugin involved)']) {
  let lost = 0;
  for (let i = 0; i < trials; i++) {
    const isShader = kind.startsWith('shader');
    writeFileSync(files.helper, 'export const HELPER = 5001;\n');
    writeFileSync(files.probe, probeSource(7001));
    setMain("\nimport { probe } from './shaders/probe.gpu';\nconsole.log(probe(1));\n");
    const t = startWatcher();
    await nextEvent(t, 0, 90000);
    if (isShader) writeFileSync(files.probe, probeSource(7100 + i));
    else writeFileSync(files.helper, `export const HELPER = ${5100 + i};\n`);
    const ev = await nextEvent(t, 1, 25000);
    if (!ev) lost++;
    stop(t);
    await sleep(500);
  }
  record(`first edit right after the initial build, ${kind}: rebuilt in ${trials - lost} of ${trials} trials`, true, lost ? `${lost} lost` : 'none lost');
  cleanup();
}
cleanup();
console.log(failed ? '\nSOME EXPECTATIONS FAILED' : '\nall expectations held');
process.exit(failed ? 1 : 0);
