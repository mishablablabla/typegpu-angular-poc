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
    expect(pkg.dependencies.typegpu).toBe('^0.12.8');
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

  it.each([['dist/a b'], ['dist/a;touch pwned'], ['dist/$(id)'], ['dist/`id`'], ['dist/a&b'], ['dist/a|b']])(
    'does not put an output folder that is not a plain word (%s) into an npm script: no script is added, the rest of ng add is done',
    async (outputPath) => {
      const tree = await workspaceWith();
      editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.options.outputPath = outputPath));
      const result = await ngAdd(tree);
      const pkg = readJson(result, 'package.json');
      expect(pkg.scripts['check:shaders']).toBeUndefined();
      expect(pkg.dependencies['typegpu']).toBeDefined(); // the setup itself went through
      expect(JSON.stringify(readJson(result, 'angular.json'))).toContain('custom-esbuild');
    },
  );

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

  it('a webpack build, and says truthfully that the package itself was installed by ng add', async () => {
    await refuse((json) => (json.projects.app.architect.build.builder = '@angular-devkit/build-angular:browser'), /@angular-devkit\/build-angular:browser.*use-application-builder/s);
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.builder = '@angular-devkit/build-angular:browser'));
    const message = await ngAdd(tree).then(
      () => '',
      (error: Error) => error.message,
    );
    // ng add installs the package before the schematic runs: "Nothing was changed" would be false
    expect(message).not.toMatch(/Nothing was changed|not touched/i);
    expect(message).toMatch(/@typegpu-poc\/angular itself is already installed.*angular\.json.*not modified.*npm uninstall @typegpu-poc\/angular/s);
  });

  it('another builder on the build target, without suggesting the webpack migration', async () => {
    await refuse((json) => (json.projects.app.architect.build.builder = 'my-company:build'), /"my-company:build".*only extends the stock esbuild application builder/s);
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.builder = 'my-company:build'));
    await expect(ngAdd(tree)).rejects.not.toThrow(/use-application-builder/);
  });

  it('browser-esbuild, the predecessor of the application builder', () =>
    refuse((json) => (json.projects.app.architect.build.builder = '@angular-devkit/build-angular:browser-esbuild'), /browser-esbuild.*Switch the target to "@angular\/build:application"/s));

  it('a dev server that does not use the esbuild build', () =>
    refuse((json) => (json.projects.app.architect.serve.builder = 'my-company:serve'), /serves with "my-company:serve"/));

  it('a plugins option that is not a list', () =>
    refuse((json) => (json.projects.app.architect.build.options.plugins = 'x'), /not a list/));

  it('a project without a build target', () => refuse((json) => delete json.projects.app.architect.build, /no "build" target/));

  it('Babel 8, an old typegpu and an unsupported Angular major', async () => {
    for (const [edit, message] of [
      [(pkg: any) => (pkg.devDependencies['@babel/core'] = '^8.0.0'), /@babel\/core "\^8.0.0"/],
      [(pkg: any) => (pkg.dependencies.typegpu = '^0.11.0'), /typegpu "\^0\.11\.0".*\^0\.12\.8/],
      [(pkg: any) => (pkg.dependencies.typegpu = '0.12.7'), /typegpu "0\.12\.7"/],
      // the unsupported-Angular path is a refusal too: it carries the same honest note, and no "nothing changed" claim
      [(pkg: any) => (pkg.dependencies['@angular/core'] = '^19.0.0'), /Angular 19 is not supported.*Angular 20, 21, 22.*already installed.*not modified/s],
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

describe('ng add: legacy builder names', () => {
  it('treats @angular-devkit/build-angular:application and :dev-server as the stock esbuild builders', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.build.builder = '@angular-devkit/build-angular:application';
      json.projects.app.architect.serve.builder = '@angular-devkit/build-angular:dev-server';
    });
    const after = readJson(await ngAdd(tree), 'angular.json');
    expect(after.projects.app.architect.build.builder).toBe('@angular-builders/custom-esbuild:application');
    expect(after.projects.app.architect.serve.builder).toBe('@angular-builders/custom-esbuild:dev-server');
    expect(after.projects.app.architect.build.options.plugins).toEqual([PLUGIN]);
  });
});

describe('ng add: the check script', () => {
  it('also checks the SSR server bundle when the application has one', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.build.options.server = 'src/main.server.ts';
      json.projects.app.architect.build.options.ssr = { entry: 'src/server.ts' };
    });
    expect(readJson(await ngAdd(tree), 'package.json').scripts['check:shaders']).toBe(
      `ng build --configuration production && node ${CHECK} dist/app/browser dist/app/server`,
    );
    const custom = await workspaceWith();
    editJson(custom, 'angular.json', (json) => {
      json.projects.app.architect.build.options.server = 'src/main.server.ts';
      json.projects.app.architect.build.options.outputPath = { base: 'out', browser: 'web', server: 'node' };
    });
    expect(readJson(await ngAdd(custom), 'package.json').scripts['check:shaders']).toContain(` ${CHECK} out/web out/node`);
  });

  it('does not add a server directory to an application without SSR', async () => {
    expect(readJson(await ngAdd(await workspaceWith()), 'package.json').scripts['check:shaders']).not.toContain('server');
  });
});

