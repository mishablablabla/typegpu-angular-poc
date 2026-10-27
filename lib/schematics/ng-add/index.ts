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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BABEL_RANGE,
  BUILDERS,
  CHECK_SCRIPT,
  CUSTOM_ESBUILD,
  CUSTOM_UNIT_TEST_OPTIONS,
  DEVKIT_ALIASES,
  PACKAGE_NAME,
  REFUSAL_NOTE,
  SHADERS_BIN,
  SHADERS_OUT,
  TYPEGPU_DEFAULT,
  WRAPPERS,
} from '../utils/constants';
import { applicationNames, outputDirectories, selectApplication } from '../utils/project';
import { keepFormatting, setJson } from '../utils/text-files';
import { type ToolPaths, findWorkspaceRoot, resolveToolPaths } from '../utils/tool-paths';
import { angularMajor, assertTypegpuRange, lowestVersion, unpluginVersionFor } from '../utils/versions';
import { ngAddPrebuild } from './prebuild';
import type { NgAddOptions } from './schema';

type Options = NonNullable<TargetDefinition['options']>;
type Json = Options[string];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const hasDependency = (pkg: PackageJson, name: string) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];

const unsupported = (what: string, fix: string) => new SchematicsException(`${what}\n${fix}\n${REFUSAL_NOTE}`);

/**
 * Turns an Angular application into a TypeGPU consumer: the shader plugin and the community esbuild builders
 * in angular.json, the build dependencies in package.json, and a `check:shaders` script for CI.
 * Idempotent; refuses (modifying no project file) build setups it cannot extend safely.
 */
export function ngAdd(options: NgAddOptions): Rule {
  if (options.shaders === 'prebuild') {
    return keepFormatting(
      chain([
        ngAddPrebuild(options),
        (_host, ctx) => {
          ctx.logger.info(
            `"${SHADERS_OUT}/" is generated and not committed: after a fresh clone (or before the first ng build / ng serve / ng test) editors and tsc report TS2307 for "@shaders/..." imports until the shaders are built once (npx ${SHADERS_BIN} build, or any ng build).`,
          );
        },
      ]),
    );
  }
  return keepFormatting(ngAddPlugin(options));
}

