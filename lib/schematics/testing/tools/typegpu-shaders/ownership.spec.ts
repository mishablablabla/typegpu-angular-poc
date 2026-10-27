// QA regressions: what the tool may delete, and what happens when the last shader module goes away.
// Found by the QA run (QA_FINDINGS.md L1, L2) on the packed package with real `ng` commands.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { createBuilder } from '../../../../tools/typegpu-shaders/build.mjs';
// @ts-expect-error plain ES module without types
import { buildShaders, checkShaders, ensureShaders, resolveConfig, watchShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { BAD_SHADER, createProject, waitFor, type Project } from './project';

let project: Project;
beforeEach(() => {
  project = createProject();
});
afterEach(() => project.dispose());

describe('the output folder: only what the tool wrote is ever deleted', () => {
  it('files of the user in the output folder survive a build and a rebuild after a module was removed', async () => {
    project.write('shaders-dist/notes.md', 'my notes');
    project.write('shaders-dist/sub/data.json', '{"keep":true}');
    project.write('src/extra.gpu.ts', project.read('src/wave.gpu.ts').replace('wave', 'extra'));
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(project.exists('shaders-dist/extra.gpu.js')).toBe(true);
    project.remove('src/extra.gpu.ts');
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(project.exists('shaders-dist/extra.gpu.js')).toBe(false); // what the tool wrote is still pruned
    expect(project.read('shaders-dist/notes.md')).toBe('my notes');
    expect(project.read('shaders-dist/sub/data.json')).toBe('{"keep":true}');
  });

  // Only the configuration is resolved here, never a build: before the fix a build with such an `out` emptied the project folder, and
  // through a symlinked node_modules the directory the link points to (the QA run lost lib/node_modules to exactly this).
  it.each([['.'], ['..'], ['src'], ['src/app/..'], ['src/..']])('refuses an output folder (%s) that is, or contains, the sources or the project: a build would delete them', (out) => {
    expect(() => resolveConfig({ root: project.root, out })).toThrow(/out/i);
  });

  it('accepts a dedicated folder, also inside the sources', () => {
    expect(() => resolveConfig({ root: project.root, out: 'shaders-dist' })).not.toThrow();
    expect(() => resolveConfig({ root: project.root, out: 'src/generated' })).not.toThrow();
  });
});

describe('the last shader module is deleted while the application still imports its output', () => {
  it('ensure removes the stale output and fails on the dangling import (a plain build must not bundle a shader that no longer exists)', async () => {
    expect((await ensureShaders({ root: project.root })).ok).toBe(true);
    project.remove('src/wave.gpu.ts');
    project.remove('src/model.ts'); // nothing is imported by a shader module any more
    const result = await ensureShaders({ root: project.root });
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostics)).toContain("'@shaders/wave.gpu' does not match a generated shader module");
  });

  it('with no import left, the project builds as a project without shaders, and nothing of the old output remains', async () => {
    await ensureShaders({ root: project.root });
    project.remove('src/wave.gpu.ts');
    project.remove('src/model.ts');
    project.write('src/app/main.ts', 'export const used = 1;\n');
    const result = await ensureShaders({ root: project.root });
    expect(result).toMatchObject({ ok: true, skipped: 'empty' });
    expect(existsSync(project.path('shaders-dist/wave.gpu.js'))).toBe(false);
    expect(checkShaders({ root: project.root }).ok).toBe(false); // `check` says there is nothing to check
  });

  it('watch mode prunes the output of the last module too', async () => {
    const watcher = watchShaders({ root: project.root }, {});
    try {
      await watcher.ready;
      expect(project.exists('shaders-dist/wave.gpu.js')).toBe(true);
      project.remove('src/wave.gpu.ts');
      project.remove('src/model.ts');
      await waitFor(() => !project.exists('shaders-dist/wave.gpu.js'), 'the stale output to be removed');
    } finally {
      watcher.close();
      await watcher.settled(); // the rebuild that pruned is still writing its manifest: it must end before the project is removed
    }
  });
});

