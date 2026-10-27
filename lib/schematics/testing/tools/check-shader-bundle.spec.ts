// Spawns tools/check-shader-bundle.mjs on fixture directories, the way CI runs it.
// Fixtures in ../fixtures are real output: `transformed/` is unplugin-typegpu output (the @typegpu/noise dist and a
// sample bundled with esbuild, development and minified), `untransformed/` the same sample bundled without the transform.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// CHECK_SHADER_BUNDLE_TOOL lets a run point at another copy of the tool (e.g. an older one, to prove the tests catch the old bugs).
const posix = (text: string) => text.replaceAll('\\', '/');
const TOOL = process.env['CHECK_SHADER_BUNDLE_TOOL'] ?? join(__dirname, '..', '..', '..', 'tools', 'check-shader-bundle.mjs');
const FIXTURES = join(__dirname, '..', 'fixtures');
const TRANSFORMED = "e.f=function(r){'use gpu';return r};\n";
const UNTRANSFORMED = "const f = (x) => { 'use gpu'; return x; };\n";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'check-shader-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
};

describe('check-shader-bundle: usage and directories', () => {
  it('needs a directory argument', () => {
    const r = run();
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage:/);
  });

  it('--help prints the usage and the exit codes and exits 0 (found by QA: it was "unknown option")', () => {
    for (const flag of ['--help', '-h']) {
      const r = run(flag);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Usage:/);
      expect(r.out).toMatch(/Exit codes/);
    }
  });

  it('rejects an unknown option', () => {
    expect(run('--nope', '.').code).toBe(2);
  });

  it('fails with one clear line for a missing directory, not a stack trace', () => {
    const r = run('dist/app/browser');
    expect(r.code).toBe(2);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(posix(r.err)).toMatch(/directory not found: .*dist\/app\/browser.*run the build first/);
    expect(r.err).not.toMatch(/ENOENT|at /);
  });

  it('fails clearly when the argument is a file', () => {
    put('main.js', TRANSFORMED);
    const r = run('main.js');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not a directory/);
  });
});

describe('check-shader-bundle: what it scans', () => {
  it('treats an empty directory as an error by default', () => {
    mkdirSync(join(dir, 'out'));
    const r = run('out');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no 'use gpu' directive in 0 script file\(s\)/);
    expect(r.err).toMatch(/--allow-empty/);
    expect(r.out).toMatch(/scanning 0 script file\(s\) under .*out/);
  });

  it('--allow-empty turns "nothing to check" into a warning and exit 0', () => {
    put('out/main.js', 'console.log(1);\n');
    const r = run('--allow-empty', 'out');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/warning: no 'use gpu' directive in 1 script file\(s\).*nothing was checked/);
    const flagLast = run('out', '--allow-empty');
    expect(flagLast.code).toBe(0);
  });

  it('--allow-empty does not hide an untransformed directive', () => {
    put('out/main.js', UNTRANSFORMED);
    expect(run('--allow-empty', 'out').code).toBe(1);
  });

  it('prints the directory and the number of files it scanned, and counts the directives', () => {
    put('out/main.js', TRANSFORMED);
    put('out/chunk.js', 'x();');
    const r = run('out');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scanning 2 script file\(s\) under .*out/);
    expect(r.out).toMatch(/ok: 1 'use gpu' directive\(s\) in 2 file\(s\)/);
  });

  it('recurses into subfolders (localized builds) and reads .mjs and .cjs (SSR server bundles)', () => {
    put('dist/browser/de/main-ABC.js', TRANSFORMED);
    put('dist/browser/fr/main-DEF.js', TRANSFORMED);
    put('dist/server/server.mjs', TRANSFORMED);
    put('dist/server/chunk.cjs', TRANSFORMED);
    const ok = run('dist');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/ok: 4 'use gpu' directive\(s\) in 4 file\(s\)/);

    for (const [path, name] of [['dist/browser/fr/main-DEF.js', 'fr/main-DEF.js'], ['dist/server/server.mjs', 'server/server.mjs'], ['dist/server/chunk.cjs', 'server/chunk.cjs']] as const) {
      put(path, UNTRANSFORMED);
      const bad = run('dist');
      expect(bad.code, path).toBe(1);
      expect(posix(bad.err), path).toContain(name);
      put(path, TRANSFORMED);
    }
  });

  it('ignores other file types', () => {
    put('out/main.js', TRANSFORMED);
    put('out/main.js.map', UNTRANSFORMED);
    put('out/index.html', `<script>${UNTRANSFORMED}</script>`);
    put('out/3rdpartylicenses.txt', UNTRANSFORMED);
    expect(run('out').code).toBe(0);
  });

  it('scans several directories', () => {
    put('a/main.js', TRANSFORMED);
    put('b/server.mjs', UNTRANSFORMED);
    const r = run('a', 'b');
    expect(r.code).toBe(1);
    expect(r.err).toContain('server.mjs');
    expect(r.out).toMatch(/scanning 1 script file\(s\) under .*a\n/);
    expect(r.out).toMatch(/scanning 1 script file\(s\) under .*b\n/);
  });
});

