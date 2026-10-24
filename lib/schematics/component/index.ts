import {
  type Rule,
  SchematicsException,
  apply,
  applyTemplates,
  filter,
  mergeWith,
  move,
  noop,
  strings,
  url,
} from '@angular-devkit/schematics';
import { readWorkspace } from '@schematics/angular/utility';
import { parseName } from '@schematics/angular/utility/parse-name';
import { validateClassName, validateHtmlSelector } from '@schematics/angular/utility/validation';
import { buildDefaultPath } from '@schematics/angular/utility/workspace';
import { BUILDERS, PACKAGE_NAME, PLUGIN_PATH } from '../utils/constants';
import { selectApplication } from '../utils/project';
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
    assertConfigured(project.targets.get('build'), projectName);

    const parsed = parseName(options.path ?? buildDefaultPath(project), options.name);
    const name = parsed.name;
    const classifiedName = strings.classify(name);
    const selector = `${project.prefix ? `${project.prefix}-` : ''}${strings.dasherize(name)}`;
    validateHtmlSelector(selector);
    validateClassName(classifiedName);
    validateClassName(`${classifiedName}Scene`);

    return mergeWith(
      apply(url('./files'), [
        options.skipTests ? filter((path) => !path.endsWith('.spec.ts.template')) : noop(),
        applyTemplates({ ...strings, name, classifiedName, selector, packageName: PACKAGE_NAME }),
        move(parsed.path),
      ]),
    );
  };
}

/** A `*.gpu.ts` module only works when the build plugin is configured; say so now instead of failing in the browser. */
function assertConfigured(
  build: { builder: string; options?: Record<string, unknown> } | undefined,
  projectName: string,
): void {
  const plugins = build?.options?.['plugins'];
  const configured =
    build?.builder === BUILDERS.custom.build &&
    Array.isArray(plugins) &&
    plugins.some((entry) => (typeof entry === 'string' ? entry : (entry as { path?: string })?.path)?.replace(/^\.\//, '') === PLUGIN_PATH);
  if (!configured) {
    throw new SchematicsException(
      `Project "${projectName}" is not set up for TypeGPU shaders yet (the shader build plugin is missing from its build target). ` +
        `Run: ng add ${PACKAGE_NAME} --project ${projectName}`,
    );
  }
}
