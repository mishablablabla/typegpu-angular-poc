// S07 import forms, S14 not applied, S15 stale artifact, S16 fileReplacements, S19 source mistakes, S20 external shaders,
// S21 Angular drift, S22 adversarial names, S23 diagnostics sample.
import fs from 'node:fs';
import path from 'node:path';
import { freshApp, freshNew, M0, H0, mk, shaderSrc, helperSrc, markerState, readOutput, PKG } from './app.mjs';
import { R, classify, said, tail, head, startServe, servedMark } from './kit.mjs';
import { writeWgslSpec, testArgs, testVerdict } from './s-basic.mjs';
import { until, run, childEnv, rmUnder, WIN } from './util.mjs';
import { npm } from './app.mjs';

const SHADER = 'src/app/my-canvas/my-canvas.gpu.ts';
const DEADLINE = 30000;
const fnShader = (name, mark, { importsExtra = '', bodyExtra = '' } = {}) => shaderSrc({ name, mark, helper: false, importsExtra, bodyExtra });

// ---- S07 ------------------------------------------------------------------------------------------------------------------
export async function s07(c) {
  const app = await freshApp(c);
  const [MS, MA, MB, MC] = [mk(301), mk(302), mk(303), mk(304)];
  app.write('src/app/shaders/shared.gpu.ts', `export function shift(x: number) {\n  'use gpu';\n  return x * ${MS};\n}\n`);
  app.write('src/app/shaders/a.gpu.ts', fnShader('aShader', MA, { importsExtra: "import { shift } from './shared.gpu';", bodyExtra: '    const s = shift(k);\n' }));
  app.write('src/app/shaders/b.gpu.ts', fnShader('bShader', MB, { importsExtra: "import { shift } from './shared.gpu';", bodyExtra: '    const s = shift(k);\n' }));
  app.write('src/app/shaders/c.gpu.ts', fnShader('cShader', MC, { importsExtra: "import { aShader } from './a.gpu';\nexport const again = aShader;" }));
  app.useShader('a', 'app/shaders/a.gpu', 'aShader');
  app.useShader('b', 'app/shaders/b.gpu', 'bShader');
  app.useShader('c', 'app/shaders/c.gpu', 'cShader');
  const b = await app.build(['-c', 'production'], { tag: 'build-prod' });
  const chk = await app.check();
  const st = Object.fromEntries([['shared', MS], ['a', MA], ['b', MB], ['c', MC]].map(([k, m]) => [k, app.mark(m)]));
  const once = Object.values(st).every((s) => s.transformed && s.ast === 1);
  const detail = `build exit ${b.code}; transformed once (ast count): ${Object.entries(st).map(([k, s]) => `${k}=${s.ast}`).join(' ')}; check exit ${chk.code}`;
  if (b.code !== 0) return R('LOUD', detail + ' | ' + tail(b.text, 5));
  if (once && chk.code === 0) return R('CORRECT', detail);
  return R(chk.code !== 0 || said(b.text, 'use gpu') ? 'LOUD' : 'SILENT-WRONG', detail);
}