describe('check-shader-bundle: what it counts', () => {
  it('does not count the directive text inside strings, template literals, comments or regular expressions', () => {
    put('out/main.js', ["const a = \"Use 'use gpu'; here\";", "const b = `function f() { 'use gpu'; }`;", "// function g() { 'use gpu'; }", "/* 'use gpu'; */", TRANSFORMED].join('\n'));
    const r = run('out');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ok: 1 'use gpu' directive\(s\)/);
  });

  it('a file with only such text counts as having no directive', () => {
    put('out/main.js', "const a = \"'use gpu';\";\n");
    expect(run('out').code).toBe(1);
    expect(run('out', '--allow-empty').code).toBe(0);
  });

  it('reports file, line and the code before an untransformed directive', () => {
    put('out/main.js', `const x = 1;\n${UNTRANSFORMED}`);
    const r = run('out');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/1 of 1 'use gpu' directive\(s\) were not transformed/);
    expect(posix(r.err)).toMatch(/out\/main\.js:2 /);
  });

  it('names Web Workers when the offending file is a worker bundle, and lists them as a possible cause otherwise', () => {
    put('out/worker-ABC123.js', UNTRANSFORMED);
    const worker = run('out');
    expect(worker.code).toBe(1);
    expect(posix(worker.err)).toMatch(/Web Workers are not supported.*out\/worker-ABC123\.js/);

    rmSync(join(dir, 'out'), { recursive: true });
    put('out/main.js', UNTRANSFORMED);
    const main = run('out');
    expect(main.err).toMatch(/Web Worker bundle \(not supported/);
    expect(main.err).toMatch(/plugin is missing from the build configuration/);
  });
});

describe('check-shader-bundle: the list of possible causes (C12: removing the tsconfig `paths` line failed no test)', () => {
  it('names every way a directive stays untransformed, so the person reading the failure can tell which applies', () => {
    put('out/main.js', UNTRANSFORMED);
    const { code, err } = run('out');
    expect(code).toBe(1);
    expect(err).toContain('Possible causes:');
    expect(err).toContain('build.options.plugins and configurations[*].plugins'); // the plugin is not configured
    expect(err).toContain('is not named *.gpu.ts'); // the module name
    expect(err).toContain('imports a shader module by a relative path instead of \'@shaders/...\''); // prebuild, relative
    expect(err).toContain('typegpu-shaders check');
    expect(err).toContain('through a tsconfig `paths` alias or a `baseUrl` path other than \'@shaders/...\''); // prebuild, tsconfig alias
    expect(err).toContain('Web Worker');
  });

  it('is not printed when everything is transformed', () => {
    put('out/main.js', TRANSFORMED);
    expect(run('out').err).not.toContain('Possible causes');
  });
});

describe('check-shader-bundle: a string at the start of a block is not a directive (B8)', () => {
  it('an `if` block, a bare block and a loop body next to a transformed function pass; a real untransformed function in the same file still fails', () => {
    const noise = "if (x) { 'use gpu'; }\n{ 'use gpu'; }\nfor (;;) { \"use gpu\" }\ntry { 'use gpu' } catch { 'use gpu' }\n";
    put('out/main.js', noise + TRANSFORMED);
    const ok = run('out');
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/ok: 1 'use gpu' directive\(s\)/);
    put('out/main.js', noise + UNTRANSFORMED);
    const bad = run('out');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/1 of 1 'use gpu' directive\(s\) were not transformed/);
  });
});

describe('check-shader-bundle: real transformed output', () => {
  it('passes on the @typegpu/noise dist (the parenthesised `$.f = (function ...` wrapper) and on esbuild output of unplugin-typegpu', () => {
    cpSync(join(FIXTURES, 'transformed'), join(dir, 'transformed'), { recursive: true });
    const r = run('transformed');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ok: 30 'use gpu' directive\(s\) in 3 file\(s\)/); // 22 noise + 4 + 4 (development and minified sample)
  });

  it('fails on the same sample bundled without the transform', () => {
    cpSync(join(FIXTURES, 'untransformed'), join(dir, 'untransformed'), { recursive: true });
    const r = run('untransformed');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/8 of 8 'use gpu' directive\(s\) were not transformed/);
  });
});
