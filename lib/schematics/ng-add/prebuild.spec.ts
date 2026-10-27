// ng add --shaders prebuild, on virtual workspaces created by Angular's own schematics (the same helper as index.spec.ts).
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { editJson, ours, readJson, workspaceWith } from '../testing/workspace';

type Tree = Awaited<ReturnType<typeof workspaceWith>>;

const PKG = '@typegpu-poc/angular';
const snapshot = (tree: Tree) => Object.fromEntries(tree.files.map((file) => [file, tree.read(file)!.toString('base64')]));
/** JSON with comments (tsconfig files). */
const readJsonc = (tree: Tree, path: string) => parse(tree.readText(path)) as Record<string, any>;
const target = (tree: Tree, project: string, name: string) => readJson(tree, 'angular.json')['projects'][project]['architect'][name];

/** Runs the schematic in prebuild mode; collects what it logged. */
async function add(tree: Tree, options: Record<string, unknown> = {}) {
  const runner = ours();
  const info: string[] = [];
  const warnings: string[] = [];
  runner.logger.subscribe((entry) => (entry.level === 'warn' ? warnings : info).push(entry.message));
  const after = await runner.runSchematic('ng-add', { shaders: 'prebuild', ...options }, tree);
  return { tree: after, info, warnings, tasks: runner.tasks.map((task) => task.name) };
}

/** The schematic must fail with `message` and leave every file as it was. */
async function refused(tree: Tree, message: RegExp, options: Record<string, unknown> = {}) {
  const before = snapshot(tree);
  await expect(ours().runSchematic('ng-add', { shaders: 'prebuild', ...options }, tree)).rejects.toThrow(message);
  expect(snapshot(tree)).toEqual(before);
}

