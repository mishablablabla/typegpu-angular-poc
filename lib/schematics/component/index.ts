import {
  type Rule,
  SchematicsException,
  type Tree,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  noop,
  strings,
  url,
} from '@angular-devkit/schematics';
import { type ProjectDefinition, readWorkspace } from '@schematics/angular/utility';
import { parseName } from '@schematics/angular/utility/parse-name';
import { validateClassName, validateHtmlSelector } from '@schematics/angular/utility/validation';
import { buildDefaultPath } from '@schematics/angular/utility/workspace';
import { posix } from 'node:path';
import { BUILDERS, PACKAGE_NAME, WRAPPERS } from '../utils/constants';
import { selectApplication } from '../utils/project';
import { type ToolPaths, findWorkspaceRoot, resolveToolPaths } from '../utils/tool-paths';
import type { ComponentOptions } from './schema';

/**
 * Creates `<name>/<name>.ts` (a standalone component with an animated TypeGPU canvas, fallback UI for
 * "no WebGPU" / "init failed" / "device lost"), `<name>.gpu.ts` (its shader) and an optional spec.
 * Conventions follow `ng generate component`: folder per component under `src/app` (or `--path`).
 */
export function component(options: ComponentOptions): Rule {
  return async (tree) => {
    const workspace = await readWorkspace(tree);
    const command = `ng generate ${PACKAGE_NAME}:component ${options.name}`;
    const projectName = selectApplication(workspace, options.project, command);
    const project = workspace.projects.get(projectName)!;
    const workspaceRoot = findWorkspaceRoot(process.cwd(), tree.exists('angular.json') ? tree.readText('angular.json') : undefined);
    const prebuild = project.targets.get('build')?.builder === WRAPPERS.build;
    if (!prebuild) assertConfigured(project.targets.get('build'), projectName, resolveToolPaths(workspaceRoot, project.root));

    const parsed = parseName(options.path ?? buildDefaultPath(project), options.name);
    const name = parsed.name;
    const dashed = strings.dasherize(name);
    // The name becomes a file name, a class name and an element selector: anything else (`foo.bar`, `foo@bar`) would
    // produce a selector Angular rejects (NG8001) only when the component is used.
    if (!SELECTOR_SAFE.test(dashed)) {
      throw new SchematicsException(
        `"${name}" cannot be used as a component name: it becomes the element selector "${project.prefix ? `${project.prefix}-` : ''}${dashed}". ` +
          `Use letters, digits and dashes, starting with a letter (my-canvas, MyCanvas, myCanvas).`,
      );
    }
    const classifiedName = strings.classify(name);
    const selector = `${project.prefix ? `${project.prefix}-` : ''}${dashed}`;
    validateHtmlSelector(selector);
    validateClassName(classifiedName);
    validateClassName(`${classifiedName}Scene`);
    assertNoSceneClash(tree, parsed.path, dashed);
    // Plugin mode imports the shader module next to the component. Prebuild mode (the project's builders build the shaders first)
    // imports the generated copy through `@shaders/...`: a relative import of a shader module would bundle its untransformed source.
    let shaderImport = `./${dashed}.gpu`;
    if (prebuild) {
      const sourceRoot = posix.normalize((project.sourceRoot ?? posix.join(project.root, 'src')).replace(/^\.?\//, ''));
      const inside = posix.relative(sourceRoot, posix.join(parsed.path.replace(/^\//, ''), dashed, `${dashed}.gpu`));
      if (inside.startsWith('..')) {
        throw new SchematicsException(
          `"${parsed.path}" is outside the source root of "${projectName}" (${sourceRoot}), where the shader modules are looked for. Generate the component under ${sourceRoot}/ (--path).`,
        );
      }
      shaderImport = `@shaders/${inside}`;
    }

    const zoneless = !usesZoneJs(project);

    return chain([
      mergeWith(
        apply(url('./files'), [
          options.skipTests ? filter((path) => !path.endsWith('.spec.ts.template')) : noop(),
          applyTemplates({ ...strings, name, classifiedName, selector, shaderImport, zoneless, packageName: PACKAGE_NAME }),
          move(parsed.path),
        ]),
      ),
      (_tree, context) => {
        context.logger.info(
          `Next: add ${classifiedName} to the "imports" of the component (or route) that should show it, and use <${selector}></${selector}> in that template.`,
        );
      },
    ]);
  };
}

/**
 * Does the project load zone.js (a `zone.js` entry in the polyfills of the build target, one of its configurations, or the test target)?
 * Angular 20's TestBed fails a project without it with NG0908 unless the spec provides `provideZonelessChangeDetection()`, so the generated
 * spec provides it exactly when zone.js is not there. Not finding zone.js is the safe default: a zoneless spec also runs in a zone.js project.
 */
function usesZoneJs(project: ProjectDefinition): boolean {
  const lists: unknown[] = [];
  for (const name of ['build', 'test']) {
    const target = project.targets.get(name);
    lists.push(target?.options?.['polyfills']);
    for (const configuration of Object.values(target?.configurations ?? {})) lists.push(configuration?.['polyfills']);
  }
  return lists.some((polyfills) => (Array.isArray(polyfills) ? polyfills : [polyfills]).some((entry) => typeof entry === 'string' && /^zone\.js(\/|$)/.test(entry)));
}

const SELECTOR_SAFE = /^[a-z][a-z0-9-]*$/;

/**
 * Each component also declares an internal `<Name>Scene` (selector `<name>-scene`). A sibling component folder named
 * `<name>-scene` (or, when generating `<x>-scene`, a sibling `<x>`) would declare the same class name and selector.
 */
function assertNoSceneClash(tree: Tree, parent: string, dashed: string): void {
  const exists = (folder: string) => tree.getDir(`${parent}/${folder}`).subfiles.length > 0;
  const base = dashed.endsWith('-scene') ? dashed.slice(0, -'-scene'.length) : undefined;
  if (exists(`${dashed}-scene`)) {
    throw new SchematicsException(
      `"${dashed}" would clash with the existing component folder "${dashed}-scene": both declare the class ${strings.classify(dashed)}Scene and the selector ${dashed}-scene. Pick another name.`,
    );
  }
  if (base && exists(base)) {
    throw new SchematicsException(
      `"${dashed}" would clash with the existing component "${base}": its internal scene is also called ${strings.classify(dashed)} (selector ${dashed}). Pick another name.`,
    );
  }
}

/** A `*.gpu.ts` module only works when the build plugin is configured; say so now instead of failing in the browser. */
function assertConfigured(
  build: { builder: string; options?: Record<string, unknown> } | undefined,
  projectName: string,
  tools: ToolPaths,
): void {
  const plugins = build?.options?.['plugins'];
  const configured = build?.builder === BUILDERS.custom.build && Array.isArray(plugins) && plugins.some((entry) => tools.isPlugin(entry));
  if (!configured) {
    throw new SchematicsException(
      `Project "${projectName}" is not set up for TypeGPU shaders yet (the shader build plugin is missing from its build target). ` +
        `Run: ng add ${PACKAGE_NAME} --project ${projectName}` +
        ` (or, to build the shaders in the project's own builders instead of through a plugin: ng add ${PACKAGE_NAME} --shaders prebuild --project ${projectName})`,
    );
  }
}
