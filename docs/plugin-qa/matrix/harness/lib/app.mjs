// The app under test: fixture creation (ng new once per Angular major, ng add + generate once per mode) and per-scenario copies.
import fs from 'node:fs';
import path from 'node:path';
import { Proc, run, childEnv, copyTree, rmUnder, sleep, until, httpGet, WIN } from './util.mjs';

export const PKG = '@typegpu-poc/angular';
export const CLI_VERSION = { 22: '22.2.4', 21: '21.2.28', 20: '20.3.41' };
// Markers: numeric literals that only one source file contains. M0 is in the shader body, H0 in a helper only the shader imports.
export const M0 = '0.3141';
export const H0 = '0.7007';
export const mk = (i) => `0.${4000 + i}7`; // fresh markers for edits (a trailing 7: esbuild prints 0.4120 as 0.412, which would hide the marker)

// ---- marker scanning (the verdict source: the BUILT output, never an exit code) ------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function readOutput(dir, exts = ['.js', '.mjs', '.cjs']) {
  const files = [];
  const walk = (d, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (exts.includes(path.extname(e.name))) {
        try {
          files.push({ rel: r, text: fs.readFileSync(path.join(d, e.name), 'utf8') });
        } catch {}
      }
    }
  };
  walk(dir, '');
  return files;
}
/**
 * State of a numeric marker in a set of output files.
 *  ast  = occurrences of the quoted string "<marker>": that is how TypeGPU's metadata (the transformed shader AST) stores a literal
 *         (`__TYPEGPU_META__` ... [5,"0.3141"]); a raw, untransformed shader never has the quoted form.
 *  raw  = occurrences of the bare number (the function body itself, transformed or not).
 *  meta = number of files that contain the marker AND `__TYPEGPU_META__`.
 */
export function markerState(files, m) {
  const quoted = new RegExp(`"${esc(m)}"`, 'g');
  const bare = new RegExp(`(?<![0-9.])0?${esc(m.replace(/^0/, ''))}(?![0-9])`, 'g');
  let ast = 0, raw = 0, meta = 0;
  const where = [];
  for (const f of files) {
    const a = (f.text.match(quoted) || []).length;
    const r = (f.text.match(bare) || []).length;
    ast += a;
    raw += r;
    if (r && f.text.includes('__TYPEGPU_META__') && a) meta++;
    if (r || a) where.push(f.rel);
  }
  return { ast, raw, meta, where, present: raw > 0 || ast > 0, transformed: ast > 0 && meta > 0, rawOnly: raw > 0 && ast === 0 };
}
export const metaCount = (files) => files.reduce((n, f) => n + (f.text.match(/__TYPEGPU_META__/g) || []).length, 0);

// ---- shader sources ------------------------------------------------------------------------------------------------
export function shaderSrc({ name = 'sceneFragment', mark, helper = true, importsExtra = '', bodyExtra = '' }) {
  return `import tgpu, { d, std } from 'typegpu';
${helper ? "import { HELP } from './helper';\n" : ''}${importsExtra}
export function ${name}(time: { $: number }, tint: { $: d.v3f }) {
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const k = ${mark};
${bodyExtra}    const base = d.vec3f(input.uv.x * k, input.uv.y, ${helper ? 'HELP' : '0.2'});
    return d.vec4f(std.mul(base, tint.$), 1);
  });
}
`;
}
export const helperSrc = (mark = H0) => `export const HELP = ${mark};\n`;