describe('ng add --shaders prebuild: a fresh application', () => {
  it('moves build, serve and test to the wrapper builders, adds the dependencies, maps @shaders/*, ignores the output', async () => {
    const before = await workspaceWith();
    const scripts = readJson(before, 'package.json').scripts;
    const { tree, tasks } = await add(before);

    expect(target(tree, 'app', 'build').builder).toBe(`${PKG}:application`);
    expect(target(tree, 'app', 'serve').builder).toBe(`${PKG}:dev-server`);
    expect(target(tree, 'app', 'test').builder).toBe(`${PKG}:unit-test`);

    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies.typegpu).toBe('^0.12.8');
    expect(pkg.devDependencies['@babel/core']).toBe('^7.28.0');
    expect(pkg.devDependencies['unplugin-typegpu']).toBe('0.12.6');
    expect(pkg.devDependencies['esbuild']).toBe('^0.28.2');
    expect(pkg.devDependencies['@angular-builders/custom-esbuild']).toBeUndefined();
    expect(pkg.scripts).toEqual(scripts); // no npm script is touched: the builders do the work

    expect(readJsonc(tree, 'tsconfig.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
    expect(tree.readText('.gitignore')).toMatch(/^shaders-dist\/$/m);
    expect(tasks.filter((name) => name === 'node-package')).toHaveLength(1);
  });

  it('keeps every option and configuration of the targets, and all of angular.json outside the three builder names', async () => {
    const before = await workspaceWith();
    const original = readJson(before, 'angular.json');
    const { tree } = await add(before);
    const changed = structuredClone(readJson(tree, 'angular.json'));
    for (const name of ['build', 'serve', 'test']) {
      const t = changed.projects.app.architect[name];
      expect(t.builder).toContain(PKG);
      t.builder = original.projects.app.architect[name].builder;
    }
    expect(changed).toEqual(original);
  });

  it('keeps the comments of tsconfig.json and every source file', async () => {
    const before = await workspaceWith();
    const sources = Object.fromEntries(before.files.filter((f) => f.startsWith('/src/')).map((f) => [f, before.readText(f)]));
    expect(before.readText('tsconfig.json')).toContain('/*');
    const { tree } = await add(before);
    expect(tree.readText('tsconfig.json')).toContain('/* To learn more about Typescript configuration file');
    for (const [path, content] of Object.entries(sources)) expect(tree.readText(path)).toBe(content);
  });

  it('keeps the final newline (or its absence) of package.json, also when dependencies are added', async () => {
    const withNewline = await workspaceWith();
    withNewline.overwrite('package.json', `${withNewline.readText('package.json').trimEnd()}\n`);
    expect((await add(withNewline)).tree.readText('package.json').endsWith('\n')).toBe(true);
    const without = await workspaceWith();
    without.overwrite('package.json', without.readText('package.json').trimEnd());
    expect((await add(without)).tree.readText('package.json').endsWith('\n')).toBe(false);
  });

  it('says what it did', async () => {
    const { info } = await add(await workspaceWith());
    expect(info.join('\n')).toContain('ng build, ng serve and ng test now build the shaders first');
    expect(info.join('\n')).toContain('"@shaders/<path under the source root>"');
  });
});

describe('ng add --shaders prebuild: test targets', () => {
  it('a Karma target (@angular/build:karma) gets the Karma wrapper', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test = { builder: '@angular/build:karma', options: { tsConfig: 'tsconfig.spec.json' } }));
    expect(target((await add(tree)).tree, 'app', 'test')).toEqual({ builder: `${PKG}:karma`, options: { tsConfig: 'tsconfig.spec.json' } });
  });

  it('a unit-test target with the Karma runner keeps its options and gets the unit-test wrapper', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test = { builder: '@angular/build:unit-test', options: { runner: 'karma', include: ['**/*.spec.ts'] } }));
    expect(target((await add(tree)).tree, 'app', 'test')).toEqual({ builder: `${PKG}:unit-test`, options: { runner: 'karma', include: ['**/*.spec.ts'] } });
  });

  it('another test builder is left alone, with a warning that says why', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test = { builder: '@angular-devkit/build-angular:karma', options: {} }));
    const { tree: after, warnings } = await add(tree);
    expect(target(after, 'app', 'test').builder).toBe('@angular-devkit/build-angular:karma');
    expect(warnings.join('\n')).toContain('does not build the shaders first');
  });

  it('a project without a test or serve target gets only what it has', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      delete json.projects.app.architect.test;
      delete json.projects.app.architect.serve;
    });
    const { tree: after } = await add(tree);
    expect(Object.keys(readJson(after, 'angular.json').projects.app.architect).sort()).toEqual(['build', 'extract-i18n'].filter((k) => k in readJson(after, 'angular.json').projects.app.architect));
    expect(target(after, 'app', 'build').builder).toBe(`${PKG}:application`);
  });

  it('the legacy devkit names of build and serve are accepted', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.build.builder = '@angular-devkit/build-angular:application';
      json.projects.app.architect.serve.builder = '@angular-devkit/build-angular:dev-server';
    });
    const { tree: after } = await add(tree);
    expect(target(after, 'app', 'build').builder).toBe(`${PKG}:application`);
    expect(target(after, 'app', 'serve').builder).toBe(`${PKG}:dev-server`);
  });
});

