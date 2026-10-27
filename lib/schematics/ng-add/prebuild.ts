import { type Rule, type Tree, SchematicsException, chain } from '@angular-devkit/schematics';
import {
  DependencyType,
  ExistingBehavior,
  InstallBehavior,
  type ProjectDefinition,
  addDependency,
  readWorkspace,
  updateWorkspace,
} from '@schematics/angular/utility';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { posix } from 'node:path';
import {
  BABEL_RANGE,
  BUILDERS,
  CUSTOM_ESBUILD,
  DEVKIT_ALIASES,
  ESBUILD_RANGE,
  PACKAGE_NAME,
  REFUSAL_NOTE,
  SHADERS_OUT,
  SHADERS_PATH_KEY,
  TYPEGPU_DEFAULT,
  WRAPPERS,
} from '../utils/constants';
import { applicationNames, selectApplication } from '../utils/project';
import { angularMajor, assertTypegpuRange, lowestVersion, unpluginVersionFor } from '../utils/versions';
import type { NgAddOptions } from './schema';

/**
 * `ng add --shaders prebuild`: the project's `'use gpu'` shaders are built by the `typegpu-shaders` tool BEFORE Angular builds, and
 * this is enforced by the builders themselves: the build, serve and test targets of angular.json move to this package's wrapper
 * builders (builders.json), which build the shaders and then run the official builder. So `ng build`, `ng serve` and `ng test`
 * (from a script, an IDE or CI) can never bundle shaders older than their sources, and no npm script has to be rewritten.
 *
 * Changes: angular.json (the builder names of three targets; their options are kept), package.json (dependencies only), the
 * tsconfig that holds the compiler options (a `paths` entry), .gitignore. Idempotent. Every check runs before any file is
 * touched: an unsupported or ambiguous layout is refused with what to change.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const refuse = (what: string, fix: string) => new SchematicsException(`${what}\n${fix}\n${REFUSAL_NOTE}`);
const hasDependency = (pkg: PackageJson, name: string) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
const normalize = (path: string) => posix.normalize(path.replace(/^\.\//, '')).replace(/\/$/, '');

// ---------- JSON with comments (tsconfig) ----------

function readJsonc(tree: Tree, path: string): { text: string; json: Record<string, any> } {
  const text = tree.readText(path);
  const errors: ParseError[] = [];
  const json = parse(text, errors, { allowTrailingComma: true }) as Record<string, any> | undefined;
  if (errors.length > 0 || !json || typeof json !== 'object') {
    throw refuse(`${path} is not valid JSON (with comments).`, `Fix the file and run the schematic again.`);
  }
  return { text, json };
}

const indentOf = (text: string) => /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';

// ---------- tsconfig: where the `@shaders/*` path goes ----------

/** The file a relative `extends` names, as a tree path (TypeScript allows the `.json` extension to be left out). */
function extendsTarget(tree: Tree, from: string, spec: unknown): string {
  if (typeof spec !== 'string' || !spec.startsWith('.')) {
    throw refuse(
      `${from} has an "extends" that is not a single relative path (${JSON.stringify(spec)}).`,
      `The schematic can only follow "extends": "./other.json" chains. Add the paths entry yourself: "${SHADERS_PATH_KEY}": ["./${SHADERS_OUT}/*"], then run the schematic again.`,
    );
  }
  const base = normalize(posix.join(posix.dirname(from), spec));
  const found = [base, `${base}.json`].find((candidate) => tree.exists(candidate));
  if (!found) throw refuse(`${from} extends "${spec}", which does not exist.`, 'Fix the path and run the schematic again.');
  return found;
}

/** `file` followed by what it extends, and what that extends, ... */
function configChain(tree: Tree, file: string): string[] {
  const chain: string[] = [];
  for (let current = file; ; ) {
    if (chain.includes(current) || chain.length > 8) throw refuse(`The tsconfig "extends" chain of ${file} is circular or too deep.`, 'Fix it and run the schematic again.');
    chain.push(current);
    const { json } = readJsonc(tree, current);
    if (json['extends'] === undefined) return chain;
    current = extendsTarget(tree, current, json['extends']);
  }
}

interface TsconfigEdit {
  file: string;
  value: string;
  present: boolean;
}

/** The mapping value for a tsconfig file: the way from its folder to the project's shader output. */
function valueFor(file: string, out: string): string {
  const relative = posix.relative(posix.dirname(file), out);
  return `${relative.startsWith('.') ? relative : `./${relative}`}/*`;
}

/**
 * Where `compilerOptions.paths["@shaders/*"]` goes, so that EVERY tsconfig the application is compiled with (build, test, web worker) sees it.
 * `paths` of a file replaces (does not merge with) the `paths` it extends. Usually one edit in the config the others extend. When that
 * config is shared with another application (it would be one mapping for two shader packages), each tsconfig gets its own entry.
 */
