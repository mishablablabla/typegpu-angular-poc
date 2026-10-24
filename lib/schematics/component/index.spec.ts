import { describe, expect, it } from 'vitest';
import { editJson, ngAdd, ours, readJson, workspaceWith } from '../testing/workspace';

const generate = (tree: Awaited<ReturnType<typeof workspaceWith>>, options: Record<string, unknown>) =>
  ours().runSchematic('component', options, tree);

const configured = async (apps?: string[]) => ngAdd(await workspaceWith(apps), { project: apps?.[0] });

describe('component: a basic name', () => {
  it('creates the component, its shader and a spec in src/app/<name>/', async () => {
    const tree = await generate(await configured(), { name: 'my-canvas' });
    const files = tree.files.filter((f) => f.includes('my-canvas'));
    expect(files.sort()).toEqual([
      '/src/app/my-canvas/my-canvas.gpu.ts',
      '/src/app/my-canvas/my-canvas.spec.ts',
      '/src/app/my-canvas/my-canvas.ts',
    ]);
  });

  it('uses the conventional class, selector and the public package API only', async () => {
    const tree = await generate(await configured(), { name: 'my-canvas' });
    const ts = tree.readText('/src/app/my-canvas/my-canvas.ts');

    expect(ts).toContain("selector: 'app-my-canvas',");
    expect(ts).toContain("selector: 'app-my-canvas-scene',");
    expect(ts).toContain('export class MyCanvas {');
    // exported: Angular 21's compiler rejects an unexported component that another component imports (NG3004)
    expect(ts).toContain('export class MyCanvasScene {');
    expect(ts).toContain("import { sceneFragment } from './my-canvas.gpu';");
    // every import comes from Angular, typegpu, the package's public entry point or the sibling shader
    const specifiers = [...ts.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['@angular/core', 'typegpu', '@typegpu-poc/angular', './my-canvas.gpu']);
    expect(ts).toContain('*tgpuReady="let root; else fallback"');
    expect(ts).toMatch(/injectUniform\(d\.vec3f, \{ from: computed/);
    expect(ts).not.toMatch(/\bany\b|NgModule|@typegpu-poc\/angular\/(src|lib|tools)/);
  });

  it('writes a shader module in the form the plugin transforms', async () => {
    const tree = await generate(await configured(), { name: 'my-canvas' });
    const gpu = tree.readText('/src/app/my-canvas/my-canvas.gpu.ts');
    expect(gpu).toContain("import tgpu, { d, std } from 'typegpu';");
    expect(gpu).toContain('export function sceneFragment(');
    expect(gpu).toContain("'use gpu';");
    expect(gpu).toContain('std.mul(base, tint.$)'); // no vector operators
    expect(gpu).not.toContain('@angular/'); // no Angular in shader modules
    expect(gpu).not.toMatch(/^\s*@\w+\(/m); // no decorators
    expect(gpu).not.toContain('<%'); // all template tags were expanded
  });

  it('generates a spec that uses the testing entry point', async () => {
    const tree = await generate(await configured(), { name: 'my-canvas' });
    const spec = tree.readText('/src/app/my-canvas/my-canvas.spec.ts');
    expect(spec).toContain("from '@typegpu-poc/angular/testing'");
    expect(spec).toContain("import { MyCanvas } from './my-canvas';");
    expect(spec).not.toContain('vitest'); // globals, so it runs under any runner the app uses
    expect(spec).toContain('GPU initialisation failed');
    expect(spec).toContain('fixture.detectChanges()'); // zone-based test beds (Angular 20) need it
  });

  it('skips the spec with skipTests', async () => {
    const tree = await generate(await configured(), { name: 'my-canvas', skipTests: true });
    expect(tree.exists('/src/app/my-canvas/my-canvas.spec.ts')).toBe(false);
    expect(tree.exists('/src/app/my-canvas/my-canvas.ts')).toBe(true);
  });

  it('converts any naming style to the same names', async () => {
    const tree = await generate(await configured(), { name: 'MyOtherCanvas' });
    expect(tree.exists('/src/app/my-other-canvas/my-other-canvas.gpu.ts')).toBe(true);
    expect(tree.readText('/src/app/my-other-canvas/my-other-canvas.ts')).toContain('export class MyOtherCanvas {');
  });
});

describe('component: project and path handling', () => {
  it('honours --path and a name with directories', async () => {
    const withPath = await generate(await configured(), { name: 'my-canvas', path: 'src/app/widgets' });
    expect(withPath.exists('/src/app/widgets/my-canvas/my-canvas.gpu.ts')).toBe(true);
    const inName = await generate(await configured(), { name: 'gfx/sky' });
    expect(inName.exists('/src/app/gfx/sky/sky.gpu.ts')).toBe(true);
    expect(inName.readText('/src/app/gfx/sky/sky.ts')).toContain('export class Sky {');
  });

  it('puts the component in the selected application and uses its prefix', async () => {
    const base = await workspaceWith(['shop', 'admin']);
    editJson(base, 'angular.json', (json) => (json.projects.admin.prefix = 'adm'));
    const tree = await generate(await ngAdd(base, { project: 'admin' }), { name: 'my-canvas', project: 'admin' });
    expect(tree.exists('/projects/admin/src/app/my-canvas/my-canvas.gpu.ts')).toBe(true);
    expect(tree.readText('/projects/admin/src/app/my-canvas/my-canvas.ts')).toContain("selector: 'adm-my-canvas',");
    expect(tree.files.some((f) => f.startsWith('/projects/shop/') && f.includes('my-canvas'))).toBe(false);
  });

  it('asks for --project when there are several applications', async () => {
    const base = await ngAdd(await workspaceWith(['shop', 'admin']), { project: 'shop' });
    await expect(generate(base, { name: 'my-canvas' })).rejects.toThrow(/several applications.*--project <name>/s);
  });
});

describe('component: safety', () => {
  it('refuses to overwrite existing files', async () => {
    const once = await generate(await configured(), { name: 'my-canvas' });
    const before = once.readText('/src/app/my-canvas/my-canvas.ts');
    once.overwrite('/src/app/my-canvas/my-canvas.ts', '// edited by the user\n');
    await expect(generate(once, { name: 'my-canvas' })).rejects.toThrow(/merge conflicted on path "\/src\/app\/my-canvas\/my-canvas.ts"/);
    expect(once.readText('/src/app/my-canvas/my-canvas.ts')).toBe('// edited by the user\n');
    expect(before).not.toBe('// edited by the user\n');
  });

  it('refuses, with the command to run, when ng add has not configured the project', async () => {
    const tree = await workspaceWith();
    await expect(generate(tree, { name: 'my-canvas' })).rejects.toThrow(/not set up for TypeGPU shaders.*ng add @typegpu-poc\/angular --project app/s);
    expect(tree.exists('/src/app/my-canvas/my-canvas.ts')).toBe(false);
  });

  it('refuses names that cannot be a selector or class', async () => {
    await expect(generate(await configured(), { name: '1-bad' })).rejects.toThrow();
  });

  it('does not change angular.json or package.json', async () => {
    const base = await configured();
    const before = { w: base.readText('angular.json'), p: base.readText('package.json') };
    const tree = await generate(base, { name: 'my-canvas' });
    expect(tree.readText('angular.json')).toBe(before.w);
    expect(tree.readText('package.json')).toBe(before.p);
    expect(readJson(tree, 'package.json').scripts['check:shaders']).toBeDefined();
  });
});
