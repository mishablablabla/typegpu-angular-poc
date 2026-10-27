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

  it('refuses names whose selector would be broken (NG8001), with a message that says what is allowed', async () => {
    for (const name of ['foo.bar', 'foo@bar', 'foo$', 'my canvas!', 'a/foo.bar', '-x', 'foo:bar']) {
      const tree = await configured();
      await expect(generate(tree, { name }), name).rejects.toThrow(/cannot be used as a component name.*letters, digits and dashes/s);
      expect(tree.files.some((f) => f.startsWith('/src/app/foo') || f.includes('foo.bar')), name).toBe(false);
    }
  });

  it('keeps accepting the usual naming styles', async () => {
    for (const [name, folder, cls] of [
      ['my-fancy-canvas', 'my-fancy-canvas', 'MyFancyCanvas'],
      ['MyCanvas', 'my-canvas', 'MyCanvas'],
      ['myCanvas', 'my-canvas', 'MyCanvas'],
      ['my_canvas', 'my-canvas', 'MyCanvas'],
      ['canvas2d', 'canvas2d', 'Canvas2d'],
      ['a/b/foo-bar', 'a/b/foo-bar', 'FooBar'],
    ] as const) {
      const tree = await generate(await configured(), { name });
      const file = `/src/app/${folder}/${folder.split('/').pop()}.ts`;
      expect(tree.readText(file), name).toContain(`export class ${cls} {`);
    }
  });

  it('refuses foo when foo-scene exists, and foo-scene when foo exists: both would declare FooScene / app-foo-scene', async () => {
    const withScene = await generate(await configured(), { name: 'foo-scene' });
    await expect(generate(withScene, { name: 'foo' })).rejects.toThrow(/"foo" would clash with the existing component folder "foo-scene".*FooScene.*foo-scene/s);
    const withFoo = await generate(await configured(), { name: 'foo' });
    await expect(generate(withFoo, { name: 'foo-scene' })).rejects.toThrow(/"foo-scene" would clash with the existing component "foo"/);
    // unrelated names are fine
    const both = await generate(withFoo, { name: 'bar' });
    expect(both.exists('/src/app/bar/bar.ts')).toBe(true);
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

describe('component: what it tells you after the files', () => {
  const run = async (tree: Awaited<ReturnType<typeof workspaceWith>>, options: Record<string, unknown>) => {
    const runner = ours();
    const info: string[] = [];
    runner.logger.subscribe((entry) => info.push(entry.message));
    await runner.runSchematic('component', options, tree);
    return info.join('\n');
  };

  it('says to import the component and use its selector in a template', async () => {
    expect(await run(await configured(), { name: 'my-canvas' })).toMatch(
      /Next: add MyCanvas to the "imports" of the component \(or route\) that should show it, and use <app-my-canvas><\/app-my-canvas> in that template\./,
    );
  });

  it('uses the project prefix in the selector, in both modes', async () => {
    const tree = await workspaceWith(['shop'], '22.0.0', false);
    editJson(tree, 'angular.json', (json) => (json.projects.shop.prefix = 'sh'));
    const prebuilt = await ours().runSchematic('ng-add', { shaders: 'prebuild', project: 'shop' }, tree);
    expect(await run(prebuilt, { name: 'orb', project: 'shop' })).toContain('<sh-orb></sh-orb>');
  });

  it('names no hint when the schematic fails', async () => {
    await expect(run(await workspaceWith(), { name: 'my-canvas' })).rejects.toThrow(/not set up for TypeGPU shaders/);
  });

  it('refuses a library project, and a workspace that has only libraries', async () => {
    const tree = await workspaceWith(['shop', 'kit']);
    editJson(tree, 'angular.json', (json) => (json.projects.kit.projectType = 'library'));
    await expect(generate(tree, { name: 'orb', project: 'kit' })).rejects.toThrow(/Project "kit" is not an application/);
    const libraries = await workspaceWith(['kit']);
    editJson(libraries, 'angular.json', (json) => (json.projects.kit.projectType = 'library'));
    await expect(generate(libraries, { name: 'orb' })).rejects.toThrow(/no application project.*not applications: kit/s);
  });
});

describe('component: any path that points at the plugin counts as configured', () => {
  const PLUGIN = 'node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs';

  it('accepts the conventional path in string and object form, with or without ./', async () => {
    for (const entry of [PLUGIN, `./${PLUGIN}`, { path: PLUGIN }, { path: `./${PLUGIN}`, options: {} }]) {
      const tree = await configured();
      editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = [entry]));
      expect((await generate(tree, { name: 'my-canvas' })).exists('/src/app/my-canvas/my-canvas.ts')).toBe(true);
    }
  });

  it('refuses a project whose plugins list has no shader plugin', async () => {
    const tree = await configured();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = ['tools/other.mjs']));
    await expect(generate(tree, { name: 'my-canvas' })).rejects.toThrow(/not set up for TypeGPU shaders/);
  });
});