describe('ng add: stock-only options on the test target', () => {
  const logsOf = (runner: ReturnType<typeof ours>) => {
    const logs: string[] = [];
    runner.logger.subscribe((entry) => logs.push(entry.message));
    return logs;
  };

  it('drops every option the custom unit-test schema lacks (runner, splitting) and logs what it removed', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.test.options = { splitting: false, runner: 'vitest', coverage: true, watch: false, include: ['src/**/*.spec.ts'], notAnOption: 1 };
    });
    const runner = ours();
    const logs = logsOf(runner);
    const after = readJson(await runner.runSchematic('ng-add', {}, tree), 'angular.json');
    const options = after.projects.app.architect.test.options;
    expect(options.splitting).toBeUndefined();
    expect(options.runner).toBeUndefined();
    expect(options.notAnOption).toBeUndefined();
    expect(options).toMatchObject({ coverage: true, watch: false, include: ['src/**/*.spec.ts'], buildTarget: 'app:build:development' });
    expect(logs.join('\n')).toMatch(/Removed from the "test" target of "app".*: splitting, runner, notAnOption\..*does not support them.*Vitest only/s);
  });

  it('cleans test configurations too', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.test.options = { runner: 'vitest' };
      json.projects.app.architect.test.configurations = { ci: { splitting: true, watch: false } };
    });
    const test = readJson(await ngAdd(tree), 'angular.json').projects.app.architect.test;
    expect(test.configurations.ci).toEqual({ watch: false });
  });

  it('says nothing when there was nothing to remove', async () => {
    const runner = ours();
    const logs = logsOf(runner);
    await runner.runSchematic('ng-add', {}, await workspaceWith());
    expect(logs.join('\n')).not.toMatch(/Removed from the "test" target/);
  });

  it('does not touch the options of a target that already uses the custom builder', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      json.projects.app.architect.test = { builder: '@angular-builders/custom-esbuild:unit-test', options: { watch: false, whatever: 1 } };
    });
    expect(readJson(await ngAdd(tree), 'angular.json').projects.app.architect.test.options.whatever).toBe(1);
  });

  it('uses the Angular 21 option list on Angular 21 (no isolate/quiet in that schema)', async () => {
    const tree = await workspaceWith(['app'], '21.0.0');
    editJson(tree, 'package.json', (pkg) => (pkg.dependencies['@angular/core'] = '^21.0.0'));
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.test.options = { isolate: true, quiet: true, watch: false }));
    const options = readJson(await ngAdd(tree), 'angular.json').projects.app.architect.test.options;
    expect(options.isolate).toBeUndefined();
    expect(options.quiet).toBeUndefined();
    expect(options.watch).toBe(false);
    const on22 = await workspaceWith();
    editJson(on22, 'angular.json', (json) => (json.projects.app.architect.test.options = { isolate: true, quiet: true }));
    expect(readJson(await ngAdd(on22), 'angular.json').projects.app.architect.test.options).toMatchObject({ isolate: true, quiet: true });
  });
});

/** Runs ng add and returns the tree with what was logged (warnings and infos apart). */
async function run(tree: Awaited<ReturnType<typeof workspaceWith>>, options: Record<string, unknown> = {}) {
  const runner = ours();
  const info: string[] = [];
  const warn: string[] = [];
  runner.logger.subscribe((entry) => (entry.level === 'warn' ? warn : info).push(entry.message));
  const after = await runner.runSchematic('ng-add', options, tree);
  return { tree: after, info: info.join('\n'), warn: warn.join('\n') };
}