describe('the sources change, and change back, while a build runs (A, then B, then A again)', () => {
  const marked = (marker: string) => project.read('src/wave.gpu.ts').replace(/std\.\w+\(x\)/, `std.${marker}(x)`);
  const A = 'sin';
  const B = 'cos';

  it('the output is what was read when the build started, and the manifest describes exactly that: after the revert it is fresh and correct, in between it is stale', async () => {
    const config = resolveConfig({ root: project.root });
    const builder = createBuilder(config, {
      // an edit to B right after the build has read its sources (the barrier a real race would need)
      afterSnapshot: () => project.write('src/wave.gpu.ts', marked(B)),
    });
    expect((await builder.run({})).ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).toContain(`std.${A}(x)`); // built from A, not from the B that appeared meanwhile
    expect(project.read('shaders-dist/wave.gpu.d.ts')).toBeTruthy();
    expect(checkShaders({ root: project.root }).problems.map((p: { code: string }) => p.code)).toContain('stale'); // the disk says B now
    project.write('src/wave.gpu.ts', marked(A)); // reverted: A again
    expect(checkShaders({ root: project.root }).ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).toContain(`std.${A}(x)`); // fresh AND true
    expect(project.read('shaders-dist/wave.gpu.js')).not.toContain(`std.${B}(x)`);
  });
});

describe('the declarations and the type errors come from the snapshot the build read, not from the disk (C3)', () => {
  // The TypeScript host must read the snapshot: a build that read the disk would describe a file the manifest hash was not taken from.
  const tagged = (value: string) => `${project.read('src/wave.gpu.ts')}\nexport const tag = '${value}';\n`;

  it('an edit after the sources were read does not reach the declaration (.d.ts), while the JavaScript and the declaration agree', async () => {
    project.write('src/wave.gpu.ts', tagged('before'));
    const builder = createBuilder(resolveConfig({ root: project.root }), { afterSnapshot: () => project.write('src/wave.gpu.ts', tagged('after')) });
    expect((await builder.run({})).ok).toBe(true);
    expect(project.read('shaders-dist/wave.gpu.js')).toContain('"before"');
    expect(project.read('shaders-dist/wave.gpu.d.ts')).toContain('"before"');
    expect(project.read('shaders-dist/wave.gpu.d.ts')).not.toContain('after');
  });

  it('a type error in the sources that were read is reported even when the disk was fixed meanwhile, and one that appeared meanwhile is not', async () => {
    const config = resolveConfig({ root: project.root });
    const broken = `${project.read('src/wave.gpu.ts')}\nexport const wrong: number = 'text';\n`;
    project.write('src/wave.gpu.ts', broken);
    const fixedMeanwhile = createBuilder(config, { afterSnapshot: () => project.write('src/wave.gpu.ts', project.read('src/wave.gpu.ts').replace("'text'", '1')) });
    const first = await fixedMeanwhile.run({});
    expect(first.ok).toBe(false);
    expect(first.diagnostics.map((d: { text: string }) => d.text).join('\n')).toContain("Type 'string' is not assignable to type 'number'");

    project.write('src/wave.gpu.ts', project.read('src/wave.gpu.ts').replace('= 1;', "= 1; // fixed"));
    const brokenMeanwhile = createBuilder(config, { afterSnapshot: () => project.write('src/wave.gpu.ts', broken) });
    expect((await brokenMeanwhile.run({})).ok).toBe(true);
  });
});

describe('what the output depends on is part of the cache key', () => {
  it('a change of the tsconfig is not "fresh" (declarations follow it)', async () => {
    await buildShaders({ root: project.root });
    expect(checkShaders({ root: project.root }).ok).toBe(true);
    const tsconfig = JSON.parse(project.read('tsconfig.app.json'));
    tsconfig.compilerOptions.removeComments = true;
    project.write('tsconfig.app.json', JSON.stringify(tsconfig));
    expect(checkShaders({ root: project.root }).problems.map((p: { code: string }) => p.code)).toContain('stale');
  });
});

describe('modules outside the source folder', () => {
  it('a shader that imports a module outside src fails with a message and writes nothing outside the output folder', async () => {
    project.write('shared/helpers.ts', 'export const helper = 1;\n');
    project.write('shared/helpers.d.ts', '// hand written declarations\nexport declare const helper: number;\n');
    project.write('src/wave.gpu.ts', `import { helper } from '../shared/helpers';\n${project.read('src/wave.gpu.ts')}\nexport const h = helper;\n`);
    const result = await buildShaders({ root: project.root });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostics)).toContain('outside the source folder');
    expect(project.read('shared/helpers.d.ts')).toContain('hand written');
    expect(project.exists('shared/helpers.d.ts.map')).toBe(false);
  });
});

