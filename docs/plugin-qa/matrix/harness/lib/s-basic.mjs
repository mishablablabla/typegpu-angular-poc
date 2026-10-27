// S01 setup, S02 first builds, S03 determinism, S08 unit tests, S09 SSR, S13 package integrity.
import fs from 'node:fs';
import path from 'node:path';
import { freshApp, freshNew, ensureBase, setupApp, M0, H0, PKG, markerState, readOutput, metaCount } from './app.mjs';
import { R, classify, said, tail, head } from './kit.mjs';
import { run, childEnv, listTree, hashTree, diffHashes, rmUnder, sha256, until, httpGet, freePort, sleep } from './util.mjs';

const PLUGIN_PATH_TAIL = 'tools/typegpu-shaders.esbuild.mjs';

export async function s01(c) {
  const app = await freshNew(c);
  const base = await ensureBase(c.w);
  const baseWs = JSON.parse(fs.readFileSync(path.join(base, 'angular.json'), 'utf8'));
  const basePkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  const topBefore = listTree(app.dir, { skipTop: ['node_modules', '.angular'] }).filter((p) => !p.includes('/'));
  const tgzSha = sha256(fs.readFileSync(c.w.tgz));
  const steps = await setupApp(app, { tgz: c.w.tgz, mode: c.mode });
  const problems = [];
  for (const s of steps) if (s.code !== 0) problems.push(`${s.step} exit ${s.code}`);
  const t = app.json('angular.json').projects.demo.architect;
  const pkg = app.json('package.json');
  const keep = ['browser', 'tsConfig', 'assets', 'styles'];
  for (const k of keep) if (JSON.stringify(t.build.options[k]) !== JSON.stringify(baseWs.projects.demo.architect.build.options[k])) problems.push(`build.options.${k} changed`);
  if (JSON.stringify(t.build.configurations.production.budgets) !== JSON.stringify(baseWs.projects.demo.architect.build.configurations.production.budgets)) problems.push('budgets changed');
  const plugins = JSON.stringify(t.build.options.plugins ?? []);
  if (c.mode === 'plugin') {
    if (t.build.builder !== '@angular-builders/custom-esbuild:application') problems.push('build builder ' + t.build.builder);
    if (!plugins.includes(PLUGIN_PATH_TAIL)) problems.push('plugin path missing: ' + plugins);
    if (t.serve.builder !== '@angular-builders/custom-esbuild:dev-server') problems.push('serve builder ' + t.serve.builder);
    if (c.angular >= 21 && t.test.builder !== '@angular-builders/custom-esbuild:unit-test') problems.push('test builder ' + t.test.builder);
    for (const d of ['@angular-builders/custom-esbuild', '@babel/core', 'unplugin-typegpu']) if (!pkg.devDependencies?.[d]) problems.push('devDependency ' + d);
  } else {
    if (t.build.builder !== `${PKG}:application`) problems.push('build builder ' + t.build.builder);
    if (t.serve.builder !== `${PKG}:dev-server`) problems.push('serve builder ' + t.serve.builder);
    const want = c.angular >= 21 ? `${PKG}:unit-test` : `${PKG}:karma`;
    if (t.test.builder !== want) problems.push(`test builder ${t.test.builder} (wanted ${want})`);
    const tsc = app.read('tsconfig.json');
    if (!/@shaders\/\*/.test(tsc)) problems.push('tsconfig has no @shaders/* mapping');
    if (!/shaders-dist/.test(app.exists('.gitignore') ? app.read('.gitignore') : '')) problems.push('.gitignore lacks shaders-dist');
    for (const d of ['@babel/core', 'unplugin-typegpu', 'esbuild']) if (!pkg.dependencies?.[d] && !pkg.devDependencies?.[d]) problems.push('dependency ' + d);
  }
  if (!pkg.dependencies?.typegpu) problems.push('typegpu not in dependencies');
  if (!pkg.dependencies?.[PKG]) problems.push(PKG + ' not saved');
  for (const [k, v] of Object.entries({ ...basePkg.dependencies, ...basePkg.devDependencies })) if ((pkg.dependencies?.[k] ?? pkg.devDependencies?.[k]) !== v) problems.push(`existing dependency ${k} changed`);
  for (const f of ['my-canvas.ts', 'my-canvas.gpu.ts', 'my-canvas.spec.ts']) if (!app.exists(`src/app/my-canvas/${f}`)) problems.push('missing ' + f);
  const imp = c.mode === 'plugin' ? "'./my-canvas.gpu'" : "'@shaders/app/my-canvas/my-canvas.gpu'";
  if (!app.read('src/app/my-canvas/my-canvas.ts').includes(imp)) problems.push(`component does not import its shader as ${imp}`);
  // nothing left behind outside the app, tarball untouched, no new top-level entries in the app except what the mode documents
  const outside = fs.readdirSync(path.dirname(app.dir));
  if (outside.join() !== 'demo') problems.push('files next to the app: ' + outside.join());
  if (sha256(fs.readFileSync(c.w.tgz)) !== tgzSha) problems.push('the supplied tarball changed');
  const topAfter = listTree(app.dir, { skipTop: ['node_modules', '.angular'] }).filter((p) => !p.includes('/'));
  const added = topAfter.filter((p) => !topBefore.includes(p));
  if (added.length) problems.push('new top-level entries in the app: ' + added.join(', '));
  const detail = `steps: ${steps.map((s) => `${s.step} exit ${s.code} ${s.ms}ms`).join('; ')}; problems: ${problems.length ? problems.join(' | ') : 'none'}`;
  return problems.length ? R('LOUD', detail + ' (setup finished with problems)', { evidence: app.c.ev }) : R('CORRECT', detail);
}