const angular20 = async () => {
  const tree = await workspaceWith(['app'], '20.3.0');
  editJson(tree, 'package.json', (pkg) => (pkg.dependencies['@angular/core'] = '^20.3.0'));
  return tree;
};

describe('ng add: the `security` block that `ng new --ssr` of Angular 20.3 writes (custom-esbuild 20 rejects security.allowedHosts)', () => {
  const ssr = (json: Record<string, any>, security: unknown = { allowedHosts: [] }) => {
    const options = json.projects.app.architect.build.options;
    Object.assign(options, { server: 'src/main.server.ts', outputMode: 'server', security, ssr: { entry: 'src/server.ts' } });
  };

  it('removes the empty allowedHosts (the default), keeps every other option, and says what and why, with the production host advice', async () => {
    const tree = await angular20();
    editJson(tree, 'angular.json', (json) => ssr(json));
    const before = readJson(tree, 'angular.json').projects.app.architect.build.options;
    const { tree: after, warn } = await run(tree);
    const options = readJson(after, 'angular.json').projects.app.architect.build.options;
    expect(options.security).toBeUndefined();
    const { security, plugins, ...rest } = { ...options };
    const { security: _security, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest); // nothing else was touched
    expect(plugins).toEqual([PLUGIN]);
    expect(warn).toMatch(/Removed security\.allowedHosts \(an empty list, which is also the default\) from the build options of "app".*Schema validation failed.*NG_ALLOWED_HOSTS.*AngularNodeAppEngine/s);
  });

  it('keeps the other security options (autoCsp) and removes the key only when it is empty', async () => {
    const tree = await angular20();
    editJson(tree, 'angular.json', (json) => ssr(json, { allowedHosts: [], autoCsp: true }));
    const options = readJson((await run(tree)).tree, 'angular.json').projects.app.architect.build.options;
    expect(options.security).toEqual({ autoCsp: true });
  });

  it('cleans build configurations too', async () => {
    const tree = await angular20();
    editJson(tree, 'angular.json', (json) => {
      ssr(json, undefined);
      delete json.projects.app.architect.build.options.security;
      json.projects.app.architect.build.configurations.production.security = { allowedHosts: [] };
    });
    const { tree: after, warn } = await run(tree);
    expect(readJson(after, 'angular.json').projects.app.architect.build.configurations.production.security).toBeUndefined();
    expect(warn).toContain('the "production" configuration');
  });

  it('is idempotent: the second run changes nothing and does not repeat the removal note', async () => {
    const tree = await angular20();
    editJson(tree, 'angular.json', (json) => ssr(json));
    const first = await run(tree);
    const second = await run(first.tree);
    expect(second.tree.readText('angular.json')).toBe(first.tree.readText('angular.json'));
    expect(second.tree.readText('package.json')).toBe(first.tree.readText('package.json'));
    expect(second.warn).not.toContain('Removed security.allowedHosts');
  });

  it('refuses a list with hosts in it (an allow-list must not be dropped silently, and keeping it breaks the build): nothing is written', async () => {
    const tree = await angular20();
    editJson(tree, 'angular.json', (json) => ssr(json, { allowedHosts: ['shop.example.com'] }));
    const before = { workspace: tree.readText('angular.json'), pkg: tree.readText('package.json') };
    await expect(ngAdd(tree)).rejects.toThrow(
      /security\.allowedHosts \(\["shop\.example\.com"\]\).*Schema validation failed.*drop your host allow-list.*--shaders prebuild.*NG_ALLOWED_HOSTS.*already installed/s,
    );
    expect(tree.readText('angular.json')).toBe(before.workspace);
    expect(tree.readText('package.json')).toBe(before.pkg);
  });

  it('leaves the block alone on Angular 21 and 22 (their custom-esbuild schema knows it) and says nothing', async () => {
    for (const [version, range] of [['21.0.0', '^21.2.0'], ['22.0.0', '^22.0.0']] as const) {
      const tree = await workspaceWith(['app'], version);
      editJson(tree, 'package.json', (pkg) => (pkg.dependencies['@angular/core'] = range));
      editJson(tree, 'angular.json', (json) => ssr(json, { allowedHosts: ['a.example.com'] }));
      const { tree: after, warn } = await run(tree);
      expect(readJson(after, 'angular.json').projects.app.architect.build.options.security, version).toEqual({ allowedHosts: ['a.example.com'] });
      expect(warn).not.toContain('allowedHosts');
    }
  });
});

