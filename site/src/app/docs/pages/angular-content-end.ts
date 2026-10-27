import { callout, code, h2, h3, p, table, ul, type DocBlock } from '../doc-blocks';

const CANVAS = `import { Component, viewChild } from '@angular/core';
import { TgpuCanvas, injectFrame, injectRoot } from '@typegpu-poc/angular';

@Component({
  selector: 'app-scene',
  imports: [TgpuCanvas],
  // The canvas needs a CSS size: the directive sizes its pixel buffer from it.
  template: \`<canvas [tgpuCanvas]="{ alphaMode: 'premultiplied' }" (resized)="onResize($event)"></canvas>\`,
  styles: \`canvas { display: block; width: 100%; height: 360px; }\`,
})
export class Scene {
  private readonly root = injectRoot();
  private readonly canvas = viewChild.required(TgpuCanvas);

  constructor() {
    injectFrame(() => {
      const context = this.canvas().context(); // undefined until a root is ready
      if (!context) return;
      // draw with this.root and the context
    });
  }

  protected onResize(size: { width: number; height: number }): void {} // the bitmap size in device pixels
}`;

const FRAME = `// In the constructor of a component like Scene above (uniform, pipeline and context come from there).
const frame = injectFrame(({ deltaSeconds, elapsedSeconds }) => {
  uniform.write(elapsedSeconds);
  pipeline.withColorAttachment({ view: context }).draw(3);
}, { maxDeltaSeconds: 0.1 });   // optional; the default is 0.25

frame.pause();      // stop calling the callback; resources are untouched
frame.resume();     // the next deltaSeconds is clamped to maxDeltaSeconds, not the length of the pause
frame.paused();     // a signal`;

const GATE = `import { Component, inject } from '@angular/core';
import { TgpuReady, TypeGpu } from '@typegpu-poc/angular';
import { Scene } from './scene';

@Component({
  selector: 'app-host',
  imports: [TgpuReady, Scene],
  template: \`
    <app-scene *tgpuReady="let root; else fallback" />
    <ng-template #fallback let-state>
      @switch (state.status) {
        @case ('unsupported') { <p>WebGPU is not available in this browser.</p> }
        @case ('failed')      { <p>GPU initialisation failed. <button (click)="gpu.retry()">Retry</button></p> }
        @case ('lost')        { <p>The GPU device was lost. <button (click)="gpu.retry()">Reconnect</button></p> }
        @default              { <div class="placeholder"></div> }
      }
    </ng-template>
  \`,
})
export class Host {
  protected readonly gpu = inject(TypeGpu);
}`;

const PROVIDE = `import { ApplicationConfig } from '@angular/core';
import { tgpu } from 'typegpu';
import { provideTypeGpu } from '@typegpu-poc/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    // Everything is optional. Without it the service calls tgpu.init() with defaults.
    provideTypeGpu({
      options: { adapter: { powerPreference: 'high-performance' } },
      // or: root: existingRoot            (used as is, never destroyed by us)
      // or: createRoot: async () => tgpu.initFromDevice({ device: await myDevice() })
    }),
  ],
};`;

const TEST = `import { TestBed } from '@angular/core/testing';
import { provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames } from '@typegpu-poc/angular/testing';

it('destroys its buffers', async () => {
  const fake = createFakeTypeGpu();
  const frames = installManualAnimationFrames();
  TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] }); // ready immediately

  const fixture = TestBed.createComponent(MyGpuComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  frames.flush();                        // runs injectFrame callbacks once
  expect(fake.liveResources()).toBe(2);  // the number of inject* resources of your component

  fixture.destroy();
  expect(fake.liveResources()).toBe(0);
  frames.restore();
});`;

const FAKE_PIPELINE = `// A component that builds a pipeline needs this on the fake root:
const draw = vi.fn();
Object.assign(fake.root, {
  createRenderPipeline: () => ({ withColorAttachment: () => ({ draw }) }),
});`;

