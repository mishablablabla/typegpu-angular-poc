// Tripwire for the shader build workflow (see "Shader authoring" in lib/README.md): if the esbuild plugin
// stops transforming `*.gpu.ts` modules (e.g. after an Angular upgrade changes plugin ordering, or because the
// angular.json entry is wrong), 'use gpu' functions have no metadata and these specs fail with a message that
// says what to check, before TypeGPU's generic "Missing metadata".
import { describe, expect, it } from 'vitest';
import tgpu, { d } from 'typegpu';
import { wave } from './gradient.gpu';
import { wave as waveViaAlias } from '@shaders/gradient.gpu';
import { wave as waveViaJsSpecifier } from './gradient.gpu.js';

const HINT =
  'src/shaders/gradient.gpu.ts was NOT transformed by unplugin-typegpu. Check: ' +
  '(1) angular.json lists node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs under the `plugins` of the ' +
  'build target the tests use (a `plugins` entry in a configuration replaces the global list); ' +
  '(2) build and test use @angular-builders/custom-esbuild builders (the stock @angular/build:unit-test ignores plugins); ' +
  '(3) the import specifier ends in `.gpu` / `.gpu.ts` and resolves to a project file. ' +
  'Run `TYPEGPU_SHADERS_LOG=1 ng test` to see which imports the plugin matched.';

const hasMetadata = (fn: object) =>
  (globalThis as { __TYPEGPU_META__?: WeakMap<object, unknown> }).__TYPEGPU_META__?.has(fn) === true;

describe('`*.gpu.ts` shader modules', () => {
  it('were transformed by the build plugin', () => {
    if (!hasMetadata(wave)) throw new Error(HINT);
  });

  it('are transformed however they are imported, and are one module', () => {
    // A tsconfig `paths` alias and a `./x.gpu.js` specifier must be transformed too, and a file imported through
    // two specifiers must stay one module (not bundled twice, one copy untransformed).
    for (const imported of [waveViaAlias, waveViaJsSpecifier]) {
      if (!hasMetadata(imported)) throw new Error(HINT);
      expect(imported).toBe(wave);
    }
  });

  it('still run as plain JavaScript on the CPU', () => {
    expect(wave(0, 1)).toBeCloseTo(0.5);
  });

  it('carry build-time metadata, so TypeGPU can turn them into WGSL', () => {
    const shell = tgpu.fn([d.f32, d.f32], d.f32)(wave);
    const wgsl = tgpu.resolve([shell]);
    expect(wgsl).toContain('fn wave(t: f32, frequency: f32) -> f32');
    expect(wgsl).toContain('sin((t * frequency))');
  });
});