export async function s02(c) {
  const app = await freshApp(c);
  const out = [];
  let worst = null;
  for (const [name, args] of [['development', ['-c', 'development']], ['production', []]]) {
    const b = await app.build(args, { tag: `build-${name}` });
    const files = app.scan();
    const m = markerState(files, M0);
    const chk = await app.check();
    const cls = classify({ exit0: b.code === 0, transformed: m.transformed, signals: { check: chk.code !== 0, build: said(b.text, 'use gpu', 'my-canvas.gpu') } });
    out.push(`${name}: build exit ${b.code} ${b.ms}ms, marker ast=${m.ast} meta-files=${m.meta} metaWrites=${metaCount(files)}, check exit ${chk.code}`);
    if (chk.code !== 0 && m.transformed) cls.category = 'LOUD'; // false alarm of the check on a correct output
    if (!worst || cls.category !== 'CORRECT') worst = cls;
  }
  return R(worst.category, out.join(' | '));
}

export async function s03(c, only) {
  const app = await freshApp(c);
  const gen = () => ['shaders-dist', '.angular', 'dist'].forEach((d) => app.exists(d) && app.rm(d));
  const lines = [];
  let diffs = [];
  for (const [name, args] of [['development', ['-c', 'development']], ['production', []]].filter(([n]) => !only || n === only)) {
    gen();
    const b1 = await app.build(args, { tag: `cold1-${name}` });
    const h1 = hashTree(app.dist);
    app.rm('dist');
    const b2 = await app.build(args, { tag: `warm-${name}` }); // caches (.angular, shaders-dist) kept
    const h2 = hashTree(app.dist);
    gen();
    const b3 = await app.build(args, { tag: `cold2-${name}` });
    const h3 = hashTree(app.dist);
    const d12 = diffHashes(h1, h2), d13 = diffHashes(h1, h3);
    diffs = diffs.concat(d12.map((d) => `${name} cold-vs-warm ${d}`), d13.map((d) => `${name} cold-vs-cold ${d}`));
    lines.push(`${name}: exits ${b1.code}/${b2.code}/${b3.code}, ${Object.keys(h1).length} files, cold/warm diffs ${d12.length}, cold/cold diffs ${d13.length}, ${b1.ms}/${b2.ms}/${b3.ms}ms`);
    if ([b1, b2, b3].some((b) => b.code !== 0)) return R('LOUD', lines.join(' | ') + ' | a build failed: ' + tail(b1.text, 3));
  }
  return diffs.length ? R('SILENT-WRONG', `outputs differ: ${diffs.slice(0, 6).join('; ')} | ${lines.join(' | ')}`) : R('CORRECT', lines.join(' | '));
}

