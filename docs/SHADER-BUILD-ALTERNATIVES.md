# Shader build: alternatives to `custom-esbuild` + namespaced plugin

Date 2026-10-26, macOS arm64, Node 24.21. Angular 22.2 (`@angular/build` 22.2.4), typegpu 0.12.8, unplugin-typegpu 0.12.6, Vite 7.3.7, `@analogjs/vite-plugin-angular` 2.9.2.
The experiments of this first round lived in a local `experiments/shader-alternatives/` folder that is **not part of this repository** (the text below is the record of them). Approach I became the prebuild mode (`ng add --shaders prebuild`, see `SHADER-PREBUILD-POC.md` for its history and `lib/README.md` for what it is now).
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


## Round 2 (2026-10-27): the hybrid "per-file sibling generation", prototyped and measured

**Idea** (from an architecture study): keep the thin wrapper builders and the option-schema copies (nothing wrapper-free can guarantee freshness: Angular's Architect has no `dependsOn`, `concat` drops flags, the CLI never runs package.json scripts), but replace the tool core by a generated file **next to each shader**: `x.gpu.ts` gets `x.gpu.generated.js` (header with the source hash and a status) and a facade `x.gpu.generated.d.ts` (`export * from './x.gpu'`). No output folder, no manifest, no session registry, no prune, no tsconfig `paths` edit; freshness is a stateless `verify()` before and after the official builder.

**Prototype:** built for real in a sandbox clone (a second tool `typegpu-siblings`, a hidden `ng add --shaders=siblings`), run with real `ng` on Angular 22.2.4, 21.2.28 and 20.3.41, against the same scenario list as the QA state machine. It is kept, unmerged, on the branch `experiment/siblings-prototype`.

| Question | Result (measured, macOS arm64, a loaded host: timings are not benchmark-grade) |
|---|---|
| Does TypeScript resolve `./x.gpu.generated` to the facade `.d.ts` on 20/21/22? | Yes (`--traceResolution`: `.ts` and `.tsx` missing, `.d.ts` used); `allowJs`/`checkJs` fine |
| Does Angular's watcher rebuild when a neighbouring generated file is rewritten? | Yes on all three: edit to served value 0.25 to 0.45 s (the current design: 0.36 to 0.68 s) |
| Hand-written lines, tool + wrappers (`wc -l`, specs and schemas excluded) | about 1040 against 2095 (**-50%**), but features were dropped: the CLI `run`/`dev` commands, `check --fix-imports`, own declaration emit |
| Scenarios (invalid shader, SIGINT at 6 offsets, `kill -9`, concurrent builds, two dev servers, rename/delete, stale or hand-edited output, `ng build --watch`, `ng test --watch`, SSR dev server through a broken shader) | The same pass rate as the current design; no scenario where it was worse, except a different policy for an edit made during a build (the after-check refused 7 of 16 builds at a 180 ms edit cadence) |
| Ergonomics | imports become `./x.gpu.generated`; helper modules that shaders import can be imported freely by application code (the current design reports them as stray); generated files sit next to the sources (editor excludes, `.gitignore` for the `.js`, commit the facade `.d.ts`) |
| Prototype defects | case-only rename, a throwing stub taking down an Angular 21 SSR dev server (the same weak spot the current tool had, now fixed there too), `tgpu.fn(...)` in a plain module not flagged, config lookup in multi-project workspaces; **one unexplained** `verify` failure in 1 of 15 rapid-edit runs |
| Not verified | Windows, Linux, pnpm/PnP, libraries (ng-packagr), `extract-i18n`, real browser rendering of the siblings |

**Decision: not adopted for now.** The measured gain is simplicity (half the code, no state to get out of sync), not a better outcome on any scenario; the cost is a migration of every user's imports, a larger safety surface (a generator that writes next to the sources), dropped features, an unexplained failure, and no Windows or Linux evidence, while the current design has been hardened by two QA rounds, runs in CI on Linux and Windows, and now has every defect that the siblings prototype also exposed (SSR stub) fixed. **What would change the decision:** a library user who wants generated files in source control, a second Windows/Linux evidence round for the prototype, and the unexplained `verify` failure explained. The conditions the prototype's author named for adopting it: commit the facade `.d.ts` and ignore only the generated `.js`; port the SSR-safe stub (done in the current tool); fold the mode into the existing wrapper schemas; decide the after-check policy; a codemod from `@shaders/...`; document the `*.gpu.ts` naming rule; Windows and Linux CI.
