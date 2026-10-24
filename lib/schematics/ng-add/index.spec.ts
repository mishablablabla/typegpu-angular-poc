import { describe, expect, it } from 'vitest';
import { editJson, ngAdd, ours, readJson, workspaceWith } from '../testing/workspace';

const PLUGIN = 'node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs';
const CHECK = 'node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs';

const target = (tree: Awaited<ReturnType<typeof workspaceWith>>, project: string, name: string) =>
  readJson(tree, 'angular.json')['projects'][project]['architect'][name];

describe('ng add: a clean standalone application', () => {
  it('configures builders, plugin, test target, dependencies and the CI script', async () => {
    const tree = await ngAdd(await workspaceWith());

    const build = target(tree, 'app', 'build');
    expect(build.builder).toBe('@angular-builders/custom-esbuild:application');
    expect(build.options.plugins).toEqual([PLUGIN]);
    expect(build.options.browser).toBe('src/main.ts'); // unrelated options survive

    expect(target(tree, 'app', 'serve').builder).toBe('@angular-builders/custom-esbuild:dev-server');

    const test = target(tree, 'app', 'test');
    expect(test.builder).toBe('@angular-builders/custom-esbuild:unit-test');
    expect(test.options).toMatchObject({
      buildTarget: 'app:build:development',
      tsConfig: 'tsconfig.spec.json',
      reporters: ['default'],
    });

    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies.typegpu).toBe('0.12.8');
    expect(pkg.devDependencies['@angular-builders/custom-esbuild']).toBe('^22.0.0');
    expect(pkg.devDependencies['@babel/core']).toBe('^7.28.0');
    expect(pkg.devDependencies['unplugin-typegpu']).toBe('0.12.6');
    // the package itself is saved by `ng add` (package.json "ng-add.save"), not by the schematic
    expect(pkg.dependencies['@typegpu-poc/angular']).toBeUndefined();
    expect(pkg.scripts['check:shaders']).toBe(`ng build --configuration production && node ${CHECK} dist/app/browser`);
  });

  it('schedules exactly one package install', async () => {
    const runner = ours();
    await runner.runSchematic('ng-add', {}, await workspaceWith());
    expect(runner.tasks.filter((task) => task.name === 'node-package')).toHaveLength(1);
  });

  it('does not touch application providers or any source file', async () => {
    const before = await workspaceWith();
    const sources = Object.fromEntries(before.files.filter((f) => f.startsWith('/src/')).map((f) => [f, before.readText(f)]));
    const after = await ngAdd(before);
    for (const [path, content] of Object.entries(sources)) expect(after.readText(path)).toBe(content);
  });

  it('is idempotent: a second run changes nothing and duplicates nothing', async () => {
    const first = await ngAdd(await workspaceWith());
    const snapshot = { workspace: first.readText('angular.json'), pkg: first.readText('package.json') };
    const second = await ngAdd(first);
    expect(second.readText('angular.json')).toBe(snapshot.workspace);
    expect(second.readText('package.json')).toBe(snapshot.pkg);
    expect(target(second, 'app', 'build').options.plugins).toEqual([PLUGIN]);
  });
});

