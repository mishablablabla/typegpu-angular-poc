// Fast check of lib/tools/typegpu-shaders.esbuild.mjs with plain esbuild (no Angular build). Scenarios:
//   - a tsconfig `paths` alias (`@shaders/wave`) that hides `.gpu` in the specifier is transformed (the RESOLVED path decides)
//   - the same import marked `external` is left alone and does not crash
//   - two `noise.gpu.ts` in different folders get distinct, workspace-relative entries in the source map
//   - a `'use gpu'` directive in a file not named *.gpu.ts produces a build WARNING with file, line, column,
//     and nothing is reported for transformed modules or for the text 'use gpu' in a string
//   - without @babel/core / unplugin-typegpu the error names the exact peer ranges and `ng add`
// Usage:   node scripts/verify-shader-plugin.mjs <consumer-dir>
// <consumer-dir> is any directory whose node_modules has esbuild, @babel/core, unplugin-typegpu and typegpu
// (for example a clean consumer made by acceptance-clean-consumer.sh: acceptance/work/demo). No network needed.
// The plugin under test is a COPY of lib/tools placed next to a copy of lib/package.json, like the installed package.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumer = process.argv[2] && resolve(process.argv[2]);
if (!consumer || !existsSync(join(consumer, 'node_modules', 'esbuild'))) {
  console.error('Usage: node scripts/verify-shader-plugin.mjs <consumer dir with node_modules/{esbuild,@babel/core,unplugin-typegpu,typegpu}>');
  process.exit(2);
}
// TYPEGPU_POC_LIB: another copy of lib/ (tools/ + package.json), e.g. an older one, to see that these checks catch its bugs
const lib = resolve(process.env.TYPEGPU_POC_LIB ?? new URL('../lib', import.meta.url).pathname);
const { build } = await import(pathToFileURL(createRequire(join(consumer, 'package.json')).resolve('esbuild')).href);

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${message}`);
  if (!ok) failures++;
};

/** `<dir>/package/{package.json,tools/}` like an installed package, and `<dir>/node_modules` linked to the consumer's. */
function workspace(withModules = true) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-plugin-'));
  mkdirSync(join(dir, 'package'), { recursive: true });
  cpSync(join(lib, 'tools'), join(dir, 'package', 'tools'), { recursive: true });
  cpSync(join(lib, 'package.json'), join(dir, 'package', 'package.json'));
  if (withModules) symlinkSync(join(consumer, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
const write = (dir, path, text) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const SHADER = (n) => `import tgpu, { d } from 'typegpu';\nexport const fn${n} = tgpu.fn([d.f32], d.f32)((x) => { 'use gpu'; return x + ${n}; });\n`;
const loadPlugin = async (dir) => (await import(pathToFileURL(join(dir, 'package', 'tools', 'typegpu-shaders.esbuild.mjs')).href + `?${Math.random()}`)).default;

// ---------- aliases, externals, source maps, warnings ----------
{
  const dir = workspace();
  write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@shaders/*': ['./src/shaders/*.gpu'], '@lib/*': ['./src/lib/*'] } } }));
  write(dir, 'src/a/noise.gpu.ts', SHADER(1));
  write(dir, 'src/b/noise.gpu.ts', SHADER(2));
  write(dir, 'src/shaders/wave.gpu.ts', SHADER(3));
  write(dir, 'src/lib/plain.ts', `${SHADER(4)}export const note = "mentions 'use gpu'; in a string";\n`);
  write(dir, 'src/main.ts', `import { fn1 } from './a/noise.gpu';\nimport { fn2 } from './b/noise.gpu';\nimport { fn3 } from '@shaders/wave';\nimport { fn4 } from '@lib/plain';\nconsole.log(fn1, fn2, fn3, fn4);\n`);
  const plugin = await loadPlugin(dir);
  const options = (extra = {}) => ({
    entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'esm', outdir: 'out', sourcemap: true, metafile: true,
    external: ['typegpu', 'typegpu/*'], plugins: [plugin], absWorkingDir: dir, tsconfig: 'tsconfig.json', logLevel: 'silent', ...extra,
  });

  const result = await build(options());
  const js = result.outputFiles.find((f) => f.path.endsWith('main.js')).text;
  const map = JSON.parse(result.outputFiles.find((f) => f.path.endsWith('main.js.map')).text);
  const sources = map.sources.map((s) => s.replace(/^(\.\.\/)+/, ''));
  const metaCount = (js.match(/__TYPEGPU_META__ \?\?=/g) ?? []).length;
  check(metaCount === 3, `a/noise.gpu, b/noise.gpu and the alias import @shaders/wave are transformed (${metaCount} of 3 wrapped; plain.ts is not named *.gpu)`);
  check(['src/a/noise.gpu.ts', 'src/b/noise.gpu.ts', 'src/shaders/wave.gpu.ts'].every((s) => sources.includes(s)), `source map sources are workspace-relative and unique: ${sources.filter((s) => s.includes('.gpu.')).join(', ')}`);
  check(!map.sources.includes('noise.gpu.ts'), 'no bare "noise.gpu.ts" entry in the source map');

  const warnings = result.warnings.filter((w) => w.pluginName === 'typegpu-shaders');
  check(warnings.length === 1, `exactly one plugin warning (got ${warnings.length}): ${warnings.map((w) => w.location?.file).join(', ')}`);
  const [warning] = warnings;
  check(warning?.location?.file === 'src/lib/plain.ts' && warning.location.line === 2, `the warning points at src/lib/plain.ts:2 (got ${warning?.location?.file}:${warning?.location?.line}:${warning?.location?.column})`);
  check(/not named \*\.gpu\.ts/.test(warning?.text ?? '') && /\.gpu\.ts/.test(warning?.notes?.[0]?.text ?? ''), 'the warning says why and what to rename it to');

  const external = await build(options({ external: ['typegpu', 'typegpu/*', '@shaders/wave'] }));
  const externalJs = external.outputFiles.find((f) => f.path.endsWith('main.js')).text;
  check(/from "@shaders\/wave"/.test(externalJs) && (externalJs.match(/__TYPEGPU_META__ \?\?=/g) ?? []).length === 2, 'an alias import marked external stays an import and is not transformed');

  rmSync(dir, { recursive: true, force: true });
}

// ---------- the missing-dependency message ----------
{
  const dir = workspace(false); // no node_modules: @babel/core cannot be found
  write(dir, 'src/main.ts', 'console.log(1);\n');
  const plugin = await loadPlugin(dir);
  const manifest = JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8'));
  let message = '';
  try {
    await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, plugins: [plugin], absWorkingDir: dir, logLevel: 'silent' });
  } catch (error) {
    message = String(error?.errors?.[0]?.text ?? error?.message ?? error);
  }
  const babel = manifest.peerDependencies['@babel/core'];
  const unplugin = manifest.peerDependencies['unplugin-typegpu'];
  check(message.includes(`@babel/core@${babel}`) && message.includes(`unplugin-typegpu@${unplugin}`), `the message names the peer ranges from package.json (@babel/core@${babel}, unplugin-typegpu@${unplugin})`);
  check(message.includes(`ng add ${manifest.name}`), 'the message recommends ng add');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nshader plugin checks passed' : `\n${failures} shader plugin check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