function ngAddPlugin(options: NgAddOptions): Rule {
  return async (tree, context) => {
    const workspace = await readWorkspace(tree);
    const projectName = selectApplication(workspace, options.project, `ng add ${PACKAGE_NAME}`);
    const project = workspace.projects.get(projectName)!;
    const multiple = applicationNames(workspace).length > 1;
    // Real location of the plugin and the check tool relative to the workspace (hoisted node_modules, pnpm links, ...).
    const workspaceRoot = findWorkspaceRoot(process.cwd(), tree.exists('angular.json') ? tree.readText('angular.json') : undefined);
    const tools = resolveToolPaths(workspaceRoot, project.root);

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
    const infoNote: string[] = [];
    const configureWorkspace = updateWorkspace((ws) => {
      const target = ws.projects.get(projectName)!;
      configureBuild(target, projectName, tools, testNote, installedSchema(workspaceRoot, project.root, 'application'), major);
      configureServe(target, projectName);
      configureTest(target, projectName, tree.exists(`${projectRoot(target)}tsconfig.spec.json`), major, testNote, installedUnitTestOptions(workspaceRoot, project.root), tools, infoNote);
    });

    // ---- CI check script ----
    let checkScript: string | undefined; // the name of our script in package.json after this run (for the final message)
    const addCheckScript: Rule = (host, ctx) => {
      const name = multiple ? `${CHECK_SCRIPT}:${projectName}` : CHECK_SCRIPT;
      // Re-read: addDependency rules have rewritten package.json since `pkg` was parsed.
      const text = host.readText('package.json');
      const manifest = JSON.parse(text) as PackageJson & Record<string, unknown>;
      if (manifest.scripts?.[name] !== undefined) {
        // keep the user's script, but fix a path to the check tool that no longer exists (dependencies moved)
        const existing = manifest.scripts[name]!;
        const repaired = tools.repairCheckScript(existing);
        if (repaired !== existing) {
          host.overwrite('package.json', setJson(text, ['scripts', name], repaired));
          ctx.logger.info(`Fixed the path of the check tool in the "${name}" script (file not found): ${tools.check}`);
        }
        if (repaired.includes('check-shader-bundle')) checkScript = name;
        return;
      }
      const build = project.targets.get('build');
      const production = build?.configurations?.['production'] !== undefined;
      // The script is run by npm through the shell of the user's platform: only values that are plain words are put in it unquoted (a space
      // would split it, `;` `&` `$(...)` in a value of a hostile angular.json would be run). Anything else: the user writes the script.
      const directories = outputDirectories(project, projectName, production ? 'production' : undefined);
      const words = [projectName, tools.check, ...directories];
      const unsafe = words.filter((word) => !/^[\w@.\/-]+$/.test(word));
      if (unsafe.length > 0) {
        ctx.logger.warn(`The "${name}" script was not added: ${unsafe.map((word) => JSON.stringify(word)).join(', ')} cannot be put in an npm script without quoting. Add it yourself: build the project, then run node ${JSON.stringify(tools.check)} on its output folders.`);
        return;
      }
      const script =
        `ng build${multiple ? ` ${projectName}` : ''}${production ? ' --configuration production' : ''}` +
        ` && node ${tools.check} ${directories.join(' ')}`;
      host.overwrite('package.json', setJson(text, ['scripts', name], script));
      checkScript = name;
      ctx.logger.info(`Added the "${name}" script (production build + shader bundle check, for CI).`);
    };

    return chain([
      configureWorkspace,
      ...dependencies,
      addCheckScript,
      (_host, ctx) => {
        testNote.forEach((line) => ctx.logger.warn(line));
        infoNote.push(...budgetNote(project));
        infoNote.forEach((line) => ctx.logger.info(line));
        ctx.logger.info(
          `TypeGPU is set up for "${projectName}". Next: ng generate ${PACKAGE_NAME}:component <name>` +
            (checkScript
              ? ` (until the build contains a shader, "npm run ${checkScript}" fails by design: nothing to check; pass --allow-empty to the check tool to accept that).`
              : '.'),
        );
      },
    ]);
  };
}

function projectRoot(project: ProjectDefinition): string {
  return project.root ? `${project.root.replace(/\/$/, '')}/` : '';
}

/**
 * Adds the shader plugin to a `plugins` list. Lists in configurations replace the global list, so those that exist get it too.
 * An entry that already points at the plugin file (whatever relative path it is written with, e.g. one corrected by hand
 * for a hoisted node_modules) counts as present. An entry that has the shape `ng add` writes but points at a file that
 * no longer exists (the dependencies moved) is replaced by the real path, not left next to it.
 */
function ensurePlugin(options: Options | undefined, createIfMissing: boolean, tools: ToolPaths, notes: string[]): Options {
  const target = options ?? {};
  const list = target['plugins'];
  if (list === undefined) {
    if (createIfMissing) target['plugins'] = [tools.plugin];
  } else if (!Array.isArray(list)) {
    throw unsupported('A "plugins" option in angular.json is not a list.', 'Make it a list of plugin paths and run the schematic again.');
  } else {
    const present = list.some((entry) => tools.isPlugin(entry));
    let placed = present;
    const repaired: string[] = [];
    const next: NonNullable<Json>[] = [];
    for (const entry of list) {
      if (tools.isStalePlugin(entry)) {
        repaired.push(typeof entry === 'string' ? entry : String((entry as { path?: string }).path));
        if (placed) continue; // the real path is there already: drop the stale duplicate
        placed = true;
        next.push(typeof entry === 'string' ? tools.plugin : { ...(entry as object), path: tools.plugin });
      } else {
        next.push(entry as NonNullable<Json>);
      }
    }
    if (!placed) next.push(tools.plugin);
    if (repaired.length > 0) {
      notes.push(`Replaced the plugin path ${repaired.map((p) => `"${p}"`).join(', ')} (file not found) with "${tools.plugin}".`);
    }
    if (!present || repaired.length > 0) target['plugins'] = next;
  }
  return target;
}