describe('ng add: existing configuration', () => {
  it('keeps custom options, other plugins and configuration-level plugin lists, and adds the plugin where a list replaces the global one', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      const build = json.projects.app.architect.build;
      build.options.plugins = ['tools/my-plugin.mjs'];
      build.options.define = { FLAG: 'true' };
      build.options.baseHref = '/shop/';
      build.options.assets = [{ glob: '**/*', input: 'public' }, { glob: '*.txt', input: 'extra' }];
      build.options.styles = ['src/styles.css', 'src/theme.css'];
      build.configurations.production.plugins = ['tools/prod-only.mjs'];
      build.configurations.production.fileReplacements = [{ replace: 'src/env.ts', with: 'src/env.prod.ts' }];
      json.projects.app.architect.test.options = { include: ['src/**/*.spec.ts'] };
    });
    const before = readJson(tree, 'angular.json');
    const after = readJson(await ngAdd(tree), 'angular.json');
    const build = after.projects.app.architect.build;

    expect(build.options.plugins).toEqual(['tools/my-plugin.mjs', PLUGIN]);
    expect(build.configurations.production.plugins).toEqual(['tools/prod-only.mjs', PLUGIN]);
    expect(build.configurations.development.plugins).toBeUndefined(); // no list there: it inherits the global one
    for (const key of ['define', 'baseHref', 'assets', 'styles']) expect(build.options[key]).toEqual(before.projects.app.architect.build.options[key]);
    expect(build.configurations.production.fileReplacements).toEqual([{ replace: 'src/env.ts', with: 'src/env.prod.ts' }]);
    expect(after.projects.app.architect.test.options.include).toEqual(['src/**/*.spec.ts']);
    expect(after.projects.app.architect.test.options.buildTarget).toBe('app:build:development');
  });

  it('keeps an existing object-style plugin entry and an explicit test buildTarget', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.build.options.plugins = [{ path: `./${PLUGIN}` }];
      json.projects.app.architect.test.options = { buildTarget: 'app:build:production', reporters: ['verbose'] };
    });
    const after = readJson(await ngAdd(tree), 'angular.json');
    expect(after.projects.app.architect.build.options.plugins).toEqual([{ path: `./${PLUGIN}` }]);
    expect(after.projects.app.architect.test.options).toMatchObject({ buildTarget: 'app:build:production', reporters: ['verbose'] });
  });

  it('keeps existing dependency entries (no duplicates, no downgrade) and picks the matching unplugin-typegpu', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', (pkg) => {
      pkg.dependencies.typegpu = '^0.12.9';
      pkg.devDependencies['@angular-builders/custom-esbuild'] = '^22.0.1';
      pkg.devDependencies['@babel/core'] = '^7.29.0';
      pkg.scripts = { ...pkg.scripts, lint: 'eslint .' };
    });
    const after = await ngAdd(tree);
    const pkg = readJson(after, 'package.json');
    expect(pkg.dependencies.typegpu).toBe('^0.12.9');
    expect(pkg.devDependencies['@angular-builders/custom-esbuild']).toBe('^22.0.1');
    expect(pkg.devDependencies['@babel/core']).toBe('^7.29.0');
    expect(pkg.devDependencies['unplugin-typegpu']).toBe('0.12.7'); // 0.12.6 would not match typegpu 0.12.9's pair
    expect(pkg.devDependencies.typegpu).toBeUndefined();
    expect(pkg.dependencies['@babel/core']).toBeUndefined();
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(after.readText('package.json')).toMatch(/^\{\n {2}"/); // indentation kept
  });

  it('does not replace a check:shaders script the user already has', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', (pkg) => (pkg.scripts['check:shaders'] = 'echo mine'));
    expect(readJson(await ngAdd(tree), 'package.json').scripts['check:shaders']).toBe('echo mine');
  });

  it('uses the custom-esbuild major of the application\'s Angular major', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', (pkg) => (pkg.dependencies['@angular/core'] = '^21.2.0'));
    const pkg = readJson(await ngAdd(tree), 'package.json');
    expect(pkg.devDependencies['@angular-builders/custom-esbuild']).toBe('^21.0.0');
  });

  it('follows a custom outputPath in the CI script', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.outputPath = 'out/site'));
    expect(readJson(await ngAdd(tree), 'package.json').scripts['check:shaders']).toContain('out/site/browser');
    const other = await workspaceWith();
    editJson(other, 'angular.json', (json) => (json.projects.app.architect.build.options.outputPath = { base: 'out/site', browser: '' }));
    expect(readJson(await ngAdd(other), 'package.json').scripts['check:shaders']).toMatch(/ out\/site$/);
  });
});

describe('ng add: several applications', () => {
  it('asks which one instead of guessing', async () => {
    const tree = await workspaceWith(['shop', 'admin']);
    await expect(ngAdd(tree)).rejects.toThrow(/several applications \(shop, admin\).*--project <name>/s);
  });

  it('configures only the selected application and names its script after it', async () => {
    const tree = await workspaceWith(['shop', 'admin']);
    const before = readJson(tree, 'angular.json');
    const after = readJson(await ngAdd(tree, { project: 'admin' }), 'angular.json');

    expect(after.projects.admin.architect.build.builder).toBe('@angular-builders/custom-esbuild:application');
    expect(after.projects.admin.architect.build.options.plugins).toEqual([PLUGIN]);
    expect(after.projects.admin.architect.test.options.tsConfig).toBe('projects/admin/tsconfig.spec.json');
    expect(after.projects.shop).toEqual(before.projects.shop);

    const scripts = readJson(await ngAdd(await workspaceWith(['shop', 'admin']), { project: 'admin' }), 'package.json').scripts;
    expect(scripts['check:shaders:admin']).toBe(`ng build admin --configuration production && node ${CHECK} dist/admin/browser`);
    expect(scripts['check:shaders']).toBeUndefined();
  });

  it('rejects an unknown project and a project that is not an application', async () => {
    const tree = await workspaceWith(['shop', 'admin']);
    await expect(ngAdd(tree, { project: 'nope' })).rejects.toThrow(/does not exist/);
    editJson(tree, 'angular.json', (json) => (json.projects.admin.projectType = 'library'));
    await expect(ngAdd(tree, { project: 'admin' })).rejects.toThrow(/not an application/);
  });
});