describe('ng add: what it tells you at the end', () => {
  it('tells a project that is already set up for the prebuild to restore the stock builders (running the prebuild again changes nothing)', async () => {
    const prebuilt = await ours().runSchematic('ng-add', { shaders: 'prebuild' }, await workspaceWith());
    const message = await ngAdd(prebuilt).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toMatch(/already set up for the shader prebuild.*first restore the stock builders in angular\.json.*@angular\/build:application.*then run ng add @typegpu-poc\/angular again/s);
    expect(message).not.toMatch(/run `ng add \.\.\. --shaders prebuild` again/);
  });

  it('names the script that exists: check:shaders:<project> in a workspace with several applications', async () => {
    const { info } = await run(await workspaceWith(['shop', 'admin']), { project: 'admin' });
    expect(info).toContain('"npm run check:shaders:admin" fails by design');
    expect(info).not.toContain('"npm run check:shaders" ');
    expect((await run(await workspaceWith())).info).toContain('"npm run check:shaders" fails by design');
  });

  it('does not talk about a script that was not added or is the user\'s own', async () => {
    const odd = await workspaceWith();
    editJson(odd, 'angular.json', (json) => (json.projects.app.architect.build.options.outputPath = 'dist/a b'));
    expect((await run(odd)).info).not.toContain('npm run');
    const mine = await workspaceWith();
    editJson(mine, 'package.json', (pkg) => (pkg.scripts['check:shaders'] = 'echo mine'));
    expect((await run(mine)).info).not.toContain('fails by design');
  });

  const ssrApp = (json: Record<string, any>) => Object.assign(json.projects.app.architect.build.options, { server: 'src/main.server.ts', ssr: { entry: 'src/server.ts' } });

  it('notes the default initial budget of an SSR application (once, as info) and never edits budgets', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', ssrApp);
    const budgets = readJson(tree, 'angular.json').projects.app.architect.build.configurations.production.budgets;
    const { tree: after, info, warn } = await run(tree);
    expect(info).toMatch(/SSR application.*500 kB.*ng add does not change your budgets.*"maximumWarning"/s);
    expect(warn).not.toContain('500 kB');
    expect(readJson(after, 'angular.json').projects.app.architect.build.configurations.production.budgets).toEqual(budgets);
  });

  it('says nothing about budgets for a browser-only application or one whose budget was changed', async () => {
    expect((await run(await workspaceWith())).info).not.toContain('budget');
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      ssrApp(json);
      json.projects.app.architect.build.configurations.production.budgets[0].maximumWarning = '700kB';
    });
    expect((await run(tree)).info).not.toContain('budget');
  });

  it('explains the stock `ng test` warning about the custom build target, only when there is a test target we configured', async () => {
    const { info } = await run(await workspaceWith());
    expect(info).toMatch(/`ng test` prints "The 'buildTarget' is configured to use '@angular-builders\/custom-esbuild:application', which is not supported" on every run.*harmless/s);
    const noTest = await workspaceWith();
    editJson(noTest, 'angular.json', (json) => delete json.projects.app.architect.test);
    expect((await run(noTest)).info).not.toContain('`ng test` prints');
    const karma = await workspaceWith();
    editJson(karma, 'angular.json', (json) => (json.projects.app.architect.test = { builder: '@angular/build:karma', options: {} }));
    expect((await run(karma)).info).not.toContain('`ng test` prints');
  });

  it('the prebuild mode adds one note about TS2307 for @shaders/... on a fresh clone', async () => {
    const { info } = await run(await workspaceWith(), { shaders: 'prebuild' });
    expect(info.match(/TS2307/g)).toHaveLength(1);
    expect(info).toContain('npx typegpu-shaders build');
  });
});

