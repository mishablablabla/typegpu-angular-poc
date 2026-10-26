// `check`: does the generated package match the sources, and does the application import it the way that works?
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { buildShaders, checkShaders, ensureShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { BAD_SHADER, createProject, posix, SHADER, tsconfigWith, type Project } from './project';

type Problem = { code: string; message: string };
const check = (project: Project, fixImports = false) => checkShaders({ root: project.root }, { fixImports }) as { ok: boolean; problems: Problem[]; fixed: number };
const codes = (project: Project) => check(project).problems.map((p) => p.code);

let project: Project;
beforeEach(async () => {
  project = createProject();
  await buildShaders({ root: project.root });
});
afterEach(() => project.dispose());

describe('check: the generated package against the sources', () => {
  it('passes right after a build', () => {
    expect(check(project)).toMatchObject({ ok: true, problems: [] });
  });

  it('reports a package that was never built or was deleted', () => {
    project.remove('shaders-dist');
    expect(codes(project)).toEqual(['missing']);
  });

  it('reports a shader edited since the build as stale, with the command that fixes it', () => {
    project.write('src/wave.gpu.ts', SHADER.replace('* SCALE', '* SCALE * 2'));
    const { problems } = check(project);
    expect(problems.map((p) => p.code)).toEqual(['stale']);
    expect(problems[0]!.message).toContain('STALE');
    expect(problems[0]!.message).toContain('typegpu-shaders build');
  });

  it('reports a change in a plain module a shader imports as stale too (it is part of the package)', () => {
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 4;\n');
    expect(codes(project)).toContain('stale');
  });

  it('ignores an edit of application code outside the shader package', () => {
    project.write('src/app/main.ts', `${project.read('src/app/main.ts')}// edited\n`);
    expect(check(project).ok).toBe(true);
  });

  it('reports a generated file that was deleted', () => {
    project.remove('shaders-dist/model.js');
    const { problems } = check(project);
    expect(problems.map((p) => p.code)).toContain('incomplete');
    expect(problems.find((p) => p.code === 'incomplete')!.message).toContain('model.js');
    expect(problems.map((p) => p.code)).toContain('unresolved'); // and the application's `@shaders/model` import no longer resolves
  });

  it('reports a module that was added to the closure since the build (a new import in a shader)', () => {
    project.write('src/helper.ts', 'export const H = 1;\n');
    project.write('src/wave.gpu.ts', `import { H } from './helper';\nvoid H;\n${SHADER}`);
    expect(codes(project)).toContain('stale');
  });

  it('reports a failed build as failed even though the sources have not changed since', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    await buildShaders({ root: project.root });
    const found = codes(project);
    expect(found[0]).toBe('failed'); // the sources are the same as in the failed build, so it is not reported as stale
    expect(found).not.toContain('stale');
  });

  it('reports a source tree without shader modules', () => {
    project.remove('src/wave.gpu.ts');
    expect(codes(project)).toEqual(['empty']);
  });
});

describe('check: how the application imports the shader package', () => {
  it('finds a relative import of a shader module and names the import that works', () => {
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    const { problems } = check(project);
    expect(problems.map((p) => p.code)).toEqual(['stray']);
    expect(problems[0]!.message).toContain("'@shaders/wave.gpu'");
    expect(problems[0]!.message).toContain('stray.ts');
  });

  it('finds relative imports of plain modules that the shaders use too (they would be a second instance)', () => {
    project.write('src/app/stray.ts', `import { state } from '../model';\nexport const s = state;\n`);
    expect(check(project).problems[0]).toMatchObject({ code: 'stray', message: expect.stringContaining("'@shaders/model'") });
  });

  it('finds dynamic imports and re-exports as well', () => {
    project.write('src/app/a.ts', `export const load = () => import('../wave.gpu');\n`);
    project.write('src/app/b.ts', `export * from '../model';\n`);
    expect(check(project).problems.filter((p) => p.code === 'stray')).toHaveLength(2);
  });

  it('--fix-imports rewrites them to the alias, and the result passes', () => {
    project.write('src/app/stray.ts', `import { wave } from '../wave.gpu';\nimport type { X } from '../model';\nexport const x = wave;\n`);
    const result = check(project, true);
    expect(result.fixed).toBe(1);
    expect(result.ok).toBe(true);
    expect(project.read('src/app/stray.ts')).toBe(`import { wave } from '@shaders/wave.gpu';\nimport type { X } from '@shaders/model';\nexport const x = wave;\n`);
  });

  it('finds an alias import that matches no generated module', () => {
    project.write('src/app/typo.ts', `import { wave } from '@shaders/wave.gpuu';\nexport const x = wave;\n`);
    const { problems } = check(project);
    expect(problems.map((p) => p.code)).toEqual(['unresolved']);
    expect(problems[0]!.message).toContain("'@shaders/wave.gpuu'");
  });

  it('leaves imports with a query (`?raw`, `?source`: the file as text, not as code) alone, also with --fix-imports', () => {
    project.write('src/app/text.ts', `import text from '../wave.gpu.ts?source';\nexport const t = text;\n`);
    const result = check(project, true);
    expect(result.ok).toBe(true);
    expect(result.fixed).toBe(0);
    expect(project.read('src/app/text.ts')).toContain("'../wave.gpu.ts?source'");
  });

  it('does not touch imports of ordinary application modules', () => {
    project.write('src/app/util.ts', 'export const u = 1;\n');
    project.write('src/app/uses.ts', `import { u } from './util';\nimport { used } from './main';\nexport const x = [u, used];\n`);
    expect(check(project).ok).toBe(true);
  });
});

