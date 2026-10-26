// The command line: exit codes and the order in which things happen.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAD_SHADER, CLI, createProject, posix, type Project } from './project';

let project: Project;
beforeEach(() => {
  project = createProject();
});
afterEach(() => project.dispose());

const run = (args: string[], timeout = 60_000) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project.root, encoding: 'utf8', timeout });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
// A script file rather than an inline `node -e '...'`: the same on every platform, whatever the shell would make of the quoting.
let scripts = 0;
const JS = (code: string) => {
  const file = `probe-${++scripts}.cjs`;
  project.write(file, code);
  return ['node', file];
};

describe('build / check', () => {
  it('build exits 0 and prints the module count; check then exits 0', () => {
    expect(run(['build'])).toMatchObject({ code: 0, out: expect.stringContaining('2 modules') });
    expect(run(['check'])).toMatchObject({ code: 0 });
  });

  it('check exits 1 when nothing was built, and says what to run', () => {
    const result = run(['check']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('typegpu-shaders build');
  });

  it('build exits 1 on a transformation error and prints file-specific diagnostics', () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const result = run(['build']);
    expect(result.code).toBe(1);
    expect(posix(result.err)).toContain('src/wave.gpu.ts');
    expect(result.err).toContain('TryStatement');
    expect(run(['check']).code).toBe(1);
  });

  it('build prints a syntax error with file:line:column and the source line', () => {
    project.write('src/model.ts', 'export const a = 1;\nexport const = ;\n');
    const result = run(['build']);
    expect(result.code).toBe(1);
    expect(posix(result.err)).toMatch(/src\/model\.ts:2:\d+ - error/);
    expect(result.err).toContain('export const = ;');
  });

  it('options: --out and --alias change where the output goes and what check expects', () => {
    expect(run(['build', '--out', 'gen']).code).toBe(0);
    expect(project.exists('gen/wave.gpu.js')).toBe(true);
    project.write('src/app/main.ts', `import { wave } from '~gen/wave.gpu';\nexport const x = wave;\n`);
    expect(run(['check', '--out', 'gen', '--alias', '~gen/']).code).toBe(0);
    expect(run(['check', '--out', 'gen']).code).toBe(0); // the default alias never matches '~gen/', so it is just another package import
  });

  it('reads typegpu-shaders.config.json, and flags override it', () => {
    project.write('typegpu-shaders.config.json', JSON.stringify({ out: 'from-config' }));
    expect(run(['build']).code).toBe(0);
    expect(project.exists('from-config/wave.gpu.js')).toBe(true);
    expect(run(['build', '--out', 'from-flag']).code).toBe(0);
    expect(project.exists('from-flag/wave.gpu.js')).toBe(true);
  });

  it('usage errors exit 2', () => {
    expect(run([]).code).toBe(2);
    expect(run(['nonsense']).code).toBe(2);
    expect(run(['run']).code).toBe(2);
    expect(run(['build', '--bogus']).code).toBe(2);
  });

  it('a missing dependency is explained', () => {
    project.remove('node_modules');
    const result = run(['build']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/needs "esbuild" in your project/);
  });
});

