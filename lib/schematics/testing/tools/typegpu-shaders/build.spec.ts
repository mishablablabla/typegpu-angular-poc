// The shader prebuild: one build, what it emits, what it reports, and what comes out can be used.
import { spawn } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
// @ts-expect-error plain ES module without types
import { buildShaders, checkShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { BAD_SHADER, createProject, SHADER, type Project } from './project';

type Diagnostic = { source: string; file?: string; line?: number; column?: number; text: string; notes?: string[] };
type Result = { ok: boolean; status: string; files: string[]; diagnostics: Diagnostic[] };
const build = (project: Project, stubs = false) => buildShaders({ root: project.root }, { stubs }) as Promise<Result>;

describe('a successful build', () => {
  let project: Project;
  let result: Result;
  beforeAll(async () => {
    project = createProject();
    result = await build(project);
  });
  afterAll(() => project.dispose());

  it('emits JavaScript, declarations and source maps for the shader and for the module it imports, and a manifest', () => {
    expect(result.ok).toBe(true);
    for (const name of ['wave.gpu', 'model']) {
      for (const ext of ['js', 'js.map', 'd.ts', 'd.ts.map']) expect(project.exists(`shaders-dist/${name}.${ext}`), `${name}.${ext}`).toBe(true);
    }
    expect(JSON.parse(project.read('shaders-dist/.manifest.json'))).toMatchObject({ status: 'ok', files: ['src/model.ts', 'src/wave.gpu.ts'] });
  });

  it('transforms the shader: metadata is written, and the module resolves to WGSL', async () => {
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('__TYPEGPU_META__');
    const { default: tgpu } = await import('typegpu');
    const { wave } = await project.import('shaders-dist/wave.gpu.js');
    expect(tgpu.resolve([wave])).toMatch(/fn wave\(.*\)/);
  });

  it('leaves a module that has no shader code untouched apart from type stripping', () => {
    expect(project.read('shaders-dist/model.js')).not.toContain('__TYPEGPU_META__');
    expect(project.read('shaders-dist/model.js')).toContain('SCALE = 3');
  });

  it('keeps one instance of a plain module that a shader imports (the application imports the generated copy, not the source)', async () => {
    const shader = await project.import('shaders-dist/wave.gpu.js'); // a fresh copy of the shader module ...
    expect(shader.touch()).toBe(1);
    expect(shader.touch()).toBe(2);
    // ... whose `./model` import is the generated model.js: the module an application importing `@shaders/model` gets is the one the shader mutates
    const model = await import(project.path('shaders-dist/model.js'));
    expect(model.state.count).toBe(2);
  });

  it('maps generated code back to the original TypeScript: line, source path and source text', () => {
    const generated = project.read('shaders-dist/wave.gpu.js');
    const index = generated.indexOf('std.sin(x), SCALE');
    expect(index).toBeGreaterThan(0);
    const before = generated.slice(0, index);
    const map = new TraceMap(project.read('shaders-dist/wave.gpu.js.map'));
    const position = originalPositionFor(map, { line: before.split('\n').length, column: index - before.lastIndexOf('\n') - 1 });
    expect(position.line).toBe(6); // `return std.sin(x) * SCALE;`
    expect(resolve(project.path('shaders-dist'), position.source!)).toBe(project.path('src/wave.gpu.ts'));
    const raw = JSON.parse(project.read('shaders-dist/wave.gpu.js.map'));
    expect(raw.sourcesContent[0]).toBe(project.read('src/wave.gpu.ts')); // the original, not the transformed text
  });

  it('maps declarations to the source too (go to definition lands in the .ts file)', () => {
    const map = JSON.parse(project.read('shaders-dist/wave.gpu.d.ts.map'));
    expect(resolve(project.path('shaders-dist'), dirname(map.file), map.sources[0])).toBe(project.path('src/wave.gpu.ts'));
  });

  it('a second build changes nothing and `check` accepts the result', async () => {
    const before = project.read('shaders-dist/wave.gpu.js');
    expect((await build(project)).ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).toBe(before);
    expect(checkShaders({ root: project.root }).ok).toBe(true);
  });

  it('prunes the output of a module that no longer exists, and never wipes the folder first', async () => {
    project.write('src/extra.gpu.ts', `import { d } from 'typegpu';\nexport const Pair = d.struct({ a: d.f32 });\n`);
    expect((await build(project)).ok).toBe(true);
    expect(project.exists('shaders-dist/extra.gpu.js')).toBe(true);
    project.remove('src/extra.gpu.ts');
    expect((await build(project)).ok).toBe(true);
    expect(['js', 'js.map', 'd.ts', 'd.ts.map'].some((ext) => project.exists(`shaders-dist/extra.gpu.${ext}`))).toBe(false);
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(true);
  });
});

describe('errors are specific and a failed build cannot be mistaken for a good one', () => {
  it('a transformation error names the file and the candidate lines, and the failed module leaves no output (plain build)', async () => {
    const project = createProject({ 'src/wave.gpu.ts': BAD_SHADER });
    try {
      const result = await build(project);
      expect(result.ok).toBe(false);
      const diagnostic = result.diagnostics.find((d) => d.source === 'transform')!;
      expect(diagnostic.file).toBe('src/wave.gpu.ts');
      expect(diagnostic.text).toContain('TryStatement');
      expect(diagnostic.notes!.join(' ')).toMatch(/use gpu.* directives at line/);
      expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false); // nothing for a bundler to pick up
      expect(project.exists('shaders-dist/model.js')).toBe(true); // the rest is intact
      expect(JSON.parse(project.read('shaders-dist/.manifest.json')).status).toBe('error');
      const check = checkShaders({ root: project.root });
      expect(check.ok).toBe(false);
      expect(check.problems.map((p: { code: string }) => p.code)).toContain('failed');
    } finally {
      project.dispose();
    }
  });

  it('a syntax error reports file, line and column', async () => {
    const project = createProject({ 'src/wave.gpu.ts': `${'// filler\n'.repeat(11)}export const = ;\n` });
    try {
      const result = await build(project);
      const diagnostic = result.diagnostics.find((d) => d.source === 'syntax')!;
      expect(diagnostic).toMatchObject({ file: 'src/wave.gpu.ts', line: 12 });
      expect(typeof diagnostic.column).toBe('number');
    } finally {
      project.dispose();
    }
  });

  it('a syntax error in a plain module (no shader code) is reported the same way', async () => {
    const project = createProject({ 'src/model.ts': `export const SCALE = ;\n` });
    try {
      const result = await build(project, true);
      const diagnostic = result.diagnostics.find((d) => d.source === 'syntax' && d.file === 'src/model.ts')!;
      expect(diagnostic).toMatchObject({ line: 1 });
    } finally {
      project.dispose();
    }
  });

  it('a type error in a shader source fails the build with file, line, column and the TS code', async () => {
    const project = createProject({ 'src/model.ts': `export const SCALE: number = 'three';\nexport const state = { count: 0 };\n` });
    try {
      const result = await build(project);
      expect(result.ok).toBe(false);
      expect(result.diagnostics.find((d) => d.source === 'types')).toMatchObject({ file: 'src/model.ts', line: 1, text: expect.stringContaining('TS2322') });
      expect(project.exists('shaders-dist/wave.gpu.js')).toBe(true); // JavaScript is fine; the manifest still says "error"
      expect(JSON.parse(project.read('shaders-dist/.manifest.json')).status).toBe('error');
    } finally {
      project.dispose();
    }
  });

  it('reports a project without shader modules instead of building nothing silently', async () => {
    const project = createProject();
    try {
      project.remove('src/wave.gpu.ts');
      const result = await build(project);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]!.text).toContain('No shader modules found');
    } finally {
      project.dispose();
    }
  });
});