describe('two watch sessions on one output folder: the one that ends does not delete the stub the other shows', () => {
  it('closing one watcher leaves the stub; closing the last one removes it', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    const first = watchShaders({ root: project.root }, {});
    const second = watchShaders({ root: project.root }, {});
    try {
      await Promise.all([first.ready, second.ready]);
      expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error');
      first.close();
      expect(project.read('shaders-dist/wave.gpu.js')).toContain('typegpu-shaders-error'); // the second session's page still needs it
    } finally {
      second.close();
      await Promise.all([first.settled(), second.settled()]);
    }
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
  });

  it('a session record of a process that is gone does not keep a stub alive', async () => {
    project.write('src/wave.gpu.ts', BAD_SHADER);
    mkdirSync(project.path('shaders-dist/.tmp/sessions'), { recursive: true });
    writeFileSync(project.path('shaders-dist/.tmp/sessions/2147483646'), ''); // no such process
    const watcher = watchShaders({ root: project.root }, {});
    await watcher.ready;
    watcher.close();
    await watcher.settled();
    expect(project.exists('shaders-dist/wave.gpu.js')).toBe(false);
  });
});

describe('leftovers and case-insensitive file systems', () => {
  it('temporary files a killed process left are cleaned up by the next build; fresh ones are not touched', async () => {
    await buildShaders({ root: project.root });
    const old = project.path('shaders-dist/.tmp/999999-1');
    const fresh = project.path('shaders-dist/.tmp/999999-2');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(old, past, past);
    project.write('src/wave.gpu.ts', `${project.read('src/wave.gpu.ts')}\n// edit\n`);
    await buildShaders({ root: project.root });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  const caseInsensitive = (() => {
    const probe = createProject();
    try {
      return existsSync(join(probe.root, 'PACKAGE.JSON'));
    } finally {
      probe.dispose();
    }
  })();
  it.skipIf(!caseInsensitive)('a rename that only changes the case of a shader file keeps its output (it is one file for the file system)', async () => {
    project.write('src/gen/big.gpu.ts', project.read('src/wave.gpu.ts').replace('wave', 'big').replace("'./model'", "'../model'"));
    expect((await ensureShaders({ root: project.root })).ok).toBe(true);
    project.remove('src/gen/big.gpu.ts');
    project.write('src/gen/Big.gpu.ts', project.read('src/wave.gpu.ts').replace('wave', 'big').replace("'./model'", "'../model'"));
    project.write('src/app/main.ts', `import { wave } from '@shaders/wave.gpu';\nimport { big } from '@shaders/gen/Big.gpu';\nexport const used = [wave, big];\n`);
    const result = await ensureShaders({ root: project.root });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(existsSync(project.path('shaders-dist/gen/Big.gpu.js'))).toBe(true); // resolves under the new name too
  });
});

describe('builds that run at the same time on one output folder', () => {
  it('a build that started with an older closure does not delete the output of a module another build added meanwhile', async () => {
    const config = resolveConfig({ root: project.root });
    await buildShaders({ root: project.root }); // the folder is in use
    const older = createBuilder(config, {
      afterSnapshot: async () => {
        // while the older build is between reading its sources and pruning, a new shader appears and another build (a dev server) builds it
        project.write('src/extra.gpu.ts', project.read('src/wave.gpu.ts').replace('wave', 'extra'));
        if (!project.exists('shaders-dist/extra.gpu.js')) expect((await buildShaders({ root: project.root })).ok).toBe(true);
      },
    });
    project.write('src/wave.gpu.ts', `${project.read('src/wave.gpu.ts')}\n// edit\n`); // so that the older build has something to do
    expect((await older.run({})).ok).toBe(true);
    expect(project.exists('shaders-dist/extra.gpu.js')).toBe(true); // not pruned by the build that did not know it
    expect((await ensureShaders({ root: project.root })).ok).toBe(true); // and the folder converges
    expect(checkShaders({ root: project.root }).ok).toBe(true);
  });

  it('several builds that all prune the same leftovers never fail on a file another one removed', async () => {
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 12; i++) project.write(`src/orphan${i}.gpu.ts`, project.read('src/wave.gpu.ts').replace('wave', `orphan${i}`));
      expect((await buildShaders({ root: project.root })).ok).toBe(true);
      for (let i = 0; i < 12; i++) project.remove(`src/orphan${i}.gpu.ts`); // twelve generated modules become leftovers
      const results = await Promise.all([1, 2, 3].map(() => buildShaders({ root: project.root }).then((r: { ok: boolean }) => r.ok, (e: Error) => e.message)));
      expect(results).toEqual([true, true, true]);
    }
  }, 120_000);
});