describe('ng add: setups it must not change', () => {
  const refuse = async (edit: (json: Record<string, any>) => void, message: RegExp) => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', edit);
    const before = { workspace: tree.readText('angular.json'), pkg: tree.readText('package.json') };
    await expect(ngAdd(tree)).rejects.toThrow(message);
    expect(tree.readText('angular.json')).toBe(before.workspace); // nothing was written
    expect(tree.readText('package.json')).toBe(before.pkg);
  };

  it('a webpack build', () =>
    refuse((json) => (json.projects.app.architect.build.builder = '@angular-devkit/build-angular:browser'), /@angular-devkit\/build-angular:browser.*use-application-builder.*Nothing was changed/s));

  it('another builder on the build target', () =>
    refuse((json) => (json.projects.app.architect.build.builder = 'my-company:build'), /"my-company:build"/));

  it('a dev server that does not use the esbuild build', () =>
    refuse((json) => (json.projects.app.architect.serve.builder = '@angular-devkit/build-angular:dev-server'), /serves with "@angular-devkit\/build-angular:dev-server"/));

  it('a plugins option that is not a list', () =>
    refuse((json) => (json.projects.app.architect.build.options.plugins = 'x'), /not a list/));

  it('a project without a build target', () => refuse((json) => delete json.projects.app.architect.build, /no "build" target/));

  it('Babel 8, an old typegpu and an unsupported Angular major', async () => {
    for (const [edit, message] of [
      [(pkg: any) => (pkg.devDependencies['@babel/core'] = '^8.0.0'), /@babel\/core "\^8.0.0"/],
      [(pkg: any) => (pkg.dependencies.typegpu = '^0.11.0'), /typegpu "\^0\.11\.0".*\^0\.12\.8/],
      [(pkg: any) => (pkg.dependencies.typegpu = '0.12.7'), /typegpu "0\.12\.7"/],
      [(pkg: any) => (pkg.dependencies['@angular/core'] = '^19.0.0'), /Angular 19 is not supported/],
    ] as const) {
      const tree = await workspaceWith();
      editJson(tree, 'package.json', edit);
      await expect(ngAdd(tree)).rejects.toThrow(message);
    }
  });
});

describe('ng add: test targets', () => {
  it('leaves a Karma test target alone and says so', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test = { builder: '@angular/build:karma', options: { tsConfig: 'tsconfig.spec.json' } }));
    const runner = ours();
    const logs: string[] = [];
    runner.logger.subscribe((entry) => logs.push(entry.message));
    const after = readJson(await runner.runSchematic('ng-add', {}, tree), 'angular.json');
    expect(after.projects.app.architect.test).toEqual({ builder: '@angular/build:karma', options: { tsConfig: 'tsconfig.spec.json' } });
    expect(logs.join('\n')).toMatch(/uses "@angular\/build:karma".*left unchanged/s);
    expect(after.projects.app.architect.build.options.plugins).toEqual([PLUGIN]); // build is still configured
  });

  it('treats the stock unit-test builder with the karma runner as Karma', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test.options = { runner: 'karma' }));
    const after = readJson(await ngAdd(tree), 'angular.json');
    expect(after.projects.app.architect.test.builder).toBe('@angular/build:unit-test');
  });

  it('keeps the stock unit-test builder on Angular 20: custom-esbuild 20 has no unit-test builder', async () => {
    const tree = await workspaceWith(['app'], '20.3.0');
    editJson(tree, 'package.json', (pkg) => (pkg.dependencies['@angular/core'] = '^20.3.0'));
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test.options = { runner: 'vitest' }));
    const runner = ours();
    const logs: string[] = [];
    runner.logger.subscribe((entry) => logs.push(entry.message));
    const after = readJson(await runner.runSchematic('ng-add', {}, tree), 'angular.json');
    expect(after.projects.app.architect.test).toEqual({ builder: '@angular/build:unit-test', options: { runner: 'vitest' } });
    expect(after.projects.app.architect.build.builder).toBe('@angular-builders/custom-esbuild:application'); // build still done
    expect(logs.join('\n')).toMatch(/left unchanged: custom-esbuild 20 has no "unit-test" builder/);
  });

  it('drops the vitest runner option, which the custom unit-test builder does not know', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test.options = { runner: 'vitest', watch: false }));
    const test = readJson(await ngAdd(tree), 'angular.json').projects.app.architect.test;
    expect(test.options.runner).toBeUndefined();
    expect(test.options.watch).toBe(false);
  });

  it('works without a test target', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => delete json.projects.app.architect.test);
    const after = readJson(await ngAdd(tree), 'angular.json');
    expect(after.projects.app.architect.test).toBeUndefined();
  });
});