describe('component: in a project set up with `ng add --shaders prebuild`', () => {
  const prebuild = async (apps?: string[], firstAtRoot = true) =>
    ours().runSchematic('ng-add', { shaders: 'prebuild', project: apps?.[0] }, await workspaceWith(apps, '22.0.0', firstAtRoot));

  it('generates the component and its shader, importing the shader through @shaders/ (not by a relative path)', async () => {
    const tree = await generate(await prebuild(), { name: 'my-canvas' });
    expect(tree.files.filter((f) => f.includes('my-canvas')).sort()).toEqual([
      '/src/app/my-canvas/my-canvas.gpu.ts',
      '/src/app/my-canvas/my-canvas.spec.ts',
      '/src/app/my-canvas/my-canvas.ts',
    ]);
    const ts = tree.readText('/src/app/my-canvas/my-canvas.ts');
    expect(ts).toContain("import { sceneFragment } from '@shaders/app/my-canvas/my-canvas.gpu';");
    expect(ts).not.toContain("'./my-canvas.gpu'");
    expect(tree.readText('/src/app/my-canvas/my-canvas.gpu.ts')).toContain("'use gpu';");
  });

  it('the alias is the path under the source root, for --path and for an application in projects/<name>', async () => {
    const nested = await generate(await prebuild(), { name: 'orb', path: 'src/app/features' });
    expect(nested.readText('/src/app/features/orb/orb.ts')).toContain("from '@shaders/app/features/orb/orb.gpu'");
    const project = await generate(await prebuild(['shop'], false), { name: 'orb', project: 'shop' });
    expect(project.readText('/projects/shop/src/app/orb/orb.ts')).toContain("from '@shaders/app/orb/orb.gpu'");
  });

  it('refuses a path outside the source root: the shader would not be built', async () => {
    const tree = await prebuild();
    await expect(generate(tree, { name: 'orb', path: 'lib/elsewhere' })).rejects.toThrow(/outside the source root of "app" \(src\)/);
    expect(tree.exists('/lib/elsewhere/orb/orb.ts')).toBe(false);
  });

  it('still refuses overwriting files and clashing scene names, like the plugin mode', async () => {
    const once = await generate(await prebuild(), { name: 'my-canvas' });
    once.overwrite('/src/app/my-canvas/my-canvas.ts', '// edited by the user\n');
    await expect(generate(once, { name: 'my-canvas' })).rejects.toThrow(/merge conflicted on path/);
    await expect(generate(once, { name: 'my-canvas-scene' })).rejects.toThrow(/would clash with the existing component "my-canvas"/);
  });

  it('does not change angular.json, package.json or tsconfig files', async () => {
    const before = await prebuild();
    const files = ['/angular.json', '/package.json', '/tsconfig.json', '/tsconfig.app.json'].map((f) => [f, before.readText(f)] as const);
    const after = await generate(before, { name: 'my-canvas' });
    for (const [file, text] of files) expect(after.readText(file)).toBe(text);
  });

  it('the refusal in an unconfigured project names both ways to configure it', async () => {
    await expect(generate(await workspaceWith(), { name: 'my-canvas' })).rejects.toThrow(/--shaders prebuild/);
  });
});