const wgslSpec = (spec, m1 = M0, m2 = H0) => `import tgpu, { d } from 'typegpu';
import { sceneFragment } from '${spec}';
describe('matrix wgsl', () => {
  it('resolves the shader to WGSL that carries the markers', () => {
    const wgsl = tgpu.resolve([sceneFragment(tgpu.const(d.f32, 1), tgpu.const(d.vec3f, d.vec3f(1, 0.5, 0.25)))]);
    console.log('MATRIX-WGSL len=' + wgsl.length + ' shader=' + wgsl.includes('${m1}') + ' helper=' + wgsl.includes('${m2}'));
    expect(wgsl).toContain('${m1}');
    expect(wgsl).toContain('${m2}');
  });
});
`;
export const writeWgslSpec = (app, m1, m2) => app.write('src/matrix-wgsl.spec.ts', wgslSpec(app.spec('src/matrix-wgsl.spec.ts', 'app/my-canvas/my-canvas.gpu'), m1, m2));
export function testArgs(c) {
  return c.angular >= 21 ? ['--watch=false', '--include', 'src/matrix-wgsl.spec.ts'] : ['--watch=false', '--browsers=ChromeHeadless', '--include', 'src/matrix-wgsl.spec.ts'];
}
// The spec itself asserts that the WGSL contains both markers, so "1 passed" IS the verdict (console output of a passing test is not
// always shown: the reporter list differs between the modes' test targets).
export const testVerdict = (t) => {
  const ran = /Tests\s+1 passed|Executed 1 of 1 .*SUCCESS|1 spec, 0 failures/.test(t.text) || t.text.includes('MATRIX-WGSL');
  return { ok: t.code === 0 && ran && !/failed|FAILED/.test(t.text.replace(/0 failed/g, '')), ran };
};

export async function s08(c) {
  if (c.angular === 20 && !process.env.CHROME_BIN) return R('N/A', 'Angular 20 `ng test` is Karma and needs a browser: CHROME_BIN is not set');
  const app = await freshApp(c);
  writeWgslSpec(app);
  const env = c.angular === 20 ? { CHROME_BIN: process.env.CHROME_BIN } : {};
  const t = await app.ng(['test', ...testArgs(c)], { tag: 'ng-test', env, timeout: 300000 });
  const v = testVerdict(t);
  const detail = `ng test exit ${t.code} ${t.ms}ms, spec ran=${v.ran}, spec (asserts both markers in the WGSL) passed=${v.ok}; ${said(t.text, 'Missing metadata') ? 'message: Missing metadata' : ''}`;
  if (c.mode === 'plugin' && c.angular === 20) return v.ok ? R('CORRECT', detail + ' (documented UNSUPPORTED, but it worked)') : R('UNSUPPORTED', detail);
  if (v.ok) return R('CORRECT', detail);
  return t.code !== 0 ? R('LOUD', detail + ' | ' + tail(t.text, 6)) : R('SILENT-WRONG', detail);
}

