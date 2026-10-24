# Architecture decisions: Angular integration for TypeGPU

Each decision lists what was chosen, what was rejected, and why. How the API maps to `@typegpu/react` is in `REACT-COMPARISON.md`. Behaviour described here is covered by the specs in `app/src/lib-tests` and the schematic specs in `lib/schematics`.

## D1. Root: lazy, app-scoped service; never part of bootstrap

**Chosen.** `TypeGpu` is an `@Injectable({ providedIn: 'root' })` service. It starts `tgpu.init()` **after the first render, in the browser only**. Its state is one signal, `state()`, a discriminated union:
`idle | initializing | ready{root} | unsupported | failed{error} | lost{info}`. `root()` is a computed convenience. `provideTypeGpu(config)` is optional and only configures (options, a pre-made root, or a custom root factory). It provides `TypeGpu` as well as the configuration, so that it also works in a route or child injector (a `providedIn: 'root'` service would otherwise never see that configuration); below the root that means a separate service and device.

**Rejected.**
- *Init in `provideAppInitializer`* (an early version of this integration). It makes bootstrap wait for the GPU and fail without it. We had to add a `.catch`, skip it on the server, and wrap consumers in `@defer`. It also gave a sync `injectRoot()`, which turned out to be obtainable another way (D2).
- *Per-component roots by default.* Each `tgpu.init` creates a separate device; buffers cannot be shared across devices. Component scope remains possible: `providers: [TypeGpu]` creates a second service instance (and device). Not the default.

