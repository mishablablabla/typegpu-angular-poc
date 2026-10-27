import { callout, code, h2, h3, p, table, ul, type DocBlock } from '../doc-blocks';

const ANGULAR_JSON = `// angular.json (what ng add leaves in projects.<name>.architect)
"build": {
  "builder": "@angular-builders/custom-esbuild:application",
  "options": {
    "plugins": ["node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs"]
  }
},
"serve": { "builder": "@angular-builders/custom-esbuild:dev-server" },
"test": {
  "builder": "@angular-builders/custom-esbuild:unit-test",
  "options": {
    "buildTarget": "<name>:build:development",
    "tsConfig": "tsconfig.spec.json",
    "reporters": ["default"]
  }
}`;

const PREBUILD_JSON = `// angular.json (what ng add --shaders prebuild leaves in projects.<name>.architect): only the builder names change
"build":        { "builder": "@typegpu-poc/angular:application", /* options as before */ },
"serve":        { "builder": "@typegpu-poc/angular:dev-server",  /* ... */ },
"test":         { "builder": "@typegpu-poc/angular:unit-test",   /* or :karma */ },
"extract-i18n": { "builder": "@typegpu-poc/angular:extract-i18n" /* only if the target exists */ }`;

const PREBUILD_IMPORT = `// tsconfig.json (edited in place by ng add; comments are kept)
"compilerOptions": { "paths": { "@shaders/*": ["./shaders-dist/*"] } }

// my-canvas.ts: the application imports the generated module, never the .gpu.ts source
import { sceneFragment } from '@shaders/app/my-canvas/my-canvas.gpu';`;

const TRIPWIRE = `import { expect, it } from 'vitest';
import { wave } from './gradient.gpu'; // any 'use gpu' function of yours

it('shader modules are transformed by the build plugin', () => {
  const meta = (globalThis as { __TYPEGPU_META__?: WeakMap<object, unknown> }).__TYPEGPU_META__;
  expect(meta?.has(wave), 'check angular.json plugins, the custom-esbuild test builder and the .gpu import specifier').toBe(true);
});`;

const FROM_SIGNAL = `import { Component, computed, input } from '@angular/core';
import { d } from 'typegpu';
import { injectUniform } from '@typegpu-poc/angular';

@Component({ selector: 'app-tinted', template: '' })
export class Tinted {
  readonly hue = input.required<number>();

  // Destroyed with the component. Mirrors the signal: read once per frame, written only when it changed.
  private readonly tint = injectUniform(d.vec3f, {
    from: computed(() => d.vec3f(this.hue() / 360, 1 - this.hue() / 360, 0.6)),
  });
}`;

const STORAGE = `import { d } from 'typegpu';
import { injectBuffer, injectMutable, injectReadonly, injectUniform } from '@typegpu-poc/angular';

// Inside a component or service that sits behind *tgpuReady:
const frame = injectUniform(d.f32);                                        // a uniform
const cells = injectMutable(d.arrayOf(d.u32, 128 * 128));                  // storage buffer, read-write in shaders
const palette = injectReadonly(d.arrayOf(d.vec3f, 2), {                    // storage buffer, read-only in shaders
  initial: [d.vec3f(0.1, 0.1, 0.4), d.vec3f(1, 0.7, 0.2)],
});
const raw = injectBuffer(d.arrayOf(d.f32, 1024)).$usage('storage');       // a raw TgpuBuffer, add usages yourself`;

