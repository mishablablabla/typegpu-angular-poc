# @typegpu-poc/angular

Angular-native lifecycle for [TypeGPU](https://typegpu.com): one shared GPU root, resources that are destroyed with their component, a signal-friendly render loop, and a canvas directive. Proof of concept, not published.

TypeGPU itself stays visible. You get a real `TgpuRoot`, real `TgpuUniform`s, real pipelines. This package only owns **who creates and who destroys** them, and **when** values reach the GPU.

## Quick path

**Prerequisites:** a standalone Angular application on the esbuild application builder (the default of `ng new`), Angular 20, 21 or 22, Node 24, and a browser with WebGPU (Chrome or Edge) to see the result.

```sh
ng add ./typegpu-poc-angular-0.0.1.tgz                      # not on npm yet; `ng add @typegpu-poc/angular` once it is (the name is provisional)
ng generate @typegpu-poc/angular:component my-canvas
```

Then put `<app-my-canvas />` in a template, add `MyCanvas` to the `imports` of that component, and run `ng serve`. You get an animated gradient whose tint follows a slider, drawn by a `'use gpu'` shader in `src/app/my-canvas/my-canvas.gpu.ts`, with messages for "no WebGPU", "init failed" and "device lost". `npm run check:shaders` (added by `ng add`) is the CI check that every shader was transformed.

Before adopting it, read "Limits that come with this setup" below: shaders need a **community builder** and an Angular implementation detail, and the Angular 20 default (Karma) test setup does not transform shaders.

## Compatibility: what was actually verified

Everything below was run on **macOS (arm64) with Node 24.21.0**. The checks are reproducible with the scripts in the repository's `scripts/` folder (`acceptance-clean-consumer.sh`, `verify-shader-watch.mjs`, `verify-diagnostics.sh`).

| | Verified | Not verified |
|---|---|---|
| Angular | CLI 22.2.4 / core 22.2.3, CLI 21.2.28 / core 21.2.25, CLI 20.3.41 / core 20.3.34: a new app, `ng add`, `ng generate`, unit tests, development and production builds, shader bundle check, a second `ng add` (`scripts/acceptance-clean-consumer.sh`); the generated component rendered, animated and reacting to its slider in a WebGPU browser on all three (20.3 with zone.js, 21.2 and 22.2 zoneless) | 19 and older, 23+ |
| `typegpu` | 0.12.8 and 0.12.9, with `unplugin-typegpu` 0.12.6 or 0.12.7 (pairs 0.12.8+0.12.6, 0.12.9+0.12.7 and 0.12.9+0.12.6 were run; the generated shader resolves to WGSL in each) | other 0.12.x, 0.13+ |
| Package manager | npm; pnpm (22 only, strict `node_modules`) | Yarn |
| OS / Node | macOS arm64, Node 24.21.0 | Linux, Windows, other Node versions |
| Browser | one Chromium-based browser with WebGPU | Safari, Firefox |
| Test runners | Vitest (Angular 21 and 22 default, custom `unit-test` builder); Karma on Angular 20 in headless Chrome (the generated spec only; shader modules are **not** transformed there) | Jest, Angular 20's experimental Vitest builder |
| Zone.js | not required (zoneless on 21/22); also works in an app that uses it (verified on 20.3) | unit tests under zone.js beyond the generated spec |

## What `ng add` and `ng generate` do

For a standard standalone Angular application.

**`ng add` changes** (one application per run: the CLI takes the project from the directory you run it in, so in a workspace with several applications run it inside the application's folder or pass `--project <name>`; running it again changes nothing):
- `angular.json`: the project's `build`, `serve` and `test` targets move to the community builders `@angular-builders/custom-esbuild:application`, `:dev-server` and `:unit-test`; the shader plugin is added to `build.options.plugins` (and to any `configurations.*.plugins` list that exists, because such a list replaces the global one); the test target gets `buildTarget`, `tsConfig` and `reporters` unless you set them. Everything else (assets, styles, file replacements, budgets, other options, other plugins) is kept.
- `package.json`: `typegpu` (`0.12.8`) in `dependencies` and, as `devDependencies`, `@angular-builders/custom-esbuild` (the major of your Angular), `@babel/core ^7.28.0` and `unplugin-typegpu` (the release that pairs with your `typegpu`: 0.12.6 for 0.12.8, 0.12.7 for 0.12.9). Entries you already have are kept. It adds the script `check:shaders` (`ng build --configuration production` and the shader bundle check; `check:shaders:<project>` with several applications). npm then installs everything.
- It does **not** edit your application code or providers: `TypeGpu` is a root service with a safe lazy default, so `provideTypeGpu()` is only for configuration (see API).
- It **refuses, changing nothing**, with a message that says what to do, when the build target is not the esbuild application builder (for example webpack: run `ng update @angular/cli --name use-application-builder` first), when the dev server is another builder, when `plugins` is not a list, or when `typegpu`, `@babel/core` or Angular are outside the supported versions. A Karma test target (the Angular 20 default) is left unchanged with a warning: shader modules are not transformed in Karma tests. On Angular 20 a stock `unit-test` target is left unchanged too, because `custom-esbuild` 20 has no `unit-test` builder (it appeared in 21).
- The CLI prints "unmet peer dependencies" while it installs the package: the peers are exactly what the schematic adds next.

**`ng generate` creates** `src/app/my-canvas/` (or `--path`, `--project`; same conventions as `ng generate component`): `my-canvas.ts` (the component `MyCanvas`, selector `app-my-canvas`, plus an internal `MyCanvasScene`), `my-canvas.gpu.ts` (the shader) and `my-canvas.spec.ts` (`--skip-tests` omits it). It refuses to overwrite files ("A merge conflicted on path"; the CLI's `--force` did not overwrite in CLI 22.2.4, also for the built-in `ng generate component`, so delete the files or pick another name) and refuses projects that `ng add` has not configured. Run from inside a folder, it creates the component there, like `ng generate component`. Put `<app-my-canvas />` in a template, add `MyCanvas` to the `imports` of that component, and `ng serve`: an animated gradient whose tint follows a slider (an Angular signal), with a message while the GPU is not available and a Retry/Reconnect button. The component is the quick start below, split so that GPU code lives behind `*tgpuReady`; edit it freely.

**Shaders:** the shader file must be named `*.gpu.ts` and imported as `./my-canvas.gpu` (see "Shader authoring" for the exact rules and limits). The unit tests need no GPU: the generated spec uses `createFakeTypeGpu()`.

**In CI**, run `npm run check:shaders`. It builds for production and exits 1 if any `'use gpu'` function was not transformed (checked: it fails when the plugin is disabled in the production configuration, which a green build and green tests would not reveal).

**Limits that come with this setup:** it depends on a community builder and on an Angular implementation detail (see "Shader authoring"); shader modules are not transformed in Karma tests or in Angular 20's `unit-test` target; the default production budget (500 kB) is exceeded by TypeGPU itself, so `ng build` prints a warning until you raise it; the `check:shaders` script is named `check:shaders:<project>` when the workspace has several applications at the time of the run (an existing `check:shaders` is never replaced).

## Quick start (by hand)

Without `ng add`: install the tarball next to `typegpu` (`npm install ./typegpu-poc-angular-0.0.1.tgz typegpu@0.12.8`; build it with `npm run pack` in `lib/`). The component below is what `ng generate` produces, written out.


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

No provider, no `ApplicationConfig` change. `TypeGpu` is `providedIn: 'root'`. Use `provideTypeGpu({...})` only to configure it. In the `else` template `let-state` is untyped (Angular cannot type it): `state.status` and, for `failed`, `state.error` are what to read. The `*tgpuReady` content template is fully typed.

Things the quick start relies on: `TgpuCanvas` and `TgpuReady` must be in the `imports` of the components that use them (see "Troubleshooting"), and the `<canvas>` needs a CSS size (`width`/`height` in CSS, as above): `tgpuCanvas` sizes the bitmap *from* the layout size, so a canvas without one cannot be sized and the directive switches resizing off with a console warning.


## The model in six rules

1. **One root per injector, created lazily, in the browser, after the first render.** It never delays bootstrap and never runs on the server. Its state is the signal `TypeGpu.state()`: `idle | initializing | ready | unsupported | failed | lost`.
2. **`*tgpuReady` is the async boundary.** Content inside it only exists while a root is ready, so it may call `injectRoot()` synchronously. When the device is lost, the content is destroyed (all cleanups run); `TypeGpu.retry()` makes a new root and the content is created again.
3. **`inject*` resources belong to the injection context that created them** (component, directive, service) and are destroyed with it: `injectUniform`, `injectMutable`, `injectReadonly`, `injectBuffer`. Everything else (pipelines, bind groups, samplers, textures) you create from `injectRoot()` yourself; textures and other memory-holding objects are yours to `destroy()` (use `inject(DestroyRef).onDestroy(...)`).
4. **Signals that feed a render loop are sampled once per frame** (`{ from: signal }`), before your frame callbacks. A value is written to the GPU only when it changed. Everything not rendered every frame can use a plain `effect(() => uniform.write(...))`.
5. **One animation loop for the whole app.** `injectFrame` registers a callback; it runs outside the zone and stops with its owner. Its first call, and the first `from` sample, happen after the owner's first render, so `viewChild.required()` and signal inputs are available.
6. **Work is bound to the root it was created for.** Frame callbacks and `from` writes run only while that root is `ready`. After device loss they stop in the same frame the loss is published; they never resume on the root made by `retry()`. Behind `*tgpuReady` the owner is recreated for the new root instead.

## API

| Export | Purpose |
|---|---|
| `TypeGpu` | Service: `state()`, `root()` (signals), `whenReady()`, `retry()` |
| `provideTypeGpu({ options?, root?, createRoot? })` | Optional config for the injector it is provided in (normally `ApplicationConfig`). `root` = use an existing root (never destroyed by us, ready immediately); `createRoot` = custom factory, e.g. `() => tgpu.initFromDevice({ device })`. Provided in a route or child injector it creates a **separate** service (and device) for that injector |
| `*tgpuReady` (`TgpuReady`) | Renders content only while ready; `else` template gets the state |
| `injectRoot()` | Synchronous `TgpuRoot`; throws with guidance when not ready |
| `injectUniform / injectMutable / injectReadonly / injectBuffer (schema, { initial?, from? })` | Owned resources (see rules 3 and 4) |
| `injectFrame(cb)` | Per-frame callback `{ deltaSeconds, elapsedSeconds }`; returns `{ paused, pause(), resume() }`. Needs an injection context (constructor, field initialiser, `runInInjectionContext`) |
| `canvas[tgpuCanvas]` (`TgpuCanvas`) | Configures a WebGPU context and keeps the canvas pixel size in sync with its CSS size (the canvas must have one). `[tgpuCanvas]="{ alphaMode: 'premultiplied', autoResize: true }"`, `(resized)`, `context()` and `size()` signals. Needs a canvas that has no other context type yet. Without `ResizeObserver` (jsdom) the context is configured but the size is not tracked |
| `@typegpu-poc/angular/testing` | `createFakeTypeGpu()`, `installManualAnimationFrames()` |

## Signals and uniforms: which one do I use?

| Your value is... | Use | Why |
|---|---|---|
| derived from UI state and shown every frame (hue, zoom, selection) | `injectUniform(schema, { from: signal })` | Visible to the same frame's draw call, written only on change, safe with `input.required()` |
| changes every frame (time, a simulation head) | `uniform.write(...)` in your `injectFrame` callback | You already have the number; no signal needed |
| changes rarely and is not tied to a frame (a config panel) | `effect(() => uniform.write(sig()))` | Fine. For a signal read directly (not an `input()`), the effect's write can land one frame after a sampled one (measured 15 of 30 trials); for `input()`-fed signals the two measured identically |
| fixed after creation | `injectUniform(schema, { initial })` | |
| a different schema, size or root | recreate the owner (`@if`, `@for` track) | Schemas are fixed per resource on purpose |

`from` needs the value to change identity to be rewritten (signals and `computed` do this; mutating one object in place is not seen). It never reads the signal before the owner's first render, and a required `input()` that still has no value (Angular error NG0950) is skipped until it has one. A `from` resource keeps the shared loop alive while its owner lives.

## Ownership and cleanup

| Thing | Created by | Destroyed by |
|---|---|---|
| `TgpuRoot` and its device | `TypeGpu` (via `tgpu.init`) | **Never on destroy**: a canvas may still hold the device, and destroying a device under a configured surface can crash some drivers. A root you pass in is never touched. Exception: a root that arrives after the service was destroyed is released at once |
| uniforms, buffers (`inject*`) | the component/directive/service that called `inject*` | `DestroyRef` of that owner, immediately |
| pipelines, bind groups | you | nothing to release |
| textures and other raw GPU memory | you | you, via `DestroyRef` |
| the frame callback | `injectFrame` | its owner's `DestroyRef` |
| canvas context / ResizeObserver | `tgpuCanvas` | observer disconnected on destroy; the context is garbage-collected |

Shared resources: create them in a service and `inject()` the service; the service's lifetime is then their lifetime. Do not destroy a resource you received from someone else.

Note: TypeGPU creates the underlying `GPUBuffer` lazily, so a component destroyed before its first frame may never have allocated one.

## Shader authoring

Two ways, both type-safe:

1. **WGSL templates** (`tgpu.fn`, `tgpu.fragmentFn` as in the quick start): no build setup.
2. **`'use gpu'` TypeScript functions** in modules named `*.gpu.ts`, transformed at build time. `ng add` performs the setup below for you; this is what it does, for reference or for configurations it refuses (verified in `ng build` development and production, `ng build --watch`, `ng test` and the shader bundle check on Angular 20.3, 21.2 and 22.2, with npm and pnpm; `ng serve` and SSR on 22.2):

```sh
npm i -D @angular-builders/custom-esbuild @babel/core@^7.28 unplugin-typegpu@0.12.6
```

Versions matter: this package's optional peer is `@babel/core ^7.28.0` (a bare `npm i -D @babel/core` installs Babel 8 and fails with `ERESOLVE`; do not "fix" that with `--legacy-peer-deps`, it leaves the test builder without Vite). `unplugin-typegpu` must match your `typegpu`: 0.12.6 with `typegpu@0.12.8`, 0.12.7 with `typegpu@0.12.9` (0.12.7 declares `typegpu ^0.12.9` as a peer, so with `typegpu@0.12.8` npm reports an invalid peer: use the matching pair). A project whose `package.json` says `^0.12.8` and which has 0.12.9 installed works with `unplugin-typegpu` 0.12.6 (run: the generated shader resolves to WGSL).

```jsonc
// angular.json (projects.<name>.architect)
"build": { "builder": "@angular-builders/custom-esbuild:application",
           "options": { "plugins": ["node_modules/@typegpu-poc/angular/tools/typegpu-shaders.esbuild.mjs"], /* ... */ } },
"serve": { "builder": "@angular-builders/custom-esbuild:dev-server", /* ... */ },
"test":  { "builder": "@angular-builders/custom-esbuild:unit-test",
           "options": { "buildTarget": "<name>:build:development", "tsConfig": "tsconfig.spec.json", "reporters": ["default"] } }
```

- A `plugins` entry is a **file path relative to the workspace root**, not a package specifier (`@typegpu-poc/angular/tools/...` fails with "Cannot find module").
- `ng new` generates `"test": { "builder": "@angular/build:unit-test" }`. Replace it as above: the stock builder has no plugin hook, ignores `plugins` without a word, and your shader specs then fail with TypeGPU's "Missing metadata".
- A `plugins` list inside a build configuration (for example `production`) replaces the global one (observed with an empty list). Do not set it there unless it includes this plugin.

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

Import it as `'../shaders/gradient.gpu'`. These specifier forms are all matched, because the plugin lets esbuild resolve the import first: relative with or without the `.ts` extension, `./x.gpu.js` for `x.gpu.ts`, tsconfig `paths` aliases and `baseUrl` imports, dynamic `import()`, barrels that re-export a `.gpu` module, and `.gpu.js`/`.gpu.mjs` modules. A file imported through several specifiers is still one module. (`import './a.gpu.ts'` with the extension needs `allowImportingTsExtensions` and `noEmit` in tsconfig; that is TypeScript's rule, not the plugin's.) `@webgpu/types` is not needed to build.

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

- after `ng build` (also `-c production`), run `node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs dist/<app>/browser`. It exits 1 and names each `'use gpu'` directive that was not transformed. Verified to catch a production-only plugin override that leaves the tripwire spec green.

How it works and why it needs a trick: Angular's compiler plugin registers `onLoad` handlers for every `.ts`/`.js` file without a namespace, so they run first and a normal plugin never sees the files. The shipped plugin redirects `*.gpu` imports (`onResolve`) to a virtual path that does not end in a script extension, so Angular's handlers do not match, then runs `unplugin-typegpu/babel` on the original file. Type checking still happens on the original source. `TYPEGPU_SHADERS_LOG=1` logs which imports were matched. A missing `@babel/core` / `unplugin-typegpu` stops the build at start with an install hint; a syntax error in a `*.gpu.ts` is reported with file, line and column; an error raised by unplugin-typegpu itself (for example "Unsupported JS functionality: TryStatement") names the file and the lines of its `'use gpu'` directives, but has no exact line, because the unplugin gives none.

Limits (verified unless noted):
- The plugin redirects only resolved project files named `*.gpu.<ts|mts|js|mjs>`. Shader code in components, services, or files with other names is not transformed.
- `custom-esbuild` is a community builder, not part of Angular, and the plugin depends on Angular's un-namespaced `onLoad` ordering. That ordering is in the source of `@angular/build` 20.3.41, 21.2.28 and 22.2.4 (read), and the plugin works against all three (run); nothing guarantees it for later versions. Its `unit-test` builder warns that the `application` build target is "not supported" and needs explicit `buildTarget`, `tsConfig`, `reporters`; `custom-esbuild` 20 (the only 20.x release) has no `unit-test` builder at all, so on Angular 20 shaders are not transformed in unit tests.
- The dev server does a full reload when a shader changes (no HMR). In watch mode (`ng build --watch`; run on 20.3, 21.2 and 22.2: edit, syntax error, fix, helper edit, new and removed module all rebuild with fresh output) a failed build keeps the previous bundle in `dist` until the error is fixed, like any Angular error, and the message names the shader file with line and column; a `.gpu` file created *after* a failed "could not resolve" import does not trigger a rebuild by itself: edit the importer (same for plain TS files). `scripts/verify-shader-watch.mjs` in the repository reproduces this.
- No Angular decorators in `*.gpu.ts` (the build fails with a Babel message that wrongly suggests Babel plugins: remove the decorator instead).
- A shader file inside `node_modules` is transformed by `ng build` but not by `ng test` (vitest loads it as-is). Keep shader sources in your project.
- A `'use gpu'` function that you also **call on the CPU** and that contains operators (even `t * 2 + 1`) is rewritten to `__tsover_add(...)`, defined by `tsover-runtime`, which `typegpu` loads as a side effect when it is *executed*. If no `typegpu` code runs before the call (the `import` is unused, so the bundler drops it: `typegpu` is `sideEffects: false`), it fails with `ReferenceError: __tsover_add is not defined` (reproduced in `ng test` with npm and pnpm; resolving to WGSL is not affected). Running any `typegpu` code at module load avoids it (a top-level `tgpu.const(...)` in the shader module: verified with pnpm). `import 'tsover-runtime'` works with npm's flat `node_modules` but **fails under pnpm** (`TS2882`: it is a transitive dependency); do not rely on it. This is an issue in TypeGPU's own tooling, not something this package can fix.
- Vector operators (`a + b` on `d.vec3f`) fail type checking under stock TypeScript (TS2365). Use `std.add/mul/...` or `.add()/.mul()`; scalar operators are fine. Plain helper functions without `'use gpu'` type-check but fail at resolve time.
- Not verified: Windows paths (the plugin treats paths as opaque ids, but its fallback matcher only recognises `./` and `/`), Yarn and Yarn PnP, vitest watch mode, source-map line accuracy.
- Fallback if the community builder cannot be adopted: a pre-build Babel step that generates `*.ts` files, which has its own problems (a second watch process, type errors reported on generated code).

## Failure behavior

| Situation | What you get |
|---|---|
| No `navigator.gpu` | `state()` = `unsupported`; not reported as an error |
| `tgpu.init` rejects | `state()` = `failed` + `error`; reported **once** to `ErrorHandler`; `retry()` tries again |
| Device lost | `state()` = `lost` + `GPUDeviceLostInfo`; frame callbacks and `from` writes stop in that very frame; `*tgpuReady` tears its content down; `retry()` = new root. **Recovery is manual**; only content behind the gate is recreated. Owners outside a gate stay stopped (their resources belong to the dead device) |
| Component destroyed while init is pending | Nothing leaks: the late root is destroyed, waiting `whenReady()` promises reject, no unhandled rejection |
| A frame callback throws, or returns a promise that rejects | That callback is stopped and the error goes to `ErrorHandler` once; other consumers keep running. Do not `await` in a frame callback: the loop does not wait for it |
| `whenReady()` on the server | Rejects at once (the GPU is never initialised there) |
| `whenReady()` while `lost` | Stays pending until `retry()` produces a root, and rejects if the service is destroyed first. Nobody calls `retry()` for you |
| `retry()` after the root from `provideTypeGpu({ root })` was lost | A provided root cannot be recreated: the service falls back to `createRoot` (if given) or `tgpu.init(options)`, and never destroys the root it was given |
| `<canvas tgpuCanvas>` whose canvas already has a 2d/webgl context | TypeGPU's `Unable to initialize 'webgpu' context on the provided canvas.` goes to `ErrorHandler`; `context()` stays `undefined` and the state stays `ready`. Use a fresh canvas |
| `<canvas tgpuCanvas>` without a CSS size | A console warning (dev mode) and automatic resizing is switched off; the canvas keeps its bitmap size |
| `injectRoot()` outside a ready gate | Throws an error that says which state it saw and how to fix it |

## SSR and hydration

- Importing the package and instantiating `TypeGpu` on the server is safe (verified: Node import test, real `@angular/ssr` render). On the server `state()` stays `idle` (even with `provideTypeGpu({ root })`), `retry()` does nothing, `whenReady()` rejects, no frame loop starts, `<canvas tgpuCanvas>` is a plain element.
- Server and first client render both see `idle`, so `*tgpuReady` renders the same `else` markup on both and hydration matches (verified with `provideClientHydration()`; the dev log reports `hydrated N components, 0 skipped`). The GPU content appears after hydration.
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

- `provideTypeGpu({ createRoot })` with your own promise tests the async paths; `fake.loseDevice()` simulates device loss.
- Angular's scheduler also uses `requestAnimationFrame`: assert on what *your* callbacks did per `flush()`, never on how many times rAF was called.
- The fake is a stand-in with `createUniform/Buffer/Mutable/Readonly`, `configureContext`, `destroy` and `device.lost`. A component that builds a pipeline (like the quick start) needs one more method on the fake, which you add yourself:

  ```ts
  const draw = vi.fn();
  Object.assign(fake.root, {
    createRenderPipeline: () => ({ withColorAttachment: () => ({ draw }) }),
  });
  ```

  The shader template in the component is not compiled by the fake; only the calls are observed (`draw` was called, buffers were destroyed).
- Components behind `@if`/`*tgpuReady` appear after `fixture.detectChanges()` / `await fixture.whenStable()`; after toggling the flag, call it again before asserting.
- Under jsdom there is no `ResizeObserver`, so `tgpuCanvas` configures the context but does not size the canvas. To test sizing, stub `ResizeObserver` yourself (see "Troubleshooting").
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
| `ReferenceError: ResizeObserver is not defined` in your own test setup | Only if your own code uses it; the directive guards it. A minimal stub: `globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }` |
| `[external-omitted] ... the external 'in.uv' has been omitted` in the console | A TypeGPU 0.12 development warning for `in.x` inside a WGSL template function; plain TypeGPU prints it too (checked without this package). The shader still works |
| `ng generate ...:component` says the project is "not set up for TypeGPU shaders yet" | Run `ng add` for that project first (the shader plugin is missing from its build target) |
| `ng add` stops with "Nothing was changed" | Read the message: it names the unsupported builder or version and the fix. Your files were not touched |
| "A merge conflicted on path ..." from `ng generate` | The files exist already. Pick another name or delete them (`--force` did not overwrite in CLI 22.2.4, same as for `ng generate component`) |
| `ng build` warns that the initial bundle exceeds 500 kB | TypeGPU itself is most of it; this package is small. Raise the budget in `angular.json` |

To look at the unsupported or failed UI without breaking your GPU (both checked in a real browser with the generated component): for *unsupported*, run `Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })` before `bootstrapApplication` (`delete navigator.gpu` does nothing: the property lives on the prototype); for *failed*, use `provideTypeGpu({ createRoot: () => Promise.reject(new Error('no adapter')) })` (the error goes to `ErrorHandler` once per attempt, and `retry()` calls the factory again).

## Advanced use

`injectRoot()` returns the real `TgpuRoot`; use any TypeGPU API. A custom device: `provideTypeGpu({ createRoot: async () => tgpu.initFromDevice({ device: await myDevice() }) })`. A second, independent GPU context for one component subtree: `providers: [TypeGpu]` on that component (creates a second service instance, hence a second device; buffers do not cross devices). Custom frame scheduling (e.g. render only on demand): `injectFrame` returns `pause()/resume()`; there is no on-demand scheduler.

## Known limitations

- **`'use gpu'` shaders** work only through the shipped esbuild plugin and the community builder, in `*.gpu.ts` modules (see "Shader authoring"). WGSL template functions need nothing.
- Vector operators (`vecA + vecB`) in your own TypeScript are not typed by stock TypeScript (TS2365; the `tsover` fork would allow them, and was not needed to build or use this package); use `std.add` etc., `.add()`, or WGSL templates.
- Mirroring detects changes by identity, per frame; there is no per-signal equality option.
- No automatic device recovery, no render-on-demand scheduler, no multi-canvas layout helper.
- Tested in one browser (the Claude desktop app's embedded Chromium). Not tested in Safari/Firefox.
- Packaging: builds with `ng-packagr` (partial Ivy, secondary entry point `testing`) on stock TypeScript 6.0.3. The package name and layout are provisional.