function addAlias(app) {
  app.edit('tsconfig.json', (t) => (t.includes('"@shaders/*"')
    ? t.replace('"@shaders/*"', '"@sh/*": ["./src/app/shaders/*"],\n      "@shaders/*"')
    : t.replace('"compilerOptions": {', '"compilerOptions": {\n    "paths": { "@sh/*": ["./src/app/shaders/*"] },')));
}
export async function s07form(c, form) {
  const app = await freshApp(c);
  const MF = mk(310 + ['relative', 'js', 'alias', 'barrel', 'dynamic'].indexOf(form));
  app.write('src/app/shaders/f.gpu.ts', fnShader('fShader', MF));
  const prebuild = c.mode === 'prebuild';
  if (form === 'relative') app.useShader('f', 'app/shaders/f.gpu', 'fShader', './shaders/f.gpu');
  else if (form === 'js') app.useShader('f', 'app/shaders/f.gpu', 'fShader', app.spec('src/app/uses-f.ts', 'app/shaders/f.gpu') + '.js');
  else if (form === 'alias') { addAlias(app); app.useShader('f', 'app/shaders/f.gpu', 'fShader', '@sh/f.gpu'); }
  else if (form === 'barrel') {
    if (prebuild) { app.write('src/app/shaders/barrel.gpu.ts', "export * from './f.gpu';\n"); app.useShader('f', 'app/shaders/barrel.gpu', 'fShader'); }
    else { app.write('src/app/shaders/index.ts', "export * from './f.gpu';\n"); app.useShader('f', 'app/shaders/index', 'fShader', './shaders'); }
  } else {
    const s = app.spec('src/app/uses-f.ts', 'app/shaders/f.gpu');
    app.write('src/app/uses-f.ts', `(globalThis as Record<string, unknown>)['__m_f'] = () => import('${s}');\n`);
    app.edit('src/main.ts', (t) => `import './app/uses-f';\n${t}`);
  }
  const b = await app.build(['-c', 'production'], { tag: 'build-prod' });
  const chk = await app.check();
  const m = app.mark(MF);
  const detail = `${form}: build exit ${b.code}, marker ast=${m.ast} transformed=${m.transformed} (files: ${m.where.join(',')}), check exit ${chk.code}${b.code ? ' | ' + tail(b.text, 4).replace(/\s+/g, ' ').slice(0, 260) : ''}`;
  if (b.code !== 0) return R('LOUD', detail, { named: said(b.text, 'f.gpu', "'./shaders/f.gpu'", '@sh/f.gpu') });
  if (m.transformed && m.ast === 1 && chk.code === 0) return R('CORRECT', detail);
  return R(chk.code !== 0 || said(b.text, 'use gpu', 'f.gpu') ? 'LOUD' : 'SILENT-WRONG', detail);
}

// ---- S14 --------------------------------------------------------------------------------------------------------------------
const ARCH = (a) => a.json('angular.json').projects.demo.architect;
const setArch = (a, fn) => a.editJson('angular.json', (j) => { fn(j.projects.demo.architect); });

