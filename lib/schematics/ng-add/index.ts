import { type Rule, SchematicsException, chain } from '@angular-devkit/schematics';
import {
  DependencyType,
  ExistingBehavior,
  InstallBehavior,
  type ProjectDefinition,
  type TargetDefinition,
  addDependency,
  readWorkspace,
  updateWorkspace,
} from '@schematics/angular/utility';
import {
  BABEL_RANGE,
  BUILDERS,
  CHECK_SCRIPT,
  CHECK_TOOL_PATH,
  CUSTOM_ESBUILD,
  PACKAGE_NAME,
  PLUGIN_PATH,
  TYPEGPU_DEFAULT,
} from '../utils/constants';
import { applicationNames, selectApplication } from '../utils/project';
import { angularMajor, assertTypegpuRange, lowestVersion, unpluginVersionFor } from '../utils/versions';
import type { NgAddOptions } from './schema';

type Options = NonNullable<TargetDefinition['options']>;
type Json = Options[string];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const hasDependency = (pkg: PackageJson, name: string) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];

const unsupported = (what: string, fix: string) =>
  new SchematicsException(`${what}\n${fix}\nNothing was changed.`);

/**
 * Turns an Angular application into a TypeGPU consumer: the shader plugin and the community esbuild builders
 * in angular.json, the build dependencies in package.json, and a `check:shaders` script for CI.
 * Idempotent; refuses (changing nothing) build setups it cannot extend safely.
 */
export function ngAdd(options: NgAddOptions): Rule {
  return async (tree, context) => {
    const workspace = await readWorkspace(tree);
    const projectName = selectApplication(workspace, options.project, `ng add ${PACKAGE_NAME}`);
    const project = workspace.projects.get(projectName)!;
    const multiple = applicationNames(workspace).length > 1;

    if (!tree.exists('package.json')) {
      throw new SchematicsException('package.json was not found in the workspace root.');
    }
    const pkg = JSON.parse(tree.readText('package.json')) as PackageJson;

    // ---- dependencies (decided first: any error here aborts before anything is written) ----
    const major = angularMajor(hasDependency(pkg, '@angular/core'));
    const existingTypegpu = hasDependency(pkg, 'typegpu');
    const typegpuVersion = existingTypegpu ? assertTypegpuRange(existingTypegpu) : lowestVersion(TYPEGPU_DEFAULT)!;
    const existingBabel = hasDependency(pkg, '@babel/core');
    if (existingBabel && lowestVersion(existingBabel)?.major !== 7) {
      throw unsupported(
        `package.json has @babel/core "${existingBabel}", but unplugin-typegpu and this package need @babel/core ${BABEL_RANGE} (Babel 8 is not supported).`,
        'Use @babel/core ^7.28.0 and run the schematic again.',
      );
    }

    const dependencies: Rule[] = [];
    const add = (name: string, version: string, type: DependencyType) =>
      dependencies.push(
        addDependency(name, version, { type, existing: ExistingBehavior.Skip, install: InstallBehavior.Auto }),
      );
    if (!existingTypegpu) add('typegpu', TYPEGPU_DEFAULT, DependencyType.Default);
    if (!hasDependency(pkg, CUSTOM_ESBUILD)) add(CUSTOM_ESBUILD, `^${major}.0.0`, DependencyType.Dev);
    if (!existingBabel) add('@babel/core', BABEL_RANGE, DependencyType.Dev);
    if (!hasDependency(pkg, 'unplugin-typegpu')) {
      add('unplugin-typegpu', unpluginVersionFor(typegpuVersion), DependencyType.Dev);
    }

    // ---- angular.json ----
    const testNote: string[] = [];
    const configureWorkspace = updateWorkspace((ws) => {
      const target = ws.projects.get(projectName)!;
      configureBuild(target, projectName);
      configureServe(target, projectName);
      configureTest(target, projectName, tree.exists(`${projectRoot(target)}tsconfig.spec.json`), major >= 21, testNote);
    });

    // ---- CI check script ----
    const addCheckScript: Rule = (host, ctx) => {
      const name = multiple ? `${CHECK_SCRIPT}:${projectName}` : CHECK_SCRIPT;
      // Re-read: addDependency rules have rewritten package.json since `pkg` was parsed.
      const text = host.readText('package.json');
      const manifest = JSON.parse(text) as PackageJson & Record<string, unknown>;
      if (manifest.scripts?.[name] !== undefined) return;
      const build = project.targets.get('build');
      const production = build?.configurations?.['production'] !== undefined;
      manifest.scripts = {
        ...manifest.scripts,
        [name]:
          `ng build${multiple ? ` ${projectName}` : ''}${production ? ' --configuration production' : ''}` +
          ` && node ${CHECK_TOOL_PATH} ${outputDirectory(project, projectName)}`,
      };
      const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
      host.overwrite('package.json', JSON.stringify(manifest, null, indent) + (text.endsWith('\n') ? '\n' : ''));
      ctx.logger.info(`Added the "${name}" script (production build + shader bundle check, for CI).`);
    };

    return chain([
      configureWorkspace,
      ...dependencies,
      addCheckScript,
      (_host, ctx) => {
        testNote.forEach((line) => ctx.logger.warn(line));
        ctx.logger.info(
          `TypeGPU is set up for "${projectName}". Next: ng generate ${PACKAGE_NAME}:component <name>`,
        );
      },
    ]);
  };
}