describe('ng add: files with Windows line endings (CRLF)', () => {
  const crlf = (tree: Awaited<ReturnType<typeof workspaceWith>>, path: string) => tree.overwrite(path, tree.readText(path).replace(/\r?\n/g, '\r\n'));
  const lone = (text: string) => /(^|[^\r])\n/.test(text);

  it.each([['plugin', {}], ['prebuild', { shaders: 'prebuild' }]])('%s mode: angular.json, package.json and .gitignore stay CRLF throughout, indentation and unrelated lines are kept', async (_mode, options) => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', (pkg) => (pkg.files = ['dist', 'README.md']));
    tree.overwrite('package.json', tree.readText('package.json').replace('"files": [\n    "dist",\n    "README.md"\n  ]', '"files": ["dist", "README.md"]'));
    expect(tree.readText('package.json')).toContain('"files": ["dist", "README.md"]');
    tree.overwrite('.gitignore', '/node_modules\n/dist\n');
    for (const file of ['angular.json', 'package.json', '.gitignore']) crlf(tree, file);

    const after = (await run(tree, options)).tree;
    for (const file of ['angular.json', 'package.json', '.gitignore']) {
      const text = after.readText(file);
      expect(lone(text), `${file} has a lone LF`).toBe(false);
      expect(text, file).toContain('\r\n');
    }
    expect(after.readText('package.json')).toContain('"files": ["dist", "README.md"]'); // not reformatted
    expect(after.readText('package.json')).toMatch(/^\{\r\n {2}"/);
    expect(readJson(after, 'package.json').dependencies.typegpu).toBe('^0.12.8');
    const prebuild = 'shaders' in options;
    if (!prebuild) expect(readJson(after, 'package.json').scripts['check:shaders']).toContain('check-shader-bundle');
    expect(readJson(after, 'angular.json').projects.app.architect.build.builder).toContain(prebuild ? 'typegpu-poc' : 'custom-esbuild');
  });

  it('is byte-identical on the second run', async () => {
    const tree = await workspaceWith();
    for (const file of ['angular.json', 'package.json']) crlf(tree, file);
    const first = (await run(tree)).tree;
    const snapshot = { workspace: first.readText('angular.json'), pkg: first.readText('package.json') };
    const second = (await run(first)).tree;
    expect(second.readText('angular.json')).toBe(snapshot.workspace);
    expect(second.readText('package.json')).toBe(snapshot.pkg);
  });

  it('does not turn LF files into CRLF', async () => {
    // Angular's own schematics write the fixture with the platform's line ending (CRLF on Windows): make it LF first
    const tree = await workspaceWith();
    for (const file of ['angular.json', 'package.json']) tree.overwrite(file, tree.readText(file).replace(/\r\n/g, '\n'));
    const after = (await run(tree)).tree;
    expect(after.readText('angular.json')).not.toContain('\r');
    expect(after.readText('package.json')).not.toContain('\r');
  });

  it('keeps tab indentation and a missing final newline in package.json', async () => {
    const tree = await workspaceWith();
    const pkg = readJson(tree, 'package.json');
    tree.overwrite('package.json', JSON.stringify(pkg, null, '\t'));
    const text = (await run(tree)).tree.readText('package.json');
    expect(text).toMatch(/^\{\n\t"/);
    expect(text.endsWith('\n')).toBe(false);
    expect(text).toContain('\t\t"check:shaders": ');
  });
});

describe('ng add: output folders of the check script', () => {
  const script = async (edit: (json: Record<string, any>) => void) => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', edit);
    return readJson(await ngAdd(tree), 'package.json').scripts['check:shaders'] as string | undefined;
  };

  it('follows ./ and trailing slashes of a string outputPath', async () => {
    expect(await script((json) => (json.projects.app.architect.build.options.outputPath = './out/site/'))).toMatch(/ \.\/out\/site\/browser$/);
  });

  it('follows the outputPath of the production configuration, which the script builds with', async () => {
    const value = await script((json) => (json.projects.app.architect.build.configurations.production.outputPath = { base: 'release', browser: 'web' }));
    expect(value).toMatch(/--configuration production && node \S+ release\/web$/);
  });

  it('adds no script (and says so) for an absolute path or a Windows backslash path', async () => {
    expect(await script((json) => (json.projects.app.architect.build.options.outputPath = '/var/www/app'))).toMatch(/ \/var\/www\/app\/browser$/);
    expect(await script((json) => (json.projects.app.architect.build.options.outputPath = 'dist\\app'))).toBeUndefined();
  });
});

describe('ng add: a workspace without an application', () => {
  it('names what its projects are instead of just saying there is no application', async () => {
    const tree = await workspaceWith(['shop']);
    editJson(tree, 'angular.json', (json) => (json.projects.shop.projectType = 'library'));
    await expect(ngAdd(tree)).rejects.toThrow(/no application project.*not applications: shop.*"projectType" must be "application"/s);
    await expect(ngAdd(tree, { project: 'shop' })).rejects.toThrow(/Project "shop" is not an application/);
  });
});

describe('ng add (plugin mode): resolve conditions (B1)', () => {
  const conditionsOf = (tree: Awaited<ReturnType<typeof workspaceWith>>) => {
    const build = target(tree, 'app', 'build');
    return { options: build.options.conditions, production: build.configurations.production?.conditions, development: build.configurations.development?.conditions };
  };

  it('writes the conditions the stock builder uses into the production and development configurations, and says so once', async () => {
    const tree = await workspaceWith();
    const before = readJson(tree, 'angular.json').projects.app.architect.build;
    const { tree: after, info } = await run(tree);
    expect(conditionsOf(after)).toEqual({ options: undefined, production: ['module', 'production'], development: ['module', 'development'] });
    // nothing else in the configurations changed
    const { conditions: _p, ...production } = target(after, 'app', 'build').configurations.production;
    const { conditions: _d, ...development } = target(after, 'app', 'build').configurations.development;
    expect(production).toEqual(before.configurations.production);
    expect(development).toEqual(before.configurations.development);
    expect(info.match(/Set "conditions" in the build configurations of "app"/g)).toHaveLength(1);
    expect(info).toMatch(/"production": \["module","production"\], "development": \["module","development"\].*empty list.*"default" file/s);
  });

  it('is idempotent: the second run is byte-identical and does not say it again', async () => {
    const first = await run(await workspaceWith());
    const text = { workspace: first.tree.readText('angular.json'), pkg: first.tree.readText('package.json') };
    const second = await run(first.tree);
    expect(second.tree.readText('angular.json')).toBe(text.workspace);
    expect(second.tree.readText('package.json')).toBe(text.pkg);
    expect(second.info).not.toContain('Set "conditions"');
  });

  it('leaves a project alone that sets conditions anywhere: in the build options, or in any configuration', async () => {
    for (const place of ['options', 'production', 'development', 'staging']) {
      const tree = await workspaceWith();
      editJson(tree, 'angular.json', (json) => {
        const build = json.projects.app.architect.build;
        if (place === 'staging') build.configurations.staging = { conditions: ['custom'] };
        else (place === 'options' ? build.options : build.configurations[place]).conditions = ['custom'];
      });
      const before = readJson(tree, 'angular.json').projects.app.architect.build;
      const { tree: after, info } = await run(tree);
      const build = target(after, 'app', 'build');
      expect(info, place).not.toContain('Set "conditions"');
      for (const name of ['production', 'development']) {
        expect(build.configurations[name].conditions, `${place}/${name}`).toEqual(before.configurations[name].conditions);
      }
      expect(build.options.conditions).toEqual(before.options.conditions);
    }
  });

  it('keeps an empty list too: setting `conditions: []` is the user\'s explicit choice', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect.build.configurations.production.conditions = []));
    expect(conditionsOf(await ngAdd(tree)).production).toEqual([]);
  });

  it('picks production or development by whether the configuration optimizes, as the stock builder does, not by its name', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      const { configurations } = json.projects.app.architect.build;
      configurations.production.optimization = false;
      configurations.development.optimization = { scripts: true, styles: false };
    });
    expect(conditionsOf(await ngAdd(tree))).toMatchObject({ production: ['module', 'development'], development: ['module', 'production'] });
  });

  it('writes only into the configurations that exist, and not into the options of a project without them', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => delete json.projects.app.architect.build.configurations.development);
    expect(conditionsOf(await ngAdd(tree))).toEqual({ options: undefined, production: ['module', 'production'], development: undefined });
    const bare = await workspaceWith();
    editJson(bare, 'angular.json', (json) => delete json.projects.app.architect.build.configurations);
    const { tree: after, info } = await run(bare);
    expect(target(after, 'app', 'build').options.conditions).toBeUndefined();
    expect(info).not.toContain('Set "conditions"');
  });

  it('also writes for an SSR project: the server bundle is built with the same option', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) =>
      Object.assign(json.projects.app.architect.build.options, { server: 'src/main.server.ts', outputMode: 'server', ssr: { entry: 'src/server.ts' } }),
    );
    expect(conditionsOf(await ngAdd(tree))).toMatchObject({ production: ['module', 'production'], development: ['module', 'development'] });
  });

  it('only for the selected application', async () => {
    const tree = await workspaceWith(['shop', 'admin']);
    const after = await ngAdd(tree, { project: 'admin' });
    expect(target(after, 'admin', 'build').configurations.production.conditions).toEqual(['module', 'production']);
    expect(target(after, 'shop', 'build').configurations.production.conditions).toBeUndefined();
  });

  it('the prebuild mode does not write conditions (the stock builder keeps its defaults)', async () => {
    const after = await ours().runSchematic('ng-add', { shaders: 'prebuild' }, await workspaceWith());
    const build = target(after, 'app', 'build');
    expect(build.configurations.production.conditions).toBeUndefined();
    expect(build.configurations.development.conditions).toBeUndefined();
  });
});

