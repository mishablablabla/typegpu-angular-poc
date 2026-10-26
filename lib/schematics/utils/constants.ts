import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package name is read from the package itself, so a rename does not need to touch the schematics.
// From `<package>/schematics/utils/` the manifest is two levels up (also in `dist/` during development).
const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { name: string };

export const PACKAGE_NAME = manifest.name;
export const PLUGIN_PATH = `node_modules/${PACKAGE_NAME}/tools/typegpu-shaders.esbuild.mjs`;
export const CHECK_TOOL_PATH = `node_modules/${PACKAGE_NAME}/tools/check-shader-bundle.mjs`;
export const CHECK_SCRIPT = 'check:shaders';

/**
 * Appended to every refusal. `ng add` installs the package (and saves it to package.json and the lockfile) BEFORE it
 * runs the schematic, so "nothing was changed" would be false.
 */
export const REFUSAL_NOTE =
  `${PACKAGE_NAME} itself is already installed (ng add does that before running the schematic), but angular.json, ` +
  `package.json (apart from that entry) and your sources were not modified. To undo the installation: npm uninstall ${PACKAGE_NAME}`;

export const CUSTOM_ESBUILD = '@angular-builders/custom-esbuild';
export const BUILDERS = {
  stock: {
    build: '@angular/build:application',
    serve: '@angular/build:dev-server',
    test: '@angular/build:unit-test',
  },
  custom: {
    build: `${CUSTOM_ESBUILD}:application`,
    serve: `${CUSTOM_ESBUILD}:dev-server`,
    test: `${CUSTOM_ESBUILD}:unit-test`,
  },
} as const;

/**
 * `@angular-devkit/build-angular:application` is the stock esbuild application builder under its legacy package name:
 * @angular-devkit/build-angular's builders.json maps it to `@angular/build:application`. Its `:dev-server` serves an
 * esbuild application build with the same Vite dev server (it switches on the build target's builder name). Projects
 * migrated from older Angular versions still use them; they are replaced exactly like the `@angular/build` ones
 * (checked in a real app: ng add, build, serve and test work afterwards).
 */
export const DEVKIT_ALIASES = {
  build: '@angular-devkit/build-angular:application',
  serve: '@angular-devkit/build-angular:dev-server',
} as const;

/**
 * The options of the custom-esbuild `unit-test` builder (its schema.json, `additionalProperties: false`), by Angular
 * major. The stock `@angular/build:unit-test` accepts more (`runner`, `splitting`); the custom builder runs Vitest only. Used when the installed schema cannot be read yet (the package is installed after the schematic).
 */
const UNIT_TEST_21 = [
  'buildTarget', 'tsConfig', 'runnerConfig', 'browsers', 'browserViewport', 'include', 'exclude', 'filter', 'watch', 'headless',
  'debug', 'ui', 'coverage', 'coverageInclude', 'coverageExclude', 'coverageReporters', 'coverageThresholds',
  'coverageWatermarks', 'reporters', 'outputFile', 'providersFile', 'setupFiles', 'progress', 'listTests', 'dumpVirtualFiles',
  'plugins',
];
export const CUSTOM_UNIT_TEST_OPTIONS: Record<number, readonly string[]> = {
  21: UNIT_TEST_21,
  22: [...UNIT_TEST_21, 'isolate', 'quiet'],
};

/** Angular majors this package was built against and the schematics were tested with (peer range). */
export const SUPPORTED_ANGULAR_MAJORS = [20, 21, 22];

/** The tested pairs: unplugin-typegpu 0.12.6 needs typegpu ^0.12.8, 0.12.7 needs ^0.12.9. */
/**
 * What `ng add` writes for `typegpu` when the project has none: the package's own peer range, not an exact pin. An exact `0.12.8` next to this
 * package's `^0.12.8` peer made npm (workspaces, hoisting) install 0.12.9 for the package and 0.12.8 for the app: two copies of typegpu,
 * and the generated component did not compile (QA finding E1). The paired unplugin-typegpu is chosen from the range's lowest version.
 */
export const TYPEGPU_DEFAULT = '^0.12.8';
export const BABEL_RANGE = '^7.28.0';

/** The prebuild mode of `ng add` (`--shaders prebuild`): the builders and the names it relies on. */
export const SHADERS_BIN = 'typegpu-shaders';
export const SHADERS_OUT = 'shaders-dist';
export const SHADERS_PATH_KEY = '@shaders/*';
/** This package's wrapper builders (builders.json): each builds the shaders, then runs the official builder. */
export const WRAPPERS = {
  build: `${PACKAGE_NAME}:application`,
  serve: `${PACKAGE_NAME}:dev-server`,
  unitTest: `${PACKAGE_NAME}:unit-test`,
  karma: `${PACKAGE_NAME}:karma`,
} as const;
/** esbuild is a peer of the tool; this is the version it was run with (0.28.2). */
export const ESBUILD_RANGE = '^0.28.2';