describe('component: the generated spec in a project with and without zone.js (F-L7: NG0908 under Angular 20 --zoneless, 2 of 4 specs failed)', () => {
  const specOf = async (edit?: (json: Record<string, any>) => void, mode: 'plugin' | 'prebuild' = 'plugin') => {
    const tree = mode === 'plugin' ? await configured() : await ours().runSchematic('ng-add', { shaders: 'prebuild' }, await workspaceWith());
    if (edit) editJson(tree, 'angular.json', edit);
    return (await generate(tree, { name: 'my-canvas' })).readText('/src/app/my-canvas/my-canvas.spec.ts');
  };
  const PROVIDER = /provideZonelessChangeDetection\(\)/g;

  it('a project without zone.js provides zoneless change detection in both specs, and imports it', async () => {
    for (const mode of ['plugin', 'prebuild'] as const) {
      const spec = await specOf(undefined, mode);
      expect(spec, mode).toContain("import { ErrorHandler, provideZonelessChangeDetection } from '@angular/core';");
      expect(spec.match(PROVIDER), mode).toHaveLength(2); // one per spec; the import names it without the call
      expect(spec, mode).toContain('providers: [provideZonelessChangeDetection(), provideTypeGpu({ root: fake.root })]');
      expect(spec, mode).not.toContain('<%'); // every template tag was expanded
    }
  });

  it('a project that loads zone.js (build polyfills, a build configuration, or the test target) does not', async () => {
    const zoneJs: [string, (json: Record<string, any>) => void][] = [
      ['build options', (json) => (json.projects.app.architect.build.options.polyfills = ['zone.js'])],
      ['a build configuration', (json) => (json.projects.app.architect.build.configurations.development.polyfills = ['zone.js'])],
      ['the test target', (json) => (json.projects.app.architect.test.options = { ...json.projects.app.architect.test.options, polyfills: ['zone.js', 'zone.js/testing'] })],
    ];
    for (const [where, edit] of zoneJs) {
      const spec = await specOf(edit);
      expect(spec, where).not.toContain('provideZonelessChangeDetection');
      expect(spec, where).toContain("import { ErrorHandler } from '@angular/core';");
      expect(spec, where).toContain('providers: [provideTypeGpu({ root: fake.root })]');
    }
  });

  it('other polyfills do not count as zone.js, and a polyfills option given as a string is read too', async () => {
    expect(await specOf((json) => (json.projects.app.architect.build.options.polyfills = ['./src/polyfills.ts', 'zone.js-fake']))).toContain('provideZonelessChangeDetection()');
    expect(await specOf((json) => (json.projects.app.architect.build.options.polyfills = 'zone.js'))).not.toContain('provideZonelessChangeDetection');
  });

  it('the spec of the failing GPU factory waits for what it asserts, not for whenStable() (zone.js returns from it too early: F-L3)', async () => {
    for (const edit of [undefined, (json: Record<string, any>) => (json.projects.app.architect.build.options.polyfills = ['zone.js'])]) {
      const spec = await specOf(edit);
      const failing = spec.slice(spec.indexOf("it('offers a retry"));
      expect(failing).toContain("for (let attempt = 0; attempt < 50 && !fixture.nativeElement.textContent.includes('GPU initialisation failed'); attempt++) {");
      expect(failing).toContain('await new Promise((resolve) => setTimeout(resolve));');
      expect(failing).not.toMatch(/await [\w.]*whenStable/); // the comment explaining why may name it
    }
  });
});