export async function s14(c, kind) {
  if (kind === 'a' && c.mode === 'prebuild') return R('N/A', 'a builder is chosen per target, not per configuration: there is no production-only wrapper to remove (the per-target swap is S15)');
  if (kind === 'c' && c.angular === 20) return R('N/A', 'Angular 20: the test target is Karma, which ng add leaves unchanged; the stock-vs-wrapper question is the Karma builder (not covered here)');
  const app = await freshApp(c);
  const notes = [];
  if (kind === 'a') setArch(app, (t) => { t.build.configurations.production.plugins = []; });
  let servedInfo = '', cat;
  if (kind === 'b') {
    await app.build(['-c', 'development'], { tag: 'dev-build' }); // prebuild: shaders-dist exists (M0); plugin: no effect
    app.write(SHADER, shaderSrc({ mark: mk(401) })); // prebuild: shaders-dist is now stale
    setArch(app, (t) => { t.serve.builder = '@angular/build:dev-server'; });
    const s = await startServe(app, { tag: 'serve-stock' });
    let m = {}, old = {};
    if (s.up) { await sleep0(1500); m = await servedMark(s.port, mk(401)); old = await servedMark(s.port, M0); }
    const out = s.proc.text;
    await s.proc.stop();
    servedInfo = `stock dev-server: up ${s.up}; served shader has the CURRENT marker transformed ${m.transformed}, raw-only ${m.rawOnly}; OLD marker still served ${old.transformed}; told: ${said(out, 'use gpu', 'my-canvas.gpu', 'untransformed') ? 'yes: ' + tail(out, 3).replace(/\s+/g, ' ').slice(0, 200) : 'nothing'}`;
    notes.push(servedInfo);
    var servedCls = !s.up ? { category: 'LOUD' } : classify({ exit0: true, transformed: !!m.transformed, signals: { serve: said(out, 'use gpu', 'my-canvas.gpu', 'untransformed', 'error') } });
    app.rm('dist');
  }
  if (kind === 'c') {
    await app.build(['-c', 'development'], { tag: 'dev-build' });
    app.write(SHADER, shaderSrc({ mark: mk(402) }));
    setArch(app, (t) => { t.test = { builder: '@angular/build:unit-test' }; });
    writeWgslSpec(app, mk(402), H0);
  } else writeWgslSpec(app, kind === 'b' ? mk(401) : M0, H0);
  const b = await app.build([], { tag: 'build-prod' });
  const chk = await app.check();
  const target = kind === 'b' ? mk(401) : kind === 'c' ? mk(402) : M0;
  const prodState = app.mark(target);
  notes.push(`production build exit ${b.code}, shader transformed in the bundle ${prodState.transformed} (raw-only ${prodState.rawOnly}), bundle check exit ${chk.code}${chk.code ? ' [' + tail(chk.text, 2).replace(/\s+/g, ' ').slice(0, 160) + ']' : ''}`);
  const env = c.angular === 20 && process.env.CHROME_BIN ? { CHROME_BIN: process.env.CHROME_BIN } : {};
  const t = await app.ng(['test', ...testArgs(c)], { tag: 'ng-test', env, timeout: 300000 });
  const tv = testVerdict(t);
  notes.push(`ng test exit ${t.code}, spec ran ${tv.ran}, markers resolved ${tv.ok}${t.code ? ' [' + tail(t.text, 3).replace(/\s+/g, ' ').slice(0, 200) + ']' : ''}`);
  if (kind === 'b') cat = servedCls.category;
  else if (kind === 'c') cat = tv.ok ? 'CORRECT' : 'LOUD';
  else cat = classify({ exit0: b.code === 0, transformed: prodState.transformed, signals: { build: said(b.text, 'use gpu', 'my-canvas.gpu'), check: chk.code !== 0 } }).category;
  const silentTest = kind === 'c' && !tv.ok && t.code === 0;
  return R(silentTest ? 'SILENT-WRONG' : cat, notes.join(' | '));
}
const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- S15 --------------------------------------------------------------------------------------------------------------------
export async function s15(c) {
  const app = await freshApp(c);
  const b1 = await app.build([], { tag: 'build-1' });
  app.write(SHADER, shaderSrc({ mark: mk(411) }));
  const b1b = await app.build([], { tag: 'build-1b-edited' });
  const ok1 = app.mark(mk(411)).transformed;
  app.write(SHADER, shaderSrc({ mark: mk(412) })); // newer than anything built so far
  setArch(app, (t) => {
    t.build.builder = '@angular/build:application';
    delete t.build.options.plugins;
    for (const cfg of Object.values(t.build.configurations ?? {})) delete cfg.plugins;
  });
  app.rm('dist');
  const b2 = await app.build([], { tag: 'build-stock' });
  const chk = await app.check();
  const cur = app.mark(mk(412)), old = app.mark(mk(411));
  const detail = `before the swap: bare build with the new edit reached the bundle ${ok1} (exit ${b1b.code}); after swapping to the stock application builder and editing again: build exit ${b2.code}; bundle has the NEWEST shader transformed ${cur.transformed} (raw-only ${cur.rawOnly}), the OLD shader (previous build) ${old.transformed}; build said something about the shader ${said(b2.text, 'use gpu', 'my-canvas.gpu')}; bundle check exit ${chk.code}${chk.code ? ' [' + tail(chk.text, 2).replace(/\s+/g, ' ').slice(0, 140) + ']' : ''}`;
  const cls = classify({ exit0: b2.code === 0, transformed: cur.transformed, signals: { build: said(b2.text, 'use gpu', 'my-canvas.gpu', 'shaders-dist'), check: chk.code !== 0 } });
  return R(cls.category, detail);
}