describe('ng add --shaders prebuild: an existing project', () => {
  it('keeps unrelated scripts and dependencies; an existing dependency is never changed', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', (json) => {
      json.scripts = { ...json.scripts, lint: 'ng lint', chained: 'ng build && node scripts/after.mjs' };
      json.devDependencies.esbuild = '0.25.1';
    });
    const { tree: after } = await add(tree);
    const pkg = readJson(after, 'package.json');
    expect(pkg.scripts.lint).toBe('ng lint');
    expect(pkg.scripts.chained).toBe('ng build && node scripts/after.mjs');
    expect(pkg.devDependencies.esbuild).toBe('0.25.1');
  });

  it('adds the mapping next to the existing paths and keeps them', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.json', `{\n  // my config\n  "compilerOptions": {\n    "strict": true,\n    "paths": { "@app/*": ["./src/app/*"] }\n  }\n}\n`);
    const { tree: after } = await add(tree);
    expect(after.readText('tsconfig.json')).toContain('// my config');
    expect(readJsonc(after, 'tsconfig.json').compilerOptions.paths).toEqual({ '@app/*': ['./src/app/*'], '@shaders/*': ['./shaders-dist/*'] });
  });

  it('puts the mapping in the base config the app, test and worker configs extend', async () => {
    const tree = await workspaceWith();
    tree.create('tsconfig.worker.json', JSON.stringify({ extends: './tsconfig.json', compilerOptions: { types: [] } }));
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.webWorkerTsConfig = 'tsconfig.worker.json'));
    const { tree: after } = await add(tree);
    expect(readJsonc(after, 'tsconfig.json').compilerOptions.paths['@shaders/*']).toBeDefined();
    expect(after.readText('tsconfig.app.json')).not.toContain('paths');
  });

  it('does not add a .gitignore line that is there, and notes a missing .gitignore', async () => {
    const tree = await workspaceWith();
    tree.overwrite('.gitignore', `node_modules\n/shaders-dist\n`);
    expect((await add(tree)).tree.readText('.gitignore')).toBe(`node_modules\n/shaders-dist\n`);
    const bare = await workspaceWith();
    bare.delete('.gitignore');
    const { tree: after, warnings } = await add(bare);
    expect(after.exists('.gitignore')).toBe(false);
    expect(warnings.join('\n')).toContain('There is no .gitignore');
  });

  it('does not warn on Angular 20 and 21: the prebuild was verified there (build, serve, test, SSR, Karma) with the packed package', async () => {
    const tree = await workspaceWith(['app'], '21.0.0');
    editJson(tree, 'package.json', (json) => (json.dependencies['@angular/core'] = '^21.2.0'));
    expect((await add(tree)).warnings.join('\n')).not.toContain('only verified');
  });

  it('the plugin mode on a project that is set up for the prebuild says so (it used to say the wrapper is not the esbuild builder), and changes nothing', async () => {
    const { tree } = await add(await workspaceWith());
    const before = snapshot(tree);
    await expect(ours().runSchematic('ng-add', {}, tree)).rejects.toThrow(/already set up for the shader prebuild/);
    expect(snapshot(tree)).toEqual(before);
  });

  it('plugin mode on Angular 20 with the `security` block of an `ng new --ssr` app removes its empty allowedHosts (custom-esbuild 20 rejects it) and says so', async () => {
    const tree = await workspaceWith(['app'], '20.3.0');
    editJson(tree, 'package.json', (json) => (json.dependencies['@angular/core'] = '^20.3.0'));
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.security = { allowedHosts: [] }));
    const runner = ours();
    const warnings: string[] = [];
    runner.logger.subscribe((entry) => entry.level === 'warn' && warnings.push(entry.message));
    const after = await runner.runSchematic('ng-add', {}, tree);
    expect(warnings.join('\n')).toContain('Removed security.allowedHosts');
    expect(target(after, 'app', 'build').options.security).toBeUndefined();
  });

  it('plugin mode on Angular 22 with a `security` block does not warn (custom-esbuild 22 knows it)', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.security = { allowedHosts: [] }));
    const runner = ours();
    const warnings: string[] = [];
    runner.logger.subscribe((entry) => entry.level === 'warn' && warnings.push(entry.message));
    await runner.runSchematic('ng-add', {}, tree);
    expect(warnings.join('\n')).not.toContain('Removed security.allowedHosts');
  });

  it('the plugin mode is still the default and still changes angular.json the old way', async () => {
    const after = await ours().runSchematic('ng-add', {}, await workspaceWith());
    expect(target(after, 'app', 'build').builder).toBe('@angular-builders/custom-esbuild:application');
  });
});