export async function s09(c) {
  const app = await freshApp(c, { ssr: true });
  const b = await app.build([], { tag: 'ng-build-ssr' });
  const browser = readOutput(app.p('dist', 'demo', 'browser'));
  const server = readOutput(app.p('dist', 'demo', 'server'));
  const mb = markerState(browser, M0), ms = markerState(server, M0);
  const chk = await app.check(app.p('dist', 'demo', 'browser'), app.p('dist', 'demo', 'server'));
  let status = 0, body = '';
  let srv = null;
  if (b.code === 0 && fs.existsSync(app.p('dist', 'demo', 'server', 'server.mjs'))) {
    const port = await freePort();
    srv = app.startNode([path.join('dist', 'demo', 'server', 'server.mjs')], { env: { PORT: port, NG_ALLOWED_HOSTS: 'localhost' }, tag: 'node-server' });
    const r = await until(async () => (srv.code !== null ? 'dead' : (await httpGet(`http://localhost:${port}/`)).status > 0), { timeout: 40000, step: 300 });
    if (r.ok && srv.code === null) {
      const g = await httpGet(`http://localhost:${port}/`);
      status = g.status;
      body = g.body;
    }
    await srv.stop(3000);
  }
  const detail = `build exit ${b.code} ${b.ms}ms; browser marker ast=${mb.ast}; server marker ast=${ms.ast}; check exit ${chk.code}; GET / ${status} (${body.length} bytes, <app-root ${body.includes('<app-root')})`;
  const cls = classify({ exit0: b.code === 0, transformed: mb.transformed && ms.transformed && status === 200, signals: { check: chk.code !== 0 } });
  if (cls.category === 'CORRECT' && chk.code !== 0) cls.category = 'LOUD';
  return R(cls.category, detail);
}

export async function s13(c) {
  const app = await freshApp(c);
  const notes = [];
  let bad = false;
  const lock = app.json('package-lock.json');
  const entry = lock.packages?.[`node_modules/${PKG}`];
  const want = 'sha512-' + (await import('node:crypto')).createHash('sha512').update(fs.readFileSync(c.w.tgz)).digest('base64');
  if (entry?.integrity === want) notes.push('lockfile integrity == sha512 of the supplied tarball');
  else { bad = true; notes.push(`lockfile integrity ${entry?.integrity ?? 'missing'} != ${want}`); }
  // byte-compare the installed files with the tarball contents (tar is on Linux, macOS and Windows 10+)
  const ex = path.join(c.w.root, `s13-extract-${c.mode}`);
  rmUnder(c.w.work, ex);
  fs.mkdirSync(ex, { recursive: true });
  const tr = await run('tar', ['-xzf', c.w.tgz, '-C', ex], { timeout: 60000 });
  if (tr.code === 0) {
    const a = hashTree(path.join(ex, 'package'));
    const b = hashTree(app.p('node_modules', ...PKG.split('/')));
    const d = diffHashes(a, b);
    if (d.length) { bad = true; notes.push(`installed files differ from the tarball: ${d.slice(0, 5).join('; ')}`); } else notes.push(`${Object.keys(a).length} installed files are byte-identical to the tarball`);
  } else notes.push('tar not usable here: file-by-file compare skipped (' + tr.text.slice(0, 80) + ')');
  rmUnder(c.w.work, ex);
  const pkgJson = app.json(`node_modules/${PKG}/package.json`);
  for (const [bin, target] of Object.entries(pkgJson.bin ?? {})) {
    const linked = ['', '.cmd'].some((x) => fs.existsSync(app.p('node_modules', '.bin', bin + x)));
    const there = fs.existsSync(app.p('node_modules', ...PKG.split('/'), target));
    if (!linked || !there) { bad = true; notes.push(`bin ${bin}: linked=${linked} target=${there}`); }
  }
  const e1 = await run(process.execPath, [app.p('node_modules', ...PKG.split('/'), 'tools', 'check-shader-bundle.mjs')], { cwd: app.dir, env: childEnv(), logFile: app.logName('check-noargs') });
  const e2 = await run(process.execPath, [app.p('node_modules', ...PKG.split('/'), 'tools', 'check-shader-bundle.mjs'), '--allow-empty', app.p('src')], { cwd: app.dir, env: childEnv(), logFile: app.logName('check-allow-empty') });
  await app.build(['-c', 'development']);
  const e3 = await app.check();
  notes.push(`typegpu-check-bundle: no args exit ${e1.code} (want 2), --allow-empty on a dir without bundles exit ${e2.code} (want 0), on a real build exit ${e3.code} (want 0)`);
  if (e1.code !== 2 || e2.code !== 0 || e3.code !== 0) bad = true;
  return bad ? R('LOUD', notes.join(' | ')) : R('CORRECT', notes.join(' | '));
}