export const ANGULAR_DOC_END: readonly DocBlock[] = [
  h2('canvas-and-frames', 'Canvas, resizing and frames'),
  h3('canvas', 'The canvas directive'),
  p(
    '<code>canvas[tgpuCanvas]</code> owns one WebGPU context on the host canvas and its pixel size. It configures the context as soon as a root is ready, reconfigures it only when the root or an option that reaches WebGPU changes (so <code>autoResize</code> and <code>maxPixelRatio</code> never clear the canvas), and sizes the canvas in <strong>device pixels</strong> from a <code>ResizeObserver</code> (content-box fallback). It unconfigures the context on destroy and device loss, never starts a frame loop and never creates resources.',
  ),
  code(CANVAS, 'typescript', 'scene.ts'),
  table(
    ['Member', 'What it is'],
    ['<code>[tgpuCanvas]="options"</code>', 'A <code>GPUCanvasConfiguration</code> without <code>device</code> (the format defaults to the preferred one), plus <code>autoResize</code> (default <code>true</code>) and <code>maxPixelRatio</code> (default: no limit; caps canvas pixels per CSS pixel to bound the cost of a heavy fragment shader on high-DPI screens)'],
    ['<code>(resized)</code>', 'Emits the new pixel size after the canvas was resized, and its initial size'],
    ['<code>context()</code>', 'The configured context, or <code>undefined</code> until a root is ready and after it is lost'],
    ['<code>size()</code>', 'The last pixel size applied by <code>autoResize</code>'],
  ),
  callout(
    'caution',
    'The canvas needs a CSS <code>width</code> and <code>height</code>: the pixel buffer is sized from the layout size, so without one the directive switches resizing off and warns in development. The canvas must also be fresh: with an existing 2d or WebGL context, <code>context()</code> stays <code>undefined</code>. Under jsdom there is no <code>ResizeObserver</code>, so the size is not tracked.',
  ),
  h3('frames', 'Animation frames'),
  p(
    '<code>injectFrame</code> registers a callback on <strong>one shared animation loop</strong> for the whole application. The loop runs outside the Angular zone, starts lazily, goes idle when nothing is active and stops with its owner. Call it in an injection context (a constructor or a field initializer).',
  ),
  code(FRAME, 'typescript'),
  ul(
    'The first call happens <strong>after the owner’s first render</strong>, so <code>viewChild.required()</code> and signal inputs are available.',
    'The callback gets a reused <code>&#123; deltaSeconds, elapsedSeconds &#125;</code> object: do not keep it. <strong><code>deltaSeconds</code> is clamped to <code>maxDeltaSeconds</code> (default 0.25 s, <code>Infinity</code> turns it off, <code>&lt;= 0</code> or <code>NaN</code> throws), also after a hidden tab or <code>resume()</code></strong>; it used to be the raw gap. <code>elapsedSeconds</code> is real time.',
    'Callbacks run only while their root is <code>ready</code>. After device loss they stop in that frame and do not resume on the root made by <code>retry()</code>: behind <code>*tgpuReady</code> the owner is recreated instead.',
    'A callback that throws, or returns a rejected promise (even after its owner was destroyed), is stopped and reported once through <code>ErrorHandler</code>; other consumers keep running, and a throwing handler goes to <code>console.error</code> without stopping the loop. Do not <code>await</code> inside: the loop does not wait.',
    'The loop runs while a callback is active or a <code>from</code> resource exists; with neither it requests no frames.',
  ),

  h2('lifecycle', 'Initialization, errors and device loss'),
  h3('states', 'The states of the GPU'),
  p('<code>TypeGpu.state()</code> is a signal of an <strong>object</strong> whose <code>status</code> is one of six values (read <code>gpu.state().status</code>):'),
  table(
    ['State', 'Meaning'],
    ['<code>idle</code>', 'Nothing started yet. This is also the permanent state on the server, even if you provide a root'],
    ['<code>initializing</code>', '<code>tgpu.init()</code> (or your <code>createRoot</code>) is running'],
    ['<code>ready</code> + <code>root</code>', 'A device exists; <code>injectRoot()</code> works'],
    ['<code>unsupported</code>', '<code>navigator.gpu</code> is missing, or <code>requestAdapter()</code> gives <code>null</code> (detected by matching TypeGPU’s “compatible GPU” message, a heuristic: reworded, it becomes <code>failed</code>). Not an error, so nothing is reported'],
    ['<code>failed</code> + <code>error</code>', 'Initialization rejected (also <code>requestDevice</code>). Reported once to <code>ErrorHandler</code>; <code>retry()</code> tries again'],
    ['<code>lost</code> + <code>info</code>', 'The device was lost after it had been ready (<code>GPUDeviceLostInfo</code>)'],
  ),
  p('<code>root()</code> is the root while <code>ready</code>; code outside templates can await it with <code>whenReady()</code>, which rejects when the GPU is unsupported or failed, on the server and after the service was destroyed; while <code>lost</code> it waits for your <code>retry()</code> and resolves with the new root.'),
  code(PROVIDE, 'typescript', 'app.config.ts'),
  callout(
    'note',
    '<code>provideTypeGpu</code> configures the injector it is provided in: in a route or a child injector it creates a <strong>separate</strong> service and GPU device. A root you pass in is never destroyed; one from <code>createRoot</code> is. With SSR and hydration use <code>createRoot</code>, not <code>root</code>: a service that is ready at construction renders <code>*tgpuReady</code> content during hydration (documented limitation, unverified).',
  ),
  h3('gate', 'The *tgpuReady gate'),
  p(
    'Content inside <code>*tgpuReady</code> exists only while a root is ready, so it may call <code>injectRoot()</code> synchronously and frame callbacks need no <code>undefined</code> checks. The <code>else</code> template receives the state. Server and first client render both see <code>idle</code>, so hydration matches.',
  ),
  code(GATE, 'typescript', 'host.ts'),
  p('<code>injectRoot()</code> outside a ready gate throws an error naming the state it saw. In the <code>else</code> template <code>let-state</code> is untyped: read <code>state.status</code> and, for <code>failed</code>, <code>state.error</code>.'),
  h3('recovery', 'Failures, device loss and retry'),
  table(
    ['Situation', 'What you get'],
    ['The device is lost', '<code>lost</code>; frame callbacks and <code>from</code> writes stop in that very frame; <code>*tgpuReady</code> tears its content down (every cleanup runs); <code>retry()</code> creates a new root and the content is created again. <strong>Recovery is manual</strong>'],
    ['Components outside a gate', 'They stay stopped after a loss: their resources belong to the dead device'],
    ['Destroyed while init is pending', 'Nothing leaks: the late root is destroyed'],
    ['<code>retry()</code> after a provided root was lost', 'A provided root cannot be recreated: the service falls back to <code>createRoot</code> or <code>tgpu.init(options)</code>'],
  ),
  p('To see the fallback UI: for <em>unsupported</em>, run <code>Object.defineProperty(navigator, \'gpu\', &#123; value: undefined, configurable: true &#125;)</code> before bootstrapping; for <em>failed</em>, use <code>provideTypeGpu(&#123; createRoot: () =&gt; Promise.reject(new Error(\'no adapter\')) &#125;)</code>.'),

  h2('testing', 'Testing'),
  p('The <code>testing</code> entry point gives you a fake root and a manual animation-frame queue, so component tests need no GPU. <code>provideTypeGpu(&#123; root: fake.root &#125;)</code> makes the service ready at once, <code>createRoot</code> with your own promise tests the async paths, and <code>fake.loseDevice()</code> simulates device loss.'),
  code(TEST, 'typescript', 'my-gpu.spec.ts'),
  ul(
    'The fake implements the resource creators, <code>configureContext</code>, <code>destroy</code> and <code>device.lost</code>, and follows TypeGPU where it matters (a write after destroy throws; <code>root.destroy()</code> resolves <code>device.lost</code>). It exposes <code>resources</code> (<code>initial</code>, <code>calls</code>, <code>writes</code>), <code>contexts</code>, <code>unconfigured</code>, <code>rootDestroyCalls()</code> and <code>liveResources()</code>; the frame queue has <code>pending()</code>. It does not validate values and has no pipelines: add the methods your component calls.',
    'Angular’s scheduler also uses <code>requestAnimationFrame</code>: assert on what your callbacks did per <code>flush()</code>, not on how often it was called.',
    '<code>\'use gpu\'</code> shader modules are transformed in the unit tests of the plugin mode through the custom <code>unit-test</code> builder (Vitest; not on Angular 20, not in Karma) and in the prebuild mode through the stock runners, Vitest and Karma. Component specs that fake the GPU need none of this.',
    'A recording <code>GPUDevice</code> lets the real TypeGPU root build pipelines in Node, so <code>tgpu.resolve</code> can gate shaders in a unit test (this showcase does; the WGSL is not validated). Real GPU behavior belongs in browser tests.',
  ),
  code(FAKE_PIPELINE, 'typescript'),

  h2('limits', 'Limitations, compatibility and troubleshooting'),
  h3('compatibility', 'Compatibility'),
  p('What the package declares:'),
  table(
    ['', 'Declared'],
    ['Angular', '20, 21 or 22 (peer ranges), standalone applications on the esbuild application builder'],
    ['Node', '<code>engines.node</code> <code>^20.19.0 || ^22.12.0 || &gt;=24.0.0</code>, the floor of the Angular 20 and 21 CLIs; Angular 22 itself needs <code>^22.22.3 || ^24.15.0 || &gt;=26</code>, and each Angular major enforces its own range on the project'],
    ['<code>typegpu</code>', '<code>^0.12.8</code>, with <code>unplugin-typegpu</code> 0.12.6 or 0.12.7 (<code>ng add</code> picks the pair)'],
  ),
  h3('verified', 'What is verified where'),
  p('Two kinds of evidence, and they differ. <strong>GitHub Actions</strong> runs on every push and pull request:'),
  ul(
    'the unit and integration specs of the schematics, the wrapper builders and the <code>typegpu-shaders</code> tool (they run real processes and real files in temporary projects) and both typechecks, on <strong>Linux</strong> (Node 24 and 22.22.3) and <strong>Windows</strong> (Node 24);',
    'the package is packed once on Linux, its tarball contract is checked (every file the manifest, <code>collection.json</code> and <code>builders.json</code> point to exists, no specs or local paths, bin files executable), and that exact tarball is installed into a consumer app whose library specs, production build and shader bundle check run on Linux (Node 24 and 22.22.3) and Windows (Node 24);',
    'jobs with the <strong>real Angular CLI</strong> on Linux (Node 24) from the same tarball: <code>ng new</code>, <code>ng add</code>, <code>ng generate</code>, builds, <code>ng test</code> and the shader bundle check on Angular 20, 21 and 22 in plugin mode, and the prebuild mode on Angular 22 (27 checks).',
  ),
  p('What CI does <strong>not</strong> run was checked <strong>by hand on macOS</strong> (arm64):'),
  table(
    ['', 'Verified by hand', 'Not verified'],
    ['Angular', 'CLI 22.2.4, 21.2.28 and 20.3.41, plugin and prebuild: new app, <code>ng add</code>, <code>ng generate</code>, development and production builds, bundle check, <code>ng test</code>, <code>ng serve</code> (edit, break, recover), SSR and hydration; the generated component rendered and followed its slider in a WebGPU browser (headless Chrome on Metal for Angular 22, both modes, including the SSR server and <code>ng serve</code>)', '19 and older, 23+'],
    ['Node', '24.21 for everything; 22.23 and 20.20 (Angular 20/21) and 26.10 (Angular 22) for the core cells', 'other versions'],
    ['Dev server and processes', '<code>ng serve</code>, Ctrl-C, <code>kill -9</code> at many offsets, concurrent builds and dev servers: a state-machine run with real <code>ng</code> processes passed 48 of 48 (prebuild, Angular 22)', 'all of it on Windows and Linux'],
    ['Prebuild', 'Web Workers (production bundle, in a browser), <code>ng extract-i18n</code> on 20, 21 and 22, a workspace with two applications', 'Yarn and PnP, an npm-workspaces layout with the CLI at the repository root, interactive <code>ng test</code> watch'],
    ['Package manager', 'npm; npm workspaces (Angular 22, 21); pnpm (22 and 21)', 'Yarn 2+/PnP, pnpm/Yarn workspaces; Yarn 1.22 was run once in an earlier audit and not repeated'],
    ['OS and browser', 'macOS; Chromium-based browsers with WebGPU (Chrome)', 'Safari, Firefox, non-Metal GPUs; real <code>ng</code> flows on Windows, including a real Ctrl-C'],
    ['Test runners', 'Vitest (Angular 21 and 22); Karma on Angular 20 (headless Chrome) and, in prebuild mode, on 21 and 22 with shaders transformed', 'Jest, Angular 20’s experimental Vitest builder'],
  ),
  p('Commands and results are in the repository’s <code>QA_EXECUTION_LOG.md</code>, every finding with its status in <code>QA_FINDINGS.md</code>.'),
  h3('limitations', 'Limitations'),
  ul(
    '<strong>Experimental, not production-ready.</strong> Nothing is published; the plugin mode rests on a community builder and an Angular implementation detail, the prebuild mode on experimental <code>&#64;angular/build</code> exports and state kept on disk, and several platforms and package managers were not exercised (above). The repository also has no <code>LICENSE</code> file yet (the manifest says MIT).',
    '<strong>Plugin mode: the shader build depends on a community builder</strong> and on the order of esbuild <code>onLoad</code> handlers, checked on Angular 20.3, 21.2 and 22.2 but not guaranteed for later versions. That is why the CI check exists.',
    '<strong>Plugin mode: no Web Workers</strong> (Angular passes no esbuild plugins to worker bundles; shader code there ships raw), <strong>shader modules are not transformed in Karma tests</strong> or in Angular 20’s <code>unit-test</code> target, and the dev server reloads the whole page when a shader changes. Prebuild mode has none of these.',
    '<strong>Prebuild mode:</strong> experimental Angular exports, <code>shaders-dist/</code> on disk, <code>&#64;shaders/…</code> unresolved in editors until a first build, relative and aliased imports of shader modules refused, shaders only under <code>src</code>.',
    '<strong>Vector operators</strong> (<code>a + b</code> on a <code>d.vec3f</code>) fail stock TypeScript’s type check (TS2365): use <code>std.add</code>, <code>std.mul</code> or the vector methods.',
    'A <code>\'use gpu\'</code> function that you also call <strong>on the CPU</strong> and that contains operators can fail with <code>__tsover_add is not defined</code> unless some TypeGPU code runs in the bundle first (a top-level <code>tgpu.const(…)</code> is enough).',
    '<strong>Windows:</strong> only unit and integration level evidence (CI). Real <code>ng</code> flows, a real Ctrl-C and the replacement of a file another process has open were not verified there.',
    'Device-loss recovery is manual and there is no render-on-demand scheduler.',
    '<strong>The side-by-side line counts in the examples are indicative, not a benchmark, and come from earlier rounds: they were not re-measured in the latest round.</strong> They count only the component file: about 28% fewer lines by the viewer’s count (24.8–31.6% over the six examples), roughly 14–25% under lazier or normalised counting (formatting and the metric matter), and about 10% across a whole example with its shader, model and panel files. About a third of the saved lines are hand-written change-detection caches, state helpers and wrapped imports. The manual versions reproduce the integration’s behavior, so plainer code would be shorter and behave differently. The library (about 670 code lines) and <code>manual-gpu.ts</code> (49) are not counted.',
    '<strong>Open issues.</strong> A bare <code>npm i -D @babel/core unplugin-typegpu</code> fails with <code>ERESOLVE</code> (<code>unplugin-typegpu@0.12.7</code> needs <code>typegpu ^0.12.9</code>): use <code>ng add</code>, which picks the pair. A stale hoisted plugin path is repaired only by running <code>ng add</code> again.',
    '<strong>Unverified:</strong> hydration with <code>provideTypeGpu({ root })</code> (use <code>createRoot</code>); the loop leaving the zone under real zone.js (specs are zoneless); a <code>devicePixelRatio</code>-only change reaching the <code>ResizeObserver</code>.',
    'TypeGPU itself exceeds the default 500 kB production budget, so <code>ng build</code> warns until you raise it.',
  ),
  h3('troubleshooting', 'Troubleshooting'),
  table(
    ['You see', 'Cause and fix'],
    ['Build warning <code>NG8116</code>, or <code>NG0303: Can’t bind to ’tgpuReadyElse’</code>', '<code>TgpuReady</code> is missing from the <code>imports</code> of the component that uses <code>*tgpuReady</code>'],
    ['A blank canvas and <code>NG0951</code> from <code>viewChild.required(TgpuCanvas)</code>', '<code>TgpuCanvas</code> is missing from <code>imports</code>'],
    ['<code>injectRoot() was called while the GPU is "idle"</code> (also from <code>injectUniform</code> and the others)', 'The component is not behind <code>*tgpuReady</code>. The state name tells you why there is no root'],
    ['<code>NG0203</code> from <code>injectFrame</code>, <code>injectRoot</code> or an <code>inject*</code> resource', 'Called outside an injection context: use a constructor, a field initializer or <code>runInInjectionContext</code>'],
    ['<code>ng generate</code> says the project is “not set up for TypeGPU shaders yet”', 'Run <code>ng add</code> for that project first'],
    ['“A merge conflicted on path” from <code>ng generate</code>', 'The files exist already (<code>--force</code> does not overwrite): pick another name or delete them'],
    ['<code>check:shaders</code>: “no \'use gpu\' directive … nothing was checked”', 'Wrong directory, or no shader yet: <code>--allow-empty</code>'],
    ['Build warning: <code>\'use gpu\'</code> directive not transformed', 'The file is not named <code>*.gpu.ts</code>, or (plugin mode) it is in a Web Worker bundle: prebuild mode supports workers'],
    ['Prebuild: a build refuses an import of a shader module', 'Import it as <code>&#64;shaders/…</code>, as the message says; <code>typegpu-shaders check --fix-imports</code> rewrites existing imports'],
    ['Prebuild: <code>&#64;shaders/…</code> is unresolved in the editor', 'The generated modules exist only after the first build: run any <code>ng</code> build'],
  ),
];
