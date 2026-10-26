import { SchematicsException } from '@angular-devkit/schematics';
import type { ProjectDefinition, WorkspaceDefinition } from '@schematics/angular/utility';

/** Names of the workspace's application projects. */
export function applicationNames(workspace: WorkspaceDefinition): string[] {
  const names: string[] = [];
  for (const [name, project] of workspace.projects) {
    if (project.extensions['projectType'] === 'application') names.push(name);
  }
  return names;
}

/** The project to act on: the explicit one, or the only application. Never a guess between several. */
export function selectApplication(workspace: WorkspaceDefinition, requested: string | undefined, command: string): string {
  const applications = applicationNames(workspace);
  if (requested) {
    if (!workspace.projects.has(requested)) {
      throw new SchematicsException(
        `Project "${requested}" does not exist in angular.json. Applications: ${applications.join(', ') || '(none)'}.`,
      );
    }
    if (!applications.includes(requested)) {
      throw new SchematicsException(`Project "${requested}" is not an application. Applications: ${applications.join(', ') || '(none)'}.`);
    }
    return requested;
  }
  if (applications.length === 1) return applications[0]!;
  if (applications.length === 0) {
    throw new SchematicsException('This workspace has no application project to configure.');
  }
  throw new SchematicsException(
    `This workspace has several applications (${applications.join(', ')}). Say which one: ${command} --project <name>.`,
  );
}

/** Where `ng build` writes the browser bundle (`dist/<project>/browser` unless `outputPath` says otherwise), and the SSR server bundle when there is one. */
export function outputDirectories(project: ProjectDefinition, projectName: string): string[] {
  const buildOptions = project.targets.get('build')?.options;
  const outputPath = buildOptions?.['outputPath'] as unknown;
  let base = `dist/${projectName}`;
  let browser = 'browser';
  let server = 'server';
  if (typeof outputPath === 'string') {
    base = outputPath;
  } else if (outputPath && typeof outputPath === 'object' && !Array.isArray(outputPath)) {
    const record = outputPath as Record<string, unknown>;
    if (typeof record['base'] === 'string') base = record['base'];
    if (typeof record['browser'] === 'string') browser = record['browser'];
    if (typeof record['server'] === 'string') server = record['server'];
  }
  const dir = (leaf: string) => [base.replace(/\/$/, ''), leaf].filter(Boolean).join('/');
  const dirs = [dir(browser)];
  // SSR: the server bundle (`server/*.mjs`) is built with the same plugins and holds the same shader modules.
  if (typeof buildOptions?.['server'] === 'string' && buildOptions['server'] !== '') dirs.push(dir(server));
  return dirs;
}