// ---- S16 --------------------------------------------------------------------------------------------------------------------
export async function s16(c, kind) {
  if (kind === 'b' && c.mode === 'plugin') return R('N/A', 'prebuild-only workaround variant (replace the generated module); in plugin mode it is the same as S16');
  const app = await freshApp(c);
  const MR = mk(421);
  app.write('src/app/my-canvas/my-canvas.prod.gpu.ts', shaderSrc({ mark: MR }));
  // control: the classic environment-file replacement of a plain module must work in the same build
  app.write('src/app/env.ts', "export const ENV = 0.5131;\n(globalThis as Record<string, unknown>)['__env'] = ENV;\n");
  app.write('src/app/env.prod.ts', "export const ENV = 0.5132;\n(globalThis as Record<string, unknown>)['__env'] = ENV;\n");
  app.edit('src/main.ts', (t) => `import './app/env';\n${t}`);
  if (kind === 'a') setArch(app, (t) => { t.build.configurations.production.fileReplacements = [{ replace: SHADER, with: 'src/app/my-canvas/my-canvas.prod.gpu.ts' }, { replace: 'src/app/env.ts', with: 'src/app/env.prod.ts' }]; });
  else {
    await app.build(['-c', 'development'], { tag: 'dev-build' }); // creates shaders-dist
    setArch(app, (t) => { t.build.configurations.production.fileReplacements = [{ replace: 'shaders-dist/app/my-canvas/my-canvas.gpu.js', with: 'shaders-dist/app/my-canvas/my-canvas.prod.gpu.js' }, { replace: 'src/app/env.ts', with: 'src/app/env.prod.ts' }]; });
  }
  const b = await app.build([], { tag: 'build-prod' });
  const chk = await app.check();
  const rep = app.mark(MR), orig = app.mark(M0);
  const envOk = app.mark('0.5132').present && !app.mark('0.5131').present;
  const detail = `production build exit ${b.code}; replacement marker transformed ${rep.transformed}; ORIGINAL marker still in the bundle ${orig.present}; CONTROL (plain env.ts -> env.prod.ts replacement in the same build) applied: ${envOk}; check exit ${chk.code}${b.code ? ' | ' + tail(b.text, 4).replace(/\s+/g, ' ').slice(0, 240) : ''}`;
  const cls = classify({ exit0: b.code === 0, transformed: rep.transformed && !orig.present, signals: { build: said(b.text, 'fileReplacements', 'replace'), check: chk.code !== 0 } });
  return R(cls.category, detail);
}

// ---- S19 --------------------------------------------------------------------------------------------------------------------
export async function s19(c, kind) {
  const app = await freshApp(c);
  const MK = mk(430 + 'abcd'.indexOf(kind));
  let id = 'm', fileSrc, rel, exportName, spec;
  if (kind === 'a') { rel = 'src/app/shaders/typo.gpu.ts'; fileSrc = `export function typoHelper(x: number) {\n  'use  gpu';\n  return x * ${MK};\n}\n`; exportName = 'typoHelper'; spec = app.spec('src/app/uses-m.ts', 'app/shaders/typo.gpu'); }
  if (kind === 'b') { rel = 'src/app/plain.ts'; fileSrc = `export function plainHelper(x: number) {\n  'use gpu';\n  return x * ${MK};\n}\n`; exportName = 'plainHelper'; spec = './plain'; }
  if (kind === 'c') { rel = 'src/app/thing.ts'; fileSrc = `export function thing(x: number) {\n  'use gpu';\n  return x * ${MK};\n}\n`; exportName = 'thing'; spec = c.mode === 'prebuild' ? '@shaders/app/thing.gpu' : './thing.gpu'; }
  if (kind === 'd') { rel = 'src/app/shaders/comp.gpu.ts'; fileSrc = `import { App } from '../app';\nexport const appRef = App;\n` + fnShader('compShader', MK); exportName = 'compShader'; spec = app.spec('src/app/uses-m.ts', 'app/shaders/comp.gpu'); }
  app.write(rel, fileSrc);
  app.useShader(id, null, exportName, spec);
  const b = await app.build(['-c', 'production'], { tag: 'build-prod' });
  const chk = await app.check();
  const m = app.mark(MK);
  const name = path.basename(rel);
  const named = said(b.text, name);
  const detail = `${kind}: build exit ${b.code}, marker transformed ${m.transformed} (raw-only ${m.rawOnly}), build message names ${name}: ${named}, bundle check exit ${chk.code}${b.code ? ' | ' + tail(b.text, 4).replace(/\s+/g, ' ').slice(0, 240) : ''}`;
  if (kind === 'd') { // expected: either transformed (CORRECT) or a message; a transformed shader is the good outcome
    const cls = classify({ exit0: b.code === 0, transformed: m.transformed, signals: { check: chk.code !== 0, build: named } });
    return R(cls.category, detail, { named });
  }
  if (kind === 'a') return b.code === 0 && !m.transformed && !named && chk.code === 0 ? R('SILENT-WRONG', detail + ' (a misspelled directive is just a string: nothing can detect it at build time)') : R(b.code ? 'LOUD' : 'LOUD', detail);
  const cls = classify({ exit0: b.code === 0, transformed: m.transformed, signals: { check: chk.code !== 0, build: named || said(b.text, 'use gpu') } });
  return R(cls.category, detail, { named });
}

