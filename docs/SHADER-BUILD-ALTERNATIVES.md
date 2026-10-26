# Shader build: alternatives to `custom-esbuild` + namespaced plugin

Date 2026-10-26, macOS arm64, Node 24.21. Angular 22.2 (`@angular/build` 22.2.4), typegpu 0.12.8, unplugin-typegpu 0.12.6, Vite 7.3.7, `@analogjs/vite-plugin-angular` 2.9.2.
Everything is in `experiments/shader-alternatives/` (one folder per approach, shared `node_modules` symlink except C). Nothing was committed; the TypeGPU monorepo and the DevTools clone were not touched.
Labels: **VERIFIED** (run here), **REPORTED** (research agent read a page, not re-checked), **UNVERIFIED**.

## The problem
`'use gpu'` code needs the unplugin-typegpu transform. `@angular/build:application` has no user-plugin option, and its compiler plugin claims every `.ts`/`.js` file first (un-namespaced `onLoad`). Today: community builder + a plugin that hides `*.gpu.ts` under a virtual namespace (approach A).

## Approaches tried

| | Approach | build | `ng test` | serve: edit to served | Web Worker | Type errors | Angular coupling |
|---|---|---|---|---|---|---|---|
| A | custom-esbuild + our plugin (current, earlier rounds) | yes | needs custom `unit-test` | yes | **no** (plugins not passed to workers) | original source checked | community builder + un-namespaced `onLoad` order |
| B | own thin builder (`application`/`dev-server`/`unit-test`, ~25 lines + Angular's schemas copied) | yes (1 META write) | yes (needs `reporters`; warns the build target builder is "not supported") | yes, 0.25 to 0.5 s | UNVERIFIED (same plugin, expected no) | original source checked | `extensions` param; Angular's JSDoc: "NOT supported and may cause unexpected build output" |
| H | stock builders + Angular's Bazel env hook (`NG_INTERNAL_ESBUILD_PLUGINS_DO_NOT_USE`, plus `BAZEL_BINDIR`, `JS_BINARY__EXECROOT`) | yes (control without env: 0 META) | yes, stock `unit-test` | not run | not run | original source checked | internal hook named DO_NOT_USE |
| I | **precompile shaders outside Angular** (esbuild + `unplugin-typegpu/esbuild` + `tsc` for `.d.ts`), app consumes plain JS through a tsconfig path | yes, **stock** builder | yes, **stock** `unit-test`, WGSL resolves | yes, 0.32 s (3 watchers) | **yes** (2 META writes in the worker bundle; not executed) | shader errors in the tsc watcher, app-side errors in `ng serve` | **none** |
| C | Vite + Analog + the official `unplugin-typegpu/vite` | yes | not run | yes, 0.22 s | not run | **build passes with TS and template errors (exit 0)**; needs `ngc --noEmit` | leaves the Angular CLI |

Details worth knowing:
- **I** builds the shader package in ~50 ms. Dev source maps show the original `wave.gpu.ts` (not the transformed text). A stale `dist` is the main way to go wrong: the shader package must be built before the app (CI order). A shader cannot import app code unless it lives in the shader package. Not run: Karma, SSR, pnpm, Windows, a full scene with the library.
- **C** in a real browser (the app's pane): WGSL resolved, and a scene using the packed library (`*tgpuReady`, `TgpuCanvas`, `injectUniform`, `injectFrame`) mounted with no errors (dev server only; the production bundle was built but not run). The library tarball is dated Oct 25 and was not re-packed. The component under Analog does not need a `*.gpu.ts` name.
- **H** works but only through three environment variables that Angular marks internal; it is useful as a measurement, not as something to ship.

## Research (subagent, REPORTED)
- No public `plugins` option in the application builder, none planned on the roadmap; maintainers' answer (angular-cli #26849) is "use a custom or third-party builder". #31513 added the Bazel-only hook above.
- `unplugin-typegpu` docs: only Babel and Vite/Rollup are actively maintained; Angular, tsc transformers and ts-patch are not mentioned. No Angular issues found in the TypeGPU repository.
- Community pattern for Angular: `@angular-builders/custom-esbuild`, or Nx `@nx/angular:application` with a `plugins` option (same builder underneath).
- Analog's own docs: `fastCompile` passes about 91% of Angular's conformance suite, skips template type-checking, "behavior may change between minor releases".

## Reading
- No option is both official and low-friction. Every approach that stays inside the Angular build (A, B, H) depends on Angular internals; B only swaps whose code does it.
- **I is the only approach with zero Angular coupling** and it removes the Web Worker limit and the test-builder constraint. Its cost is a second build step and a stale-output risk, both manageable with one npm script and a CI order.
- C is the only route where TypeGPU's supported plugin runs natively, but it means leaving the Angular CLI and losing build-time type/template errors.
- Suggested direction (a proposal, not decided): the Angular package ships the runtime library only; shader building is a documented recipe (I), with A kept as an optional convenience for apps that already use `custom-esbuild`.

## Not tested
Karma, SSR with prebuilt shaders, pnpm/Yarn PnP, Windows/Linux, Angular 20/21, `ng add` wiring for I, B/H with Web Workers, HMR beyond full reload, Analog tests and SSR.

See also: `SHADER-PREBUILD-POC.md` (approach I run on the real showcase, with results and a recommendation).
