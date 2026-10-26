# @typegpu-poc/angular

Angular-native lifecycle for [TypeGPU](https://typegpu.com): one shared GPU root, resources that are destroyed with their component, a signal-friendly render loop, and a canvas directive. Proof of concept, not published.

TypeGPU itself stays visible. You get a real `TgpuRoot`, real `TgpuUniform`s, real pipelines. This package only owns **who creates and who destroys** them, and **when** values reach the GPU.

## Quick path

**Prerequisites:** a standalone Angular application on the esbuild application builder (the default of `ng new`), Angular 20, 21 or 22, and a browser with WebGPU (Chrome or Edge) to see the result.

**Getting the package (not published yet).** `@typegpu-poc/angular` and `@typegpu/angular` both return 404 on npm, and the tarball is git-ignored: build it with `cd lib && npm ci && npm run pack` (creates `lib/typegpu-poc-angular-0.0.1.tgz`). The installable name is `@typegpu-poc/angular` (provisional; `@typegpu/angular` is the intended future name and appears only in the site's headings). npm records the dependency as a relative `file:` path, so teammates and CI need the tarball at the same relative place.

```sh
ng add /abs/path/to/typegpu-poc-angular-0.0.1.tgz --skip-confirmation   # the flag is needed without a terminal
ng generate @typegpu-poc/angular:component my-canvas
```

Then put `<app-my-canvas />` in a template, add `MyCanvas` to the `imports` of that component, and run `ng serve`. You get an animated gradient whose tint follows a slider, drawn by a `'use gpu'` shader in `src/app/my-canvas/my-canvas.gpu.ts`, with messages for "no WebGPU", "init failed" and "device lost". `npm run check:shaders` (added by `ng add`) is the CI check that every shader was transformed.

Before adopting it, read "Shader authoring" (limits) below: shaders need a **community builder** and an Angular implementation detail, and the Angular 20 default (Karma) test setup does not transform shaders.

## Compatibility: what was actually verified

Run on **macOS (arm64) with Node 24.21.0**, the only Node version tested (Angular's own Node requirements apply). Who ran which check, and what was only reported to the author, is in `docs/VERIFICATION.md`; the scripts are in `scripts/`.

| | Verified | Not verified |
|---|---|---|
| Angular | CLI 22.2.4 / core 22.2.3, CLI 21.2.28 / core 21.2.25, CLI 20.3.41 / core 20.3.34: new app, `ng add`, `ng generate`, unit tests, development and production builds, shader bundle check, a second `ng add`; the generated component rendered, animated and followed its slider in a WebGPU browser on all three (20.3 with zone.js, 21.2 and 22.2 zoneless) | 19 and older, 23+ |
| `typegpu` | 0.12.8 and 0.12.9 (the peer range `^0.12.8` and the schematic accept any later 0.12.x, which was not run), with `unplugin-typegpu` 0.12.6 or 0.12.7 (the pairs 0.12.8+0.12.6, 0.12.9+0.12.7, 0.12.9+0.12.6; the generated shader resolves to WGSL in each) | other 0.12.x, 0.13+ |
| Package manager | npm; npm workspaces with hoisted dependencies (22, 21); pnpm (22, strict `node_modules`); Yarn 1.22 (22, one full flow) | Yarn 2+/PnP |
| OS / Node | macOS arm64, Node 24.21.0 | Linux, Windows, other Node versions |
| Browser | one Chromium-based browser with WebGPU | Safari, Firefox |
| Test runners | Vitest (Angular 21 and 22 default, custom `unit-test` builder); Karma on Angular 20 in headless Chrome (the generated spec only; no shader transform there) | Jest, Angular 20's experimental Vitest builder |
| Zone.js | not required (zoneless on 21/22); an app that uses it works (browser, 20.3). Specs are zoneless: a spec pins that the loop requests frames through `NgZone.runOutsideAngular`; real zone.js behaviour was not observed | specs under zone.js |

**Shader prebuild with the wrapper builders** (`ng add --shaders prebuild`), verified end to end with the **packed package** installed by the real `ng add` into clean `ng new` projects (2026-10-26, macOS arm64, Node 24.21.0): Angular **22.2.4**, **21.2.28** and **20.3.41** with npm (20.3 with Karma in headless Chrome, 21.2 and 22.2 with Vitest); Angular 22.2.4 with **pnpm 12.10.1** (strict `node_modules`); an Angular 22.2.4 **SSR** project (prerendered, server bundle, hydration in a WebGPU browser); an Angular 22.2.4 **Web Worker** that imports a shader (production bundle and in a browser); a workspace with **two applications** in `projects/` (each built and tested); a second `ng add` (nothing changed); `ng extract-i18n` (Angular 20) and `ng build --watch` (22). In each: a bare `ng build` rebuilds a stale shader and skips the work when current, fails with file, line and the candidate lines on a transform error and builds nothing, refuses a relative import of a shader module, and `ng test` runs. The dev server (`ng serve`) was exercised on 22.2 (in a browser: banner, recovery, edit to served 0.6 to 0.8 s), 21.2 (0.3 to 0.4 s) and 20.3 (0.9 to 1.0 s). **Not verified:** Yarn and Yarn PnP, Windows, Linux, Node versions other than 24, Angular 19 or 23+, an npm-workspaces layout with the Angular CLI installed at the repository root, Karma on Angular 21/22 (the wrapper handles `runner: karma` of the unit-test builder and the `@angular/build:karma` builder; only Angular 20's was run), interactive (TTY) `ng test` watch mode.


**Added by the QA run (2026-10-26, packed package, macOS arm64):** Node 22.23 and 20.20 (Angular 20/21 only; Angular 22 needs Node 22.22+) and Node 26.10 (Angular 22) with npm for the six core cells (3 Angular majors × plugin/prebuild: dev and production build, bundle check, `ng test`, `ng serve`, a canvas rendered in headless Chrome); Karma on Angular 21 and 22 through the prebuild wrappers (`:karma`, and `:unit-test` with `runner: karma`: shaders are transformed there); prebuild SSR on 20, 21 and 22 (after the schema fix) and plugin SSR on 21 and 22; hydration in Chrome (prerendered, `ng serve` SSR, the Node server) with and without WebGPU; `--localize` with two locales and `--base-href`/`--deploy-url` builds. Known gaps found there: Angular 20.3 SSR in plugin mode needs the `security` block removed from the build options (custom-esbuild 20.0.0's schema rejects it; `ng add` warns); a project created with `--no-zoneless` needs the generated spec of this version (it waits for the asserted text); `ng generate web-worker` adds `webWorkerTsConfig` to the test target (accepted by the prebuild wrappers, rejected by `custom-esbuild:unit-test`: delete it there); with the prebuild, `ng extract-i18n` (and other stock targets) need `shaders-dist` (run `ng build` or `typegpu-shaders build` first); pnpm with `CI` set fails `ng add` at its frozen-lockfile install (the same happens with `ng add @angular/material`; run `pnpm install --no-frozen-lockfile`).

## What `ng add` and `ng generate` do

For a standard standalone Angular application.

**`ng add` changes** (one application per run: the CLI takes the project from the directory you run it in, so in a workspace with several applications run it inside the application's folder or pass `--project <name>`; running it again changes nothing, except that it repairs a stale plugin or check path, for example after a later install hoisted the dependencies; a hand-corrected path that resolves to the plugin is accepted, not duplicated):
- `angular.json`: `build`, `serve` and `test` move to `@angular-builders/custom-esbuild:application`, `:dev-server` and `:unit-test` (starting from the stock `@angular/build:*` or the legacy `@angular-devkit/build-angular:application` / `:dev-server`); the shader plugin is added to `build.options.plugins` (and to any `configurations.*.plugins`, which replace the global list) under the **real relative path** (`../../node_modules/...` when dependencies are hoisted to a workspace root); the test target gets `buildTarget`, `tsConfig` and `reporters` unless you set them, and stock-only options the custom schema rejects (`runner`, `splitting`, ...) are removed and logged. Everything else is kept; the file is reformatted.
- `package.json`: `typegpu` (`0.12.8`) in `dependencies` (only a peer of this package, which npm would install without listing it: the app imports it, so it is declared) and, as `devDependencies`, `@angular-builders/custom-esbuild` (your Angular's major), `@babel/core ^7.28.0` and `unplugin-typegpu` (0.12.6 for `typegpu` 0.12.8, 0.12.7 for 0.12.9). Existing entries are kept. It adds the script `check:shaders` (production build plus the bundle check; `check:shaders:<project>` with several applications; an existing script is never replaced). npm then installs everything.
- It does **not** edit your application code or providers (`provideTypeGpu()` is only for configuration).
- It **refuses**, with a message that says what to do, when the build target is not the esbuild application builder (webpack: run `ng update @angular/cli --name use-application-builder` first), when the dev server is another builder, when `plugins` is not a list, or when `typegpu`, `@babel/core` or Angular are outside the supported versions. A refusal leaves `@typegpu-poc/angular` itself installed (the CLI installs it before running the schematic); `angular.json`, the rest of `package.json` and your sources are not modified. Undo with `npm uninstall @typegpu-poc/angular`. A Karma test target (the Angular 20 default) is left unchanged with a warning, and so is a stock `unit-test` target on Angular 20 (`custom-esbuild` 20 has no `unit-test` builder).
- Failures before the schematic runs are npm's: Angular 19 stops with `ERESOLVE` (the schematic's "Angular 19 is not supported" shows only with `--legacy-peer-deps` or `--force`); with `@angular-devkit/build-angular` 22 installed a peer conflict on `@babel/core` is bypassed by `--legacy-peer-deps` for that one run (verified). The CLI also prints "unmet peer dependencies": the schematic adds them next.
- Every `ng test` prints a warning that the `application` build target of `custom-esbuild:unit-test` is "not supported". Expected.
- `npm run check:shaders` **fails until the build contains a shader** (zero directives is an error, so a wrong directory cannot pass). Before the first shader exists, run the check tool with `--allow-empty` (warns, exits 0) or generate a component first; the `ng add` log says so.

**`ng add --shaders prebuild`** sets the project up for the shader prebuild instead of the plugin (see "Shader prebuild" below); the plugin mode stays the default and is not changed. It changes:
- `angular.json`: the **builder names** of `build`, `serve` and `test` move to this package's wrapper builders (`@typegpu-poc/angular:application`, `:dev-server`, and `:unit-test` or `:karma`); every option and configuration stays. From then on `ng build`, `ng serve` and `ng test` build the shaders first, however they are started. No npm script is touched.
- `package.json` dependencies, only when absent: `typegpu` `0.12.8`, `@babel/core` `^7.28.0`, `unplugin-typegpu` (0.12.6 for `typegpu` 0.12.8, 0.12.7 for 0.12.9) and `esbuild` `^0.28.2` (the tool uses the project's own copies; `typescript` must already be there).
- the tsconfig files: `compilerOptions.paths["@shaders/*"]` pointing into the project's shader output (`<project root>/shaders-dist`), edited in place with comments kept. Usually one edit in the config the app, test and worker tsconfigs extend; when that config is shared with another application of the workspace, each tsconfig of the project gets its own entry. All of the project's tsconfigs (build, test, web worker) must see it.
- `.gitignore`: a `shaders-dist/` line (a note instead when there is no `.gitignore`).
Several applications are supported (`--project <name>` for each; each has its own `shaders-dist` in its project folder). `ng add` **refuses** (nothing changed except that the package itself stays installed, as in the plugin mode) a project already set up with the plugin mode (community builders, or the plugin in an options list), a build target that is not the stock `@angular/build:application`, a serve target that is not the stock dev server, a missing `tsConfig` or `typescript`, `@shaders/*` already mapped elsewhere, a `baseUrl` other than the config's own folder, an `extends` that is a package or a list, an invalid tsconfig, a shared tsconfig whose existing `paths` cannot take a mapping per application, and the same unsupported versions as the plugin mode. A test target of another builder (for example the webpack Karma builder) is left unchanged with a warning. Running it again changes nothing. Angular majors other than 22 get a warning (verified on 20.3, 21.2 and 22.2, see below). `ng generate @typegpu-poc/angular:component` works in both modes: in a prebuild project the component imports its shader as `@shaders/<path under the source root>/<name>.gpu`.

**`ng generate` creates** `src/app/my-canvas/` (or `--path`, `--project`; same conventions as `ng generate component`, including creating the component in the folder you run it from): `my-canvas.ts` (the component `MyCanvas`, selector `app-my-canvas`, plus an internal `MyCanvasScene`), `my-canvas.gpu.ts` (the shader) and `my-canvas.spec.ts` (`--skip-tests` omits it; it needs no GPU: it uses `createFakeTypeGpu()`). The name must dasherize to `^[a-z][a-z0-9-]*$` (`foo.bar` is refused), and `foo` clashes with an existing `foo-scene` (and the reverse). It refuses to overwrite files ("A merge conflicted on path"); `--force` appears in `--help` but is a CLI-level option that does not overwrite (CLI 22.2.4, also for the built-in component generator), so delete the files or pick another name. It refuses projects that `ng add` has not configured. The component is the quick start below, split so that GPU code lives behind `*tgpuReady`; edit it freely. The shader file must be named `*.gpu.ts` and imported as `./my-canvas.gpu` (see "Shader authoring").

**In CI**, run `npm run check:shaders`: it builds for production and exits 1 if any `'use gpu'` function was not transformed (checked: it fails when the plugin is disabled in the production configuration, which a green build and green tests would not reveal). The first CI run after `ng add` fails by design while no shader exists.

## Quick start (by hand)

Without `ng add`: install the tarball next to `typegpu`, which you must list yourself (`npm install /abs/path/typegpu-poc-angular-0.0.1.tgz typegpu@0.12.8`; build the tarball as described above). This path uses WGSL templates with the stock builders. The two files below are the generated component written out.


```ts
// gradient.ts — a component that exists only while a GPU root is ready
import { Component, computed, input, viewChild } from '@angular/core';
import tgpu, { common, d } from 'typegpu';
import { TgpuCanvas, injectFrame, injectRoot, injectUniform } from '@typegpu-poc/angular';

@Component({
  selector: 'app-gradient',
  imports: [TgpuCanvas],
  template: `<canvas tgpuCanvas></canvas>`,
  styles: `canvas { width: 100%; height: 240px; display: block; }`,
})
export class Gradient {
  readonly hue = input.required<number>();

  private readonly root = injectRoot();                 // the plain TgpuRoot
  private readonly canvas = viewChild.required(TgpuCanvas);

  private readonly time = injectUniform(d.f32);         // destroyed with this component
  private readonly tint = injectUniform(d.vec3f, {      // mirrors a signal (see below)
    from: computed(() => d.vec3f(this.hue() / 360, 1 - this.hue() / 360, 0.6)),
  });

  private readonly pipeline = this.root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })`{
      return vec4f(in.uv * (0.5 + 0.5 * sin(time)), 0.3, 1) * vec4f(tint, 1);
    }`.$uses({ time: this.time, tint: this.tint }),
  });

  constructor() {
    injectFrame(({ elapsedSeconds }) => {
      const context = this.canvas().context();
      if (!context) return;
      this.time.write(elapsedSeconds);
      this.pipeline.withColorAttachment({ view: context }).draw(3);
    });
  }
}
```

```ts
// app.ts — the only place that has to know the GPU may be missing
import { Component, inject, signal } from '@angular/core';
import { TgpuReady, TypeGpu } from '@typegpu-poc/angular';
import { Gradient } from './gradient';

@Component({
  selector: 'app-root',                    // required when this is the bootstrapped root component
  imports: [Gradient, TgpuReady],
  template: `
    <input #slider type="range" min="0" max="360" [value]="hue()" (input)="hue.set(slider.valueAsNumber)" />
    <app-gradient *tgpuReady="let root; else fallback" [hue]="hue()" />
    <ng-template #fallback let-state>
      @switch (state.status) {
        @case ('unsupported') { <p>WebGPU is not available in this browser.</p> }
        @case ('failed')      { <p>GPU initialisation failed. <button (click)="gpu.retry()">Retry</button></p> }
        @case ('lost')        { <p>The GPU device was lost. <button (click)="gpu.retry()">Reconnect</button></p> }
        @default              { <div style="height: 240px"></div> }
      }
    </ng-template>
  `,
})
export class App {
  protected readonly gpu = inject(TypeGpu);
  protected readonly hue = signal(120);
}
```

No provider, no `ApplicationConfig` change. `TypeGpu` is `providedIn: 'root'`. Use `provideTypeGpu({...})` only to configure it. `TypeGpu.state()` is a signal of an **object** (`{ status, error?, ... }`), not a string: read `gpu.state().status` (`{{ gpu.state() }}` prints `[object Object]`). In the `else` template `let-state` is that object, untyped (Angular cannot type it): `state.status` and, for `failed`, `state.error`. The `*tgpuReady` content template is fully typed.

`TgpuCanvas` and `TgpuReady` must be in the `imports` of the components that use them (see "Troubleshooting"), and the `<canvas>` needs a CSS size, as above: `tgpuCanvas` sizes the bitmap *from* the layout size, so without one it switches resizing off with a console warning.


## The model in six rules

1. **One root per injector, created lazily, in the browser, after the first render.** It never delays bootstrap and never runs on the server. Its state is the signal `TypeGpu.state()`, an object whose `status` is `idle | initializing | ready | unsupported | failed | lost`.
2. **`*tgpuReady` is the async boundary.** Content inside it only exists while a root is ready, so it may call `injectRoot()` synchronously. When the device is lost, the content is destroyed (all cleanups run); `TypeGpu.retry()` makes a new root and the content is created again.
3. **`inject*` resources belong to the injection context that created them** (component, directive, service) and are destroyed with it: `injectUniform`, `injectMutable`, `injectReadonly`, `injectBuffer`. Everything else (pipelines, bind groups, samplers, textures) you create from `injectRoot()` yourself; textures and other memory-holding objects are yours to `destroy()` (use `inject(DestroyRef).onDestroy(...)`).
4. **Signals that feed a render loop are sampled once per frame** (`{ from: signal }`), before your frame callbacks. A value is written to the GPU only when it changed (`Object.is`: replace, don't mutate). Everything not rendered every frame can use a plain `effect(() => uniform.write(...))`.
5. **One animation loop for the whole app.** `injectFrame` registers a callback; it runs outside the zone and stops with its owner. Its first call, and the first `from` sample, happen after the owner's first render, so `viewChild.required()` and signal inputs are available.
6. **Work is bound to the root it was created for.** Frame callbacks and `from` writes run only while that root is `ready`. After device loss they stop in the same frame the loss is published; they never resume on the root made by `retry()`. Behind `*tgpuReady` the owner is recreated for the new root instead.

## API

| Export | Purpose |
|---|---|
| `TypeGpu` | Service: `state()`, `root()` (signals), `whenReady()`, `retry()` |
| `provideTypeGpu({ options?, root?, createRoot? })` | Optional config for the injector it is provided in (normally `ApplicationConfig`). `root` = use an existing root (never destroyed by us, ready immediately, so with SSR/hydration prefer `createRoot`); `createRoot` = custom factory, e.g. `() => tgpu.initFromDevice({ device })`; the service owns and destroys the root it returns. Provided in a route or child injector it creates a **separate** service (and device) for that injector |
| `*tgpuReady` (`TgpuReady`) | Renders content only while ready; `else` template gets the state |
| `injectRoot()` | Synchronous `TgpuRoot`; throws with guidance when not ready |
| `injectUniform / injectMutable / injectReadonly / injectBuffer (schema, { initial?, from? })` | Owned resources (see rules 3 and 4) |
| `injectFrame(cb, { maxDeltaSeconds }?)` | Per-frame callback `{ deltaSeconds, elapsedSeconds }`; returns `{ paused, pause(), resume() }`. **`deltaSeconds` is clamped to `maxDeltaSeconds` (default 0.25 s) since this version; it used to be the raw gap.** `Infinity` restores that, `<= 0` or `NaN` throws `RangeError`; the first frame after a hidden tab or `resume()` is clamped too. `elapsedSeconds` is real time since the first frame. Needs an injection context (constructor, field initialiser, `runInInjectionContext`). `FrameOptions` is exported |
| `canvas[tgpuCanvas]` (`TgpuCanvas`) | Configures a WebGPU context and keeps the canvas pixel size in sync with its CSS size (the canvas must have one). `[tgpuCanvas]="{ alphaMode: 'premultiplied', autoResize: true }"`, `(resized)`, `context()` and `size()` signals, and `maxPixelRatio` (default no limit; caps canvas pixels per CSS pixel to bound the cost of a heavy fragment shader on high-DPI screens). The context is reconfigured only when the root or an option that reaches WebGPU changes (compared by value): `autoResize` and `maxPixelRatio` never clear the canvas. Needs a canvas without another context type. Without `ResizeObserver` (jsdom) the size is not tracked |
| `@typegpu-poc/angular/testing` | `createFakeTypeGpu()`, `installManualAnimationFrames()` |

## Signals and uniforms: which one do I use?

| Your value is... | Use | Why |
|---|---|---|
| derived from UI state and shown every frame (hue, zoom, selection) | `injectUniform(schema, { from: signal })` | Visible to the same frame's draw call, written only on change, safe with `input.required()` |
| changes every frame (time, a simulation head) | `uniform.write(...)` in your `injectFrame` callback | You already have the number; no signal needed |
| changes rarely and is not tied to a frame (a config panel) | `effect(() => uniform.write(sig()))` | Fine, if you accept that the write happens when Angular flushes effects rather than at a defined point before the frame callbacks |
| fixed after creation | `injectUniform(schema, { initial })` | |
| a different schema, size or root | recreate the owner (`@if`, `@for` track) | Schemas are fixed per resource on purpose |

`from` compares with `Object.is`: replace the value, don't mutate it (pushing into the array a signal holds is not seen); `NaN` is written once, `-0` differs from `0`. It never reads the signal before the owner's first render, and a required `input()` with no value yet (NG0950) is skipped until it has one. A `from` resource keeps the shared loop running while its owner lives (one `Object.is` per resource per frame), deliberately: the value is sampled before the frame callbacks of the same tick, so a value set before the frame is written in that frame (by construction; an earlier "effect is one frame late" measurement could not be reproduced, see `docs/DECISIONS.md` D4). With no `from` resource and no active frame callback the loop requests no frames. A throwing `from` write is reported once and that resource stops mirroring until its owner is recreated.

## Ownership and cleanup

| Thing | Created by | Destroyed by |
|---|---|---|
| `TgpuRoot` and its device | `TypeGpu` (via `tgpu.init` or `createRoot`) | `TypeGpu`, **exactly once, and only a root it created**: when its injector is destroyed (after the components' resources) and when `retry()` replaces a lost root (`destroy()` on a lost device does not throw: checked in Chrome). A root passed as `provideTypeGpu({ root })` is never destroyed; a root that arrives after the service was destroyed is released at once. Afterwards `root()` is `undefined` and `whenReady()` rejects |
| uniforms, buffers (`inject*`) | the component/directive/service that called `inject*` | `DestroyRef` of that owner, immediately (in an owner that is already destroyed, `inject*` releases the buffer it made and rethrows) |
| pipelines, bind groups | you | nothing to release (no `destroy()`). TypeGPU keeps a 12-byte uniform buffer per `createGuardedComputePipeline` for the root's lifetime; this package does not own it |
| textures and other raw GPU memory | you | you, via `DestroyRef` |
| the frame callback | `injectFrame` | its owner's `DestroyRef` |
| canvas context / ResizeObserver | `tgpuCanvas` | observer disconnected and the context `unconfigure()`d on destroy and on device loss |

Shared resources: create them in a service and `inject()` the service; the service's lifetime is then their lifetime. Do not destroy a resource you received from someone else.

Note: TypeGPU creates the underlying `GPUBuffer` lazily, so a component destroyed before its first frame may never have allocated one.

## Shader authoring

Two ways, both type-safe:

1. **WGSL templates** (`tgpu.fn`, `tgpu.fragmentFn` as in the quick start): no build setup.
2. **`'use gpu'` TypeScript functions** in modules named `*.gpu.ts`, transformed at build time. `ng add` performs the setup below for you; this is what it does, for reference or for configurations it refuses (verified in `ng build` development and production, `ng build --watch`, `ng test` and the shader bundle check on Angular 20.3, 21.2 and 22.2, with npm and pnpm; `ng serve` and SSR on 22.2):

```sh
npm i -D @angular-builders/custom-esbuild @babel/core@^7.28 unplugin-typegpu@0.12.6
```

Versions matter. The optional peer is `@babel/core ^7.28.0` (a bare `npm i -D @babel/core` installs Babel 8 and fails with `ERESOLVE`; `--legacy-peer-deps` would leave the test builder without Vite). `unplugin-typegpu` must match your `typegpu`: 0.12.6 with 0.12.8, 0.12.7 with 0.12.9 (0.12.7 declares `typegpu ^0.12.9`). So a bare `npm i -D @babel/core unplugin-typegpu` fails with `ERESOLVE` while `typegpu` is pinned to 0.12.8: prefer `ng add`. A `package.json` that says `^0.12.8` with 0.12.9 installed works with `unplugin-typegpu` 0.12.6.

```jsonc
// angular.json (projects.<name>.architect)
"build": { "builder": "@angular-builders/custom-esbuild:application",
           "options": { "plugins": ["node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs"], /* ... */ } },
"serve": { "builder": "@angular-builders/custom-esbuild:dev-server", /* ... */ },
"test":  { "builder": "@angular-builders/custom-esbuild:unit-test",
           "options": { "buildTarget": "<name>:build:development", "tsConfig": "tsconfig.spec.json", "reporters": ["default"] } }
```

- A `plugins` entry is a **file path relative to the workspace root**, not a package specifier (`@typegpu-poc/angular/tools/...` fails with "Cannot find module"), and with hoisted dependencies it must point to where the package really is (`../../node_modules/...`); `ng add` writes that and repairs a stale one.
- The stock `@angular/build:unit-test` has no plugin hook and ignores `plugins` silently, so shader specs fail with TypeGPU's "Missing metadata": replace it as above.
- A `plugins` list inside a build configuration (for example `production`) replaces the global one: include this plugin there.

```ts
// src/shaders/gradient.gpu.ts  (no Angular decorators in *.gpu.ts)
import tgpu, { d, std } from 'typegpu';
export function gradientFragment(time: { $: number }, tint: { $: d.v3f }) {
  return tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })((input) => {
    'use gpu';
    const wave = 0.5 + 0.5 * Math.sin(time.$);
    return d.vec4f(std.mul(d.vec3f(input.uv.x * wave, input.uv.y * wave, 0.3), tint.$), 1);
  });
}
```

Import it as `'../shaders/gradient.gpu'`. These specifier forms are all matched, because the plugin lets esbuild resolve the import first and the resolved path decides: relative with or without the `.ts` extension, `./x.gpu.js` for `x.gpu.ts`, tsconfig `paths` aliases (an alias that resolves to a `*.gpu.ts` file is transformed) and `baseUrl` imports, dynamic `import()`, barrels that re-export a `.gpu` module, and `.gpu.js`/`.gpu.mjs` modules. A file imported through several specifiers is still one module. (`import './a.gpu.ts'` needs `allowImportingTsExtensions` and `noEmit`: TypeScript's rule.) `@webgpu/types` is not needed to build.

**Guard against silent breakage.** If the plugin is not applied, the build still succeeds and `'use gpu'` functions are shipped raw. Two checks, together:
- a spec that checks one `'use gpu'` function carries TypeGPU's metadata. It covers the **test** build only:

  ```ts
  import { expect, it } from 'vitest';
  import { wave } from './gradient.gpu'; // any 'use gpu' function of yours
  it('shader modules are transformed by the build plugin', () => {
    const meta = (globalThis as { __TYPEGPU_META__?: WeakMap<object, unknown> }).__TYPEGPU_META__;
    expect(meta?.has(wave), 'check angular.json plugins, the custom-esbuild test builder and the .gpu import specifier').toBe(true);
  });
  ```

- after `ng build` (also `-c production`), run `node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs [--allow-empty] dist/<app>/browser [<dir>...]` (`npm run check:shaders` does this). It scans `.js`, `.mjs` and `.cjs` files recursively in one or more directories and names each `'use gpu'` directive that was not transformed. Exit codes: 0 all transformed; 1 an untransformed directive **or no directive at all** (so a wrong directory cannot pass; `--allow-empty` turns that into a warning for an app without shaders yet); 2 bad usage or a missing directory (one-line error). A small dependency-free lexer finds the directives (it skips strings, templates and comments, and accepts parenthesised function wrappers such as real `@typegpu/noise` output); a worker bundle is named in the hint. Verified to catch a production-only plugin override that leaves the tripwire spec green.

How it works: Angular's compiler plugin registers `onLoad` handlers for every `.ts`/`.js` file without a namespace, so a normal plugin never sees the files. The shipped plugin redirects `*.gpu` imports (`onResolve`) to a virtual path without a script extension, which those handlers do not match, then runs `unplugin-typegpu/babel` on the original file; type checking still sees the original source. `TYPEGPU_SHADERS_LOG=1` logs which imports were matched. A missing `@babel/core` / `unplugin-typegpu` stops the build at start with a hint that prints the exact peer ranges and recommends `ng add`; a syntax error in a `*.gpu.ts` is reported with file, line and column; an error raised by unplugin-typegpu itself (for example "Unsupported JS functionality: TryStatement") names the file and its `'use gpu'` lines, without an exact line; source maps use workspace-relative `sources`.

Limits (verified unless noted):
- The plugin redirects only resolved project files named `*.gpu.<ts|mts|js|mjs>`. Shader code in other files is not transformed; the build **warns** about a `'use gpu'` directive in a project file that was not (for example in a plain `.ts`: move it to `*.gpu.ts`). The warning reads Angular's esbuild metafile, which is always on.
- **Web Workers are not supported.** Angular's application builder does not pass user esbuild plugins to worker bundles, so shader code in a worker is bundled raw. The build warns and `check-shader-bundle` names the worker bundle; no workaround was verified.
- `custom-esbuild` is a community builder, and the plugin depends on Angular's un-namespaced `onLoad` ordering: read in `@angular/build` 20.3.41, 21.2.28 and 22.2.4 and run against all three, not guaranteed later. Its `unit-test` builder warns that the `application` build target is "not supported" and needs explicit `buildTarget`, `tsConfig`, `reporters`; `custom-esbuild` 20 (the only 20.x release) has no `unit-test` builder, so on Angular 20 shaders are not transformed in unit tests.
- **Default resolve conditions are lost** (found by QA; the CLI, not this package, causes it): for a third-party builder the CLI fills `conditions: []`, which Angular's application builder treats as "custom conditions", so `module` and `development`/`production` are no longer used when the application is bundled (`ng build`, and `ng serve --prebundle=false`). A dependency whose `exports` use those keys then resolves to its `default` file, unlike under the stock builder (verified with fixture packages; the default TypeGPU app's own dependencies bundle identically). Workaround: set `"conditions": ["module", "production"]` (`"development"` in the development configuration) in the build options. The prebuild wrappers do not have this problem.
- The dev server reloads the whole page when a shader changes (no HMR). In `ng build --watch` (run on 20.3, 21.2, 22.2: edit, syntax error, fix, helper edit, new and removed module all rebuild) a failed build keeps the previous bundle until fixed and names file, line and column; a `.gpu` file created *after* a failed "could not resolve" import does not rebuild by itself: edit the importer. `scripts/verify-shader-watch.mjs` reproduces this.
- No Angular decorators in `*.gpu.ts` (the build fails with a Babel message that wrongly suggests Babel plugins: remove the decorator instead).
- A shader file inside `node_modules` is transformed by `ng build` but not by `ng test`. Keep shader sources in your project.
- A `'use gpu'` function that you also **call on the CPU** and that contains operators (even `t * 2 + 1`) is rewritten to `__tsover_add(...)`, defined by `tsover-runtime`, which `typegpu` loads as a side effect when *executed*. If no `typegpu` code runs before the call (the unused `import` is dropped: `typegpu` is `sideEffects: false`), it fails with `ReferenceError: __tsover_add is not defined` (reproduced in `ng test`, npm and pnpm; resolving to WGSL is unaffected). Running any `typegpu` code at module load avoids it (a top-level `tgpu.const(...)`: verified with pnpm); `import 'tsover-runtime'` works with npm but **fails under pnpm** (`TS2882`). An issue in TypeGPU's own tooling.
- Vector operators (`a + b` on `d.vec3f`) fail type checking under stock TypeScript (TS2365). Use `std.add/mul/...` or `.add()/.mul()`; scalar operators are fine. Plain helper functions without `'use gpu'` type-check but fail at resolve time.
- Not verified: Windows paths (the fallback matcher only recognises `./` and `/`), vitest watch mode, source-map line accuracy.
- Fallback if the community builder cannot be adopted: a pre-build Babel step that generates `*.ts` files, which has its own problems (a second watch process, type errors reported on generated code).

## Shader prebuild: shaders without a custom builder or a plugin

An alternative to the esbuild plugin above. The `'use gpu'` modules are transformed **before** Angular builds, by the `typegpu-shaders` tool that ships in this package, and the application imports the result as plain JavaScript. Nothing in Angular's build is replaced or hooked, so Web Workers and the stock `unit-test` / Karma builders work with shaders. The Angular integration (`injectUniform`, `TgpuCanvas`, ...) does not depend on it; use either approach, or neither.

**What it does.** Entry points are the files ending in `.gpu.ts` under the project's source root. The tool finds every project module they import (models, layouts, helpers), transforms each file (esbuild + `unplugin-typegpu`, TypeScript syntax kept until esbuild strips it), and writes `shaders-dist/` with `.js`, `.js.map`, `.d.ts`, `.d.ts.map` per module and a `.manifest.json`. Declarations come from the TypeScript API with the project's tsconfig. Source maps point to the original `.ts` files. Application code imports all of it as `@shaders/<path under the source root without .ts>`, never by a relative path (the build refuses those: a relative import would bundle the untransformed source, and a module used by both a shader and the application would exist twice).

**Setup: `ng add <package> --shaders prebuild`** (see "What `ng add` and `ng generate` do"). Peers the tool needs from your project: `esbuild`, `typescript`, `@babel/core@^7.28`, `unplugin-typegpu`.

**How freshness is guaranteed: the builders.** The `build`, `serve` and `test` targets run this package's wrapper builders (`builders.json`; Architect builders loaded by the Angular CLI like any other). Each one (1) makes sure `shaders-dist` is current for the sources, rebuilding it when it is not (a fast check when it is), (2) refuses to go on when a shader fails to build or when application code imports a shader module by a relative path or an `@shaders/...` module that does not exist, then (3) runs the official Angular builder for the same target with the same options, and after a finished application build (4) scans the output and fails the build if an untransformed `'use gpu'` is in it. So `ng build`, `ng serve`, `ng test`, `ng run`, an IDE task or CI cannot bundle a shader older than its source, with no special command to remember.
- The official builder is run through the functions `@angular/build` exports for that (`buildApplication`, `executeDevServerBuilder`, `executeUnitTestBuilder`, `executeKarmaBuilder`; **Angular marks them experimental**), with options prepared as the CLI prepares them for an `@angular/build:*` builder (validated against the installed schema, with its defaults, no empty-array fillers). Going through `context.scheduleBuilder` instead changes how the official builders behave (it fills empty arrays: `reporters: []` makes `ng test` print nothing); it remains the fallback when an installed `@angular/build` lacks the export, and then says so in the log. The official dev-server and unit-test builders also read and validate the build target's options themselves; they are told the build target is `@angular/build:application` and its options are validated against the installed official schema, because validation against the wrapper's schema fills `conditions: []`, which makes Angular drop its default resolve conditions (`module`, `development`/`production`) from the bundle.
- The wrappers carry a copy of the official option schemas, because the CLI parses command-line flags from the builder's schema: `builders/schemas/*.json`, generated by `scripts/sync-builder-schemas.mjs` from `@angular/build` 20, 21 and 22 (application, dev-server and karma are identical across the three; unit-test is a union without defaults). An option of a newer Angular that the copy lacks cannot be used as a flag (set it in angular.json instead); the wrapper warns when it sees one.
- `ng serve`, `ng build --watch` and `ng test` keep rebuilding (a test run watches exactly when the official builder does: `--watch`, or an interactive terminal outside CI, or `--ui`; otherwise it gets the one-off build and fails on a shader error) the shaders on every change. A shader that fails to transform is not silently left on its previous output: its generated module becomes a stub that prints the error (`file:line:column`, or the file and the candidate `'use gpu'` lines when the transform gives no position), shows it in a red banner on the page, and throws when imported; the terminal prints the same. Fixing the file replaces the stub, the dev server reloads, and the banner is gone. When the session ends with a shader still broken (also on Ctrl-C), the stub is removed, so a later build fails instead of bundling it; a stub that another process has replaced by a real module is left alone. Saving a file that no shader imports builds nothing. A relative import of a shader module in application code is reported in the terminal (the dev server would otherwise bundle the raw source without a word). A one-off build with a failing shader fails with the same diagnostics and builds nothing.
- Until the first shader exists the builds run as before (nothing is written). `typegpu-shaders check --fix-imports` rewrites existing relative imports of shader modules to `@shaders/...`.

**The command line** (`typegpu-shaders`, for projects that do not use these builders or for CI) has `build`, `watch`, `check`, `run -- <cmd>` and `dev -- <cmd>`; options `--src`, `--out`, `--suffix`, `--alias`, `--tsconfig`, `--root`, `--config` (or `typegpu-shaders.config.json`). `check` exits 1 for output that is missing, stale, incomplete or from a failed build, and for stray or unresolved shader imports; `typegpu-check-bundle <dirs>` is the bundle scan on its own. The same functions are exported by `tools/typegpu-shaders/index.mjs` (`buildShaders`, `watchShaders`, `checkShaders`, `ensureShaders`, `watchEnsure`). Without the builders a bare `ng build` is NOT protected (an edit after the last build ships the old shader); use the wrapper commands and `check` in CI.

**Limitations.**
- The set of modules a shader imports is found by scanning import specifiers (relative `.ts` imports); path aliases or non-TypeScript files imported by a shader module are not followed.
- `ng serve` and an `ng build` / `ng test` started at the same time in the same project share `shaders-dist`. There is no lock: the generated files are written atomically (a finished temporary file is renamed into place, and a file whose content did not change is not touched), the manifest records a digest of the files the build wrote (files that are not those count as stale), and a one-off build never deletes a dev server's stub, so the sessions do not corrupt each other; when both find the output stale at once, both build it (the same bytes). Not verified on Windows, where replacing a file another process has open can fail (the write retries).
- Shader modules, and everything they import, must be under the source root (`src`): an import of a module outside it fails the build with a message (nothing is written outside the output folder). Shader modules import each other by relative paths, not by `@shaders/...`.
- Only relative specifiers and `@shaders/...` are checked statically. A shader reached through a tsconfig `paths` alias or a `baseUrl` path is bundled raw: `ng build` fails afterwards in the bundle check (naming the bundle file, not the importer); `ng serve` and `ng test` report nothing and fail at runtime with "Missing metadata". The static check ignores whole-line comments, but still reads import-looking text in strings and in comments that follow code, so such text (`"import x from './a.gpu'"`) is reported (reword it).
- The output folder (`out`) is the tool's: it deletes the files its manifest lists when their module is gone, and nothing else; an `out` that is, or contains, the project or `src` is refused. Deleting `shaders-dist` while `ng serve` runs is not repaired until a `.ts` file is saved (the watcher watches `src`).
- The freshness key covers the sources of the closure, the tsconfig (and the files it extends by a relative path), the versions of `typegpu`, `unplugin-typegpu`, esbuild, TypeScript and Babel, and the tool's own code. Sources are read once per build and everything is built from those bytes, so a file edited (and edited back) during a build cannot make the manifest describe other bytes than it holds.
- The generated modules exist only after the first build: an editor shows `@shaders/...` as unresolved until then (run any `ng` build, or `typegpu-shaders build`).
- The wrappers rely on `@angular/build` exports that Angular marks experimental; the fallback and the drift warning limit, but do not remove, the exposure to an Angular release that changes them.
- Only verified on macOS with Node 24; see "Compatibility" for the versions and package managers that were run.

## Failure behavior

| Situation | What you get |
|---|---|
| No `navigator.gpu`, or `requestAdapter()` resolves to `null` | `state()` = `unsupported`; not reported as an error. The null-adapter case is detected by matching TypeGPU's error message (`/compatible GPU/i`), a heuristic: if TypeGPU rewords it, that case falls back to `failed` + `ErrorHandler` (a spec that runs the real `tgpu.init` fails on a reword) |
| `tgpu.init` rejects (e.g. `requestDevice`) | `state()` = `failed` + `error`; reported **once** to `ErrorHandler`; `retry()` tries again |
| Device lost | `state()` = `lost` + `GPUDeviceLostInfo`; frame callbacks and `from` writes stop in that very frame; `*tgpuReady` tears its content down; `retry()` = new root. **Recovery is manual**; only content behind the gate is recreated. Owners outside a gate stay stopped (their resources belong to the dead device) |
| Service destroyed while init is pending | Nothing leaks: the late root is destroyed, waiting `whenReady()` promises reject |
| A frame callback throws, or returns a promise that rejects | That callback is stopped and the error goes to `ErrorHandler` once (also if the rejection comes after its owner was destroyed); other consumers keep running. Do not `await` in a callback: the loop does not wait. If `ErrorHandler` itself throws, the loop keeps running and the failure is logged with `console.error` |
| `whenReady()` | Resolves when `ready`; rejects when `unsupported` or `failed`, on the server, and at once after the service was destroyed. While `lost` it waits for `retry()` and resolves with the **new** root (nothing else wakes it; nobody calls `retry()` for you) |
| `retry()` after the root from `provideTypeGpu({ root })` was lost | A provided root cannot be recreated: the service falls back to `createRoot` (if given) or `tgpu.init(options)`, and never destroys the root it was given |
| `<canvas tgpuCanvas>` whose canvas already has a 2d/webgl context | TypeGPU's `Unable to initialize 'webgpu' context on the provided canvas.` goes to `ErrorHandler`; `context()` stays `undefined` and the state stays `ready`. Use a fresh canvas |
| `injectRoot()` outside a ready gate | Throws an error that says which state it saw and how to fix it |

## SSR and hydration

- Importing the package and instantiating `TypeGpu` on the server is safe (verified: Node import test, real `@angular/ssr` render). On the server `state()` stays `idle` (even with `provideTypeGpu({ root })`), `retry()` does nothing, `whenReady()` rejects, no frame loop starts, `<canvas tgpuCanvas>` is a plain element.
- Server and first client render both see `idle`, so `*tgpuReady` renders the same `else` markup on both and hydration matches (verified with `provideClientHydration()`; the dev log reports `hydrated N components, 0 skipped`). The GPU content appears after hydration.
- With SSR/hydration use `createRoot`, not `root`: a service that is `ready` at construction renders `*tgpuReady` content during hydration although the server rendered the `else` template. Documented limitation, **unverified**: a mismatch was not reproduced.
- Not tested: incremental hydration, SSG-prerendered pages hydrated in a browser without WebGPU, service workers.

## Testing without a GPU

```ts
import { TestBed } from '@angular/core/testing';
import { provideTypeGpu } from '@typegpu-poc/angular';
import { createFakeTypeGpu, installManualAnimationFrames } from '@typegpu-poc/angular/testing';

it('destroys its buffers', async () => {
  const fake = createFakeTypeGpu();
  const frames = installManualAnimationFrames();
  TestBed.configureTestingModule({ providers: [provideTypeGpu({ root: fake.root })] });  // ready immediately

  const fixture = TestBed.createComponent(MyGpuComponent);
  frames.flush();                       // runs injectFrame callbacks once
  expect(fake.liveResources()).toBe(2);

  fixture.destroy();
  expect(fake.liveResources()).toBe(0);
  frames.restore();
});
```

- `provideTypeGpu({ createRoot })` with your own promise tests the async paths; `fake.loseDevice()` simulates device loss. The service destroys a fake returned by `createRoot` on teardown (`fake.rootDestroyCalls()`), never one passed as `root`.
- Angular's scheduler also uses `requestAnimationFrame`: assert on what *your* callbacks did per `flush()`, never on how many times rAF was called.
- The fake has `createUniform/Buffer/Mutable/Readonly`, `configureContext`, `destroy` and `device.lost`, and follows TypeGPU where it matters: `write()` after destroy throws "This buffer has been destroyed"; `root.destroy()` and `device.destroy()` resolve `device.lost` with reason `'destroyed'`; buffers have `$usage`, `$addFlags`, `$name`, `as`, `arrayBuffer`, `destroyed`. It does not validate values against the schema. Per resource, `initial` is the creation value, `calls` the `write()` calls, `writes` both (initial first); `fake.unconfigured` lists `context.unconfigure()` calls; `frames.pending()` counts queued frame callbacks. A component that builds a pipeline (like the quick start) needs one more method, which you add yourself:

  ```ts
  const draw = vi.fn();
  Object.assign(fake.root, {
    createRenderPipeline: () => ({ withColorAttachment: () => ({ draw }) }),
  });
  ```

  The shader template in the component is not compiled by the fake; only the calls are observed (`draw` was called, buffers were destroyed).
- Components behind `@if`/`*tgpuReady` appear after `fixture.detectChanges()` / `await fixture.whenStable()`; after toggling the flag, call it again before asserting.
- Under jsdom there is no `ResizeObserver`, so `tgpuCanvas` configures the context but does not size the canvas. To test sizing, stub it: `globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }`.
- A recording `GPUDevice` (its `createShaderModule` stores the code) lets the **real** TypeGPU root build pipelines in Node, so `tgpu.resolve` can gate shaders in a unit test; the site's shader gate does this (`site/src/app/examples/testing/example-device.ts`) without validating the WGSL.
- Real GPU behavior (shaders, readbacks, buffer counts on a real device) belongs in browser tests; nothing in this package replaces them.

## Troubleshooting

| You see | Cause and fix |
|---|---|
| Build warning `NG8116` (the build still completes), or `NG0303: Can't bind to 'tgpuReadyElse'` (thrown by `TestBed`; a running app is expected to log it) | `TgpuReady` is missing from the `imports` of the component that uses `*tgpuReady`. Add it |
| A blank canvas and `NG0951: Child query result is required but no value is available` through `ErrorHandler` | `TgpuCanvas` is missing from `imports`, so `viewChild.required(TgpuCanvas)` finds nothing. Add it |
| `injectRoot() was called while the GPU is "idle"` (also from `injectUniform` and the other `inject*` functions, which call it) | The component is not behind `*tgpuReady` (or `@if (gpu.root())`). The state name tells you why there is no root; for `failed`, `gpu.state()` has the error |
| `NG0203: ... 'TypeGpu' token injection failed` from `injectFrame`, `injectRoot` or an `inject*` resource | Called outside an injection context. Call it in a constructor or field initialiser, or inside `runInInjectionContext` |
| `Unable to initialize 'webgpu' context on the provided canvas.` | The canvas already has a 2d/webgl context. Use a fresh `<canvas>` |
| A console warning that starts with `[tgpuCanvas] This canvas has no CSS size` | Give the canvas a CSS width and height, or set `autoResize: false` |
| `TS2322` on `from:` mentioning `InferInput<...>` | The signal must produce what the schema accepts: a `Signal<number>` for `d.f32`, a signal of `d.vec3f(...)` or `[x, y, z]` for `d.vec3f` |
| `[external-omitted] ... the external 'in.uv' has been omitted` in the console | A TypeGPU 0.12 development warning for `in.x` in a WGSL template function; plain TypeGPU prints it too. The shader works |
| `ng generate ...:component` says the project is "not set up for TypeGPU shaders yet" | Run `ng add` for that project first (the shader plugin is missing from its build target) |
| `ng add` stops with an unsupported builder or version | Read the message. `@typegpu-poc/angular` itself is already in `package.json`; nothing else was modified (`npm uninstall @typegpu-poc/angular` undoes it) |
| `ng add` fails in npm with `ERESOLVE` before any schematic output | Angular 19 (unsupported), or a peer conflict on `@babel/core` with `@angular-devkit/build-angular` 22: run that `ng add` with `--legacy-peer-deps` |
| `check:shaders`: "no 'use gpu' directive ... nothing was checked" | Wrong directory, or no shader yet: use `--allow-empty` right after `ng add` |
| Build warning about a `'use gpu'` directive that was not transformed | The file is not named `*.gpu.ts` (move it), or it is in a Web Worker bundle (unsupported) |
| `TS2345: ... 'F32' is not assignable to parameter of type 'AnyWgslData'` | Two copies of `typegpu`: see "Known limitations" |
| `NG05104: The selector "ng-component" did not match any elements`, blank page | The bootstrapped root component has no `selector` (`selector: 'app-root'`) |
| "A merge conflicted on path ..." from `ng generate` | The files exist (`--force` does not overwrite): pick another name or delete them |
| `ng build` warns that the initial bundle exceeds 500 kB | TypeGPU itself is most of it. Raise the budget in `angular.json` |

To see the fallback UI (checked in a real browser): for *unsupported*, run `Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })` before `bootstrapApplication` (`delete navigator.gpu` does nothing); for *failed*, use `provideTypeGpu({ createRoot: () => Promise.reject(new Error('no adapter')) })` (reported once per attempt; `retry()` calls the factory again).

## Advanced use

`injectRoot()` returns the real `TgpuRoot`; use any TypeGPU API. A custom device: `provideTypeGpu({ createRoot: async () => tgpu.initFromDevice({ device: await myDevice() }) })`. A second, independent GPU context for one subtree: `providers: [TypeGpu]` on that component (a second service, hence a second device; buffers do not cross devices). Render on demand: `pause()/resume()` of `injectFrame`; there is no on-demand scheduler.

## Known limitations

- **`'use gpu'` shaders** work only through the shipped esbuild plugin and the community builder, in `*.gpu.ts` modules (see "Shader authoring"). WGSL template functions need nothing.
- Vector operators (`vecA + vecB`) are not typed by stock TypeScript (TS2365); use `std.add` etc., `.add()`, or WGSL templates.
- Mirroring compares by `Object.is`, per frame; there is no per-signal equality option.
- No automatic device recovery, no render-on-demand scheduler, no multi-canvas layout helper.
- Packaging: `ng-packagr` (partial Ivy, secondary entry point `testing`), stock TypeScript 6.0.3. Name and layout are provisional; the package is not published.
- **Open: two `typegpu` copies in an npm workspace.** `ng add` pins `typegpu` `0.12.8` exactly in the application, while npm installs this package's own peer (`^0.12.8`, so 0.12.9) at the repository root: two copies and a type error (`F32` not assignable to `AnyWgslData`). Give the application the same `typegpu` range as the peer before `ng add`.
- **Open:** `unplugin-typegpu@0.12.7` needs `typegpu ^0.12.9` but `ng add` pins 0.12.8, so a bare `npm i -D @babel/core unplugin-typegpu` hits `ERESOLVE` (use `ng add`); a stale hoisted plugin path is repaired only by running `ng add` again.
- **Unverified:** hydration with `provideTypeGpu({ root })`; the frame loop leaving the zone under real zone.js (zoneless specs only); a `devicePixelRatio`-only change reaching the `ResizeObserver` in a real browser; Windows, Safari, Firefox, Linux, Yarn 2+/PnP.