describe('output that is not what the last build wrote', () => {
  // A build that is killed after it replaced some files but before it wrote the manifest leaves the OLD manifest next to NEW files; when the
  // sources are then reverted (git checkout, undo), their hash matches that manifest again, and only the files themselves show it.
  async function interruptedThenReverted() {
    const manifest = project.read('shaders-dist/.manifest.json');
    project.write('src/wave.gpu.ts', SHADER.replace('std.sin(x) * SCALE', 'std.cos(x) * SCALE'));
    await buildShaders({ root: project.root });
    project.write('shaders-dist/.manifest.json', manifest); // the manifest write that never happened
    project.write('src/wave.gpu.ts', SHADER);
  }

  it('is not current even though the sources match the manifest', async () => {
    await interruptedThenReverted();
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.cos(x)');
    expect(codes(project)).toEqual(['incomplete']);
    expect(check(project).problems[0]!.message).toContain('not the ones the last build wrote');
  });

  it('is rebuilt by ensure (what every ng build does) instead of being bundled', async () => {
    await interruptedThenReverted();
    const result = await ensureShaders({ root: project.root });
    expect(result).toMatchObject({ ok: true, built: true });
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('std.sin(x)');
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain('std.cos(x)');
  });

  it('a generated file edited by hand is noticed', () => {
    project.write('shaders-dist/model.js', project.read('shaders-dist/model.js') + '\nexport const injected = 1;\n');
    expect(codes(project)).toEqual(['incomplete']);
  });
});