describe('ng add (plugin mode): a project that already uses the prebuild wrappers (any target) is refused', () => {
  const WRAPPER_TARGETS = [
    ['build', 'application'],
    ['serve', 'dev-server'],
    ['test', 'unit-test'],
    ['test', 'karma'],
    ['extract-i18n', 'extract-i18n'],
  ] as const;

  it.each(WRAPPER_TARGETS)('%s on the wrapper %s, every other target stock: refused, nothing written', async (name, wrapper) => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => {
      const architect = json.projects.app.architect;
      if (name === 'extract-i18n') architect['extract-i18n'] = {};
      architect[name].builder = `@typegpu-poc/angular:${wrapper}`;
    });
    const before = { workspace: tree.readText('angular.json'), pkg: tree.readText('package.json') };
    const message = await ngAdd(tree).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toMatch(/already set up for the shader prebuild.*The plugin mode and the prebuild do not mix.*first restore the stock builders in angular\.json.*then run ng add @typegpu-poc\/angular again.*npm uninstall @typegpu-poc\/angular/s);
    expect(message).toContain(name === 'build' ? 'its build target is' : `its "${name}" target is "@typegpu-poc/angular:${wrapper}"`);
    expect(tree.readText('angular.json')).toBe(before.workspace);
    expect(tree.readText('package.json')).toBe(before.pkg);
  });

  it('a prebuild project whose build was moved back to stock but whose extract-i18n is still the wrapper', async () => {
    const tree = await workspaceWith();
    editJson(tree, 'angular.json', (json) => (json.projects.app.architect['extract-i18n'] = { builder: '@angular/build:extract-i18n' }));
    const prebuilt = await ours().runSchematic('ng-add', { shaders: 'prebuild' }, tree);
    editJson(prebuilt, 'angular.json', (json) => {
      const architect = json.projects.app.architect;
      architect.build.builder = '@angular/build:application';
      architect.serve.builder = '@angular/build:dev-server';
      architect.test.builder = '@angular/build:unit-test';
    });
    expect(target(prebuilt, 'app', 'extract-i18n').builder).toBe('@typegpu-poc/angular:extract-i18n');
    const before = prebuilt.readText('angular.json');
    await expect(ngAdd(prebuilt)).rejects.toThrow(/"extract-i18n" target is "@typegpu-poc\/angular:extract-i18n"/);
    expect(prebuilt.readText('angular.json')).toBe(before);
  });

  it('only the selected project counts: another application on the prebuild does not block this one', async () => {
    const tree = await workspaceWith(['shop', 'admin']);
    editJson(tree, 'angular.json', (json) => (json.projects.shop.architect['extract-i18n'] = { builder: '@typegpu-poc/angular:extract-i18n' }));
    expect(target(await ngAdd(tree, { project: 'admin' }), 'admin', 'build').builder).toBe('@angular-builders/custom-esbuild:application');
  });
});