function planTsconfig(
  tree: Tree,
  projectName: string,
  out: string,
  build: string,
  others: { label: string; path: string }[],
  otherApplications: string[][],
): TsconfigEdit[] {
  if (!tree.exists(build)) throw refuse(`The tsConfig of the build target of "${projectName}" ("${build}") does not exist.`, 'Fix the target and run the schematic again.');
  const definerOf = (chain: string[]) => chain.find((file) => readJsonc(tree, file).json['compilerOptions']?.['paths'] !== undefined);
  const mappingOf = (file: string) => readJsonc(tree, file).json['compilerOptions']?.['paths']?.[SHADERS_PATH_KEY] as unknown;
  const rejectBaseUrl = (chain: string[], mappingFile: string) => {
    for (const file of chain) {
      const baseUrl = readJsonc(tree, file).json['compilerOptions']?.['baseUrl'];
      if (baseUrl !== undefined && !(file === mappingFile && (baseUrl === '.' || baseUrl === './'))) {
        throw refuse(
          `${file} sets compilerOptions.baseUrl ("${baseUrl}"), so the path mapping would have to be written relative to it.`,
          `Remove the baseUrl (it is deprecated in TypeScript 6) or add this to compilerOptions.paths yourself: "${SHADERS_PATH_KEY}": ["<path from baseUrl to ${out}>/*"], then run the schematic again.`,
        );
      }
    }
  };
  const conflict = (file: string, existing: unknown, value: string) =>
    refuse(
      `${file} already maps "${SHADERS_PATH_KEY}" to ${JSON.stringify(existing)}, not to ["${value}"].`,
      `Change it to ["${value}"] (where the shader output of "${projectName}" goes), then run the schematic again.`,
    );

  const buildChain = configChain(tree, build);
  const reached = others.filter(({ path }) => tree.exists(path)).map((other) => ({ ...other, chain: configChain(tree, other.path) }));
  // one edit in the config the others extend, when nothing else shares it and every other tsconfig gets it from there
  const target = definerOf(buildChain) ?? buildChain[1] ?? buildChain[0]!;
  const shared = otherApplications.some((chain) => chain.includes(target));
  const allReach = reached.every(({ chain }) => chain.includes(target) && (definerOf(chain) === undefined || definerOf(chain) === target));
  if (!shared && allReach) {
    for (const chain of [buildChain, ...reached.map((o) => o.chain)]) rejectBaseUrl(chain, target);
    const value = valueFor(target, out);
    const existing = mappingOf(target);
    if (existing !== undefined && !(Array.isArray(existing) && existing.length === 1 && existing[0] === value)) throw conflict(target, existing, value);
    return [{ file: target, value, present: existing !== undefined }];
  }

  // otherwise each tsconfig of this application carries its own entry (in its own `paths`, or where its `paths` already is)
  const edits = new Map<string, TsconfigEdit>();
  for (const { label, path, chain } of [{ label: 'build', path: build, chain: buildChain }, ...reached]) {
    const holder = definerOf(chain) ?? path;
    if (otherApplications.some((c) => c.includes(holder))) {
      throw refuse(
        `The ${label} tsconfig (${path}) gets its "paths" from ${holder}, which another application uses too, so one "${SHADERS_PATH_KEY}" mapping there cannot point to the shader output of each.`,
        `Give "${projectName}" its own "paths" in ${path} (repeat the entries of ${holder} there and add "${SHADERS_PATH_KEY}": ["${valueFor(path, out).slice(0, -2)}/*"]), then run the schematic again.`,
      );
    }
    rejectBaseUrl(chain, holder);
    const value = valueFor(holder, out);
    const existing = mappingOf(holder);
    if (existing !== undefined && !(Array.isArray(existing) && existing.length === 1 && existing[0] === value)) throw conflict(holder, existing, value);
    edits.set(holder, { file: holder, value, present: existing !== undefined });
  }
  return [...edits.values()];
}