export class App {
  /** @param c scenario context (mode, angular, work, tgz, ev) @param dir app folder (contains angular.json) */
  constructor(c, dir) {
    this.c = c;
    this.dir = dir;
    this.mode = c.mode;
    this.seq = 0;
    this.procs = [];
  }
  p(...a) { return path.join(this.dir, ...a); }
  get dist() { return this.p('dist', 'demo', 'browser'); }
  get ngjs() { return this.p('node_modules', '@angular', 'cli', 'bin', 'ng.js'); }
  read(rel) { return fs.readFileSync(this.p(rel), 'utf8'); }
  write(rel, text) { fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true }); fs.writeFileSync(this.p(rel), text); }
  edit(rel, fn) { this.write(rel, fn(this.read(rel))); }
  exists(rel) { return fs.existsSync(this.p(rel)); }
  rm(rel) { rmUnder(this.c.w.work, this.p(rel)); }
  json(rel) { return JSON.parse(this.read(rel)); }
  editJson(rel, fn) { const j = this.json(rel); const r = fn(j); fs.writeFileSync(this.p(rel), JSON.stringify(r ?? j, null, 2) + '\n'); }
  /** A path under the project's source root, as the mode imports it from a file in src/app/<fromDir>. */
  spec(fromRel, targetRel) {
    // fromRel: file doing the import (relative to the app dir); targetRel: shader module path under src/, no extension, e.g. app/shaders/a.gpu
    if (this.mode === 'prebuild') return `@shaders/${targetRel}`;
    let r = path.posix.relative(path.posix.dirname(fromRel), `src/${targetRel}`);
    if (!r.startsWith('.')) r = './' + r;
    return r;
  }
  logName(tag) { return path.join(this.c.ev, `${String(++this.seq).padStart(2, '0')}-${tag.replace(/[^\w.-]+/g, '_').slice(0, 60)}.log`); }
  async ng(args, { timeout = 240000, env, tag } = {}) {
    return run(process.execPath, [this.ngjs, ...args], { cwd: this.dir, env: childEnv(env), timeout, logFile: this.logName(tag ?? `ng-${args.join('-')}`) });
  }
  startNg(args, { env, tag } = {}) {
    const p = new Proc(process.execPath, [this.ngjs, ...args], { cwd: this.dir, env: childEnv(env), logFile: this.logName(tag ?? `ng-${args.join('-')}`) });
    this.procs.push(p);
    return p;
  }
  startNode(args, { env, tag } = {}) {
    const p = new Proc(process.execPath, args, { cwd: this.dir, env: childEnv(env), logFile: this.logName(tag ?? `node-${path.basename(args[0])}`) });
    this.procs.push(p);
    return p;
  }
  build(args = [], o = {}) { return this.ng(['build', ...args], o); }
  check(...dirs) {
    const tool = this.p('node_modules', ...PKG.split('/'), 'tools', 'check-shader-bundle.mjs');
    return run(process.execPath, [tool, ...(dirs.length ? dirs : [this.dist])], { cwd: this.dir, env: childEnv(), timeout: 60000, logFile: this.logName('check-bundle') });
  }
  scan(dir = this.dist) { return readOutput(dir); }
  mark(m, dir = this.dist) { return markerState(readOutput(dir), m); }
  async cleanup() { for (const p of this.procs) await p.stop(2000).catch(() => {}); }
  /** Replace the generated shader by the marked one (and its helper). */
  brand(mark = M0, helper = H0) {
    this.write('src/app/my-canvas/my-canvas.gpu.ts', shaderSrc({ mark }));
    this.write('src/app/my-canvas/helper.ts', helperSrc(helper));
  }
  setMark(mark, rel = 'src/app/my-canvas/my-canvas.gpu.ts') {
    this.write(rel, shaderSrc({ mark }));
  }
  /** Adds a module that uses a shader module (so the bundler keeps it): src/app/uses-<id>.ts, imported by main.ts. */
  useShader(id, targetRel, exportName = 'sceneFragment', specOverride) {
    const file = `src/app/uses-${id}.ts`;
    const s = specOverride ?? this.spec(file, targetRel);
    this.write(file, `import { ${exportName} } from '${s}';\n(globalThis as Record<string, unknown>)['__m_${id}'] = ${exportName};\n`);
    this.edit('src/main.ts', (t) => (t.includes(`./app/uses-${id}`) ? t : `import './app/uses-${id}';\n${t}`));
  }
  unuse(id) {
    this.rm(`src/app/uses-${id}.ts`);
    this.edit('src/main.ts', (t) => t.replace(new RegExp(`import './app/uses-${id}';\\r?\\n`), ''));
  }
}