describe('ng add: every refusal says the package itself is already installed (E5)', () => {
  const NOTE = /@typegpu-poc\/angular itself is already installed.*angular\.json.*not modified.*npm uninstall @typegpu-poc\/angular/s;

  it.each([['plugin', {}], ['prebuild', { shaders: 'prebuild' }]])('%s mode: unknown project, not an application, several applications, no application, no package.json', async (_mode, mode) => {
    const several = await workspaceWith(['shop', 'admin']);
    await expect(ours().runSchematic('ng-add', { ...mode, project: 'nope' }, several)).rejects.toThrow(NOTE);
    await expect(ours().runSchematic('ng-add', { ...mode }, several)).rejects.toThrow(/several applications.*--project <name>.*already installed/s);
    editJson(several, 'angular.json', (json) => (json.projects.admin.projectType = 'library'));
    await expect(ours().runSchematic('ng-add', { ...mode, project: 'admin' }, several)).rejects.toThrow(NOTE);
    editJson(several, 'angular.json', (json) => (json.projects.shop.projectType = 'library'));
    await expect(ours().runSchematic('ng-add', { ...mode }, several)).rejects.toThrow(NOTE);
    const noPackage = await workspaceWith();
    noPackage.delete('package.json');
    await expect(ours().runSchematic('ng-add', { ...mode }, noPackage)).rejects.toThrow(/package\.json was not found.*already installed.*npm uninstall/s);
  });
});

