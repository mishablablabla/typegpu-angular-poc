// Security review regressions: the output folder is not trusted (a cache, a shared checkout), so nothing the tool deletes or writes may land
// outside it, whatever the manifest lists and wherever a link in it points. "Victims" live in the test project, outside `shaders-dist`.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { insideOut } from '../../../../tools/typegpu-shaders/atomic.mjs';
// @ts-expect-error plain ES module without types
import { buildShaders, resolveConfig } from '../../../../tools/typegpu-shaders/index.mjs';
// @ts-expect-error plain ES module without types
import { generatedOf } from '../../../../tools/typegpu-shaders/manifest.mjs';
// @ts-expect-error plain ES module without types
import { listTs } from '../../../../tools/typegpu-shaders/graph.mjs';
import { createProject, type Project } from './project';

let project: Project;
let victims: string;
beforeEach(() => {
  project = createProject();
  victims = join(project.root, 'victims');
  mkdirSync(victims);
  for (const name of ['a.js', 'b.js', 'keep.txt']) writeFileSync(join(victims, name), `victim ${name}`);
});
afterEach(() => project.dispose());

// A directory link on every platform (a junction needs no privilege on Windows; the type is ignored elsewhere).
const link = (target: string, path: string) => symlinkSync(target, path, 'junction');
const victimsIntact = () => ['a.js', 'b.js', 'keep.txt'].every((name) => readFileSync(join(victims, name), 'utf8') === `victim ${name}`);

const manifestWith = (generated: unknown[]) => {
  const manifest = JSON.parse(project.read('shaders-dist/.manifest.json'));
  project.write('shaders-dist/.manifest.json', JSON.stringify({ ...manifest, generated: [...manifest.generated, ...generated] }));
};

describe('a manifest in the output folder is not trusted', () => {
  it.each([['../victims/a.js'], ['sub/../../victims/a.js'], ['..\\victims\\a.js']])('an entry that leaves the output folder (%s) is never removed', async (entry) => {
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    manifestWith([entry]);
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(victimsIntact()).toBe(true);
  });

  it('an absolute entry and entries that are not names of generated files are ignored', async () => {
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    manifestWith([join(victims, 'a.js'), 'notes.txt', null, 42, { a: 1 }, '']);
    const result = await buildShaders({ root: project.root });
    expect(result.ok).toBe(true); // before: `generated: [null]` made every build crash, until shaders-dist was deleted
    expect(victimsIntact()).toBe(true);
    expect(JSON.parse(project.read('shaders-dist/.manifest.json')).generated.every((name: unknown) => typeof name === 'string' && /\.(js|js\.map|d\.ts|d\.ts\.map)$/.test(name))).toBe(true);
  });
});

describe('a link inside the output folder is never followed', () => {
  it('a directory link that the manifest lists a file through: the file behind it is not removed, and nothing is written behind it', async () => {
    project.write('src/sub/b.gpu.ts', 'export const b = 1;\n');
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    project.remove('shaders-dist/sub'); // from now on `sub` is a link to the victims
    link(victims, join(project.root, 'shaders-dist', 'sub'));
    manifestWith(['sub/a.js']);
    project.remove('src/sub/b.gpu.ts'); // pruning reaches sub/a.js
    await buildShaders({ root: project.root });
    expect(victimsIntact()).toBe(true);
    project.write('src/sub/b.gpu.ts', 'export const b = 1;\n');
    const result = await buildShaders({ root: project.root }); // writing sub/b.gpu.js would land in the victims folder
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostics)).toContain('Refusing to write');
    expect(readdirSync(victims).sort()).toEqual(['a.js', 'b.js', 'keep.txt']);
    expect(victimsIntact()).toBe(true);
  });

  it('`.tmp` as a link: an old file behind it is not cleaned, and nothing is written there', async () => {
    mkdirSync(join(project.root, 'shaders-dist'));
    link(victims, join(project.root, 'shaders-dist', '.tmp'));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(victims, 'keep.txt'), old, old);
    const result = await buildShaders({ root: project.root }).catch((error: Error) => ({ ok: false, error }));
    expect(result.ok).toBe(false);
    expect(readdirSync(victims).sort()).toEqual(['a.js', 'b.js', 'keep.txt']);
    expect(victimsIntact()).toBe(true);
  });

  it('insideOut: `..`, a link in the way, and a sibling folder with the same prefix are outside; a new file in a new folder is inside', () => {
    const out = join(project.root, 'shaders-dist');
    mkdirSync(out);
    mkdirSync(join(project.root, 'shaders-dist-2'));
    link(victims, join(out, 'sub'));
    expect(insideOut(out, join(out, 'a.js'))).toBe(true);
    expect(insideOut(out, join(out, 'new', 'deeper', 'a.js'))).toBe(true);
    expect(insideOut(out, join(out, '..', 'victims', 'a.js'))).toBe(false);
    expect(insideOut(out, join(project.root, 'shaders-dist-2', 'a.js'))).toBe(false);
    expect(insideOut(out, join(out, 'sub', 'a.js'))).toBe(false);
    expect(insideOut(out, join(out, 'sub', 'deeper', 'a.js'))).toBe(false);
  });
});

