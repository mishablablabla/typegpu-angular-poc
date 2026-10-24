import { SchematicsException } from '@angular-devkit/schematics';
import type { WorkspaceDefinition } from '@schematics/angular/utility';

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