function projectRoot(project: ProjectDefinition): string {
  return project.root ? `${project.root.replace(/\/$/, '')}/` : '';
}

function samePlugin(entry: Json | undefined): boolean {
  const path = typeof entry === 'string' ? entry : (entry as { path?: string } | undefined)?.path;
  return typeof path === 'string' && path.replace(/^\.\//, '') === PLUGIN_PATH;
}

/** Adds the shader plugin to a `plugins` list. Lists in configurations replace the global list, so those that exist get it too. */
function ensurePlugin(options: Options | undefined, createIfMissing: boolean): Options {
  const target = options ?? {};
  const list = target['plugins'];
  if (list === undefined) {
    if (createIfMissing) target['plugins'] = [PLUGIN_PATH];
  } else if (!Array.isArray(list)) {
    throw unsupported('A "plugins" option in angular.json is not a list.', 'Make it a list of plugin paths and run the schematic again.');
  } else if (!list.some(samePlugin)) {
    target['plugins'] = [...list, PLUGIN_PATH];
  }
  return target;
}

function configureBuild(target: ProjectDefinition, projectName: string): void {
  const build = target.targets.get('build');
  if (!build) {
    throw unsupported(`Project "${projectName}" has no "build" target.`, 'ng add configures applications that have a build target.');
  }
  if (build.builder === BUILDERS.stock.build) {
    build.builder = BUILDERS.custom.build;
  } else if (build.builder !== BUILDERS.custom.build) {
    throw unsupported(
      `Project "${projectName}" builds with "${build.builder}". The TypeGPU shader pipeline needs the esbuild application builder.`,
      `Move the project to "${BUILDERS.stock.build}" first (ng update @angular/cli --name use-application-builder for webpack projects), then run the schematic again.`,
    );
  }
  build.options = ensurePlugin(build.options, true);
  for (const name of Object.keys(build.configurations ?? {})) {
    build.configurations![name] = ensurePlugin(build.configurations![name], false);
  }
}

function configureServe(target: ProjectDefinition, projectName: string): void {
  const serve = target.targets.get('serve');
  if (!serve) return;
  if (serve.builder === BUILDERS.stock.serve) {
    serve.builder = BUILDERS.custom.serve;
  } else if (serve.builder !== BUILDERS.custom.serve) {
    throw unsupported(
      `Project "${projectName}" serves with "${serve.builder}", which does not use the esbuild application build.`,
      `Use "${BUILDERS.stock.serve}" and run the schematic again.`,
    );
  }
}

function configureTest(
  target: ProjectDefinition,
  projectName: string,
  hasSpecTsconfig: boolean,
  hasUnitTestBuilder: boolean,
  notes: string[],
): void {
  const test = target.targets.get('test');
  const build = target.targets.get('build');
  if (!test) {
    notes.push(`Project "${projectName}" has no "test" target: shader specs cannot run until you add one (${BUILDERS.custom.test}).`);
    return;
  }
  const runner = test.options?.['runner'];
  const isStock = test.builder === BUILDERS.stock.test && runner !== 'karma';
  if (!isStock && test.builder !== BUILDERS.custom.test) {
    notes.push(
      `The "test" target of "${projectName}" uses "${test.builder}"${runner ? ` (runner ${String(runner)})` : ''}, which is left unchanged. ` +
        `Shader modules are not transformed in those tests. To test shaders, switch the target to "${BUILDERS.stock.test}" (Vitest) and run the schematic again.`,
    );
    return;
  }
  if (isStock && !hasUnitTestBuilder) {
    // custom-esbuild 20 (the only release for Angular 20) ships `application` and `dev-server` only.
    notes.push(
      `The "test" target of "${projectName}" uses "${test.builder}", which is left unchanged: custom-esbuild 20 has no "unit-test" builder, ` +
        `so shader modules are not transformed in these tests. Angular 21 or later is needed for that.`,
    );
    return;
  }
  if (isStock) test.builder = BUILDERS.custom.test;

  const options = test.options ?? {};
  delete options['runner']; // the custom unit-test builder only runs Vitest
  if (options['buildTarget'] === undefined) {
    const hasDevelopment = build?.configurations?.['development'] !== undefined;
    options['buildTarget'] = `${projectName}:build${hasDevelopment ? ':development' : ''}`;
  }
  if (options['tsConfig'] === undefined) {
    if (hasSpecTsconfig) options['tsConfig'] = `${projectRoot(target)}tsconfig.spec.json`;
    else notes.push(`"${projectRoot(target)}tsconfig.spec.json" does not exist; set "tsConfig" on the test target yourself.`);
  }
  if (options['reporters'] === undefined) options['reporters'] = ['default'];
  test.options = ensurePlugin(options, false);
}

/** Where `ng build` writes the browser bundle (`dist/<project>/browser` unless `outputPath` says otherwise). */
function outputDirectory(project: ProjectDefinition, projectName: string): string {
  const outputPath = project.targets.get('build')?.options?.['outputPath'];
  let base = `dist/${projectName}`;
  let browser = 'browser';
  if (typeof outputPath === 'string') {
    base = outputPath;
  } else if (outputPath && typeof outputPath === 'object' && !Array.isArray(outputPath)) {
    const record = outputPath as Record<string, Json>;
    if (typeof record['base'] === 'string') base = record['base'];
    if (typeof record['browser'] === 'string') browser = record['browser'];
  }
  return [base.replace(/\/$/, ''), browser].filter(Boolean).join('/');
}