describe('ng add --shaders prebuild: running it again', () => {
  it('changes nothing the second and third time', async () => {
    const first = (await add(await workspaceWith())).tree;
    const snap = snapshot(first);
    const second = (await add(first)).tree;
    expect(snapshot(second)).toEqual(snap);
    const third = (await add(second)).tree;
    expect(snapshot(third)).toEqual(snap);
    expect(third.readText('.gitignore').match(/shaders-dist/g)).toHaveLength(1);
  });

  it('keeps what the user changed after the first run (options of the targets)', async () => {
    const first = (await add(await workspaceWith())).tree;
    editJson(first, 'angular.json', (json) => (json.projects.app.architect.build.options.baseHref = '/shop/'));
    const second = (await add(first)).tree;
    expect(target(second, 'app', 'build').options.baseHref).toBe('/shop/');
  });
});

describe('ng add --shaders prebuild: the extract-i18n target (it bundles the application itself, so it needs the shader step too)', () => {
  const withExtract = async (builder = '@angular/build:extract-i18n', options: Record<string, unknown> = { buildTarget: 'app:build', format: 'xlf2' }) => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect['extract-i18n'] = { builder, options }));
    return tree;
  };

  it('an existing stock extract-i18n target gets the wrapper and keeps its options', async () => {
    const { tree, info } = await add(await withExtract());
    expect(target(tree, 'app', 'extract-i18n')).toEqual({ builder: `${PKG}:extract-i18n`, options: { buildTarget: 'app:build', format: 'xlf2' } });
    expect(info.join('\n')).toContain(`ng extract-i18n does too (builder ${PKG}:extract-i18n)`);
  });

  it('the legacy devkit name is accepted too', async () => {
    const { tree } = await add(await withExtract('@angular-devkit/build-angular:extract-i18n', {}));
    expect(target(tree, 'app', 'extract-i18n')).toEqual({ builder: `${PKG}:extract-i18n`, options: {} });
  });

  it('an absent extract-i18n target stays absent (nothing is added)', async () => {
    const { tree, info } = await add(await workspaceWith());
    expect(Object.keys(readJson(tree, 'angular.json').projects.app.architect).sort()).toEqual(['build', 'serve', 'test']);
    expect(info.join('\n')).not.toContain('extract-i18n');
  });

  it('a project that already has the wrapper counts as prebuild-configured: running again changes nothing, byte for byte', async () => {
    const first = (await add(await withExtract())).tree;
    const snap = snapshot(first);
    expect(first.readText('angular.json')).toContain(`${PKG}:extract-i18n`);
    const second = (await add(first)).tree;
    expect(snapshot(second)).toEqual(snap);
    expect(snapshot((await add(second)).tree)).toEqual(snap);
    // the plugin mode refuses it as it refuses the other wrappers (the build target is the wrapper too)
    await expect(ours().runSchematic('ng-add', {}, second)).rejects.toThrow(/already set up for the shader prebuild/);
  });

  it('only the builder name changes: all of angular.json outside it is as it was', async () => {
    const before = await withExtract();
    const original = readJson(before, 'angular.json');
    const changed = structuredClone(readJson((await add(before)).tree, 'angular.json'));
    for (const name of ['build', 'serve', 'test', 'extract-i18n']) {
      changed.projects.app.architect[name].builder = original.projects.app.architect[name].builder;
    }
    expect(changed).toEqual(original);
  });

  it('another extract-i18n builder is left alone, with a warning that says why (and the rest is still set up)', async () => {
    const { tree, warnings } = await add(await withExtract('my-company:extract', {}));
    expect(target(tree, 'app', 'extract-i18n').builder).toBe('my-company:extract');
    expect(target(tree, 'app', 'build').builder).toBe(`${PKG}:application`);
    expect(warnings.join('\n')).toMatch(/"extract-i18n" target of "app" uses "my-company:extract", which is left unchanged/);
  });

  it('in a workspace with several applications only the chosen project\'s target moves', async () => {
    const tree = await workspaceWith(['app', 'other']);
    editJson(tree, 'angular.json', (json) => {
      for (const name of ['app', 'other']) json.projects[name].architect['extract-i18n'] = { builder: '@angular/build:extract-i18n' };
    });
    const { tree: after } = await add(tree, { project: 'other' });
    expect(target(after, 'other', 'extract-i18n').builder).toBe(`${PKG}:extract-i18n`);
    expect(target(after, 'app', 'extract-i18n').builder).toBe('@angular/build:extract-i18n');
  });
});