describe('stray imports: comments are not imports (found by QA: a migration comment blocked the build)', () => {
  const stray = (project: Project) => check(project).problems.filter((p) => p.code === 'stray').length;

  it('a comment line, a block comment and a JSDoc that mention an import of a shader module are not reported; the real import next to them still is', () => {
    project.write(
      'src/app/commented.ts',
      [
        "// old: import { wave } from '../wave.gpu';",
        '/*',
        " * import { wave } from '../wave.gpu';",
        ' */',
        '/** usage: `import { wave } from "../wave.gpu"` */',
        'export const x = 1;',
      ].join('\n'),
    );
    expect(stray(project)).toBe(0);
    project.write('src/app/commented.ts', `// import { wave } from '../wave.gpu';\nimport { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    expect(stray(project)).toBe(1);
  });

  it('a one-line block comment before an import on the next line does not hide it', () => {
    project.write('src/app/after.ts', `/* note */\nimport { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    expect(stray(project)).toBe(1);
  });

  it('--fix-imports leaves the comment alone and rewrites the import', () => {
    project.write('src/app/fix.ts', `// import { wave } from '../wave.gpu';\nimport { wave } from '../wave.gpu';\nexport const x = wave;\n`);
    expect(check(project, true).fixed).toBe(1);
    expect(project.read('src/app/fix.ts')).toBe(`// import { wave } from '../wave.gpu';\nimport { wave } from '@shaders/wave.gpu';\nexport const x = wave;\n`);
  });
});


describe('check: a shader module imported through a tsconfig `paths` / `baseUrl` alias (found by QA: only the bundle scan noticed, after bundling)', () => {
  const PATHS = { paths: { '@app/*': ['./src/app/*'], '@src/*': ['./src/*'], '@shaders/*': ['./shaders-dist/*'] } };
  const aliased = (project: Project) => check(project).problems.filter((p) => p.code === 'aliased');

  beforeEach(() => {
    project.write('tsconfig.app.json', tsconfigWith(PATHS));
    project.write('src/app/wave.gpu.ts', SHADER.replace("'./model'", "'../model'"));
  });

  it('reports the import before bundling and names the @shaders import that works', () => {
    project.write('src/app/canvas.ts', `import { wave } from '@app/wave.gpu';\nexport const c = wave;\n`);
    const { ok, problems } = check(project);
    const found = problems.filter((p) => p.code === 'aliased');
    expect(ok).toBe(false);
    expect(found).toHaveLength(1);
    expect(posix(found[0]!.message)).toContain('src/app/canvas.ts');
    expect(found[0]!.message).toContain("'@app/wave.gpu'");
    expect(found[0]!.message).toContain("Import '@shaders/app/wave.gpu' instead");
    expect(posix(found[0]!.message)).toContain('src/app/wave.gpu.ts');
  });

  it('also finds a plain module the shaders import (a second instance of it), and dynamic imports', () => {
    project.write('src/app/a.ts', `export const load = () => import('@src/wave.gpu');\n`);
    project.write('src/app/b.ts', `export { state } from '@src/model';\n`);
    expect(aliased(project).map((p) => p.message.match(/Import '([^']+)'/)![1]).sort()).toEqual(['@shaders/model', '@shaders/wave.gpu']);
  });

  it('finds a bare specifier that `baseUrl` resolves', () => {
    project.write('tsconfig.app.json', tsconfigWith({ baseUrl: '.' }));
    project.write('src/app/canvas.ts', `import { wave } from 'src/wave.gpu';\nexport const c = wave;\n`);
    expect(aliased(project).map((p) => p.message)).toEqual([expect.stringContaining("Import '@shaders/wave.gpu' instead")]);
  });

  it('finds it when `paths` comes from a tsconfig the project extends (the base is in another folder)', () => {
    project.write('config/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['../src/*'] } } }));
    project.write('tsconfig.app.json', tsconfigWith({}, { extends: './config/tsconfig.base.json' }));
    project.write('src/app/canvas.ts', `import { wave } from '@lib/wave.gpu';\nexport const c = wave;\n`);
    expect(aliased(project)).toHaveLength(1);
  });

  it('does not flag an alias to an ordinary application module, a `?raw` import, or a package', () => {
    project.write('src/app/util.ts', 'export const u = 1;\n');
    project.write('src/app/canvas.ts', `import { u } from '@app/util';\nimport text from '@app/wave.gpu?raw';\nimport tgpu from 'typegpu';\nexport const c = [u, text, tgpu];\n`);
    expect(aliased(project)).toEqual([]);
    expect(check(project).problems.map((p) => p.code)).not.toContain('aliased');
  });

  it('does not flag a node_modules package named like a shader module (baseUrl finds nothing there, the package is used)', () => {
    // a node_modules of its own: the one the helper linked is the package's, which a test must not write into
    const modules = project.path('node_modules');
    const lib = join(__dirname, '../../../../node_modules');
    rmSync(modules);
    mkdirSync(modules);
    for (const entry of readdirSync(lib)) if (!entry.startsWith('.')) symlinkSync(join(lib, entry), join(modules, entry), 'junction');
    mkdirSync(join(modules, 'wave.gpu'));
    project.write('node_modules/wave.gpu/package.json', JSON.stringify({ name: 'wave.gpu', version: '1.0.0', types: 'index.d.ts' }));
    project.write('node_modules/wave.gpu/index.d.ts', 'export const wave: number;\n');
    project.write('tsconfig.app.json', tsconfigWith({ baseUrl: '.' })); // `wave.gpu` is not ./wave.gpu: the shader is ./src/wave.gpu.ts
    project.write('src/app/canvas.ts', `import { wave } from 'wave.gpu';\nexport const c = wave;\n`);
    expect(aliased(project)).toEqual([]);
    project.write('src/app/canvas.ts', `import { wave } from 'src/wave.gpu';\nexport const c = wave;\n`); // control: the same project does flag the real one
    expect(aliased(project)).toHaveLength(1);
  });

  it('a tsconfig that cannot be read gives no alias problem and does not throw (the build reports the tsconfig itself)', () => {
    project.write('src/app/canvas.ts', `import { wave } from '@app/wave.gpu';\nexport const c = wave;\n`);
    for (const broken of ['{ "compilerOptions": { "paths": ', JSON.stringify({ extends: './missing.json' })]) {
      project.write('tsconfig.app.json', broken);
      expect(() => check(project)).not.toThrow();
      expect(check(project).problems.map((p) => p.code)).not.toContain('aliased');
    }
    project.remove('tsconfig.app.json');
    project.remove('tsconfig.json');
    expect(() => check(project)).not.toThrow();
  });

  it('--fix-imports rewrites the aliased specifier, and the result passes', () => {
    project.write('src/app/canvas.ts', `import { wave } from '@app/wave.gpu';\nimport { state } from "@src/model";\nexport const c = [wave, state];\n`);
    const result = check(project, true);
    expect(result.fixed).toBe(1);
    expect(project.read('src/app/canvas.ts')).toBe(`import { wave } from '@shaders/app/wave.gpu';\nimport { state } from "@shaders/model";\nexport const c = [wave, state];\n`);
    expect(aliased(project)).toEqual([]);
  });
});