describe('writing the output (other processes read the folder meanwhile: another build, Angular\'s watcher, an IDE)', () => {
  let project: Project;
  const out = () => project.path('shaders-dist');
  const stats = () => Object.fromEntries(readdirSync(out()).filter((name) => !name.startsWith('.')).map((name) => [name, statSync(join(out(), name))]));
  beforeAll(async () => {
    project = createProject();
    await build(project);
  });
  afterAll(() => project.dispose());

  it('a rebuild that changes nothing touches nothing: no new modification time, so nothing downstream rebuilds for nothing', async () => {
    const before = stats();
    const manifest = statSync(join(out(), '.manifest.json'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await build(project);
    for (const [name, stat] of Object.entries(stats())) expect([name, stat.mtimeMs, stat.ino]).toEqual([name, before[name]!.mtimeMs, before[name]!.ino]);
    expect(statSync(join(out(), '.manifest.json')).mtimeMs).toBe(manifest.mtimeMs);
  });

  it('a changed file is replaced by a finished one (never rewritten in place, where a reader could see it half done), and no temporary file is left', async () => {
    const before = stats();
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await build(project);
    const after = stats();
    expect(after['wave.gpu.js']!.ino).not.toBe(before['wave.gpu.js']!.ino); // a new file took the old one's place
    expect(after['model.js']!.ino).toBe(before['model.js']!.ino); // what did not change was not touched
    expect(readdirSync(join(out(), '.tmp'))).toEqual([]);
  });

  it('a reader that polls the folder while it is rebuilt over and over never sees an empty or truncated file', async () => {
    let readerProcess: ReturnType<typeof spawn> | undefined;
    const many = createProject(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/s${i}.gpu.ts`, SHADER.replace(/\bwave\b/, `wave${i}`)])));
    try {
      await build(many);
      const stop = many.path('stop-reading');
      const reader = spawn(process.execPath, [join(__dirname, 'reader.mjs'), many.path('shaders-dist'), stop], { stdio: ['ignore', 'pipe', 'inherit'] });
      readerProcess = reader;
      let printed = '';
      reader.stdout.on('data', (chunk) => (printed += chunk));
      const exited = new Promise((resolve) => reader.on('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let round = 0; round < 12; round++) {
        for (let i = 0; i < 20; i++) many.write(`src/s${i}.gpu.ts`, SHADER.replace(/\bwave\b/, `wave${i}`).replace('std.sin(x) * SCALE', `std.sin(x) * SCALE + ${round}`));
        expect((await build(many)).ok).toBe(true);
      }
      writeFileSync(stop, '');
      await exited;
      const { reads, torn } = JSON.parse(printed);
      expect(reads).toBeGreaterThan(1000);
      expect(torn).toEqual({});
    } finally {
      readerProcess?.kill('SIGKILL'); // whatever happened above, the reader must not outlive the test
      many.dispose();
    }
  }, 60_000);

  it('a plain build does not delete (or write) the stub of a failed module: a dev server in another terminal is using it', async () => {
    const failing = createProject({ 'src/wave.gpu.ts': BAD_SHADER });
    try {
      await build(failing, true);
      const stub = failing.read('shaders-dist/wave.gpu.js');
      expect(stub).toContain('typegpu-shaders-error');
      const plain = await build(failing, false);
      expect(plain.ok).toBe(false);
      expect(failing.read('shaders-dist/wave.gpu.js')).toBe(stub);
    } finally {
      failing.dispose();
    }
  });

  it('a plain build of a module that now fails removes what a good build left for it (a stale shader must not be bundled), and writes no stub', async () => {
    const failing = createProject();
    try {
      await build(failing);
      expect(failing.exists('shaders-dist/wave.gpu.js')).toBe(true);
      failing.write('src/wave.gpu.ts', BAD_SHADER);
      expect((await build(failing, false)).ok).toBe(false);
      expect(failing.exists('shaders-dist/wave.gpu.js')).toBe(false);
      expect(failing.exists('shaders-dist/wave.gpu.js.map')).toBe(false);
    } finally {
      failing.dispose();
    }
  });
});