function applyTsconfig(tree: Tree, edit: TsconfigEdit): void {
  if (edit.present) return;
  const text = tree.readText(edit.file);
  const indent = indentOf(text);
  const edits = modify(text, ['compilerOptions', 'paths', SHADERS_PATH_KEY], [edit.value], {
    formattingOptions: { insertSpaces: !indent.startsWith('\t'), tabSize: indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' },
  });
  tree.overwrite(edit.file, applyEdits(text, edits));
}

// ---------- the schematic ----------

/** The tsconfig files of a project's targets: build, test (the unit-test builder defaults to `<root>/tsconfig.spec.json`), web worker. */
function tsconfigsOf(project: ProjectDefinition): { build?: string; others: { label: string; path: string }[] } {
  const build = project.targets.get('build');
  const test = project.targets.get('test');
  const others: { label: string; path: string }[] = [];
  const buildTsConfig = typeof build?.options?.['tsConfig'] === 'string' ? normalize(build.options['tsConfig']) : undefined;
  if (test) others.push({ label: 'test', path: normalize(typeof test.options?.['tsConfig'] === 'string' ? test.options['tsConfig'] : posix.join(project.root, 'tsconfig.spec.json')) });
  if (typeof build?.options?.['webWorkerTsConfig'] === 'string') others.push({ label: 'web worker', path: normalize(build.options['webWorkerTsConfig']) });
  return { build: buildTsConfig, others };
}

/** What the experimental `siblings` mode (the same wrapper builders, the `typegpu-siblings` generator) writes instead of a tsconfig path. */
const SIBLINGS_IGNORE = '*.gpu.generated.*';
const SIBLINGS_CONFIG = 'typegpu-shaders.config.json';

export function ngAddPrebuild(options: NgAddOptions): Rule {
  const siblings = options.shaders === 'siblings';
  return async (tree) => {
    const workspace = await readWorkspace(tree);
    const command = `ng add ${PACKAGE_NAME} --shaders prebuild`;
    const projectName = selectApplication(workspace, options.project, command);
    const project = workspace.projects.get(projectName)!;

    // ---- refuse what this mode was not built or tested for (before anything is written) ----
    for (const [name, target] of project.targets) {
      const text = JSON.stringify([target.options, target.configurations]);
      if (target.builder.startsWith(`${CUSTOM_ESBUILD}:`) || text.includes('typegpu-shaders.esbuild')) {
        throw refuse(
          `The "${name}" target of "${projectName}" is already set up for the plugin mode (${target.builder.startsWith(`${CUSTOM_ESBUILD}:`) ? target.builder : 'the shader plugin is in its options'}).`,
          `The two modes must not be mixed. Move the targets back to the stock builders (${BUILDERS.stock.build}, ${BUILDERS.stock.serve}, ${BUILDERS.stock.test}) and remove the plugin, then run the schematic again.`,
        );
      }
    }
    const build = project.targets.get('build');
    if (!build) throw refuse(`Project "${projectName}" has no "build" target.`, 'ng add configures applications that have a build target.');
    const buildBuilders: string[] = [BUILDERS.stock.build, DEVKIT_ALIASES.build, WRAPPERS.build];
    if (!buildBuilders.includes(build.builder)) {
      throw refuse(
        `Project "${projectName}" builds with "${build.builder}". The prebuild mode wraps the stock esbuild application builder ("${BUILDERS.stock.build}") and was tested with it only.`,
        `Switch the build target to it (ng update @angular/cli --name use-application-builder for a webpack project) and run the schematic again.`,
      );
    }
    const serve = project.targets.get('serve');
    const serveBuilders: string[] = [BUILDERS.stock.serve, DEVKIT_ALIASES.serve, WRAPPERS.serve];
    if (serve && !serveBuilders.includes(serve.builder)) {
      throw refuse(
        `Project "${projectName}" serves with "${serve.builder}", which is not the stock dev server.`,
        `Use "${BUILDERS.stock.serve}" (or "${DEVKIT_ALIASES.serve}") and run the schematic again.`,
      );
    }
    const { build: buildTsConfig, others } = tsconfigsOf(project);
    if (!buildTsConfig) throw refuse(`The build target of "${projectName}" has no "tsConfig" option.`, 'Set it and run the schematic again.');

    if (!tree.exists('package.json')) throw new SchematicsException('package.json was not found in the workspace root.');
    const packageText = tree.readText('package.json');
    const pkg = JSON.parse(packageText) as PackageJson;
    const major = angularMajor(hasDependency(pkg, '@angular/core'));
    if (!hasDependency(pkg, 'typescript')) {
      throw refuse('package.json has no "typescript" dependency; the tool builds the shaders\' type declarations with the project\'s TypeScript.', 'Install it (npm i -D typescript) and run the schematic again.');
    }
    const existingTypegpu = hasDependency(pkg, 'typegpu');
    const typegpuVersion = existingTypegpu ? assertTypegpuRange(existingTypegpu) : lowestVersion(TYPEGPU_DEFAULT)!;
    const existingBabel = hasDependency(pkg, '@babel/core');
    if (existingBabel && lowestVersion(existingBabel)?.major !== 7) {
      throw refuse(`package.json has @babel/core "${existingBabel}", but unplugin-typegpu needs @babel/core ${BABEL_RANGE} (Babel 8 is not supported).`, 'Use @babel/core ^7.28.0 and run the schematic again.');
    }

    // the shader output of a project is `<project root>/shaders-dist` (the workspace root for an application at the root)
    const out = normalize(posix.join(project.root, SHADERS_OUT));
    const otherApplications = applicationNames(workspace)
      .filter((name) => name !== projectName)
      .flatMap((name) => {
        const { build: otherBuild, others: otherOthers } = tsconfigsOf(workspace.projects.get(name)!);
        return [otherBuild, ...otherOthers.map((o) => o.path)].filter((p): p is string => !!p && tree.exists(p)).map((p) => configChain(tree, p));
      });
    const tsconfigEdits = siblings ? [] : planTsconfig(tree, projectName, out, buildTsConfig, others, otherApplications);

    const notes: string[] = [];
    const test = project.targets.get('test');
    let testBuilder: string | undefined;
    if (test) {
      const runner = test.options?.['runner'];
      if (test.builder === BUILDERS.stock.test || test.builder === WRAPPERS.unitTest) testBuilder = WRAPPERS.unitTest;
      else if (test.builder === '@angular/build:karma' || test.builder === WRAPPERS.karma) testBuilder = WRAPPERS.karma;
      else {
        notes.push(
          `The "test" target of "${projectName}" uses "${test.builder}"${runner ? ` (runner ${String(runner)})` : ''}, which is left unchanged: ` +
            `it does not build the shaders first, so tests run against the shader output that is on disk. Use "${BUILDERS.stock.test}" or "@angular/build:karma" and run the schematic again.`,
        );
      }
    }

    // ---- apply ----
    const configureWorkspace = updateWorkspace((ws) => {
      const target = ws.projects.get(projectName)!;
      target.targets.get('build')!.builder = WRAPPERS.build;
      const serveTarget = target.targets.get('serve');
      if (serveTarget) serveTarget.builder = WRAPPERS.serve;
      const testTarget = target.targets.get('test');
      if (testTarget && testBuilder) testTarget.builder = testBuilder;
    });

    const dependencies: Rule[] = [];
    const add = (name: string, version: string, type: DependencyType) =>
      dependencies.push(addDependency(name, version, { type, existing: ExistingBehavior.Skip, install: InstallBehavior.Auto }));
    if (!existingTypegpu) add('typegpu', TYPEGPU_DEFAULT, DependencyType.Default);
    if (!existingBabel) add('@babel/core', BABEL_RANGE, DependencyType.Dev);
    if (!hasDependency(pkg, 'unplugin-typegpu')) add('unplugin-typegpu', unpluginVersionFor(typegpuVersion), DependencyType.Dev);
    if (!hasDependency(pkg, 'esbuild')) add('esbuild', ESBUILD_RANGE, DependencyType.Dev);

    // the dependency rules rewrite package.json and may drop its final newline: keep the one the file had
    const keepNewline: Rule = (host) => {
      const text = host.readText('package.json');
      if (packageText.endsWith('\n') && !text.endsWith('\n')) host.overwrite('package.json', `${text}\n`);
    };

    const files: Rule = (host) => {
      for (const edit of tsconfigEdits) applyTsconfig(host, edit);
      const configPath = posix.join(project.root, SIBLINGS_CONFIG);
      if (siblings && !host.exists(configPath)) host.create(configPath, `${JSON.stringify({ mode: 'siblings' }, null, 2)}\n`);
      const ignored = siblings ? SIBLINGS_IGNORE : `${SHADERS_OUT}/`;
      if (host.exists('.gitignore')) {
        const text = host.readText('.gitignore');
        if (!text.split(/\r?\n/).some((line) => line.trim().replace(/^\//, '').replace(/\/$/, '') === ignored.replace(/\/$/, ''))) {
          host.overwrite('.gitignore', `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}\n# TypeGPU shader ${siblings ? 'siblings' : 'prebuild output'}\n${ignored}\n`);
        }
      } else {
        notes.push(`There is no .gitignore: add "${ignored}" to the ignore list of your version control.`);
      }
    };

    return chain([
      configureWorkspace,
      ...dependencies,
      keepNewline,
      files,
      (_host, ctx) => {
        notes.forEach((line) => ctx.logger.warn(line));
        ctx.logger.info(
          `TypeGPU shader prebuild is set up for "${projectName}": ng build, ng serve and ng test now build the shaders first (builders ${WRAPPERS.build}, ${WRAPPERS.serve}, ${testBuilder ?? 'the test builder was left as it is'}). ` +
            (siblings
              ? `Shaders are the "*.gpu.ts" files under the project's source root; each gets "<name>.gpu.generated.js" and "<name>.gpu.generated.d.ts" next to it, and application code imports "./<name>.gpu.generated" (not "./<name>.gpu": the build refuses that). `
              : `Shaders are the "*.gpu.ts" files under the project's source root, imported from application code as "@shaders/<path under the source root>" (not by a relative path: the build refuses those; "typegpu-shaders check --fix-imports" rewrites existing imports). `) +
            `Until the first shader exists the builds run as before.`,
        );
      },
    ]);
  };
}