describe('run: the build always comes first', () => {
  it('builds, then runs the command, which sees the fresh output; its exit code is the result', () => {
    const result = run(['run', '--', ...JS(`process.exit(require('fs').existsSync('shaders-dist/wave.gpu.js') ? 7 : 9)`)]);
    expect(result.code).toBe(7);
  });

  it('rebuilds a stale package before the command (no stale output reaches it)', () => {
    run(['build']);
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 99;\n');
    const result = run(['run', '--', ...JS(`process.exit(require('fs').readFileSync('shaders-dist/model.js','utf8').includes('SCALE = 99') ? 0 : 9)`)]);
    expect(result.code).toBe(0);
  });

  it('does not run the command when the build fails, and exits 1', () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const result = run(['run', '--', ...JS(`require('fs').writeFileSync('ran.txt','x')`)]);
    expect(result.code).toBe(1);
    expect(project.exists('ran.txt')).toBe(false);
    expect(result.err).toContain('not running');
  });

  it('finds executables in the project node_modules/.bin like an npm script (the earlier version of this test passed for any command name)', () => {
    // The fixture's node_modules is a symlink to the package's own: replace the LINK by a private folder first, never write through it.
    unlinkSync(join(project.root, 'node_modules'));
    project.remove('src/wave.gpu.ts'); // nothing to build, so no dependency of the tool is needed
    const bin = join(project.root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'qa-probe.cmd'), '@echo off\r\necho ran> probe-ran.txt\r\nexit /b 7\r\n'); // what npm puts in .bin on Windows
    } else {
      writeFileSync(join(bin, 'qa-probe'), '#!/bin/sh\necho ran > probe-ran.txt\nexit 7\n');
      chmodSync(join(bin, 'qa-probe'), 0o755);
    }
    const result = run(['run', '--', 'qa-probe']);
    expect(result.code).toBe(7);
    expect(project.read('probe-ran.txt')).toContain('ran');
    expect(run(['run', '--', 'definitely-not-a-command']).code).toBe(127); // on Windows too: the tool looks the command up itself
  });
});

describe('check --fix-imports and --help', () => {
  it('rewrites a relative import of a shader module to the alias, then check passes; without the flag check fails on it', () => {
    run(['build']);
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    const before = run(['check']);
    expect(before.code).toBe(1);
    expect(before.err).toContain('@shaders/wave.gpu');
    const fixed = run(['check', '--fix-imports']);
    expect(fixed.code).toBe(0);
    expect(project.read('src/app/stray.ts')).toBe(`import { wave } from '@shaders/wave.gpu';\nexport const x = wave;\n`);
    expect(run(['check']).code).toBe(0);
  });

  it('--help prints the commands and exits 0', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: typegpu-shaders');
  });
});

describe('dev: watching while a command runs', () => {
  it('has built before the command starts, and ends with the command, passing its exit code', () => {
    const result = run(['dev', '--', ...JS(`setTimeout(() => process.exit(require('fs').existsSync('shaders-dist/wave.gpu.js') ? 3 : 9), 300)`)]);
    expect(result.code).toBe(3);
  });

  it('still starts the command when the first build fails (the failing module shows its error), and says so', () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    // the command sees the stub (it is what the dev server would serve) ...
    const result = run(['dev', '--', ...JS(`setTimeout(() => process.exit(require('fs').readFileSync('shaders-dist/wave.gpu.js','utf8').includes('typegpu-shaders-error') ? 4 : 9), 200)`)]);
    expect(result.code).toBe(4);
    expect(result.err).toContain('first build failed');
    // ... and once the session is over nothing is left that a plain build could bundle
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
    expect(run(['check']).code).toBe(1);
  });
});

describe('a project without shader modules (right after `ng add`)', () => {
  beforeEach(() => project.remove('src/wave.gpu.ts'));

  it('run and dev still run the wrapped command, with its exit code, and say that there was nothing to build', () => {
    const ran = run(['run', '--', ...JS(`process.exit(5)`)]);
    expect(ran.code).toBe(5);
    expect(ran.out).toContain('nothing to build');
    const dev = run(['dev', '--', ...JS(`process.exit(6)`)]);
    expect(dev.code).toBe(6);
    expect(dev.out).toContain('nothing to build');
    expect(project.exists('shaders-dist')).toBe(false); // nothing was written
  });

  it('build and check stay strict: there is nothing to build or to check', () => {
    expect(run(['build']).code).toBe(1);
    expect(run(['check']).code).toBe(1);
  });
});

describe('the commands the package exposes', () => {
  it('declares typegpu-shaders and typegpu-check-bundle, both with a node shebang', () => {
    const lib = join(__dirname, '..', '..', '..', '..');
    const manifest = JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(Object.keys(manifest.bin).sort()).toEqual(['typegpu-check-bundle', 'typegpu-shaders']);
    for (const file of Object.values(manifest.bin)) expect(readFileSync(join(lib, file), 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
