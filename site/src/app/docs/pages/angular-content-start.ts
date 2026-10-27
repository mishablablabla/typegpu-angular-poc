import { callout, code, h2, h3, p, ul, type DocBlock } from '../doc-blocks';
import componentTemplate from '../../../../../lib/schematics/component/files/__name@dasherize__/__name@dasherize__.ts.template?source';
import shaderTemplate from '../../../../../lib/schematics/component/files/__name@dasherize__/__name@dasherize__.gpu.ts.template?source';

/** The generator's templates with their placeholders filled in for `my-canvas`: the page shows what `ng generate` writes (the CLI then formats the files with Prettier, so whitespace may differ). */
const render = (template: string): string =>
  template
    .replaceAll('<%= classifiedName %>', 'MyCanvas')
    .replaceAll('<%= selector %>', 'app-my-canvas')
    .replaceAll('<%= dasherize(name) %>', 'my-canvas')
    .replaceAll('<%= packageName %>', '@typegpu-poc/angular');

export const GENERATED_COMPONENT = render(componentTemplate);
export const GENERATED_SHADER = render(shaderTemplate);

export const ANGULAR_DOC_START: readonly DocBlock[] = [
  p(
    'Using TypeGPU in Angular means solving the same problems in every component: the GPU device is requested asynchronously and only in the browser, one device should serve the whole application, buffers must be destroyed with their owner, and canvases, animation frames and device loss need handling. <code>@typegpu/angular</code> is a small set of Angular building blocks for exactly that.',
  ),
  callout(
    'caution',
    'This is an <strong>experimental proof of concept</strong>, not production-ready and not published: <code>@typegpu/angular</code> in the headings is the intended future name, and neither it nor <code>@typegpu-poc/angular</code> exists on npm. What you can install is <code>@typegpu-poc/angular</code>, built from a tarball, so commands and imports here use that name. The <a href="#limitations">limitations</a> below are part of what you adopt.',
    'Experimental',
  ),

  h2('what-is-it', 'What is @typegpu/angular?'),
  p(
    'TypeGPU stays visible: you get a real <code>TgpuRoot</code>, real uniforms and real pipelines. The integration only decides <strong>who creates and destroys</strong> them and <strong>when</strong> values reach the GPU:',
  ),
  ul(
    '<strong>One root per injector</strong>, created lazily in the browser after the first render by the <code>TypeGpu</code> service. It never delays bootstrap and never runs on the server.',
    '<strong>An async boundary in the template:</strong> <code>*tgpuReady</code> renders its content only while a root exists, so the content can call <code>injectRoot()</code> synchronously.',
    '<strong>Resources owned by their component:</strong> <code>injectUniform</code>, <code>injectBuffer</code>, <code>injectMutable</code> and <code>injectReadonly</code> are destroyed with the injection context that created them.',
    '<strong>Signals feed the GPU once per frame:</strong> <code>{ from: signal }</code> writes a value only when it changed, before your frame callbacks run.',
    '<strong>One animation loop</strong> for the whole application, outside the zone: <code>injectFrame</code>. The <code>tgpuCanvas</code> directive configures the context and sizes the canvas.',
  ),
  p('Also exported: <code>provideTypeGpu(config)</code> for optional configuration, and <code>@typegpu-poc/angular/testing</code> with a fake root for tests without a GPU.'),

  h2('setup', 'Installation and setup'),
  p(
    'You need a standalone Angular application on the esbuild application builder (the default of <code>ng new</code>), Angular 20, 21 or 22, Node <code>^20.19.0 || ^22.12.0 || &gt;=24.0.0</code> (the range the package declares; each Angular major enforces its own, Angular 22 needs <code>^22.22.3 || ^24.15.0 || &gt;=26</code>), and a WebGPU browser (Chrome or Edge) to see the result. See <a href="#compatibility">Compatibility</a> for what is declared, what CI runs and what was only checked by hand.',
  ),
  h3('get-package', 'Getting the package (not published yet)'),
  p(
    'The tarball is git-ignored, so build it from the repository: <code>cd lib &amp;&amp; npm ci &amp;&amp; npm run pack</code> creates <code>lib/typegpu-poc-angular-0.0.1.tgz</code>. npm records the dependency as a relative <code>file:</code> path, so teammates and CI need the tarball at the same relative place (this repository’s own CI keeps the library out of the lockfile for that reason and installs the freshly packed tarball with <code>npm install --no-save</code>).',
  ),
  h3('ng-add', 'With ng add'),
  p('The schematic sets up the build. Run it in the application you want to use TypeGPU in. The path to the tarball may be absolute or relative (<code>--skip-confirmation</code> is needed without a terminal):'),
  code('ng add ../typegpu-angular-poc/lib/typegpu-poc-angular-0.0.1.tgz --skip-confirmation', 'bash'),
  p('Without further options this is the <strong>plugin mode</strong>, the default. It changes, and only changes:'),
  ul(
    '<code>angular.json</code>: the <code>build</code>, <code>serve</code> and <code>test</code> targets move to <code>&#64;angular-builders/custom-esbuild</code> (a Karma test target, the Angular 20 default, is left unchanged with a warning) and the shader plugin is added to the build target under its real relative path (<code>../../node_modules/…</code> when dependencies are hoisted). Assets, styles, budgets and other plugins are kept; stock-only test options the custom builder rejects (<code>runner</code>…) are removed and logged.',
    '<strong>Resolve conditions.</strong> For a third-party builder the CLI fills <code>conditions: []</code>, which makes Angular’s application builder drop <code>module</code> and <code>production</code>/<code>development</code>. <code>ng add</code> writes the stock conditions (<code>["module","production"]</code> and <code>["module","development"]</code>) into the <code>production</code> and <code>development</code> build configurations, unless the project already sets <code>conditions</code>, and logs one line saying so. If you add configurations of your own, set <code>conditions</code> in them too.',
    '<code>package.json</code>: <code>typegpu</code> in <code>dependencies</code> (npm would install this peer unlisted); <code>&#64;angular-builders/custom-esbuild</code>, <code>&#64;babel/core</code> and <code>unplugin-typegpu</code> in <code>devDependencies</code>; and a <code>check:shaders</code> script for CI.',
    'Formatting is kept: CRLF line endings, the indentation and the final newline of <code>angular.json</code>, <code>package.json</code> and <code>.gitignore</code>. On Angular 20 with <code>--ssr</code> an <em>empty</em> <code>security.allowedHosts</code> is removed (the community builder’s schema rejects it) with a note on <code>NG_ALLOWED_HOSTS</code>; a non-empty list is refused.',
  ),
  p(
    'Your application code and providers are untouched. The schematic refuses, saying what to do, when the build target is not the esbuild application builder or versions are unsupported: <code>@typegpu-poc/angular</code> itself is already installed by then (<code>ng add</code> does that first), but <code>angular.json</code>, the rest of <code>package.json</code> and your sources are not modified (undo: <code>npm uninstall @typegpu-poc/angular</code>). Versions it was not tested with (TypeScript below 5.5, esbuild below 0.24, an unmatched <code>unplugin-typegpu</code>) give warnings, not refusals. Running it again changes nothing, except that it repairs a stale plugin path. In a workspace with several applications, pass <code>--project &lt;name&gt;</code>.',
  ),
  p(
    'The other mode is <code>ng add … --shaders prebuild</code> (<strong>experimental</strong>): instead of the community builder it points <code>build</code>, <code>serve</code>, <code>test</code> and an existing <code>extract-i18n</code> target at wrapper builders shipped with the package, adds an <code>@shaders/*</code> path to the project’s tsconfig files and a <code>shaders-dist/</code> line to <code>.gitignore</code>. Both modes are compared in <a href="#shader-modes">Two shader modes</a>.',
  ),
  ul(
    'Angular 19 stops in npm with <code>ERESOLVE</code> before the schematic runs. With <code>&#64;angular-devkit/build-angular</code> 22 installed, a peer conflict on <code>&#64;babel/core</code> is bypassed with <code>--legacy-peer-deps</code> for that run. With pnpm and <code>CI</code> set, <code>ng add</code> fails at pnpm’s frozen-lockfile install (<code>ng add &#64;angular/material</code> does the same): run <code>pnpm install --no-frozen-lockfile</code>.',
    'In plugin mode every <code>ng test</code> warns that the <code>application</code> build target of the custom <code>unit-test</code> builder is “not supported”. Expected, and upstream (the prebuild wrappers filter it).',
    '<code>npm run check:shaders</code> <strong>fails until the build contains a shader</strong>: before the first one exists, use <code>--allow-empty</code> or generate a component first.',
  ),
  h3('manual-setup', 'By hand'),
  p(
    'Without <code>ng add</code> you only need the package and <code>typegpu</code> (list it yourself) to use WGSL templates. <code>\'use gpu\'</code> TypeScript shaders also need one of the build pipelines described in <a href="#shaders">Shader files and the build pipeline</a>.',
  ),
  code('npm install /abs/path/to/typegpu-poc-angular-0.0.1.tgz typegpu@0.12.8', 'bash'),

  h2('first-component', 'Your first GPU component'),
  h3('generate', 'Generate it'),
  p('The generator follows <code>ng generate component</code> (<code>--path</code>, <code>--project</code> and <code>--skip-tests</code> work as usual):'),
  code('ng generate @typegpu-poc/angular:component my-canvas', 'bash'),
  p('It creates <code>my-canvas.ts</code> (the component, with fallbacks for “no WebGPU”, “initialization failed” and “device lost”), <code>my-canvas.gpu.ts</code> (its shader) and a spec that needs no GPU. It works in both shader modes; in a prebuild project the component imports its shader as <code>@shaders/…/my-canvas.gpu</code>. Add <code>&lt;app-my-canvas /&gt;</code> to a template and run <code>ng serve</code>: you get an animated gradient whose tint follows a slider. Names must dasherize to lowercase letters, digits and dashes (<code>foo.bar</code> is refused), and <code>foo</code> clashes with an existing <code>foo-scene</code>. It refuses to overwrite files (<code>--force</code> is listed but does not overwrite) and refuses a project that <code>ng add</code> has not configured.'),
  h3('read-it', 'What it contains'),
  p('The component is split in two: the scene, which uses the GPU, and the host, which decides whether the scene may exist.'),
  { kind: 'code', code: GENERATED_COMPONENT, lang: 'typescript', title: 'my-canvas.ts' },
  p(
    '<code>injectRoot()</code> hands over the root (so the scene must sit behind <code>*tgpuReady</code>); <code>injectUniform</code> creates uniforms that are destroyed with the component; the <code>tint</code> uniform mirrors a signal; <code>injectFrame</code> draws every frame; <code>tgpuCanvas</code> sizes the canvas. There is no <code>ngOnDestroy</code>, <code>requestAnimationFrame</code> or <code>ResizeObserver</code> in your code.',
  ),
  { kind: 'code', code: GENERATED_SHADER, lang: 'typescript', title: 'my-canvas.gpu.ts' },
];
