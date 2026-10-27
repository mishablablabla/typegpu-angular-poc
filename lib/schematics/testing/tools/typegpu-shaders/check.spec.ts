// `check`: does the generated package match the sources, and does the application import it the way that works?
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { buildShaders, checkShaders, ensureShaders } from '../../../../tools/typegpu-shaders/index.mjs';
// @ts-expect-error plain ES module without types
import { specifiersOf } from '../../../../tools/typegpu-shaders/graph.mjs';
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

describe('import-looking text that is not an import is not an import (B3: TypeScript\'s own scanner decides)', () => {
  const stray = (project: Project) => check(project).problems.filter((p) => p.code === 'stray');
  const TEXT = [
    `const a = "import x from '../wave.gpu'"; // import y from '../wave.gpu'`,
    'const b = `import z from "../wave.gpu"`;',
    `const c = /'/.test("it's"); // from '../wave.gpu'`,
    'export const all = [a, b, c];',
  ].join('\n');

  it('a string, a template literal and a comment after code are not reported; a real import after such a line still is', () => {
    project.write('src/app/text.ts', TEXT);
    expect(stray(project)).toHaveLength(0);
    project.write('src/app/text.ts', `const a = "x"; // note\nimport { wave } from '../wave.gpu';\nexport const all = [a, wave];\n`);
    expect(stray(project)).toHaveLength(1);
  });

  it('the positions are those of the specifier text, so --fix-imports rewrites exactly it (also next to a string that looks like an import)', () => {
    project.write('src/app/text.ts', `const a = "import x from '../wave.gpu'";\nimport { wave } from "../wave.gpu";\nexport const all = [a, wave];\n`);
    expect(check(project, true).fixed).toBe(1);
    expect(project.read('src/app/text.ts')).toBe(`const a = "import x from '../wave.gpu'";\nimport { wave } from "@shaders/wave.gpu";\nexport const all = [a, wave];\n`);
  });

  it('without TypeScript in the project the expression is used: the same imports are found (check needs no TypeScript), a string is then still taken for one', async () => {
    // a project of its own that never resolved TypeScript (Node keeps lookups it has made, even for a folder that was removed since)
    const bare = createProject();
    try {
      const modules = bare.path('node_modules');
      const lib = join(__dirname, '../../../../node_modules');
      rmSync(modules);
      mkdirSync(modules);
      for (const entry of readdirSync(lib)) if (!entry.startsWith('.') && entry !== 'typescript') symlinkSync(join(lib, entry), join(modules, entry), 'junction');
      const imported = `import { wave } from '../wave.gpu';\nexport const all = [wave];\n`;
      const text = `const a = "import x from '../wave.gpu'";\nexport const b = a;\n`;
      expect(specifiersOf(imported, bare.root).map((s: { spec: string }) => s.spec)).toEqual(['../wave.gpu']);
      expect(specifiersOf(text, bare.root)).toHaveLength(1); // the documented limit of the fallback: without a scanner a string that looks like an import is one
      expect(specifiersOf(text, project.root)).toHaveLength(0); // with TypeScript it is not
      expect(specifiersOf(`import { K } from "./it's";\nimport { H } from './say "hi"';`, bare.root).map((s: { spec: string }) => s.spec)).toEqual(["./it's", './say "hi"']); // a quote of the other kind inside the name
      bare.write('src/app/real.ts', imported);
      const result = checkShaders({ root: bare.root }) as { problems: Problem[] };
      expect(result.problems.filter((p) => p.code === 'stray')).toHaveLength(1);
    } finally {
      bare.dispose();
    }
  });
});

describe("a module whose file name has a quote or a '#' in it (C9)", () => {
  it('is part of the closure, built, and followed: a change in it makes the output stale', async () => {
    project.write("src/it's.ts", 'export const K = 1;\n');
    project.write('src/h#sh.ts', 'export const H = 2;\n');
    project.write('src/wave.gpu.ts', `import { K } from "./it's";\nimport { H } from './h#sh';\n${SHADER}\nexport const both = K + H;\n`);
    const result = await buildShaders({ root: project.root });
    expect(result.ok).toBe(true);
    expect(project.exists("shaders-dist/it's.js")).toBe(true);
    expect(project.exists('shaders-dist/h#sh.js')).toBe(true);
    expect(check(project).ok).toBe(true);
    project.write('src/h#sh.ts', 'export const H = 3;\n');
    expect(codes(project)).toContain('stale');
  });

  it('is a stray import when the application imports it by a relative path', async () => {
    project.write('src/h#sh.ts', 'export const H = 2;\n');
    project.write('src/wave.gpu.ts', `import { H } from './h#sh';\n${SHADER}\nexport const h = H;\n`);
    await buildShaders({ root: project.root });
    project.write('src/app/use.ts', `import { H } from '../h#sh';\nexport const x = H;\n`);
    expect(codes(project)).toContain('stray');
    project.write('src/app/use.ts', `import raw from '../wave.gpu.ts?raw';\nexport const x = raw;\n`); // control: the data import is still not one
    expect(codes(project)).not.toContain('stray');
  });
});

describe('a shader module that imports another through the shader alias (B5: TS7016 or TS5055, whichever the state of the output folder produces)', () => {
  const nestedImport = () => project.write('src/other.gpu.ts', `${SHADER}\nexport { wave as again } from '@shaders/wave.gpu';\n`);

  it('check reports it with the relative path to use, in every state of the output', async () => {
    nestedImport();
    for (const state of ['before the first build', 'after it']) {
      if (state === 'before the first build') project.remove('shaders-dist');
      else await buildShaders({ root: project.root }).catch(() => undefined);
      const found = check(project).problems.filter((p) => p.code === 'nested');
      expect(found, state).toHaveLength(1);
      expect(posix(found[0]!.message)).toContain('src/other.gpu.ts');
      expect(found[0]!.message).toContain("'@shaders/wave.gpu'");
      expect(found[0]!.message).toContain("Import './wave.gpu' instead");
    }
  });

  it('ensure refuses it before any build (nothing is written), naming the same path; the fix makes it pass', async () => {
    project.remove('shaders-dist');
    nestedImport();
    const result = await ensureShaders({ root: project.root });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d: { text: string }) => d.text).join('\n')).toContain("Import './wave.gpu' instead");
    expect(project.exists('shaders-dist')).toBe(false);
    project.write('src/other.gpu.ts', `${SHADER}\nexport { wave as again } from './wave.gpu';\n`);
    expect(await ensureShaders({ root: project.root })).toMatchObject({ ok: true });
  });

  it('the path is relative to the importing file (a shader in a subfolder importing a module of the folder above)', () => {
    project.write('src/app/deep.gpu.ts', SHADER.replace("'./model'", "'../model'") + `\nexport { state } from '@shaders/model';\n`);
    const message = check(project).problems.find((p) => p.code === 'nested')!.message;
    expect(message).toContain("Import '../model' instead");
  });

  it('application code importing through the alias is not nested (that is the way it is meant to be imported)', () => {
    expect(check(project).problems.map((p) => p.code)).not.toContain('nested');
  });
});