export const ANGULAR_DOC_MIDDLE: readonly DocBlock[] = [
  h2('shaders', 'Shader files and the build pipeline'),
  p('There are two ways to write shaders, and both are type-safe:'),
  ul(
    '<strong>WGSL templates</strong> (<code>tgpu.fn</code>, <code>tgpu.fragmentFn</code> with a template literal) need no build setup at all and work with any Angular builder.',
    '<strong><code>\'use gpu\'</code> TypeScript functions</strong> in modules named <code>*.gpu.ts</code> are transformed at build time into shader code. This is what the generated component uses, and it needs one of the two build modes below.',
  ),
  h3('shader-modes', 'Two shader modes'),
  p('<code>ng add</code> sets up the <strong>plugin mode</strong> by default; <code>ng add --shaders prebuild</code> sets up the <strong>prebuild mode</strong>, which is experimental. Pick one per project; the Angular integration (<code>injectUniform</code>, <code>TgpuCanvas</code>…) does not depend on either.'),
  table(
    ['', 'Plugin (default)', 'Prebuild (experimental)'],
    ['How', '<code>&#64;angular-builders/custom-esbuild</code> and an esbuild plugin that transforms <code>*.gpu.ts</code> during Angular’s build', 'wrapper builders run the <code>typegpu-shaders</code> tool (it transforms the shaders into a git-ignored <code>shaders-dist/</code>), then the official <code>&#64;angular/build</code> builder'],
    ['Needs', 'a community builder; relies on Angular’s <code>onLoad</code> ordering, which is not a guaranteed API', 'experimental <code>&#64;angular/build</code> exports (<code>buildApplication</code>, <code>executeDevServerBuilder</code>…); keeps state on disk'],
    ['Web Workers', 'not supported', 'supported'],
    ['<code>ng test</code>', 'the custom <code>unit-test</code> builder (Vitest); Karma on Angular 20 does not transform shaders', 'the stock runners through the wrappers (Vitest and Karma)'],
    ['<code>ng extract-i18n</code>', 'works', 'works (wrapper)'],
    ['Import in your code', '<code>./x.gpu</code>', '<code>&#64;shaders/&lt;path&gt;</code>; relative and other aliased imports of a shader module are refused before bundling'],
  ),
  callout(
    'note',
    'A third design, a generated file next to each shader (no output folder, no manifest), was prototyped and measured: about half the code, but it needs every import migrated, writes next to your sources, drops some features and has no Windows or Linux evidence. It was <strong>not adopted</strong> for now.',
    'Not adopted',
  ),
  h3('gpu-files', 'Writing a shader module'),
  p(
    'The file name matters: the build plugin transforms modules named <code>*.gpu.ts</code> (also <code>.mts</code>, <code>.js</code>, <code>.mjs</code>) and nothing else. Import them like any module, without the extension: <code>import &#123; sceneFragment &#125; from \'./my-canvas.gpu\'</code> (in prebuild mode through <code>&#64;shaders/…</code>, see below). Relative paths, tsconfig <code>paths</code> aliases (the resolved file decides), dynamic <code>import()</code> and barrel files all work, and a file imported through several specifiers is still one module.',
  ),
  p('The generated shader above shows the rules:'),
  ul(
    'The function that runs on the GPU starts with the <code>\'use gpu\'</code> directive and is passed to a TypeGPU entry point such as <code>tgpu.fragmentFn</code>.',
    'Keep Angular out of these files (no decorators, no Angular imports): esbuild compiles them, not the Angular compiler. A <code>\'use gpu\'</code> function in any other project file is not transformed; the build warns.',
    'Plain number maths is fine. Vector operators (<code>a + b</code> on a <code>d.vec3f</code>) are not typed by stock TypeScript, so use <code>std.add</code>, <code>std.mul</code> or the vector methods.',
    'Uniforms and other resources are read with <code>.$</code> inside the shader.',
  ),
  h3('pipeline', 'How the plugin mode is built'),
  p('Angular’s esbuild plugin loads every <code>.ts</code> file before any other plugin sees it, so the plugin shipped with the package redirects <code>*.gpu</code> imports to a virtual module, runs <code>unplugin-typegpu</code> on the original file and hands the result back. Loading a plugin into the Angular CLI needs the community builder <code>&#64;angular-builders/custom-esbuild</code>, which <code>ng add</code> configures:'),
  code(ANGULAR_JSON, 'json', 'angular.json'),
  ul(
    'A <code>plugins</code> entry is a <strong>file path relative to the workspace root</strong>, not a package specifier; with hoisted dependencies it must point to where the package really is (<code>ng add</code> writes it).',
    'The stock <code>&#64;angular/build:unit-test</code> builder ignores <code>plugins</code> silently, and shader specs then fail with “Missing metadata”. That is why <code>ng add</code> replaces it.',
    'A <code>plugins</code> list inside a build configuration (for example <code>production</code>) replaces the global one; add the plugin to it if you create one later.',
    'A syntax error in a shader module is reported with file, line and column. <code>TYPEGPU_SHADERS_LOG=1</code> logs which imports the plugin matched. The dev server reloads the whole page when a shader changes (no HMR).',
    '<strong>Web Workers are not supported:</strong> Angular’s application builder passes no esbuild plugins to worker bundles, so shader code there ships raw (the build warns, the check below names the bundle).',
  ),
  h3('ci-check', 'Checking the build in CI'),
  p(
    'If the plugin is not applied, the build still succeeds and <code>\'use gpu\'</code> functions ship as plain JavaScript that fails in the browser. Two checks catch it. A spec covers the <strong>test</strong> build:',
  ),
  code(TRIPWIRE, 'typescript', 'shaders.spec.ts'),
  p('The <strong>production</strong> bundle is covered by the script <code>ng add</code> adds. It builds, scans the <code>.js</code>, <code>.mjs</code> and <code>.cjs</code> files recursively, and exits with 1 when a <code>\'use gpu\'</code> directive was not transformed <strong>or none was found</strong> (a wrong directory must not pass; <code>--allow-empty</code> makes that a warning), and with 2 for bad usage or a missing directory. Run it in CI:'),
  code('npm run check:shaders', 'bash'),

  h3('prebuild', 'Prebuild mode (experimental)'),
  p(
    'The <code>\'use gpu\'</code> modules are transformed <strong>before</strong> Angular builds, by the <code>typegpu-shaders</code> tool that ships with the package, and the application imports the result as plain JavaScript. Nothing in Angular’s build is replaced or hooked, which is why Web Workers and the stock test runners work. The tool takes every <code>*.gpu.ts</code> under the source root and the project modules they import, and writes <code>shaders-dist/</code>: <code>.js</code>, <code>.d.ts</code> and source maps per module plus a manifest.',
  ),
  code(PREBUILD_JSON, 'json', 'angular.json'),
  code(PREBUILD_IMPORT, 'typescript'),
  ul(
    '<strong>Always fresh.</strong> The wrapper builders make sure <code>shaders-dist</code> is current before the official builder runs, so <code>ng build</code>, <code>ng serve</code>, <code>ng test</code>, <code>ng extract-i18n</code>, an IDE task or CI cannot bundle a shader older than its source. After an application build the output is scanned and the build fails if an untransformed <code>\'use gpu\'</code> is in it.',
    '<strong>Failures are loud.</strong> A shader that fails to transform fails a one-off build with file, line and the candidate lines, and builds nothing. In <code>ng serve</code> its module becomes a stub that shows the error in a red banner and in the terminal; fixing the file removes it. On a server (an SSR dev server) the stub only logs, so a broken shader does not take it down.',
    '<code>ng add --shaders prebuild</code> also adds <code>typegpu</code>, <code>&#64;babel/core</code>, <code>unplugin-typegpu</code> and <code>esbuild</code> when absent, the <code>&#64;shaders/*</code> path to the project’s tsconfig files (all of them: build, test and worker) and <code>shaders-dist/</code> to <code>.gitignore</code>. It refuses a project that already uses the plugin mode.',
    '<code>typegpu-shaders</code> also has a command line (<code>build</code>, <code>watch</code>, <code>check</code>, <code>run</code>, <code>dev</code>, <code>check --fix-imports</code>) for projects that do not use the wrappers. Without the wrappers a bare <code>ng build</code> is <strong>not</strong> protected from a stale shader.',
  ),
  callout(
    'caution',
    'What this mode costs: it depends on <strong>experimental</strong> <code>&#64;angular/build</code> exports (a fallback and a drift warning limit that exposure, they do not remove it); it keeps <strong>state on disk</strong> (<code>shaders-dist/</code>, shared by <code>ng serve</code> and a concurrent <code>ng build</code> without a lock; the files are written atomically, which was exercised on macOS only); an editor shows <code>&#64;shaders/…</code> as unresolved until the first build; shaders and what they import must be under <code>src</code>; and it is not offered as production-ready.',
    'Prebuild limits',
  ),

  h2('reactive-state', 'Signals and GPU data'),
  h3('uniforms-from-signals', 'Uniforms from signals'),
  p(
    'Pass <code>from</code> a signal to any <code>inject*</code> resource and the integration mirrors it: the signal is read <strong>once per animation frame</strong>, before your frame callbacks, and written only when its value changed (<code>Object.is</code>: <code>NaN</code> is written once, <code>-0</code> differs from <code>0</code>). It is never read in the constructor, and a required <code>input()</code> without a value yet is skipped until it has one, so <code>input.required()</code> is safe.',
  ),
  code(FROM_SIGNAL, 'typescript', 'tinted.ts'),
  p('Which tool for which value:'),
  table(
    ['Your value is…', 'Use', 'Why'],
    ['derived from UI state and shown every frame (hue, zoom, selection)', '<code>injectUniform(schema, &#123; from: signal &#125;)</code>', 'Visible to the same frame’s draw call, written only on change, safe with <code>input.required()</code>'],
    ['changing every frame (time, a simulation head)', '<code>uniform.write(…)</code> in your <code>injectFrame</code> callback', 'You already have the number; no signal needed'],
    ['changing rarely, not tied to a frame (a config panel)', '<code>effect(() =&gt; uniform.write(sig()))</code>', 'Fine; the write happens when Angular flushes effects, not at a defined point before the frame callbacks'],
  ),
  callout(
    'note',
    '<code>from</code> compares with <code>Object.is</code>: replace the value (a <code>computed</code> does), don’t mutate it in place. A <code>from</code> resource keeps the shared loop running while it lives (one comparison per frame): sampling happens before the frame callbacks, so a value set before a frame is written in it. A throwing write is reported once and that resource stops mirroring. Schemas are fixed per resource: for a different size, recreate the owner.',
  ),
  h3('resources', 'Buffers, mutable and readonly resources'),
  p(
    '<code>injectUniform</code> (a uniform), <code>injectMutable</code> and <code>injectReadonly</code> (storage buffers, read-write and read-only in shaders) and <code>injectBuffer</code> (a raw <code>TgpuBuffer</code>) create a resource through <code>injectRoot()</code> and destroy it with the surrounding injection context. They return the plain TypeGPU object, so <code>write</code>, <code>read</code> and use in shaders through <code>.$</code> work unchanged. All take <code>(schema, &#123; initial?, from? &#125;)</code>.',
  ),
  code(STORAGE, 'typescript', 'resources.ts'),
  h3('ownership', 'Who destroys what'),
  table(
    ['Thing', 'Created by', 'Destroyed by'],
    ['the <code>TgpuRoot</code> and its device', '<code>TypeGpu</code> (via <code>tgpu.init</code>)', 'The service, <strong>exactly once and only a root it created</strong>: when its injector is destroyed (after the components’ resources) and when <code>retry()</code> replaces a lost root. A root you pass in is never touched; a root that arrives after the service was destroyed is released at once. Afterwards <code>root()</code> is <code>undefined</code> and <code>whenReady()</code> rejects.'],
    ['uniforms and buffers from <code>inject*</code>', 'the component, directive or service that called <code>inject*</code>', 'its <code>DestroyRef</code>, immediately (in an already destroyed owner, <code>inject*</code> releases the buffer it made and rethrows)'],
    ['pipelines and bind groups', 'you', 'nothing to call: they have no <code>destroy()</code>. One catch: TypeGPU gives each <code>createGuardedComputePipeline</code> a 12-byte internal uniform buffer that lives as long as the root, so it outlives the component. Measured in this showcase: a few per mount of an example, with and without the integration; the integration does not own them.'],
    ['textures and other raw GPU memory', 'you', 'you, with <code>inject(DestroyRef).onDestroy(…)</code>'],
    ['the frame callback; the canvas observer and context', '<code>injectFrame</code>, <code>tgpuCanvas</code>', 'their owner, on destroy (the context is also <code>unconfigure()</code>d on device loss)'],
  ),
  p('To share a resource between components, create it in a service: the service’s lifetime is then the resource’s lifetime.'),
];