/** What to tell a project that is not on the esbuild application builder, by what it uses now. */
function buildFix(builder: string): string {
  switch (builder) {
    case '@angular-devkit/build-angular:browser':
      return `Move the project to "${BUILDERS.stock.build}" first (ng update @angular/cli --name use-application-builder), then run the schematic again.`;
    case '@angular-devkit/build-angular:browser-esbuild':
      return `Switch the target to "${BUILDERS.stock.build}" (the successor of this builder) and run the schematic again.`;
    default:
      return `ng add only extends the stock esbuild application builder ("${BUILDERS.stock.build}", or "${DEVKIT_ALIASES.build}"). Switch the target to it, or set up the shader plugin for your own builder by hand.`;
  }
}

function configureBuild(
  target: ProjectDefinition,
  projectName: string,
  tools: ToolPaths,
  notes: string[],
  installed: SchemaJson | undefined,
  major: number,
): void {
  const build = target.targets.get('build');
  if (!build) {
    throw unsupported(`Project "${projectName}" has no "build" target.`, 'ng add configures applications that have a build target.');
  }
  if (build.builder === BUILDERS.stock.build || build.builder === DEVKIT_ALIASES.build) {
    build.builder = BUILDERS.custom.build;
  } else if (build.builder === WRAPPERS.build) {
    throw unsupported(
      `Project "${projectName}" is already set up for the shader prebuild (its build target is "${WRAPPERS.build}"). The plugin mode and the prebuild do not mix.`,
      `To keep the prebuild, there is nothing to do. To switch the project to the plugin mode, first restore the stock builders in angular.json ("${BUILDERS.stock.build}", "${BUILDERS.stock.serve}", "${BUILDERS.stock.test}" or "@angular/build:karma"; and remove the "@shaders/*" path from tsconfig), then run ng add ${PACKAGE_NAME} again.`,
    );
  } else if (build.builder !== BUILDERS.custom.build) {
    throw unsupported(
      `Project "${projectName}" builds with "${build.builder}". The TypeGPU shader pipeline needs the esbuild application builder.`,
      buildFix(build.builder),
    );
  }
  build.options = ensurePlugin(build.options, true, tools, notes);
  for (const name of Object.keys(build.configurations ?? {})) {
    build.configurations![name] = ensurePlugin(build.configurations![name], false, tools, notes);
  }
  if (!allowedHostsSupported(installed, major)) dropAllowedHosts(build, projectName, notes);
}

type SchemaJson = { properties?: Record<string, { properties?: Record<string, unknown> } | undefined> };

/**
 * Whether the custom-esbuild `application` schema knows `security.allowedHosts`, which Angular 20.3's `ng new --ssr` writes.
 * Read from the installed package when there is one; otherwise from the Angular major: custom-esbuild 20 (20.0.0 is the only
 * release for Angular 20) ships the schema of Angular 20.0, where `security` has `autoCsp` only; 21 and later know `allowedHosts`.
 */
function allowedHostsSupported(installed: SchemaJson | undefined, major: number): boolean {
  if (installed) return installed.properties?.['security']?.properties?.['allowedHosts'] !== undefined;
  return major >= 21;
}

/**
 * The custom builder validates the build options against a schema without `security.allowedHosts`, and `ng build`,
 * `ng serve` and `ng extract-i18n` fail on it ("Schema validation failed ... /security must NOT have additional properties").
 * An EMPTY list is the default (nothing but localhost allowed), so it is removed, and said so. A list with hosts in it is a
 * security setting that must not be dropped silently, and keeping it means a build that cannot run: that is refused.
 */