**Ownership policy.** The service owns the root it creates. It never calls `root.destroy()` on a ready root (React's package makes the same choice: a surface configured on a destroyed device can crash Dawn/Vulkan; the device is released when unreferenced). A root passed in via `provideTypeGpu({ root })` is never destroyed. One exception: if the service is destroyed while init is pending, the late root has no users and no surfaces, so it is destroyed immediately.

## D2. Consumers get a synchronous `TgpuRoot` behind a gate

**Chosen.** `*tgpuReady` (structural directive) renders its content only while `state()` is `ready`; `else` template receives the state (for spinner / "WebGPU unavailable" / "device lost"). Inside gated content, `injectRoot()` is synchronous and returns the plain `TgpuRoot`. Calling it outside a gate throws an error that explains what to do.

Why: signals for every resource (`Signal<Uniform | undefined>`) would put an `undefined` check in every frame callback. The gate puts the async boundary in the template, where Angular developers already handle async (`@if`, `@defer`).
SSR/hydration: server and first client render both see `idle`, so they render the same `else` markup; GPU components are created after hydration. (Verified in `app-ssr`.)
Device loss: `lost` makes the gate tear down its content, which runs every `DestroyRef` cleanup, so no resource outlives a dead device. Because Angular tears the content down at the next change detection, frame callbacks and `from` writes are additionally bound to the root they were created under (`root-binding.ts`): they go inactive in the same tick the loss is published and never resume on a root made by `retry()` (D5). `TypeGpu.retry()` creates a fresh root and the gate recreates the content. This is manual recovery, not automatic; it is tested with a fake device.

**Rejected.** Async-only resource handles; a `TgpuScene` component that owns everything (angular-three style: a second component model).

## D3. Resources: four small `inject*` functions, owned by the injection context

`injectUniform`, `injectBuffer`, `injectMutable`, `injectReadonly`: create via `injectRoot()`, destroy the buffer on `DestroyRef`. They return the plain TypeGPU object. Everything else (pipelines, bind groups, textures, samplers) is used directly from `injectRoot()`; pipelines and bind groups hold no GPU memory that needs explicit destruction.
Schemas are fixed at creation. Replacing a schema = recreating the owner (`@if` / `@for` identity). React's `useStableSchema` machinery is deliberately not ported.

**Rejected.** A tracking Proxy around `TgpuRoot` that destroys everything created through it (hides ownership; breaks identity); wrappers for pipelines/bind groups (no lifecycle value).

## D4. Signals to GPU: `from`, sampled in the frame loop

**Chosen.** `injectUniform(d.vec3f, { from: someSignal })` registers the uniform with the shared frame loop. Once per frame, **before any frame callback**, the loop reads the signal; if the value (by `Object.is`) differs from what was last written, it writes. Writes stop when the owner is destroyed. The signal is read inside the frame loop, never at construction, so required inputs (NG0950) are safe.

Evidence (real browser, real GPU): for a signal written outside change detection, effect-driven writes were one frame late in 15 of 30 trials, and a frame that runs before Angular flushes effects used a stale value in a deterministic test; frame sampling was never late. Both wrote once per change and never when idle. Idle, the sampled side writes only the per-frame `time` uniform; one hue change is exactly one 12-byte write. For `input()`-fed signals (15 trials, a signal `input()` driven by a parent signal; harness: `app/src/examples/sync-compare`) `from` and `effect` had **identical** latency (1 frame in 7 trials, 2 frames in 8) and one write per change each, so for `input()`-fed values the choice is not about latency. The measurements used one signal kind and do not prove a general performance difference; UI-event-driven trials were mostly dropped because the embedded browser throttled `requestAnimationFrame` (n=2, inconclusive). The decision rests on determinism (writes happen at one defined point, before frame callbacks) and on removing lifecycle concepts (no effect, no injection-context rule, no ordering question).

Rule for developers: *reactive state that feeds a render loop is sampled per frame; one-off or rarely changing data can use `effect(() => uniform.write(...))` yourself.* Sampling starts after the owner's first render (required inputs are available; an input that still has no value, NG0950, is skipped until it does). A `from` uniform keeps the shared frame loop alive while its owner lives.
Values must change identity to be rewritten (signals and `computed` do this naturally; mutating the same object in place is not detected).

**Rejected.** `effect`-driven as the default (timing-dependent, requires the NG0950 workaround); a `mirror()` wrapper object like React's `useMirroredUniform` (React needs it because render-phase writes must be diffed; Angular has signals).

## D5. Frame loop: one shared loop, `injectFrame(cb)`

One `requestAnimationFrame` loop per application (root-provided `FrameLoop`), started lazily, going idle when no consumer is active (every callback paused and no `from` resource) and woken by `resume()`, started only in the browser, run outside `NgZone`. `injectFrame(cb)` returns `{ paused, pause(), resume() }`; the first call is after the owner's first render. The callback gets `{ deltaSeconds, elapsedSeconds }` (the same object is reused every frame: no per-frame allocation; do not keep it). A callback that throws, or returns a promise that rejects, is stopped and reported through `ErrorHandler`; other consumers keep running. Callbacks are active only while the root they were created under is `ready`.
Not built: priorities, render-on-demand scheduling, per-canvas scheduling. A paused consumer can render manually.

**Rejected.** One loop per `injectFrame` call (as in React's `useFrame`): duplicate rAF loops, no shared ordering for `from` sampling.

## D6. Canvas: `canvas[tgpuCanvas]` owns one WebGPU context and its pixel size, nothing else

Inputs: `[tgpuCanvas]="options"` (a `GPUCanvasConfiguration` without `device`, plus `autoResize`). Outputs: `(resized)`. Signals: `context()` (undefined until a root is ready and the canvas is configured), `size()`. It configures through `root.configureContext`, reconfigures when options or the root change, sizes the canvas in device pixels from `ResizeObserver` (`devicePixelContentBoxSize` with a `devicePixelRatio` fallback), and disconnects the observer on destroy. It never starts a frame loop, never creates resources.
It works outside a gate: the `<canvas>` is plain DOM on the server; configuration waits for the root.

## D7. Testability

Secondary entry point `@typegpu-poc/angular/testing` (`lib/testing/index.ts`): `createFakeTypeGpu()` returns a fake root (uniform/buffer/mutable/readonly/configureContext, `destroy` spies, controllable `device.lost`) and bookkeeping to assert on cleanup. Tests use `provideTypeGpu({ root: fake.root })` (ready synchronously) or `provideTypeGpu({ createRoot })` for async paths. The single cast to `TgpuRoot` lives inside the testing helper.
Real-GPU checks are separate (browser self-test page; see README).

## D8. Angular compatibility

Required APIs: `inject`, `DestroyRef`, `signal/computed/effect`, `afterNextRender`, signal `input()` / `output()` / `viewChild`, `makeEnvironmentProviders`. `effect` and `afterNextRender` are stable from Angular 20 (angular.dev API pages); earlier versions have them as developer preview. **Minimum: Angular 20**; peer range `^20 || ^21 || ^22`, i.e. only majors that were built against. Verified with the packed package: clean consumers on 22.2, 21.2 and 20.3 (build, tests, browser); the library specs pass in full on 22.2 and 21.2, and all but one on 20.3 (that spec needs a node test environment that Angular 20's experimental vitest builder ignores). A zone.js-based app (`provideZoneChangeDetection`) was checked on 21.2 in a browser (renders, mounts/unmounts, reacts to a signal); unit tests were not run under zone.js. The Ivy linker floor of the built package is 17.1 (`ɵɵngDeclareDirective` for signal inputs), so the floor is set by `effect`/`afterNextRender` stability, not by the linker. 19 and older, 23+ untested.

## D9. Build tooling and shader authoring

The integration itself needs **no** build plugin: WGSL templates (`tgpu.fn`, `tgpu.fragmentFn`) work with any Angular builder. `'use gpu'` TypeScript shaders are supported through a shipped esbuild plugin (`lib/tools/typegpu-shaders.esbuild.mjs`) loaded by the community builder `@angular-builders/custom-esbuild`, for modules named `*.gpu.ts`.

Why this and not the alternatives:
- *`unplugin-typegpu/esbuild` directly*: never receives files (Angular's compiler plugin claims them first).
- *Namespaced `onResolve` redirect*: still loses to Angular's namespace-less `onLoad`; the virtual path without a script extension is what makes it work.
- *Matching only literal relative specifiers*: tsconfig `paths`, `baseUrl` and `./x.gpu.js` imports would be silently skipped and one file could be bundled twice; the plugin therefore lets esbuild resolve first and redirects resolved `*.gpu.<ext>` files.
- *Pre-build Babel step*: no builder dependency, but a second watch process, generated files needing `@ts-nocheck`, type errors reported on generated code. Kept as the documented fallback.
- *Own builder or a fork of the Angular builder*: out of scope and a maintenance cost.

Trade-off accepted: a community builder and reliance on Angular's unnamespaced `onLoad` (not a guaranteed API) in exchange for original-source type checking, working dev server, tests, SSR and no generated files. Mitigation: a tripwire spec (test build) plus `tools/check-shader-bundle.mjs` after `ng build` (production too), because a silent skip is otherwise invisible. No compiler fork: stock TypeScript works; vector operators need `std.*`/methods there.

Packaging: `lib/` builds with ng-packagr in partial Ivy mode with a secondary entry point (`/testing`) and a copied `tools/` asset on stock TypeScript 6.0.3, from the published `typegpu` (no monorepo, no forked compiler); the `tsover` fork aliased as `typescript` produced a byte-identical tarball. Optional peers: `@babel/core`, `unplugin-typegpu` (only for the shader plugin).

## D10. Schematics: `ng add` and a component generator

**Chosen.** Real DevKit schematics shipped inside the package: `schematics/collection.json` with `ng-add` and `component` (alias `c`), found through the `schematics` field of the package's `package.json` (`ng-add.save` = `dependencies`). Sources are in `lib/schematics/`, compiled by plain `tsc` to CommonJS into `dist/schematics` (a nested `package.json` with `"type": "commonjs"` keeps them CJS inside the ESM package), with schemas and templates copied by `scripts/copy-schematic-assets.mjs`; `npm run build` runs ng-packagr and then this step, so the packed tarball carries them. The schematics use the consumer's own `@angular-devkit/schematics` and `@schematics/angular` (every Angular CLI workspace has them); they are devDependencies of this package, not dependencies.

**`ng add` decisions.**
- Structured edits only (`readWorkspace`/`updateWorkspace`, `addDependency`); `package.json` scripts are added by parsing and re-serialising with the detected indent. `JSONFile` from `@schematics/angular` is marked `@private`, so it is not used.
- Only `@angular/build:application` (and the custom builder itself) is accepted for `build`, `@angular/build:dev-server` for `serve`; anything else aborts before any write with an actionable message. A Karma test target (Angular 20 default, or `runner: 'karma'`) is left alone with a warning, because the custom `unit-test` builder is Vitest-only and shader modules are not transformed in Karma anyway. On Angular 20 a stock `unit-test` target is left alone too: `custom-esbuild` 20.0.0, the only 20.x release, has no `unit-test` builder (a stock target would otherwise be rewritten to a builder that does not exist).
- Plugin lists inside build configurations replace the global list (observed), so every existing `configurations.*.plugins` gets the plugin too; configurations without a list inherit.
- Versions: `custom-esbuild` `^<Angular major>.0.0`; `@babel/core ^7.28.0` (Babel 8 is rejected with a message, as the peer range would reject it); `typegpu` `0.12.8` only when absent; `unplugin-typegpu` 0.12.6 or 0.12.7 depending on the `typegpu` patch, because 0.12.7 declares `typegpu ^0.12.9` as a peer and an unmatched pair gives `ERESOLVE`/invalid peers. Existing entries are never changed (`ExistingBehavior.Skip`).
- No `provideTypeGpu()` is added: the service is `providedIn: 'root'` with a lazy default; the provider is configuration only (D1). An extra provider would be one more thing to keep in sync for no behavior.
- Shader bundle validation: `angular.json` has no post-build hook, and a second production build when starting the dev server would be wasteful, so it is an explicit `check:shaders` npm script (`ng build -c production && node .../check-shader-bundle.mjs <outputPath>/browser`) for CI.
- Several applications: no guessing in the schematic; the CLI infers the project from the working directory (at the workspace root that is the root project, with no prompt: observed), so `--project` or running inside the application's folder is how to pick one. `check:shaders` becomes `check:shaders:<project>` when several applications exist at run time.
- Deep imports from `@schematics/angular` (`utility/parse-name`, `utility/validation`, `utility/workspace`): they are not in its public `utility` index, but exist in 20.3.41, 21.2.28, 22.2.4 and 22.3.0-next.3 and are used the same way by Angular's own component schematic. Kept: replacing them would be about 30 lines of local code for a risk not yet seen. If a future CLI removes one, the failure is an immediate `Cannot find module` in the schematic, not silent misbehaviour.

**Component generator.** Follows `ng generate component` (Angular 20+ naming: `my-canvas.ts`, class `MyCanvas`, folder per component, `--path`, `--project`, `--skip-tests`; overwriting is refused, and the CLI's `--force` does not overwrite in CLI 22.2.4 even for the built-in component schematic). One file holds two components: `MyCanvasScene` (GPU code, calls `injectRoot()`, must live behind `*tgpuReady`) and `MyCanvas` (the gate, fallback UI, a slider signal). They are in one file to keep the starter small; the scene is exported because Angular 21's compiler rejects an unexported component imported by another (NG3004). It refuses projects without the shader plugin (the failure would otherwise only show in the browser). The spec uses test globals (no `vitest` import, so Karma also works), explicit `detectChanges()` (zone-based test beds on Angular 20 need it) and a failing `createRoot` instead of "no WebGPU", which differs between jsdom and a real browser.

**Rejected.** A schematic that shells out to the custom-esbuild `ng-add` (its package is not installed yet when ours runs, and it would set `buildTarget` without `tsConfig`/`reporters`); a post-build hook emulation; auto-editing the application's component or routes; supporting several `--project`s in one run; generating a showcase app.
