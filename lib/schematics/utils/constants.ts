import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package name is read from the package itself, so a rename does not need to touch the schematics.
// From `<package>/schematics/utils/` the manifest is two levels up (also in `dist/` during development).
const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { name: string };

export const PACKAGE_NAME = manifest.name;
export const PLUGIN_PATH = `node_modules/${PACKAGE_NAME}/tools/typegpu-shaders.esbuild.mjs`;
export const CHECK_TOOL_PATH = `node_modules/${PACKAGE_NAME}/tools/check-shader-bundle.mjs`;
export const CHECK_SCRIPT = 'check:shaders';

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

/** Angular majors this package was built against and the schematics were tested with (peer range). */
export const SUPPORTED_ANGULAR_MAJORS = [20, 21, 22];

/** The tested pairs: unplugin-typegpu 0.12.6 needs typegpu ^0.12.8, 0.12.7 needs ^0.12.9. */
export const TYPEGPU_DEFAULT = '0.12.8';
export const BABEL_RANGE = '^7.28.0';