// ---- S20 --------------------------------------------------------------------------------------------------------------------
function installFakePackage(app, MK, variant) {
  const dir = `node_modules/matrix-shader-pkg`;
  const body = (ext) => `function pkgShader(time, tint) {\n  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {\n    'use gpu';\n    const k = ${MK}${variant === 'sloppy' ? ' + 010' : ''};\n    return d.vec4f(input.uv.x * k, 0, 0, 1);\n  });\n}\n`;
  if (variant === 'sloppy') {
    app.write(`${dir}/package.json`, JSON.stringify({ name: 'matrix-shader-pkg', version: '1.0.0', exports: { './shader.gpu.cjs': { types: './shader.gpu.d.cts', default: './shader.gpu.cjs' } } }));
    app.write(`${dir}/shader.gpu.cjs`, `const { default: tgpu, d } = (() => { const m = require('typegpu'); return { default: m.default ?? m.tgpu ?? m, d: m.d }; })();\n${body()}exports.pkgShader = pkgShader;\n`);
    app.write(`${dir}/shader.gpu.d.cts`, 'export function pkgShader(time: unknown, tint: unknown): unknown;\n');
  } else {
    app.write(`${dir}/package.json`, JSON.stringify({ name: 'matrix-shader-pkg', version: '1.0.0', type: 'module', exports: { './shader.gpu.js': { types: './shader.gpu.d.ts', default: './shader.gpu.js' } } }));
    app.write(`${dir}/shader.gpu.js`, `import tgpu, { d } from 'typegpu';\nexport ${body()}`);
    app.write(`${dir}/shader.gpu.d.ts`, 'export function pkgShader(time: unknown, tint: unknown): unknown;\n');
  }
}
export async function s20(c, kind) {
  const app = await freshApp(c);
  const MK = mk(440 + 'abc'.indexOf(kind));
  let ext = {};
  if (kind === 'a' || kind === 'b') {
    installFakePackage(app, MK, kind === 'b' ? 'sloppy' : 'esm');
    const spec = kind === 'a' ? 'matrix-shader-pkg/shader.gpu.js' : 'matrix-shader-pkg/shader.gpu.cjs';
    app.write('src/app/uses-pkg.ts', `import { pkgShader } from '${spec}';\n(globalThis as Record<string, unknown>)['__m_pkg'] = pkgShader;\n`);
    app.edit('src/main.ts', (t) => `import './app/uses-pkg';\n${t}`);
  } else {
    app.write('projects/shared-lib/src/lib.gpu.ts', fnShader('libShader', MK));
    app.edit('tsconfig.json', (t) => (t.includes('"@shaders/*"') ? t.replace('"@shaders/*"', '"@shared/*": ["./projects/shared-lib/src/*"],\n      "@shaders/*"') : t.replace('"compilerOptions": {', '"compilerOptions": {\n    "paths": { "@shared/*": ["./projects/shared-lib/src/*"] },')));
    app.write('src/app/uses-lib.ts', `import { libShader } from '@shared/lib.gpu';\n(globalThis as Record<string, unknown>)['__m_lib'] = libShader;\n`);
    app.edit('src/main.ts', (t) => `import './app/uses-lib';\n${t}`);
  }
  const b = await app.build(['-c', 'production'], { tag: 'build-prod' });
  const chk = await app.check();
  const m = app.mark(MK);
  const detail = `${kind === 'a' ? 'node_modules *.gpu.js' : kind === 'b' ? 'node_modules sloppy *.gpu.cjs' : 'workspace lib via tsconfig paths'}: build exit ${b.code}, marker transformed ${m.transformed} (raw-only ${m.rawOnly}), bundle check exit ${chk.code}${b.code ? ' | ' + tail(b.text, 5).replace(/\s+/g, ' ').slice(0, 300) : ''}`;
  const cls = classify({ exit0: b.code === 0, transformed: m.transformed, signals: { check: chk.code !== 0, build: said(b.text, 'use gpu', 'untransformed', '.gpu.') } });
  let cat = cls.category;
  if (cat === 'LOUD' && c.mode === 'prebuild' && kind !== 'b') cat = 'LOUD';
  return R(cat, detail);
}