// ---- fixtures ----------------------------------------------------------------------------------------------------
const ready = new Map();
function npmCli() {
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) return process.env.npm_execpath;
  const nodeDir = path.dirname(process.execPath);
  for (const c of [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (fs.existsSync(c)) return c;
  throw new Error('cannot locate npm-cli.js next to ' + process.execPath);
}
export const npm = (args, o = {}) => run(process.execPath, [npmCli(), ...args], { env: childEnv(o.env), ...o });

export async function ensureCli(w) {
  const dir = path.join(w.root, 'cli');
  const ng = path.join(dir, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
  if (!fs.existsSync(ng)) {
    fs.mkdirSync(dir, { recursive: true });
    const r = await npm(['install', '--prefix', dir, '--no-audit', '--no-fund', `@angular/cli@${CLI_VERSION[w.angular]}`], { timeout: 300000, logFile: path.join(w.evRoot, 'fixture-cli-install.log') });
    if (r.code !== 0) throw new Error('installing @angular/cli failed: ' + r.text.slice(-400));
  }
  return ng;
}

/** ng new (once per Angular major and ssr flag). Returns the folder that contains angular.json. */
export async function ensureBase(w, { ssr = false } = {}) {
  const key = `base${ssr ? '-ssr' : ''}`;
  const dir = path.join(w.root, key, 'demo');
  if (ready.has(key)) return ready.get(key);
  const p = (async () => {
    if (!fs.existsSync(path.join(dir, '.matrix-base-ok'))) {
      rmUnder(w.work, path.join(w.root, key));
      fs.mkdirSync(path.join(w.root, key), { recursive: true });
      const ng = await ensureCli(w);
      const r = await run(process.execPath, [ng, 'new', 'demo', '--defaults', '--skip-git', '--style=css', `--ssr=${ssr}`, '--package-manager=npm'], { cwd: path.join(w.root, key), env: childEnv(), timeout: 600000, logFile: path.join(w.evRoot, `fixture-ng-new${ssr ? '-ssr' : ''}.log`) });
      if (r.code !== 0) throw new Error('ng new failed: ' + r.text.slice(-500));
      fs.writeFileSync(path.join(dir, '.matrix-base-ok'), 'ok');
    }
    return dir;
  })();
  ready.set(key, p);
  return p;
}

/** The S01 flow on a given app: ng add, ng generate, wire the component. Returns step results. */
export async function setupApp(app, { tgz, mode }) {
  const steps = [];
  const add = await app.ng(['add', tgz, ...(mode === 'prebuild' ? ['--shaders', 'prebuild'] : []), '--skip-confirmation'], { tag: 'ng-add', timeout: 300000 });
  steps.push({ step: 'ng add', code: add.code, ms: add.ms, out: add.text });
  const gen = await app.ng(['generate', `${PKG}:component`, 'my-canvas'], { tag: 'ng-generate' });
  steps.push({ step: 'ng generate', code: gen.code, ms: gen.ms, out: gen.text });
  if (app.exists('src/app/app.ts')) {
    app.edit('src/app/app.ts', (t) => {
      t = t.replace(/(import[^;]*;\r?\n)/, `$1import { MyCanvas } from './my-canvas/my-canvas';\n`);
      return t.replace(/imports:\s*\[[^\]]*\]/, 'imports: [MyCanvas]');
    });
    app.write('src/app/app.html', '<app-my-canvas />\n');
  }
  return steps;
}

/** Ready fixture: base copy + setupApp + marked shader. Built once per (mode, ssr); scenarios copy it. */
export async function ensureReady(c, { ssr = false } = {}) {
  const key = `${c.mode}${ssr ? '-ssr' : ''}`;
  if (ready.has(key)) return ready.get(key);
  const p = (async () => {
    const base = await ensureBase(c.w, { ssr });
    const dir = path.join(c.w.root, c.mode, ssr ? 'fx-ssr' : 'fx', 'demo');
    if (!fs.existsSync(path.join(dir, '.matrix-ready-ok'))) {
      rmUnder(c.w.work, path.join(c.w.root, c.mode, ssr ? 'fx-ssr' : 'fx'));
      copyTree(base, dir);
      const app = new App({ ...c, ev: path.join(c.w.evRoot, c.mode, ssr ? 'fixture-ssr' : 'fixture') }, dir);
      const steps = await setupApp(app, { tgz: c.w.tgz, mode: c.mode });
      const bad = steps.find((s) => s.code !== 0);
      if (bad) throw new Error(`fixture ${key}: ${bad.step} failed (exit ${bad.code}): ${bad.out.slice(-600)}`);
      app.brand();
      fs.writeFileSync(path.join(dir, '.matrix-ready-ok'), 'ok');
    }
    return dir;
  })();
  ready.set(key, p);
  return p;
}

/** A fresh, isolated copy of the ready app for one scenario. Its parent is <work>/a<NN>/<mode>/<id>/, the same depth as the fixture (the `file:` path to the tarball stays valid). */
export async function freshApp(c, { ssr = false, tag } = {}) {
  const fx = await ensureReady(c, { ssr });
  const dir = path.join(c.w.root, c.mode, `${c.id}${tag ? '-' + tag : ''}`, 'demo');
  rmUnder(c.w.work, path.dirname(dir));
  copyTree(fx, dir);
  for (const f of ['.matrix-ready-ok', '.matrix-base-ok']) fs.rmSync(path.join(dir, f), { force: true });
  const app = new App(c, dir);
  c.apps.push(app);
  if (process.env.MATRIX_MUTATE) await mutate(app, process.env.MATRIX_MUTATE);
  return app;
}
/**
 * HARNESS SELF-CHECK ONLY (MATRIX_MUTATE=<name>): break the product in the scenario's private copy, to prove that scenarios can fail.
 *  plugin-off     (plugin)   remove the shader plugin from every build configuration
 *  plugin-regex   (plugin)   the plugin's .gpu specifier regex can never match
 *  wrappers-off   (prebuild) after one build (shaders-dist exists), swap the wrapper builders for the stock @angular/build ones
 */
export async function mutate(app, name) {
  if (name === 'plugin-off' && app.mode === 'plugin') {
    app.editJson('angular.json', (j) => { const b = j.projects.demo.architect.build; b.options.plugins = []; for (const cfg of Object.values(b.configurations ?? {})) if (cfg.plugins) cfg.plugins = []; });
  } else if (name === 'plugin-regex' && app.mode === 'plugin') {
    const f = `node_modules/${PKG}/tools/typegpu-shaders.esbuild.mjs`;
    app.edit(f, (t) => t.replace('const GPU_SPECIFIER = /\\.gpu(\\.[cm]?[jt]s)?$/;', 'const GPU_SPECIFIER = /\\.neverMatches$/;'));
    if (!app.read(f).includes('neverMatches')) throw new Error('mutation plugin-regex did not apply');
  } else if (name === 'wrappers-off' && app.mode === 'prebuild') {
    await app.build(['-c', 'development'], { tag: 'mutation-prebuild' });
    app.editJson('angular.json', (j) => { const a = j.projects.demo.architect; a.build.builder = '@angular/build:application'; a.serve.builder = '@angular/build:dev-server'; a.test.builder = '@angular/build:unit-test'; });
  } else throw new Error(`mutation ${name} does not apply to mode ${app.mode}`);
}
export async function freshNew(c, { ssr = false, tag } = {}) {
  const base = await ensureBase(c.w, { ssr });
  const dir = path.join(c.w.root, c.mode, `${c.id}${tag ? '-' + tag : ''}`, 'demo');
  rmUnder(c.w.work, path.dirname(dir));
  copyTree(base, dir);
  fs.rmSync(path.join(dir, '.matrix-base-ok'), { force: true });
  const app = new App(c, dir);
  c.apps.push(app);
  return app;
}
export { sleep, until, httpGet, WIN };