function dropAllowedHosts(build: TargetDefinition, projectName: string, notes: string[]): void {
  const places: [string, Options][] = [['the build options', build.options ?? {}]];
  for (const [name, configuration] of Object.entries(build.configurations ?? {})) {
    if (configuration) places.push([`the "${name}" configuration`, configuration]);
  }
  const removedFrom: string[] = [];
  for (const [label, options] of places) {
    const security = options['security'];
    if (!security || typeof security !== 'object' || Array.isArray(security) || !('allowedHosts' in security)) continue;
    const hosts = (security as Record<string, Json>)['allowedHosts'];
    if (!Array.isArray(hosts) || hosts.length > 0) {
      throw unsupported(
        `${label[0]!.toUpperCase()}${label.slice(1)} of "${projectName}" set security.allowedHosts (${JSON.stringify(hosts)}). @angular-builders/custom-esbuild 20.x (the only release for Angular 20) validates the build options against an older schema that does not know it: ng build, ng serve and ng extract-i18n would fail with "Schema validation failed ... /security must NOT have additional properties", and removing the list would drop your host allow-list.`,
        `Use the prebuild mode instead (ng add ${PACKAGE_NAME} --shaders prebuild: it keeps the stock builders), or move the hosts to the NG_ALLOWED_HOSTS environment variable of the SSR server (comma-separated; it takes precedence over angular.json) and remove security.allowedHosts from angular.json, then run the schematic again.`,
      );
    }
    delete (security as Record<string, Json>)['allowedHosts'];
    if (Object.keys(security).length === 0) delete options['security'];
    removedFrom.push(label);
  }
  if (removedFrom.length > 0) {
    notes.push(
      `Removed security.allowedHosts (an empty list, which is also the default) from ${removedFrom.join(' and ')} of "${projectName}": @angular-builders/custom-esbuild 20.x validates the build options against an older schema that does not know it, and \`ng build\` would fail with "Schema validation failed ... /security must NOT have additional properties". ` +
        'To let an SSR server answer on a real host name, set the NG_ALLOWED_HOSTS environment variable (comma-separated) or pass allowedHosts to AngularNodeAppEngine in server.ts.',
    );
  }
}

/** Fresh SSR apps are over the default initial budget (a warning) once a TypeGPU component is in them. ng add never edits budgets. */
function budgetNote(project: ProjectDefinition): string[] {
  const build = project.targets.get('build');
  const ssr = typeof build?.options?.['server'] === 'string' || build?.options?.['ssr'] !== undefined;
  const budgets = build?.configurations?.['production']?.['budgets'];
  if (!ssr || !Array.isArray(budgets)) return [];
  const initial = budgets.find((budget) => (budget as { type?: string } | null)?.type === 'initial') as { maximumWarning?: string } | undefined;
  if (!initial || !/^500 ?kb$/i.test(String(initial.maximumWarning))) return [];
  return [
    'A production build of a fresh SSR application with a TypeGPU component measured about 524 kB of initial bundle, over the default budget of 500 kB that `ng new` writes (a warning; the error limit is 1 MB). ng add does not change your budgets: raise "maximumWarning" of the "initial" budget in angular.json if the warning is unwelcome.',
  ];
}

function configureServe(target: ProjectDefinition, projectName: string): void {
  const serve = target.targets.get('serve');
  if (!serve) return;
  // `@angular-devkit/build-angular:dev-server` serves an esbuild application build with the same Vite dev server; here it
  // is only reached for such a build target (a webpack `browser` target was refused above).
  if (serve.builder === BUILDERS.stock.serve || serve.builder === DEVKIT_ALIASES.serve) {
    serve.builder = BUILDERS.custom.serve;
  } else if (serve.builder !== BUILDERS.custom.serve) {
    throw unsupported(
      `Project "${projectName}" serves with "${serve.builder}", which does not use the esbuild application build.`,
      `Use "${BUILDERS.stock.serve}" (or "${DEVKIT_ALIASES.serve}") and run the schematic again.`,
    );
  }
}

/**
 * The options the custom unit-test builder accepts: read from its installed schema when it is already installed
 * (nearest `node_modules` above the project), otherwise the table for the Angular major.
 */