describe('ng add --shaders prebuild: layouts', () => {
  it('an application in projects/<name>: the mapping, in the root tsconfig, points into the project folder', async () => {
    const { tree } = await add(await workspaceWith(['shop'], '22.0.0', false));
    expect(readJsonc(tree, 'tsconfig.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./projects/shop/shaders-dist/*'] });
    expect(target(tree, 'shop', 'build').builder).toBe(`${PKG}:application`);
  });

  it('a base config in another folder gets the path relative to itself', async () => {
    const tree = await workspaceWith();
    tree.create('config/base.json', JSON.stringify({ compilerOptions: { strict: true } }));
    for (const name of ['tsconfig.app.json', 'tsconfig.spec.json']) {
      tree.overwrite(name, JSON.stringify({ ...readJsonc(tree, name), extends: './config/base.json' }));
    }
    const { tree: after } = await add(tree);
    expect(readJsonc(after, 'config/base.json').compilerOptions.paths).toEqual({ '@shaders/*': ['../shaders-dist/*'] });
    expect(readJsonc(after, 'tsconfig.json').compilerOptions?.paths).toBeUndefined();
  });

  it('several applications: --project picks one, and each gets a mapping to its own shader folder in its own tsconfigs', async () => {
    const tree = await workspaceWith(['one', 'two']);
    await refused(tree, /several applications \(one, two\)/);
    const first = (await add(tree, { project: 'one' })).tree;
    const second = (await add(first, { project: 'two' })).tree;
    expect(target(second, 'one', 'build').builder).toBe(`${PKG}:application`);
    expect(target(second, 'two', 'build').builder).toBe(`${PKG}:application`);
    expect(readJsonc(second, 'tsconfig.json').compilerOptions?.paths).toBeUndefined(); // the shared base is not used for either
    expect(readJsonc(second, 'tsconfig.app.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
    expect(readJsonc(second, 'tsconfig.spec.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
    expect(readJsonc(second, 'projects/two/tsconfig.app.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
    expect(readJsonc(second, 'projects/two/tsconfig.spec.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
    // idempotent for both
    const again = (await add(await add(second, { project: 'one' }).then((r) => r.tree), { project: 'two' })).tree;
    expect(snapshot(again)).toEqual(snapshot(second));
  });

  it('several applications whose shared base already has paths cannot be given one mapping: refused with what to do', async () => {
    const tree = await workspaceWith(['one', 'two']);
    tree.overwrite('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/app/*'] } } }));
    await refused(tree, /gets its "paths" from tsconfig\.json, which another application uses too/, { project: 'one' });
  });
});

describe('ng add --shaders prebuild: refused layouts (nothing is changed)', () => {
  it('a project already set up with the plugin mode (community builders)', async () => {
    const tree = await ours().runSchematic('ng-add', {}, await workspaceWith());
    await refused(tree as Tree, /already set up for the plugin mode/);
  });

  it('a project that only has the plugin in its options', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.plugins = ['node_modules/x/tools/typegpu-shaders.esbuild.mjs']));
    await refused(tree, /already set up for the plugin mode/);
  });

  it('a build target that is not the stock esbuild application builder', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.builder = '@angular-devkit/build-angular:browser'));
    await refused(tree, /builds with "@angular-devkit\/build-angular:browser".*stock esbuild application builder/s);
  });

  it('a dev server that is not the stock one', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.serve.builder = '@angular-devkit/build-angular:something'));
    await refused(tree, /serves with "@angular-devkit\/build-angular:something"/);
  });

  it('a project without a build target', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => delete json.projects.app.architect.build);
    await refused(tree, /has no "build" target/);
  });

  it('@shaders/* already mapped to something else', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@shaders/*': ['./src/shaders/*'] } } }));
    await refused(tree, /already maps "@shaders\/\*" to \["\.\/src\/shaders\/\*"\]/);
  });

  it('a build tsconfig with its own paths that the test tsconfig does not share, with only one application: each config gets its own entry', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.app.json', JSON.stringify({ extends: './tsconfig.json', compilerOptions: { paths: { '@a/*': ['./a/*'] } }, include: ['src/**/*.ts'] }));
    const { tree: after } = await add(tree);
    expect(readJsonc(after, 'tsconfig.app.json').compilerOptions.paths).toEqual({ '@a/*': ['./a/*'], '@shaders/*': ['./shaders-dist/*'] });
    expect(readJsonc(after, 'tsconfig.spec.json').compilerOptions.paths).toEqual({ '@shaders/*': ['./shaders-dist/*'] });
  });

  it('a test tsconfig that does not extend the config holding the mapping gets its own entry, and keeps its other settings', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.spec.json', JSON.stringify({ compilerOptions: { types: ['vitest/globals'] }, include: ['src/**/*.spec.ts'] }));
    const { tree: after } = await add(tree);
    expect(readJsonc(after, 'tsconfig.spec.json').compilerOptions).toEqual({ types: ['vitest/globals'], paths: { '@shaders/*': ['./shaders-dist/*'] } });
  });

  it('a baseUrl other than the config\'s own folder', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './src' } }));
    await refused(tree, /sets compilerOptions\.baseUrl \("\.\/src"\)/);
  });

  it('an extends that is a package or a list', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.json', JSON.stringify({ extends: '@tsconfig/strictest/tsconfig.json' }));
    await refused(tree, /not a single relative path/);
    const list = await workspaceWith();
    list.overwrite('tsconfig.json', JSON.stringify({ extends: ['./a.json', './b.json'] }));
    await refused(list, /not a single relative path/);
  });

  it('a tsconfig that is not valid JSON, and one that is missing', async () => {
    const broken = await workspaceWith();
    broken.overwrite('tsconfig.json', '{ "compilerOptions": ');
    await refused(broken, /tsconfig\.json is not valid JSON/);
    const missing = await workspaceWith();
    editJson(missing, 'angular.json', (json) => (json.projects.app.architect.build.options.tsConfig = 'nope.json'));
    await refused(missing, /\("nope\.json"\) does not exist/);
  });

  it('a circular extends chain', async () => {
    const tree = await workspaceWith();
    tree.overwrite('tsconfig.json', JSON.stringify({ extends: './tsconfig.app.json' }));
    await refused(tree, /circular or too deep/);
  });

  it('no typescript dependency, Babel 8, typegpu out of range, an unsupported Angular major', async () => {
    const noTs = await workspaceWith();
    editJson(noTs, 'package.json', (json) => delete json.devDependencies.typescript);
    await refused(noTs, /no "typescript" dependency/);
    const babel = await workspaceWith();
    editJson(babel, 'package.json', (json) => (json.devDependencies['@babel/core'] = '^8.0.0'));
    await refused(babel, /Babel 8 is not supported/);
    const old = await workspaceWith();
    editJson(old, 'package.json', (json) => (json.dependencies.typegpu = '^0.11.0'));
    await refused(old, /needs typegpu \^0\.12\.8/);
    const ng19 = await workspaceWith();
    editJson(ng19, 'package.json', (json) => (json.dependencies['@angular/core'] = '^19.0.0'));
    await refused(ng19, /Angular 19 is not supported/);
  });

  it('every refusal says how to undo the package installation, as the plugin mode does', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => delete json.projects.app.architect.build);
    await expect(ours().runSchematic('ng-add', { shaders: 'prebuild' }, tree)).rejects.toThrow(/npm uninstall @typegpu-poc\/angular/);
  });
});
