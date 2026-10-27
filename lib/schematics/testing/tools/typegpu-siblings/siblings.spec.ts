// The sibling generator (tools/typegpu-siblings): one generated file next to each `*.gpu.ts`, current-ness decided by the header of that file.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { generate, resolveConfig, verify, watchEnsure } from '../../../../tools/typegpu-siblings/index.mjs';
// @ts-expect-error plain ES module without types
import { removeGenerated, scan, writeGenerated } from '../../../../tools/typegpu-siblings/files.mjs';
import { createProject, posix, waitFor, type Project } from '../typegpu-shaders/project';

const CLI = join(__dirname, '../../../../tools/typegpu-siblings/cli.mjs');
const SHADER = `import tgpu, { d, std } from 'typegpu';
import { SCALE } from './model';
export const wave = tgpu.fn([d.f32], d.f32)((x) => {
  'use gpu';
  return std.sin(x) * SCALE;
});
`;
const FILES = { 'src/wave.gpu.ts': SHADER, 'src/model.ts': 'export const SCALE = 3;\n', 'src/app/main.ts': `import { wave } from '../wave.gpu.generated';\nexport const used = wave;\n` };
const BROKEN = `${SHADER}\nexport const bad = (x: number) => {\n  'use gpu';\n  try {\n    return x;\n  } catch (e) {\n    return 0;\n  }\n};\n`;