function allowedUnitTestOptions(major: number, installed: readonly string[] | undefined): ReadonlySet<string> {
  if (installed) return new Set(installed);
  const majors = Object.keys(CUSTOM_UNIT_TEST_OPTIONS).map(Number);
  const known = majors.includes(major) ? major : Math.max(...majors);
  return new Set(CUSTOM_UNIT_TEST_OPTIONS[known]);
}

/** The parsed schema of an installed custom-esbuild builder (`application`, `unit-test`), or undefined when it is not installed (yet) or unreadable. */
function installedSchema(workspaceRoot: string | undefined, projectRoot: string, builder: 'application' | 'unit-test'): SchemaJson | undefined {
  if (workspaceRoot === undefined) return undefined;
  for (let dir = resolve(workspaceRoot, projectRoot); ; dir = dirname(dir)) {
    const schema = join(dir, 'node_modules', CUSTOM_ESBUILD, 'dist', builder, 'schema.json');
    if (existsSync(schema)) {
      try {
        return JSON.parse(readFileSync(schema, 'utf8')) as SchemaJson;
      } catch {
        return undefined; // unreadable: fall back to the table
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** The option names of an installed custom-esbuild unit-test schema, or undefined when it is not installed (yet). */
function installedUnitTestOptions(workspaceRoot: string | undefined, projectRoot: string): readonly string[] | undefined {
  const properties = installedSchema(workspaceRoot, projectRoot, 'unit-test')?.properties;
  return properties ? Object.keys(properties) : undefined;
}

/** Removes the options the custom builder's schema does not know; returns the names removed. */
function dropUnsupported(options: Options | undefined, allowed: ReadonlySet<string>): string[] {
  const dropped: string[] = [];
  for (const key of Object.keys(options ?? {})) {
    if (!allowed.has(key)) {
      delete options![key];
      dropped.push(key);
    }
  }
  return dropped;
}

function configureTest(
  target: ProjectDefinition,
  projectName: string,
  hasSpecTsconfig: boolean,
  major: number,
  notes: string[],
  installedOptions: readonly string[] | undefined,
  tools: ToolPaths,
  info: string[],
): void {
  const hasUnitTestBuilder = major >= 21;
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
  info.push(
    `\`ng test\` prints "The 'buildTarget' is configured to use '${BUILDERS.custom.build}', which is not supported" on every run: the stock unit-test builder warns about any build target that is not its own. It is harmless here: the shader plugin is applied and Vitest runs the shader modules.`,
  );
  if (isStock) {
    test.builder = BUILDERS.custom.test;
    // The custom schema has `additionalProperties: false`: an option only the stock builder knows (`runner`,
    // `splitting`, ...) would make `ng test` fail validation. Drop them, in the target and in each configuration, and say so.
    const allowed = allowedUnitTestOptions(major, installedOptions);
    const dropped = new Set(dropUnsupported(test.options, allowed));
    for (const configuration of Object.values(test.configurations ?? {})) {
      dropUnsupported(configuration, allowed).forEach((key) => dropped.add(key));
    }
    if (dropped.size > 0) {
      notes.push(
        `Removed from the "test" target of "${projectName}" (also from its configurations): ${[...dropped].join(', ')}. ` +
          `The "${BUILDERS.custom.test}" builder does not support them` +
          (dropped.has('runner') ? ' (it runs Vitest only; "runner": "vitest" was the default there too)' : '') +
          '. Re-add them yourself only if you move the target back to the stock builder.',
      );
    }
  }

  const options = test.options ?? {};
  if (options['buildTarget'] === undefined) {
    const hasDevelopment = build?.configurations?.['development'] !== undefined;
    options['buildTarget'] = `${projectName}:build${hasDevelopment ? ':development' : ''}`;
  }
  if (options['tsConfig'] === undefined) {
    if (hasSpecTsconfig) options['tsConfig'] = `${projectRoot(target)}tsconfig.spec.json`;
    else notes.push(`"${projectRoot(target)}tsconfig.spec.json" does not exist; set "tsConfig" on the test target yourself.`);
  }
  if (options['reporters'] === undefined) options['reporters'] = ['default'];
  test.options = ensurePlugin(options, false, tools, notes);
}
