// Unit tests for tools/use-gpu-scan.mjs, the directive scanner shared by check-shader-bundle and the esbuild plugin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { scanUseGpu } from '../../../tools/use-gpu-scan.mjs';

type Directive = { index: number; line: number; column: number; transformed: boolean };
const scan = (source: string) => scanUseGpu(source) as Directive[];
const fixture = (path: string) => readFileSync(join(__dirname, '..', 'fixtures', path), 'utf8');

describe('use-gpu-scan: what is a directive', () => {
  it('finds the directive as the first statement of function bodies, in any quote style', () => {
    expect(scan(`function a() { 'use gpu'; return 1; }`)).toHaveLength(1);
    expect(scan(`const a = () => { "use gpu"; return 1; };`)).toHaveLength(1);
    expect(scan(`const a = async (x) => {\n  'use gpu'\n  return x;\n};`)).toHaveLength(1); // ASI, no semicolon
    expect(scan(`function a() { 'use strict'; 'use gpu'; }`)).toHaveLength(1);
    expect(scan(`const a = () => {"use gpu"}`)).toHaveLength(1);
  });

  it('reports line and column of the opening quote', () => {
    const [d] = scan(`const x = 1;\nfunction a() {\n  'use gpu';\n}\n`);
    expect(d).toMatchObject({ line: 3, column: 3 });
  });

  it('ignores the text inside strings, template literals, comments and regular expressions', () => {
    const cases = [
      `const s = "Use 'use gpu'; in shaders";`,
      `const s = "x 'use gpu'; y";`,
      "const t = `function f() { 'use gpu'; return 1; }`;",
      "const t = `a ${ 'use gpu' } b ${`nested { 'use gpu'; }`}`;",
      `// function f() { 'use gpu'; }\nconst a = 1;`,
      `/* function f() { 'use gpu'; } */ const a = 1;`,
      `const r = /'use gpu';/;`,
      `const o = { 'use gpu': 1 };`,
      `call(() => { return 'use gpu'; });`,
      `function f() { const x = 'use gpu'; }`,
      `function f() { 'use gpu' + 1; }`,
    ];
    for (const source of cases) expect(scan(source), source).toHaveLength(0);
  });

  it('does not lose track of strings after a regular expression, a division or a template with braces', () => {
    const source = [
      `const r = /['"]/g; const q = "it's"; function a() { 'use gpu'; }`,
      "const t = `x ${ {a: 1}.a } y`; function b() { 'use gpu'; }",
      `const h = a / b / c; function c() { "use gpu"; }`,
      `const i = x++ / 2; function d() { 'use gpu'; }`,
    ].join('\n');
    expect(scan(source).map((d) => d.line)).toEqual([1, 2, 3, 4]);
  });

  it('is fast enough for a large bundle', () => {
    const big = `function f(){'use gpu';return 1}\n` + `const a = "x";\n`.repeat(400_000);
    const start = performance.now();
    expect(scan(big)).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('use-gpu-scan: transformed or not', () => {
  const transformed = (source: string) => scan(source).map((d) => d.transformed);

  it('recognises the wrappers unplugin-typegpu writes, plain and parenthesised', () => {
    expect(transformed(`$.f = function helper(x) {\n  'use gpu';\n  return x;\n}`)).toEqual([true]);
    expect(transformed(`set($.f = (function quinticDerivative(t) {\n  "use gpu";\n}), {})`)).toEqual([true]);
    expect(transformed(`set($.f = ((value) => {\n  "use gpu";\n}), {})`)).toEqual([true]);
    expect(transformed(`set($.f = (() => {\n  "use gpu";\n}), {})`)).toEqual([true]);
    expect(transformed(`set($.f = input => {\n  'use gpu';\n}, {})`)).toEqual([true]);
    expect(transformed(`set($.f = async (a, b = (1)) => { 'use gpu'; }, {})`)).toEqual([true]);
    expect(transformed(`e.f=function(r){"use gpu";return r}`)).toEqual([true]); // minified
    expect(transformed(`(t=>(globalThis.__TYPEGPU_META__??=new WeakMap).set(t.f=n=>{"use gpu";return n},{v:2})&&t.f)({})`)).toEqual([true]);
  });

  it('flags a directive that is not wrapped', () => {
    expect(transformed(`const f = (x) => { 'use gpu'; return x; };`)).toEqual([false]);
    expect(transformed(`function f(x) { 'use gpu'; }`)).toEqual([false]);
    expect(transformed(`tgpu.fn([])(function named(v) { 'use gpu'; })`)).toEqual([false]);
    expect(transformed(`foo.f == function () { 'use gpu'; }`)).toEqual([false]);
    expect(transformed(`foo.g = function () { 'use gpu'; }`)).toEqual([false]);
    expect(transformed(`x.f(function () { 'use gpu'; })`)).toEqual([false]);
  });

  it('judges each directive on its own', () => {
    const source = `a.f = function(){'use gpu'};\nconst g = () => { 'use gpu' };\nb.f = (function n(){'use gpu'});`;
    expect(transformed(source)).toEqual([true, false, true]);
  });
});

describe('use-gpu-scan: real output', () => {
  it('accepts every directive in the built @typegpu/noise package (0.2.x dist)', () => {
    const directives = scan(fixture('transformed/typegpu-noise.mjs'));
    expect(directives).toHaveLength(22);
    expect(directives.filter((d) => !d.transformed)).toEqual([]);
  });

  it('accepts unplugin-typegpu output after esbuild, development and minified', () => {
    for (const file of ['transformed/sample-dev.js', 'transformed/sample-min.js']) {
      const directives = scan(fixture(file));
      expect(directives, file).toHaveLength(4);
      expect(directives.every((d) => d.transformed), file).toBe(true);
    }
  });

  it('flags every directive of the untransformed build and none of the strings that mention it', () => {
    for (const file of ['untransformed/sample-dev.js', 'untransformed/sample-min.js']) {
      const directives = scan(fixture(file));
      expect(directives, file).toHaveLength(4);
      expect(directives.some((d) => d.transformed), file).toBe(false);
    }
  });
});