let project: Project;
beforeEach(() => {
  project = createProject(FILES);
  project.remove('src/app/main.ts'); // the default fixture imports through @shaders
  project.write('src/app/main.ts', FILES['src/app/main.ts']);
});
afterEach(() => project.dispose());
const config = () => resolveConfig({ root: project.root });
const codes = () => (verify(config()) as { code: string }[]).map((p) => p.code).sort();
const run = (...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--root', project.root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

describe('generate', () => {
  it('writes the module and a type facade next to the source, with headers, and is quiet the second time', async () => {
    const first = await generate(config());
    expect(first.ok).toBe(true);
    expect(first.built).toBe(1);
    expect(project.read('src/wave.gpu.generated.js').split('\n')[0]).toMatch(/^\/\/ @typegpu-siblings v1 status=ok source=[0-9a-f]{16} body=[0-9a-f]{16}$/);
    expect(project.read('src/wave.gpu.generated.d.ts')).toContain("export * from './wave.gpu';");
    expect(codes()).toEqual([]);
    const before = statSync(project.path('src/wave.gpu.generated.js')).mtimeMs;
    const second = await generate(config());
    expect(second.skipped).toBe('fresh');
    expect(statSync(project.path('src/wave.gpu.generated.js')).mtimeMs).toBe(before);
  });

  it('the generated module is transformed (carries the build-time metadata) and runs; the plain module it imports is not generated', async () => {
    await generate(config());
    expect(project.read('src/wave.gpu.generated.js')).toContain('__TYPEGPU_META__');
    expect(project.exists('src/model.generated.js')).toBe(false);
    expect(typeof (await project.import('src/wave.gpu.generated.js')).wave).toBe('function');
  });

  it('re-exports the default export in the facade only when the source has one', async () => {
    project.write('src/d.gpu.ts', "export default 1;\nexport const x = 2;\n");
    await generate(config());
    expect(project.read('src/d.gpu.generated.d.ts')).toContain("export { default } from './d.gpu';");
    expect(project.read('src/wave.gpu.generated.d.ts')).not.toContain('default');
  });

  it('points imports between shader modules at their generated siblings, in every import form', async () => {
    project.write('src/a.gpu.ts', `import { wave } from './wave.gpu';\nexport const use = wave;\nexport { wave as again } from './wave.gpu.js';\nexport * from './wave.gpu';\nexport const lazy = () => import('./wave.gpu.ts');\nexport const text = "from './wave.gpu'";\n// import './wave.gpu'\n`);
    await generate(config());
    const text = project.read('src/a.gpu.generated.js');
    expect(text.match(/wave\.gpu\.generated/g)).toHaveLength(4);
    expect(text).toContain(`"from './wave.gpu'"`); // a string is not an import
    expect(text).not.toMatch(/from "\.\/wave\.gpu"/);
  });
});

describe('what verify can tell without any state', () => {
  beforeEach(async () => {
    await generate(config());
  });

  it('a changed source is stale; generating makes it fresh again', async () => {
    project.write('src/wave.gpu.ts', `${SHADER}export const more = 1;\n`);
    expect(codes()).toEqual(['stale']);
    await generate(config());
    expect(codes()).toEqual([]);
  });

  it('a source that is changed and changed back is fresh again without any build (the hash is of the content)', () => {
    project.write('src/wave.gpu.ts', `${SHADER}// x\n`);
    expect(codes()).toEqual(['stale']);
    project.write('src/wave.gpu.ts', SHADER);
    expect(codes()).toEqual([]);
  });

  it('a file edited by hand is reported and restored', async () => {
    project.write('src/wave.gpu.generated.js', project.read('src/wave.gpu.generated.js').replace('SCALE', 'SCALE_X'));
    expect(codes()).toEqual(['edited']);
    await generate(config());
    expect(codes()).toEqual([]);
    expect(project.read('src/wave.gpu.generated.js')).not.toContain('SCALE_X');
  });

  it.each([['src/wave.gpu.generated.js', ['missing']], ['src/wave.gpu.generated.d.ts', ['facade']]])('a deleted %s is reported and rewritten', async (file, expected) => {
    project.remove(file);
    expect(codes()).toEqual(expected);
    await generate(config());
    expect(codes()).toEqual([]);
    expect(project.exists(file)).toBe(true);
  });

  it('a damaged header (still ours) is regenerated', async () => {
    project.write('src/wave.gpu.generated.js', project.read('src/wave.gpu.generated.js').replace('status=ok', 'status=zzz'));
    expect(codes()).toEqual(['failed']); // a status that is not "ok" is a failed module
    expect((await generate(config())).ok).toBe(true);
    expect(codes()).toEqual([]);
  });

  it('what it cannot see: a plain module the shader imports changes, and nothing is stale (it is bundled live)', () => {
    project.write('src/model.ts', 'export const SCALE = 4;\n');
    expect(codes()).toEqual([]);
  });

  it('a shader that is deleted leaves orphans that are reported and removed; the facade goes with it', async () => {
    project.write('src/gone.gpu.ts', 'export const g = 1;\n');
    await generate(config());
    project.remove('src/gone.gpu.ts');
    expect(codes()).toEqual(['orphan', 'orphan']);
    await generate(config());
    expect(project.exists('src/gone.gpu.generated.js')).toBe(false);
    expect(project.exists('src/gone.gpu.generated.d.ts')).toBe(false);
    expect(codes()).toEqual([]);
  });

  it('the last shader is deleted: its siblings are removed too', async () => {
    project.remove('src/wave.gpu.ts');
    const result = await generate(config());
    expect(result.skipped).toBe('empty');
    expect(readdirSync(project.path('src')).filter((n) => n.includes('generated'))).toEqual([]);
  });
});

describe('a shader that fails', () => {
  it('a plain run leaves no module behind for it (nothing can bundle an older one)', async () => {
    await generate(config());
    project.write('src/wave.gpu.ts', BROKEN);
    const result = await generate(config());
    expect(result.ok).toBe(false);
    expect(posix(result.diagnostics[0].file)).toBe('src/wave.gpu.ts');
    expect(project.exists('src/wave.gpu.generated.js')).toBe(false);
    expect(codes()).toEqual(['missing']);
  });

  it('a watching run writes a stub that says so in its header; the next good run replaces it', async () => {
    project.write('src/wave.gpu.ts', BROKEN);
    const result = await generate(config(), { stubs: true });
    expect(result.ok).toBe(false);
    expect(project.read('src/wave.gpu.generated.js')).toMatch(/^\/\/ @typegpu-siblings v1 status=error /);
    expect(codes()).toEqual(['failed']);
    project.write('src/wave.gpu.ts', SHADER);
    expect((await generate(config())).ok).toBe(true);
    expect(codes()).toEqual([]);
    expect(project.read('src/wave.gpu.generated.js')).toMatch(/status=ok/);
  });

  it('the stub can be imported without a DOM (an SSR dev server): every export of the failed module is there and throws the message when used', async () => {
    project.write('src/wave.gpu.ts', `${BROKEN}\nexport default 1;\n`);
    await generate(config(), { stubs: true });
    const stub = await project.import('src/wave.gpu.generated.js'); // evaluating it must not throw
    expect(Object.keys(stub).sort()).toEqual(['bad', 'default', 'wave']);
    expect(() => stub.wave(1)).toThrow(/try|TryStatement|Unsupported/i);
    expect(() => stub.bad.x).toThrow();
  });

  it('a stub left by a killed dev server fails the next plain run until the shader is fixed (it is not bundled as if fine)', async () => {
    project.write('src/wave.gpu.ts', BROKEN);
    await generate(config(), { stubs: true });
    const result = await generate(config());
    expect(result.ok).toBe(false);
    expect(project.exists('src/wave.gpu.generated.js')).toBe(false);
  });
});

describe('imports in the sources', () => {
  it('an application file that imports a shader module itself (any specifier form) is a problem, a type import is not', async () => {
    project.write('src/app/bad1.ts', `import { wave } from '../wave.gpu';\nexport const a = wave;\n`);
    project.write('src/app/bad2.ts', `export { wave } from '../wave.gpu.js';\n`);
    project.write('src/app/bad3.spec.ts', `import '../wave.gpu';\n`);
    project.write('src/app/ok1.ts', `import type { wave } from '../wave.gpu';\nexport type W = typeof wave;\n`);
    project.write('src/app/ok2.ts', `import raw from '../wave.gpu.ts?raw';\nexport default raw;\n// import { wave } from '../wave.gpu';\n`);
    const problems = (await generate(config())).diagnostics.filter((d: { source: string }) => d.source === 'import');
    expect(problems.map((p: { file: string }) => posix(p.file)).sort()).toEqual(['src/app/bad1.ts', 'src/app/bad2.ts', 'src/app/bad3.spec.ts']);
    expect(problems[0].text).toContain("'../wave.gpu.generated'");
  });

  it("a module a shader imports that has 'use gpu' code but is not a shader module is an error naming it", async () => {
    project.write('src/model.ts', `export const f = (x: number) => {\n  'use gpu';\n  return x;\n};\n`);
    const result = await generate(config());
    expect(result.ok).toBe(false);
    expect(posix(result.diagnostics.find((d: { text: string }) => /not a "\*\.gpu\.ts" module/.test(d.text)).file)).toBe('src/model.ts');
  });
});

describe('writing next to the sources is safe', () => {
  const victim = () => join(project.root, 'victim.txt');
  beforeEach(() => writeFileSync(victim(), 'victim'));
  const intact = () => readFileSync(victim(), 'utf8') === 'victim';

  it('a symbolic link at the generated name is not written through, replaced or removed', async () => {
    symlinkSync(victim(), project.path('src/wave.gpu.generated.js'));
    const result = await generate(config());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d: { text: string }) => /Refusing to write/.test(d.text))).toBe(true);
    expect(intact()).toBe(true);
    expect(lstatSync(project.path('src/wave.gpu.generated.js')).isSymbolicLink()).toBe(true);
    project.remove('src/wave.gpu.ts'); // the link is also not removed as an orphan
    await generate(config());
    expect(lstatSync(project.path('src/wave.gpu.generated.js')).isSymbolicLink()).toBe(true);
    expect(intact()).toBe(true);
  });

  it('a hard link at the generated name is replaced, not written through', async () => {
    const { linkSync } = await import('node:fs');
    linkSync(victim(), project.path('src/wave.gpu.generated.d.ts'));
    await generate(config()); // not ours (no header): refused
    expect(intact()).toBe(true);
  });

  it('a file at the generated name that this tool did not write is left alone and reported', async () => {
    project.write('src/wave.gpu.generated.js', 'export const mine = 1;\n');
    const result = await generate(config());
    expect(result.ok).toBe(false);
    expect(project.read('src/wave.gpu.generated.js')).toBe('export const mine = 1;\n');
    project.remove('src/wave.gpu.ts');
    await generate(config()); // not removed as an orphan either
    expect(project.read('src/wave.gpu.generated.js')).toBe('export const mine = 1;\n');
  });

  it('a directory link inside src is not followed: no shader behind it is generated, no file behind it is touched', async () => {
    mkdirSync(project.path('outside'));
    writeFileSync(project.path('outside/x.gpu.ts'), 'export const x = 1;\n');
    writeFileSync(project.path('outside/old.gpu.generated.js'), '// @typegpu-siblings v1 status=ok source=0 body=0\n');
    symlinkSync(project.path('outside'), project.path('src/linked'), 'junction');
    const result = await generate(config());
    expect(result.ok).toBe(true);
    expect(existsSync(project.path('outside/x.gpu.generated.js'))).toBe(false);
    expect(existsSync(project.path('outside/old.gpu.generated.js'))).toBe(true); // an orphan only when it lies under src
  });

  it('a file link to a shader source is skipped (it would generate next to the link, from somewhere else)', async () => {
    writeFileSync(project.path('real.gpu.ts'), 'export const r = 1;\n');
    symlinkSync(project.path('real.gpu.ts'), project.path('src/linked.gpu.ts'));
    await generate(config());
    expect(existsSync(project.path('src/linked.gpu.generated.js'))).toBe(false);
  });

  // The scan never follows a link, so these reach the write and remove functions directly: a folder swapped for a link between the scan and
  // the write (the second layer) must not make a write or a removal land elsewhere.
  it('writing or removing through a folder that has become a link is refused', () => {
    mkdirSync(project.path('outside'));
    writeFileSync(project.path('outside/x.gpu.generated.js'), '// @typegpu-siblings v1 status=ok source=0 body=0\nold\n');
    symlinkSync(project.path('outside'), project.path('src/linked'), 'junction');
    expect(() => writeGenerated(config(), project.path('src/linked/x.gpu.generated.js'), '// @typegpu-siblings v1 status=ok source=1 body=1\nnew\n')).toThrow(/Refusing to write/);
    expect(removeGenerated(config(), project.path('src/linked/x.gpu.generated.js'))).toBe(false);
    expect(project.read('outside/x.gpu.generated.js')).toContain('old');
  });

  it('the scan skips linked folders and linked files, and reports files that look generated', () => {
    mkdirSync(project.path('outside'));
    writeFileSync(project.path('outside/y.gpu.ts'), 'export const y = 1;\n');
    symlinkSync(project.path('outside'), project.path('src/linked'), 'junction');
    project.write('src/node_modules/n.gpu.ts', 'export const n = 1;\n');
    const found = scan(config());
    expect(found.entries.map((p: string) => posix(p).split('/src/')[1])).toEqual(['wave.gpu.ts']);
  });

  it('`src` that is a link out of the project is refused', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'siblings-elsewhere-'));
    try {
      symlinkSync(elsewhere, project.path('linked-src'), 'junction');
      expect(() => resolveConfig({ root: project.root, src: 'linked-src' })).toThrow(/inside the project/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('several processes at once', () => {
  it('four cold runs all succeed and leave one consistent state', async () => {
    const exits = await Promise.all([1, 2, 3, 4].map(() => run('generate')));
    expect(exits.map((e) => e.code)).toEqual([0, 0, 0, 0]);
    expect(codes()).toEqual([]);
    expect(readdirSync(project.path('src')).filter((n) => n.endsWith('.typegpu-tmp'))).toEqual([]);
  });

  it('runs on a changed source from several processes end on the last content', async () => {
    await run('generate');
    project.write('src/wave.gpu.ts', `${SHADER}export const v = 2;\n`);
    const exits = await Promise.all([1, 2, 3].map(() => run('generate')));
    expect(exits.map((e) => e.code)).toEqual([0, 0, 0]);
    expect(project.read('src/wave.gpu.generated.js')).toContain('v = 2');
    expect(codes()).toEqual([]);
  });
});

describe('leftovers and watching', () => {
  it('a temporary file of a killed write is removed once it is old, and not before', async () => {
    const fresh = project.path('src/.a.gpu.generated.js.1-aa.typegpu-tmp');
    const old = project.path('src/.b.gpu.generated.js.1-bb.typegpu-tmp');
    writeFileSync(fresh, 'x');
    writeFileSync(old, 'x');
    const past = new Date(Date.now() - 11 * 60_000);
    utimesSync(old, past, past);
    await generate(config());
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('the watcher regenerates after an edit, shows a failure as a stub, and recovers', async () => {
    const watcher = watchEnsure({ root: project.root });
    expect((await watcher.ready).ok).toBe(true);
    project.write('src/wave.gpu.ts', BROKEN);
    await waitFor(() => /status=error/.test(project.read('src/wave.gpu.generated.js')), 'the stub');
    project.write('src/wave.gpu.ts', `${SHADER}export const w = 3;\n`);
    await waitFor(() => project.read('src/wave.gpu.generated.js').includes('w = 3'), 'the recovered module');
    await watcher.settled();
    watcher.close();
    expect(codes()).toEqual([]);
  });

  it('ignores its own writes (a facade rewrite does not start another run)', async () => {
    const results: unknown[] = [];
    const watcher = watchEnsure({ root: project.root }, { onBuild: (r: unknown) => results.push(r) });
    await watcher.ready;
    await watcher.settled();
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();
    expect(results).toHaveLength(1);
  });
});