describe('ng add: dependencies outside the tested set are kept but reported (E2)', () => {
  const warnings = async (mode: 'plugin' | 'prebuild', edit: (pkg: Record<string, any>) => void) => {
    const tree = await workspaceWith();
    editJson(tree, 'package.json', edit);
    const entries = (pkg: Record<string, any>) => ({ ...pkg.dependencies, ...pkg.devDependencies });
    const before = entries(readJson(tree, 'package.json'));
    const { tree: after, warn } = await run(tree, { shaders: mode });
    expect(entries(readJson(after, 'package.json'))).toMatchObject(before); // an existing entry is never changed
    return warn;
  };

  it.each(['plugin', 'prebuild'] as const)('%s: TypeScript below 5.5, esbuild below 0.24, unplugin-typegpu outside ^0.12.6, and 0.12.7 next to a pinned typegpu below 0.12.9', async (mode) => {
    expect(await warnings(mode, (pkg) => (pkg.devDependencies.typescript = '~5.4.0'))).toContain('typescript "~5.4.0" is older than 5.5');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies.typescript = '^4.9.5'))).toContain('typescript "^4.9.5" is older than 5.5');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies.typescript = '~5.5.0'))).not.toContain('typescript');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies.esbuild = '^0.23.1'))).toContain('esbuild "^0.23.1" is older than 0.24');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies['unplugin-typegpu'] = '0.11.6'))).toContain('unplugin-typegpu "0.11.6" is outside ^0.12.6');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies['unplugin-typegpu'] = '0.12.5'))).toContain('unplugin-typegpu "0.12.5" is outside ^0.12.6');
    expect(await warnings(mode, (pkg) => (pkg.devDependencies['unplugin-typegpu'] = '^0.13.0'))).toContain('unplugin-typegpu "^0.13.0" is outside ^0.12.6');
    expect(await warnings(mode, (pkg) => ((pkg.dependencies.typegpu = '0.12.8'), (pkg.devDependencies['unplugin-typegpu'] = '0.12.7')))).toContain('needs typegpu ^0.12.9');
  });

  it('plugin mode: custom-esbuild of another Angular major', async () => {
    expect(await warnings('plugin', (pkg) => (pkg.devDependencies['@angular-builders/custom-esbuild'] = '^21.0.0'))).toContain('"^21.0.0" is for Angular 21, but the project uses Angular 22: use ^22.0.0');
  });

  it('prebuild mode does not look at custom-esbuild (it does not use it)', async () => {
    expect(await warnings('prebuild', (pkg) => (pkg.devDependencies['@angular-builders/custom-esbuild'] = '^21.0.0'))).not.toContain('custom-esbuild');
  });

  it('supported combinations and ranges that may resolve above the tested pair get no warning', async () => {
    const clean = (pkg: Record<string, any>) => {
      pkg.devDependencies.typescript = '~5.9.2';
      pkg.devDependencies.esbuild = '^0.25.0';
      pkg.devDependencies['unplugin-typegpu'] = '0.12.7';
      pkg.dependencies.typegpu = '^0.12.8'; // a range: npm resolves the 0.12.9+ that 0.12.7 needs
      pkg.devDependencies['@angular-builders/custom-esbuild'] = '^22.0.0';
    };
    expect(await warnings('plugin', clean)).toBe('');
    expect(await warnings('prebuild', clean)).toBe('');
    expect(await warnings('plugin', () => undefined)).toBe('');
    expect(await warnings('prebuild', () => undefined)).toBe('');
  });
});