describe('the output folder itself', () => {
  it('a folder that leads out of the project through a link is refused', () => {
    const outside = join(project.root, 'victims');
    link(outside, join(project.root, 'dist-link'));
    // victims is inside the project here; point a link at the PARENT of the project instead
    const parent = join(project.root, '..');
    link(parent, join(project.root, 'up'));
    expect(() => resolveConfig({ root: project.root, out: 'up/anything' })).toThrow(/inside the project/);
    expect(() => resolveConfig({ root: project.root, out: '../elsewhere' })).toThrow(/inside the project|must not/);
    expect(() => resolveConfig({ root: project.root, out: 'dist-link' })).not.toThrow(); // still inside the project
  });

  it('a link to the project folder is refused like the folder itself', () => {
    link(project.root, join(project.root, 'self'));
    expect(() => resolveConfig({ root: project.root, out: 'self' })).toThrow(/out/);
    expect(existsSync(join(project.root, 'src'))).toBe(true);
  });
});

describe('review findings (round 2)', () => {
  it('a refusal for a module outside src does not forget what an earlier build listed: a deleted shader is still pruned afterwards', async () => {
    project.write('src/b.gpu.ts', 'export const b = 1;\n');
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(project.exists('shaders-dist/b.gpu.js')).toBe(true);
    project.remove('src/b.gpu.ts');
    project.write('outside.ts', 'export const OUT = 1;\n');
    const original = project.read('src/wave.gpu.ts');
    project.write('src/wave.gpu.ts', `import { OUT } from '../outside';\n${original}\nexport const o = OUT;\n`);
    expect((await buildShaders({ root: project.root })).ok).toBe(false); // refused: a module outside the source folder
    project.write('src/wave.gpu.ts', original);
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(project.exists('shaders-dist/b.gpu.js')).toBe(false); // before the fix: left behind, importable and bundled stale
  });

  it('a dangling link and a link back to a parent folder under src do not stop a build', async () => {
    mkdirSync(join(project.root, 'src', 'app'), { recursive: true });
    link(join(project.root, 'src'), join(project.root, 'src', 'app', 'loop')); // a loop
    try {
      symlinkSync('nowhere.ts', join(project.root, 'src', 'app', '.#x.ts')); // an editor's lock file
    } catch {
      /* creating a file link needs a privilege on Windows: the loop alone is then what is tested */
    }
    const found = listTs(join(project.root, 'src'));
    expect(found.length).toBeGreaterThan(0); // before: ENOENT or ELOOP
    expect(found.filter((file: string) => file.includes('loop'))).toEqual([]); // nothing is listed again through the loop
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
  });

  it('a link in the way gets no folder created behind it', async () => {
    project.write('src/sub/deeper/x.gpu.ts', 'export const x = 1;\n');
    mkdirSync(join(project.root, 'shaders-dist'));
    link(victims, join(project.root, 'shaders-dist', 'sub'));
    const result = await buildShaders({ root: project.root });
    expect(result.ok).toBe(false);
    expect(readdirSync(victims).sort()).toEqual(['a.js', 'b.js', 'keep.txt']); // before: an empty `deeper` was created in the victims folder
  });

  it('manifest names with a colon (a drive, an NTFS stream) are not names of generated files', () => {
    expect(generatedOf({ generated: ['a:b.js', 'C:x.js', 'ok.js', 'sub/ok.d.ts'] })).toEqual(['ok.js', 'sub/ok.d.ts']);
  });
});
