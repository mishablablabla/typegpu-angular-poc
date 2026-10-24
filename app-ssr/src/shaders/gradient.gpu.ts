// A `*.gpu.ts` module: `'use gpu'` functions are transformed at build time by
// node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs (see angular.json).
// Keep Angular decorators out of this file; it is compiled by esbuild, not by the Angular compiler.
import tgpu, { d, std } from 'typegpu';

/** Builds the fragment shader for one gradient instance; `time` and `tint` belong to that instance. */
export function gradientFragment(time: { $: number }, tint: { $: d.v3f }) {
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const wave = 0.5 + 0.5 * Math.sin(time.$);
    const base = d.vec3f(input.uv.x * wave, input.uv.y * wave, 0.3);
    return d.vec4f(std.mul(base, tint.$), 1);
  });
}

/** A plain scalar shader function, used by a spec as a tripwire for the build transform. */
export const wave = (t: number, frequency: number) => {
  'use gpu';
  return Math.sin(t * frequency) * 0.5 + 0.5;
};