// ---- S21 --------------------------------------------------------------------------------------------------------------------
export async function s21(c) {
  if (c.angular !== 21) return R('N/A', `Angular drift (ng update 21 -> 22) is only defined for --angular 21 (this run: ${c.angular})`);
  const app = await freshApp(c);
  writeWgslSpec(app);
  const u = await app.ng(['update', '@angular/core@22', '@angular/cli@22', '--force', '--allow-dirty'], { tag: 'ng-update', timeout: 600000 });
  const b = await app.build([], { tag: 'build-prod' });
  const chk = await app.check();
  const m = app.mark(M0);
  const t = await app.ng(['test', ...testArgs({ angular: 22 })], { tag: 'ng-test', timeout: 300000 });
  const tv = testVerdict(t);
  const detail = `ng update exit ${u.code}; build exit ${b.code}, shader transformed ${m.transformed}; check exit ${chk.code}; ng test exit ${t.code}, markers resolved ${tv.ok}`;
  return u.code === 0 && b.code === 0 && m.transformed && chk.code === 0 && tv.ok ? R('CORRECT', detail) : R(b.code || u.code ? 'LOUD' : 'SILENT-WRONG', detail + ' | ' + tail(u.text, 4));
}

// ---- S22 --------------------------------------------------------------------------------------------------------------------
const NAMES = {
  space: ['my shader', 22], hash: ['a#b', 23], squote: ["it's", 24], dquote: ['say"hi"', 25], unicode: ['ünïçøde', 26], suffix: ['evil.typegpu-shader', 27],
};
export async function s22(c, kind) {
  const [name, n] = NAMES[kind];
  if (WIN && /["]/.test(name)) return R('N/A', 'a double quote is not a legal file-name character on Windows');
  const app = await freshApp(c);
  const MK = mk(450 + n);
  app.write(`src/app/names/${name}.gpu.ts`, fnShader('nameShader', MK));
  const target = `app/names/${name}.gpu`;
  const s = app.spec('src/app/uses-n.ts', target);
  const lit = JSON.stringify(s); // a valid string literal for any file name
  app.write('src/app/uses-n.ts', `import { nameShader } from ${lit};\n(globalThis as Record<string, unknown>)['__m_n'] = nameShader;\n`);
  app.edit('src/main.ts', (t) => `import './app/uses-n';\n${t}`);
  const b = await app.build(['-c', 'production'], { tag: 'build-prod' });
  const chk = await app.check();
  const m = app.mark(MK);
  const detail = `"${name}": build exit ${b.code}, marker ast=${m.ast} transformed ${m.transformed}, check exit ${chk.code}${b.code ? ' | ' + tail(b.text, 4).replace(/\s+/g, ' ').slice(0, 260) : ''}`;
  if (b.code !== 0) return R('LOUD', detail, { named: said(b.text, name) });
  if (m.transformed && m.ast === 1 && chk.code === 0) return R('CORRECT', detail);
  return R(chk.code !== 0 || said(b.text, 'use gpu') ? 'LOUD' : 'SILENT-WRONG', detail);
}

// ---- S23 --------------------------------------------------------------------------------------------------------------------
export async function s23(c) {
  const cases = [];
  const record = async (label, app, r, nameNeedles, actionRe) => {
    const text = r.text;
    const row = { label, exit: r.code, file: said(text, ...nameNeedles), action: actionRe.test(text), first12: head(text, 12) };
    cases.push(row);
    fs.writeFileSync(path.join(c.ev, `diag-${label.replace(/\W+/g, '_')}.txt`), `exit ${r.code}\n${row.first12}\n`);
  };
  const ACTION = /(install|run |ng add|move|remove|rename|fix|check|use |add |set |unsupported|not supported|set up|configure|reinstall|npm i)/i;
  { const app = await freshApp(c); app.write(SHADER, shaderSrc({ mark: mk(461) }).replace('const k =', 'const k = ;;( ')); await record('syntax error build', app, await app.build(['-c', 'development'], { tag: 'syntax' }), ['my-canvas.gpu'], ACTION); }
  { const app = await freshApp(c); app.write(SHADER, shaderSrc({ mark: mk(462), bodyExtra: '    try { const z = 1; } catch (e) { const y = 2; }\n' })); await record('try-catch build', app, await app.build(['-c', 'development'], { tag: 'trycatch' }), ['my-canvas.gpu'], ACTION); }
  if (c.mode === 'plugin') { const app = await freshApp(c); setArch(app, (t) => { t.build.options.plugins = ['node_modules/@typegpu-poc/angular/tools/typegpu-shaders.WRONG.mjs']; }); await record('wrong plugin path', app, await app.build(['-c', 'development'], { tag: 'wrong-path' }), ['typegpu-shaders', 'plugin'], ACTION); }
  for (const dep of ['@babel/core', 'unplugin-typegpu']) {
    const app = await freshApp(c);
    fs.renameSync(app.p('node_modules', ...dep.split('/')), app.p('node_modules', ...dep.split('/')) + '.away');
    await record(`missing ${dep}`, app, await app.build(['-c', 'development'], { tag: 'missing-' + dep }), [dep, 'typegpu'], ACTION);
  }
  { // ng generate in a project where the package is installed but `ng add` never ran
    const app = await freshNew(c, { tag: 'gen' });
    const inst = await npm(['install', '--no-audit', '--no-fund', c.w.tgz], { cwd: app.dir, timeout: 300000, logFile: app.logName('npm-install-tgz') });
    const g = await app.ng(['generate', `${PKG}:component`, 'my-canvas'], { tag: 'generate-before-add' });
    cases.push({ label: 'ng generate before ng add', installExit: inst.code, exit: g.code, file: said(g.text, 'angular.json', 'build target', 'my-canvas'), action: /ng add/i.test(g.text), first12: head(g.text, 12) });
    fs.writeFileSync(path.join(c.ev, 'diag-ng_generate_before_ng_add.txt'), `install exit ${inst.code}; generate exit ${g.code}\n${head(g.text, 12)}\n`);
  }
  const lines = cases.map((x) => `${x.label}: exit ${x.exit}, file named ${x.file}, action named ${x.action}`);
  const allLoud = cases.every((x) => x.exit !== 0);
  const gaps = cases.filter((x) => x.exit !== 0 && !(x.file && x.action)).map((x) => x.label);
  const detail = lines.join(' | ') + (gaps.length ? ` | diagnostic gaps (file or action not named): ${gaps.join(', ')}` : '');
  return R(allLoud ? 'LOUD' : 'SILENT-WRONG', detail, { evidence: c.ev });
}
