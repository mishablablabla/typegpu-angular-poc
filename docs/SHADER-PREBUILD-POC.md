# Shader prebuild: proof of concept on the real showcase

> **Historical log (2026-10-26).** This file records how the prebuild was built and what was measured at each step; several statements in it are outdated: the experiments folder it refers to is not part of this repository, test counts and "not run" lists were superseded by two QA rounds and by CI (Linux and Windows unit and integration specs, real Angular CLI runs), `ng add` wiring and `extract-i18n` wrapping exist now, and `ng generate` works in a prebuild project. For the current behaviour read `lib/README.md` ("Shader prebuild"), for decisions `DECISIONS.md` (D10-D12), for known findings `../QA_FINDINGS.md`.


Date 2026-10-26, macOS arm64, Node 24.21, Angular 22.2 (`@angular/build` 22.2.4), typegpu 0.12.8, unplugin-typegpu 0.12.6.
Follow-up to `SHADER-BUILD-ALTERNATIVES.md` (approach I). Labels: **VERIFIED** (run here, result observed), **NOT VERIFIED** (not run), **HYPOTHESIS**.
All work is in `experiments/shader-alternatives/`. Nothing was committed or pushed; the TypeGPU monorepo (HEAD bec5d554), `site/`, `lib/` and `app-ssr/` were not modified (baseline builds went to a scratch output path).

## What was compared
- **A-site**: an untouched copy of `site/` on the current setup (`custom-esbuild` + `typegpu-shaders.esbuild.mjs` + the showcase's `?source` plugin).
- **I-site**: the same copy migrated to prebuilt shaders on **stock** Angular builders (`@angular/build:application`, `dev-server`, `unit-test`).
- **I-ssr**: a copy of `app-ssr/` migrated the same way.
Not compared: the main tree itself (it was not migrated).

## The minimal migration path (what actually had to change)
1. `tools/shaders.mjs` (171 lines): entry points are `src/**/*.gpu.ts`; esbuild's module graph gives the closure (shaders plus every project module they import); each module is transformed file by file (Babel + `unplugin-typegpu/babel`, TypeScript kept) into `shaders-dist/`, `tsc` emits the `.d.ts`. Modes `build`, `watch`, `check` (stale output and stray imports). Plus `tools/dev.mjs` (8 lines: build, then watchers + `ng serve`) and `tsconfig.shaders.json`.
2. `angular.json`: the three builders back to stock, `plugins` removed. `tsconfig.json`: `paths: { "@shaders/*": ["./shaders-dist/*"] }`. `package.json`: scripts `shaders`, `build`, `test`, `start`.
3. **Import rewrite**: 66 relative imports in 41 files now go through `@shaders/...`. The reason is that the 10 shader files import 10 plain modules (models, `layouts`, `crop`, `bundle`, `types`, `matrix.math`) that app code and specs import too. Those must be one instance (a bind group layout used by a shader and by a scene is one object), so they became part of the shader package. This is a one-off codemod (`tools/migrate-imports.mjs`, 51 lines) but it is a real change to the code base.
4. Showcase-only: the `?source` plugin (shows each file's code on the examples page) cannot run on stock builders; replaced by a generated module (`tools/sources.mjs`, 14 lines) and 52 changed imports. Not a library concern, but any app with its own esbuild plugins hits the same wall.
Total: 45 files differ from the original site.

## Results

| Area | A (current) | I (prebuild, stock builders) |
|---|---|---|
| Production build | 3.7 to 4.3 s (n=3) | 3.4 to 3.8 s (n=3) plus 1.4 to 1.7 s shader step |
| Initial bundle | 295.86 kB | 295.86 kB; 117 `'use gpu'` directives, all transformed, in both (shipped checker) |
| `ng test` | 11.1 to 14.3 s (n=2) | 11.9 to 13.5 s (n=2); 24 files, 358 tests pass on the **stock** `unit-test` (the 42-test `perf.writes` spec was excluded from both copies: it writes into the main tree) |
| Edit a shader, until served | 0.9 to 1.2 s (n=3) | 0.8 to 1.4 s (n=3) |
| Edit a helper/model, plain app file | 0.5 s / 0.8 s | 1.0 s / 0.9 s (one run each) |
| Web Worker importing a shader | **no**: 0 transforms in the worker bundle, build warns, checker exits 1 | **yes**: 6 transforms in the worker bundle; in a real browser the worker resolved the Risk field fragment shader to 7820 characters of WGSL |
| SSR | not run (earlier rounds: works) | server build ok, HTTP 200, hydrated in a real browser, gradient rendered |
| Source maps | dev and production map a shader token to its original line (44:33) | the same, after one fix (below) |

Measured by wall clock with a polling script (0.2 s granularity plus request overhead); the differences between A and I in speed are within noise.

Also VERIFIED in a real browser (dev server, real WebGPU): Risk field, Life, The Core, Neural flow and Autoscaler render from prebuilt shaders with no console errors. A visible edit (the cyan band turned green) appeared in the open page by itself, and reverting it restored the original within 8 s. **Matrix is NOT verified at runtime**: it stays on "Starting the demo scene" in this pane, in the original site as well, so it is not a regression; its shaders are covered by the test suite (both implementations resolve to the same WGSL) and by the bundle check.

## DX findings
Where prebuild is equal or better:
- Type errors in a shader file are reported in the same format as today (Angular still type-checks the sources because they stay in its program), and by the shader `tsc` watcher too (two reporters, duplicate lines).
- A syntax error in a shader and a transform error ("Unsupported JS functionality: TryStatement") give the same readable message as the plugin now does, after the prebuild tool got its own error formatter; with unplugin-typegpu used directly the message names no file and prints Babel internals.
- No dependency on a community builder, no reliance on Angular's `onLoad` order, workers and the stock test builder work.

Where it is worse:
- **A transform error does not stop `ng serve`.** It shows in the shader watcher's log; the app keeps running on the previous output. Today Angular fails the build and shows its overlay. `npm run build` and CI do fail correctly.
- **Stale output.** After a shader edit, a plain `ng build` (no shader step) exits 0 and ships the old shader. `shaders:check` exits 1 ("STALE"); `npm run build` and `npm test` rebuild first. Anything that calls `ng` directly (an IDE task, a CI step) bypasses that.
- **A forgotten relative import** (`./risk-field.gpu` instead of `@shaders/...`) is caught by `shaders:check` (exit 1) and by the bundle checker when the code is really used (exit 1), but `ng build` itself passes.
- Changing a shader's exports gives a burst of 2 to 5 failed rebuilds for about a second (JavaScript and declarations are written by different processes), then settles; the final state was correct after the revert.
- Three processes in dev (shader esbuild, `tsc`, `ng serve`), wrapped by `dev.mjs`. A module newly imported by a shader needs a restart of the watcher (from the code; the case was not run).
- Not checked: go-to-definition from app code lands on the generated `.d.ts` rather than the source (HYPOTHESIS; `declarationMap` was not enabled or tested).

## Problems found in my own tooling during the run (all fixed)
1. Source map paths came out doubled (`src/.../src/.../x.gpu.ts`); fixed with `sourceFileName: basename(path)`; re-verified.
2. `build` wiped `shaders-dist/`; with a watcher running, that left the dev server with an incomplete package (an overlay "Cannot find module '@shaders/...'"). Now it prunes stale files after the build instead; re-verified with `npm run shaders` during a running dev server.
3. Raw unplugin errors had no file name; fixed (see above).
4. A name clash (`SOURCES`) in the migration codemod, found by the first build.

## Maintenance cost (as far as it can be said)
- Tool code: 171 + 8 + 14 lines for prebuild, against 261 (plugin) + 261 (scanner) shipped today. (Superseded by the follow-up below: the tool is now packaged in `lib`; `ng add` wiring for it is still not done.)
- It still depends on `unplugin-typegpu/babel` and `@babel/core`, like today.
- New failure modes live in the workflow (stale output, split error surfacing), not in Angular internals. They are detectable by scripts, but only if the project uses those scripts.

## Not tested
Windows and Linux, pnpm/Yarn PnP, Angular 20 and 21, Karma, `ng add` for this approach, a new shader module added while the watcher runs, Matrix at runtime, real FPS or GPU time, hydration beyond the one SSR page, the main tree migrated in place.

## Recommendation
Prebuild is a viable path: it passed every scenario that was asked for on the real showcase, with equal build speed and bundle, and it fixes the two structural limits of the current approach (Web Workers, dependence on a community builder and on Angular's plugin order). It trades them for workflow risks that the tooling can detect but not prevent. Suggested position for a conversation with the TypeGPU team: the Angular package is runtime-only; shader building is a documented, tested prebuild recipe or small CLI; the current `custom-esbuild` plugin stays as an optional convenience for apps that want Angular's own error overlay. Before presenting it as a supported path: add `ng add` wiring and run the matrix above that was not tested. (Packaging the tool and making dev-time errors visible in the page are done: see the follow-up.)

---

# Follow-up (2026-10-26): the tool packaged in `lib`

The POC script became `typegpu-shaders`, shipped in `@typegpu-poc/angular` (`bin` + `tools/typegpu-shaders/`, 10 plain ES modules, 828 lines, no Angular imports). Usage and the guarantees table are in `lib/README.md`, section "Shader prebuild". Nothing was committed or pushed; the TypeGPU monorepo (HEAD bec5d554, only the pre-existing `?? docs/`), `site/`, `app-ssr/` and the Angular runtime sources (`lib/src`) were not touched by this step. Changed in `lib/`: new `tools/typegpu-shaders/`, new specs under `schematics/testing/tools/typegpu-shaders/`, `package.json` (`bin`, optional peers `esbuild` and `typescript`, dev dependencies `@babel/core`, `esbuild`, `unplugin-typegpu@0.12.6`, needed by the tests) with `package-lock.json`, `README.md`, and one hint line in `tools/check-shader-bundle.mjs`.

## Design (and its trade-offs)
- **Commands** `build`, `watch`, `check`, `run -- <cmd>`, `dev -- <cmd>`; options `--src --out --suffix --alias --tsconfig --root --config` or `typegpu-shaders.config.json`; the same functions as an API (`buildShaders`, `watchShaders`, `checkShaders`).
- **The project's own esbuild, TypeScript, Babel and unplugin-typegpu** are used (resolved from the project root), so the tool follows the versions the project builds with, and a missing one gives an install hint. Cost: four optional peers instead of bundled copies.
- **One process, one build at a time**, no child `tsc`: declarations come from the TypeScript API with the project's tsconfig (and `declarationMap`). JavaScript is emitted before declarations (it is what a dev server needs; measured below).
- **Single instances**: every project module a shader imports is part of the package and is emitted file by file; the application must import all of it through `@shaders/...`. The cost is the import rewrite in the application (`check --fix-imports` does it).
- **The closure is found by scanning import specifiers**, not by bundling, so it still exists while a file has a syntax error mid-edit. Cost: path aliases or non-TS imports inside shader modules are not followed.
- **Failure handling**: dev/watch writes a stub (red banner on the page + throw, file and line in the message); plain build removes the failed module's output; both record `status: error` in the manifest. Recovery is just a good build.
- **Not Angular CLI internals**: no builder, no esbuild-plugin hook, no overlay integration. The banner is plain DOM written by the stub.
- It ships inside the Angular package (one install) although it is framework-independent; a separate package would decouple versions at the cost of another artifact. Not decided.

## Tests (all run)
52 new tests in 4 files (`build`, `check`, `watch`, `cli` specs) on throwaway projects, covering: first build and a second identical build; incremental rebuild of a shader and of a plain module; a new module imported while watching and a deleted one (pruned); transformation failure, stub content, stub throws on import, recovery, closing the watcher while broken; syntax error in a shader and in a plain module; type error; stale, missing, incomplete, failed-build and empty-project detection; stray relative imports (static, dynamic, re-export), `--fix-imports`, unresolved alias imports, query imports left alone; single module instance (the model a shader mutates is the one an application importing `@shaders/model` gets); source maps (generated token mapped to the original line, source path resolves, `sourcesContent` is the original) and declaration maps; exit codes and ordering of `build`/`check`/`run`/`dev`, option and config-file handling, missing dependency message.
- Run 4 times in a row: 50/50 each time (before the last two additions); the final suite: **lib 10 files, 150 tests pass** (98 existing + 52 new).
- **Mutation check**: 13 deliberate breakages (no prune, hash ignoring plain modules, no stubs, source map path, status always ok, failed outputs kept, stray scan off, stale check off, `run` without build, watch ignoring non-`.gpu.ts` edits, alias check off, stub cleanup off, query-import fix off) were each caught by at least one test (1 to 13 failures).
- One flaky test (a race between file events and the assertion) was fixed by a `settled()` method on the watcher instead of a sleep.

## Packaging
`npm run build` + `npm pack` (to a scratch folder): the tarball has `bin: typegpu-shaders` and `tools/typegpu-shaders/*` (36 files in total; no specs or fixtures). In a **clean consumer project** (no Angular) installed from that tarball with `typegpu`, `unplugin-typegpu`, `@babel/core`, `esbuild`, `typescript`: `node_modules/.bin/typegpu-shaders` links correctly; `build`, `check` and `run --` work (`npm run build` there printed the shader step and then the wrapped command). The migrated showcase and SSR app below use the tool **extracted from that tarball** (`experiments/shader-alternatives/packed/`), not the `.bin` link, and the main `site/` still has the old package installed (not repacked).

## Re-run of the POC with the packaged tool
| Scenario | Result |
|---|---|
| Migration of the unmigrated site copy by `check --fix-imports` | 40 files rewritten, same `@shaders/...` set as the one-off codemod; all 13 `?source` imports intact (a bug here was found and fixed, below) |
| Shader step (20 modules) | 0.9 s |
| `check:shaders` (shaders, production `ng build`, bundle tripwire, shader check) | exit 0; initial 295.96 kB (+0.1 kB: the worker probe in `main.ts`); 123 `'use gpu'` directives (117 + 6 in the worker bundle), all transformed |
| `npm test` (stock `unit-test`) | 24 files, 358 tests pass |
| Web Worker in a real browser (dev server) | resolved the Risk field fragment shader: 7820 characters of WGSL |
| SSR app | build ok, HTTP 200, hydrated in a browser. The gradient was flat dark at one observation and fully drawn at another; the shader brightness is `0.5 + 0.5 * sin(time)`, which is dark near 4.7 s after load, so this is the animation phase, not a difference (original app at the same time was at a different phase) |
| Dev error visibility, real browser | a `try/catch` inside a shader: the open page showed the red banner with `src/.../risk-field.gpu.ts` and the candidate lines; fixing the file printed "recovered", and after a reload the scene rendered normally. After the failure the router had fallen back to the landing page, so the URL was lost (cost of the failed lazy chunk) |
| Edit a shader, until served (dev, n=4) | 0.71 to 1.1 s; with declarations emitted first it was 1.29 to 1.73 s (n=3). The original custom-builder copy measured 0.9 to 1.2 s earlier |
| Rename an exported shader symbol, then revert | 5 failed rebuilds in about a second, then converged to a good build (no stuck state) |
| Existing checks | lib suite 150/150; `check-shader-bundle` specs pass |

## What a plain `ng build` is protected against (each case run on the migrated showcase)
| Situation | Plain `ng build` |
|---|---|
| `shaders-dist` missing | **fails** (exit 1, 189 unresolved imports) |
| last `typegpu-shaders build` failed (transform error) | **fails** (exit 1; the failed module's output is gone); `check` exit 1 |
| a `dev`/`watch` session ended with a broken shader | **fails** (exit 1) after the cleanup added in this step; before it, the build passed with the error stub bundled (the app would throw on load) |
| type error in a shader source | **fails** (exit 1; the sources stay in Angular's TypeScript program) |
| shader edited after the last successful build | **succeeds and ships the old shader** (value check on the bundle). Not protected. `check` exit 1; `typegpu-shaders run -- ng build` rebuilt and shipped the new one |
Angular has no hook that runs before a build, so the last case cannot be guaranteed for a bare `ng build`; it is covered by the wrapper (npm scripts, CI, IDE tasks) and by `check` in CI. A killed `dev` session (SIGKILL) skips the stub cleanup (not tested), which `check` still reports.

## Found while verifying (all fixed, with tests where applicable)
1. After a `dev` session ended with a broken shader, the stub stayed and a plain build bundled it. Now removed on close; tested.
2. `check --fix-imports` rewrote `?source` imports (file text for the examples page) and dropped the suffix; imports with a query are now ignored; tested and mutation-checked. Found by comparing against the one-off codemod on the real site.
3. Emitting declarations before JavaScript made a dev edit take 1.3 to 1.7 s; swapped.
4. A test race (above).

## Still unverified or open
`ng add` wiring for this approach (the schematics still write `custom-esbuild`); Windows and Linux (the watcher uses Node's recursive `fs.watch`, run on macOS only); pnpm/Yarn PnP; Angular 20 and 21; the declared peer ranges `esbuild >=0.24` and `typescript >=5.5` (only esbuild 0.28.2 and TypeScript 6.0.3 were run); go-to-definition in an IDE (only the declaration map targets were checked); Matrix at runtime; a SIGKILLed dev session; whether the stub banner appears when the failing module is in the initial bundle rather than a lazy chunk (only a lazy chunk was observed); a production build of the showcase with real GPU rendering (dev server only). The previous plugin-based setup remains in `lib/tools/typegpu-shaders.esbuild.mjs`, unchanged and still tested.

## Comparison with the custom-builder implementation
Equal in the measured build size, test result and edit latency (0.7 to 1.1 s against 0.9 to 1.2 s); better for Web Workers and for needing no community builder. Worse for dev-time error surfacing (a banner in the page instead of Angular's overlay, and a lost route after a failed lazy chunk) and for the stale-output case on a bare `ng build`, and it adds a required import convention (`@shaders/...`) with a one-off rewrite.

---

# Follow-up 2 (2026-10-26): `ng add --shaders prebuild`

`ng add` can now set a project up for the prebuild (`lib/schematics/ng-add/prebuild.ts`, new option `--shaders plugin|prebuild`; **the plugin mode is still the default and unchanged**). Usage is in `lib/README.md` ("What `ng add` and `ng generate` do"). Nothing was committed or pushed; the TypeGPU monorepo, `site/` and `app-ssr/` were not touched.

## What it changes (exactly)
On the showcase before/after (`experiments/shader-alternatives/N-site`, a stock-builder copy of the migrated showcase with plain scripts), run through the built schematic on a real folder: 3 files changed, `angular.json` byte-identical.
- `package.json` scripts: `start` → `typegpu-shaders dev -- ng serve`; `build` → `typegpu-shaders run -- ng build`; `watch` → `typegpu-shaders dev -- ng build --watch --configuration development`; `test` → `typegpu-shaders run -- ng test`; added `shaders` (`typegpu-shaders build`) and `check:shaders` (`typegpu-shaders run -- ng build --configuration production && typegpu-check-bundle dist/site/browser && typegpu-shaders check`). Only plain `ng build|serve|test ...` scripts are wrapped (not ones with `&&`, `|`, `;`, `$(...)`, a variable prefix); the others are listed in the log. Existing `shaders` / `check:shaders` scripts are kept.
- `package.json` dependencies, only if absent: `typegpu`, `@babel/core`, `unplugin-typegpu`, `esbuild ^0.28.2` (on the showcase only `esbuild` was added).
- `tsconfig.json`: `compilerOptions.paths["@shaders/*"] = ["./shaders-dist/*"]`, comments kept (the array is written on several lines by the JSON editor).
- `.gitignore`: `shaders-dist/`.
- `typegpu-shaders.config.json`: only for a non-default layout (an app in `projects/<name>`; tested on a virtual workspace).
- The package gained two commands next to `typegpu-shaders`: `typegpu-check-bundle` (the existing bundle checker, now with a shebang) so the generated scripts do not need a `node_modules/...` path, and a `jsonc-parser` dependency (public package, for editing tsconfig files with comments). No Angular internals, no custom builder.
- `typegpu-shaders run` and `dev` now run the wrapped command unchanged while no `*.gpu.ts` file exists (`build` and `check` stay strict), so the rewritten scripts keep working right after `ng add`.

## Refusals (nothing changed)
Several applications; a project already set up with the plugin mode; a build target other than the stock `@angular/build:application` (or its devkit alias); no build `tsConfig`, or no `typescript` dependency; `@shaders/*` already mapped elsewhere; `baseUrl` other than the config's own folder; `extends` that is a package, a list, circular or missing; invalid tsconfig JSON; a test or web-worker tsconfig that would not get the mapping (own `paths`, or it does not extend the config holding it); Babel 8, `typegpu` out of range, Angular major outside 20 to 22 (the same checks as the plugin mode). Another Angular major than 22 gets a warning only.

## Tests
- `lib/schematics/ng-add/prebuild.spec.ts`: 48 tests on virtual workspaces made by Angular's own schematics: a fresh project (dependencies, all four scripts, paths with comments kept, `.gitignore`, `angular.json` identical, one install task, no source file touched, SSR output directory), an existing project (unrelated, chained and env-prefixed scripts untouched and listed; existing `check:shaders`, dependency, `paths`, `.gitignore` entries kept; the plugin mode still the default), repeated execution (2nd and 3rd run identical, user edits kept, no duplicates), layouts (`projects/<name>` config; a base config in another folder gets a relative path; an existing config kept), 14 refusal tests (some cover several cases), each asserting the message and that every file is unchanged, the final newline of `package.json`, and `wrapScript` cases. Plus 3 new tool tests (no-shader `run`/`dev`, strict `build`/`check`, the two declared commands).
- Whole lib suite: **11 files, 201 tests pass** (150 before this step).
- **Mutation check**: 12 deliberate breakages of the schematic; 10 were caught (each by 1 to 5 tests). The 2 that survived are equivalent mutants (a guard that another guard already makes redundant: `wrapScript` ignoring "already wrapped", and `ExistingBehavior` for a dependency that is never added when present); the first guard was removed as dead code. A later newline bug found on the real folder was fixed and mutation-checked.
- **Real folder**: the built schematic ran on the on-disk showcase copy (N-site), the result was written back, and a **second run changed nothing**. With the packaged commands linked into `node_modules/.bin` (as npm would link them): `npm run check:shaders` exit 0 (initial 295.96 kB; 123 `'use gpu'` directives, all transformed; the bundle checker ran through `typegpu-check-bundle`), `npm test` 24 files / 358 tests, `npm start` built the shaders, served, and a shader edit reached the dev server in about 1 s.

## Not verified
- The real `ng add <tarball> --shaders prebuild` command: the schematic was run through the schematics test runner and a script that loads a real folder, with the install skipped; the CLI's own install step, its forwarding of `--shaders`, and the `.bin` links created by a real npm install of this tarball were not exercised together (the commands were linked by hand; a clean-consumer install of the earlier tarball did create the `typegpu-shaders` link).
- Package managers other than npm (pnpm, Yarn), hoisted npm workspaces (whether `typegpu-shaders` is found on PATH from a nested app), Windows and Linux.
- Angular 20 and 21 on a real project (a virtual workspace with Angular 21 only checks the warning), Karma test targets (left untouched), an SSR project through `ng add` (the output directories are asserted in a virtual test only), a project in `projects/<name>` built end to end.
- `ng generate @typegpu-poc/angular:component` in a prebuild-configured project refuses (it looks for the plugin and its message points at the plugin mode); not changed.
- A bare `ng build` is not protected (see above); `ng add` cannot change that, it only logs it.

---

# Follow-up 3 (2026-10-26): the freshness problem removed at its source (wrapper builders)

Nothing was committed or pushed. TypeGPU core, the monorepo (HEAD bec5d554, only the pre-existing `?? docs/`), `site/`, `app-ssr/` and `lib/src` were not touched. The previous design of `ng add --shaders prebuild` (rewriting npm scripts to `typegpu-shaders run/dev -- ng ...`) is **replaced**; it was never released. Usage: `lib/README.md`.

## Root causes found in the previous design
1. **Freshness depended on how the build was started.** Angular has no hook before a build, so any `ng build` that bypassed an npm script (an IDE, CI, a colleague, a muscle-memory command) bundled stale shaders. No wrapper command or documentation can fix that; the build itself has to do it.
2. **Scripts cannot be rewritten reliably** (`&&`, env prefixes, other tools), which left unwrapped scripts that silently skipped the shader step.
3. **The generator and `ng add` were tied to the plugin setup**; `ng add` had never run through a real installation; layouts were restricted to one application.
4. The test matrix was one Angular major, one package manager.

## Options considered
| Option | Verdict |
|---|---|
| Keep scripts + wrappers (`run`, `dev`) and document `check` | Rejected: does not remove cause 1 or 2 |
| A TypeScript/Angular compiler hook | No such public hook (Angular's builders accept no plugins; the only esbuild hook in the application builder is an environment variable named `..._DO_NOT_USE`, Bazel-only) |
| A freshness assertion inside the bundle (compare a source hash at runtime) | Fails late (in the browser) and still ships the stale shader |
| `@angular-devkit/architect:concat` of a shader target and the stock target | CLI flags (`--output-path`, `--port`, `--watch=false`) are validated against the target's builder schema, so they would not reach the stock target |
| **A builder in this package that builds the shaders, then runs the official builder** (chosen) | The documented extension mechanism of the CLI (builders.json, `createBuilder`; angular.dev "Angular CLI builders"); `ng build/serve/test` from anywhere are protected; failures fail the run with file and line |

Findings that shaped the chosen design (all checked in the installed packages, not assumed):
- The official `application`, `dev-server` and `karma` option schemas are **identical in Angular 20.3, 21.2 and 22.2** except dev-server's `define` (21+); `unit-test` differs (`runner` required in 20, defaults differ, many options added). The CLI needs the schema to parse flags, so the package carries a generated union (`scripts/sync-builder-schemas.mjs`; unit-test without defaults).
- **The CLI treats `@angular/build:*` builders differently from any other builder**: `getArchitect(builderName.startsWith('@angular/build:'))` skips the empty-array fillers for them (identical in 20, 21, 22). A wrapper that delegates with `context.scheduleBuilder` makes the official builder run with `reporters: []` and friends, and `ng test` then prints **nothing** (observed, dump of the options the stock builder received through each path). So the wrapper validates against the installed official schema with the same object-only transform, and calls the functions `@angular/build` exports (`buildApplication`, `executeDevServerBuilder`, `executeUnitTestBuilder`, `executeKarmaBuilder`; Angular marks them experimental); `scheduleBuilder` stays as the fallback.
- Under pnpm (strict `node_modules`) the Architect and devkit packages are not visible from the package; they are looked up through the CLI's own tree.

## What changed
- **Builders** (`lib/builders.json`, `lib/builders/*.cjs`, `lib/builders/schemas/*.json`): `application`, `dev-server`, `unit-test`, `karma`. Each (1) makes the shader output current (fast no-op when it is), (2) fails the run for a transform, syntax or type error, a relative import of a shader module, or an `@shaders/...` import that matches nothing, (3) runs the official builder with the CLI's own options, (4) after a finished application build scans the output (and the SSR server directory) for an untransformed `'use gpu'`. `serve`, `build --watch` and `test` (unless `--watch=false`) rebuild on every change, show a failing shader as a banner + throw, and recover; the stub is removed when the session ends. The "buildTarget ... not supported" warning the official unit-test builder prints for a wrapper build target is filtered.
- **`ng add --shaders prebuild`** now switches the builder names in angular.json (options kept), adds the dependencies, the `@shaders/*` tsconfig mapping and the `.gitignore` line; **no script is touched** (problem 2 disappears). Several applications are supported (own `shaders-dist` per project folder; a tsconfig shared by several applications gets per-config entries). Plugin mode is the default and unchanged; the two modes refuse each other.
- **`ng generate ...:component`** works in both modes (prebuild: `@shaders/<path under the source root>/<name>.gpu`, refuses a path outside the source root).
- **Tool**: `ensureShaders`, `watchEnsure`, `allowEmpty` in `tools/typegpu-shaders` (shared by the CLI and the builders: no duplicated implementation); the CLI remains for non-Angular-CLI use.
- Package: `builders` entry, `builders.json` and `builders/` as assets, optional peers `@angular-devkit/architect`, `esbuild`, `typescript`; dependency `jsonc-parser` (tsconfig files with comments).

## Tests (all run, on the final tree)
- `cd lib && npm run test:schematics` (builds the schematics, then vitest) three times in a row: **13 files, 234 tests pass each time**. New or rewritten: `ng-add/prebuild.spec.ts` (36), component generator prebuild cases (6), `testing/builders/delegate.spec.ts` (30: the wrappers run by Architect itself with a stand-in `@angular/build`; includes a golden of the options a real `ng test` receives), `testing/builders/package.spec.ts` (9).
- `npx tsc -p schematics/tsconfig.json --noEmit` and `npx tsc -p tsconfig.lib.json --noEmit`: clean. `node --check` on every shipped script. There is no lint or format configuration in `lib/`.
- **Mutation checks**: 14 deliberate breakages of the builders and 8 of the schematic/generator; **all are caught** after two gaps were closed (watch decisions of `build --watch` and `test` had no test; 4 tests added).
- **One flaky run was seen** (a dev-server builder test failed twice in three consecutive runs right after an edit, then not in 12 runs, nor in 12 parallel-load runs, nor in the final suite); the cause was not found. If it reappears, that test (`dev-server wrapper ... keeps rebuilding`) is the place to look.

## Real end-to-end (the packed tarball, real `ng add`, clean `ng new` projects; macOS arm64, Node 24.21.0)
Commands: `npm run build && cd dist && npm pack`, then in each project `ng add <tgz> --shaders prebuild --skip-confirmation`, `ng generate @typegpu-poc/angular:component my-canvas`, the component wired into the app, then a battery: (1) bare `ng build` with `shaders-dist` deleted, (2) again unchanged, (3) shader edited then bare `ng build`, (4) a `try/catch` in a shader, (5) fixed, (6) a relative import of the shader module, (7) restored, (8) `ng test`.
| Project | Result |
|---|---|
| Angular 22.2.4, npm | all 8 pass (1: builds shaders itself; 2: shader step skipped; 3: new value in bundle, old gone; 4: exit 1, file and lines printed, **no `dist` written**; 6: exit 1) |
| Angular 21.2.28, npm | all 8 pass (Vitest) |
| Angular 20.3.41, npm | all 8 pass (Karma, headless Chrome: 4 of 4) |
| Angular 22.2.4, **pnpm 12.10.1** | all 8 pass (strict `node_modules`) |
| Angular 22.2.4 **SSR** (`--ssr`) | bare build: transformed shader in the server and browser bundles; prerendered; hydrated in a WebGPU browser; canvas drawn; no console errors |
| Angular 22.2.4 + a **Web Worker** importing the shader | production bundle has the transformed shader in the worker; in a browser the worker resolved the shader to WGSL (416 characters) |
| Workspace with **two applications** in `projects/` | `ng add --project` for each; each builds and tests; each has its own `projects/<name>/shaders-dist` |
| Second real `ng add` | `angular.json`, `tsconfig.json`, `.gitignore`, `package.json` unchanged |
| Dev server (`ng serve`, bare) | 22.2 in a browser: scene drawn, edit to served 0.61 to 0.77 s, a shader error shows the banner and the terminal message, fixing it recovers by itself; 21.2: 0.30 to 0.43 s; 20.3: 0.86 to 1.03 s |
| `ng build --watch` (22), `ng extract-i18n` (20) | shader rebuilt on edit and bundled; extraction works with a wrapper build target |
| Real-CLI refusals | webpack build target, a plugin-mode project, `--shaders bogus`: each refused with a message, `angular.json`, `tsconfig.json` and `.gitignore` byte-identical (only the CLI's own `package.json` entry for the package changed) |
| **Plugin mode (default)** with the same tarball | `ng add`, generate (relative import), bare build, `check:shaders` and `ng test` work exactly as before (the "not supported" warning of the test builder is the known one of that mode) |
Final reinstall of the last package into all projects: the same results again (and SSR, workspace and plugin-mode projects).

## Problems found while verifying (all fixed)
1. `ng test` through the first wrapper printed nothing: the array fillers above. Fixed by the direct-call design; the golden test pins the options.
2. Filler options of the schema union (`browsers: []`, `coverageWatermarks`, ...) made the official builder reject the run; they are dropped unless the project set them.
3. The generated union schema lost `definitions` of older majors (the CLI crashed on `#/definitions/coverage-reporters`); the script merges them and a test resolves every `$ref`.
4. The component generator computed the alias without the component folder.
5. `package.json` lost its final newline after dependency rules; kept.
6. A watcher outlived a finished official builder; closed in a `finally`.

## Unresolved, and why it cannot be removed here
- **Yarn / Yarn PnP, Windows, Linux, other Node versions**: only macOS with Node 24 and npm/pnpm are available in this environment (Linux and Windows are not testable here; this is an environment limit, not a known defect). The watcher uses Node's recursive `fs.watch`, which Node documents for Linux and Windows too.
- **Reliance on exports Angular marks experimental** (`buildApplication` and the other three). The alternative, `scheduleBuilder`, demonstrably changes the behavior of the official builders (arrays); it is the fallback only. A future Angular that changes these exports or adds options is handled by the fallback and by the drift warning, not removed.
- **Option flags newer than the schema copy** cannot be used on the command line (the CLI parses flags from the builder's schema); they work in `angular.json`.
- **Two sessions on one project** (`ng serve` plus a one-off `ng build` or `ng test`) share `shaders-dist` with no lock; since Follow-up 4 they cannot corrupt it (atomic writes, digest of the written files, no deletion of a running session's stub), but two sessions that both find the output stale both build it.
- **Editors** show `@shaders/...` unresolved until a first build.
- `ng new` projects print "Package has unmet peer dependencies" during `ng add` (`typegpu`, added by the schematic right after); the Angular `web-worker` schematic adds `webWorkerTsConfig` to the test target, which the official unit-test builder itself rejects (reproduced with the stock builder; not caused by this package).
- **Not run**: Karma on Angular 21/22 (only 20.3's), interactive (TTY) `ng test` watch mode, Angular 19 or 23+, an npm-workspaces layout with the CLI at the repository root.

## Migration implications
- Existing plugin-mode projects: nothing changes unless they run `ng add --shaders prebuild`, which is refused until the plugin setup is removed by hand.
- A project configured with the earlier (unreleased) script-wrapping version keeps working (`typegpu-shaders run/dev` still exist); running the new `ng add --shaders prebuild` on it switches the builders and leaves its scripts, which then do the shader step twice (the second is a no-op).
- Prebuild projects must import shaders and the modules they import as `@shaders/...`; `typegpu-shaders check --fix-imports` rewrites them.
- Angular's workspace writer reformats short arrays in `angular.json` (for example `styles`) when `ng add` updates it.

## Follow-up 4: adversarial audit of the builders (what was wrong, found by running it)
Each item was reproduced first (script or failing test), then fixed, then re-run on real `ng` projects. Details: the final report of that session; tests in `lib/schematics/testing/{builders,tools}`.
- **Build target options (serve, test).** The official dev-server and unit-test builders validate the build target's options against the schema of the builder the target names, i.e. the wrapper's, which the CLI fills with empty arrays; `conditions: []` made Angular drop `module` and `development`/`production` from the resolve conditions. Real CLI, `prebundle: false`, a package with `development` and `default` exports: stock serves `development`, the earlier wrapper served `default`. The official builder now sees `@angular/build:application` and an official-schema validation.
- **Outputs held back one step**: the first output of a dev server only arrived with the second (`ng e2e`, Cypress wait for the first one). Only an application build that is being checked holds its output now.
- **Cancel before the official builder started** left it running with nobody to stop it. Teardown is registered first and checked before anything starts.
- **`ng test` without `--watch` outside a terminal** was watched (stubs instead of a failure) although the official builder runs once there; the decision now follows `watch ?? isTTY()` and `--ui`.
- **Torn reads**: esbuild rewrote files in place; a reader process saw empty `.js`, `.js.map`, `.d.ts` files (about 50 in 700 000 reads over 42 rebuilds). Files are now written by a temporary file and a rename; unchanged files are not written.
- **Every save of any `.ts` file rewrote every shader output** (3 saves, 3 rebuilds, 17 of 17 files) and so made the dev server rebuild; a save that changes nothing the shaders are built from now builds nothing.
- **An interrupted build plus reverted sources was "fresh" with the wrong files** (reproduced with the earlier tool: it shipped the old edit). The manifest now carries a digest of the files the build wrote and `check`/`ensure` compare it with the folder.
- **A plain build deleted the stub a running dev server used**; it now writes none and leaves an existing stub (it still removes a stale good output of a failing module).
- **Stubs survived Ctrl-C** (the CLI does not stop builders on SIGINT and emits no `exit`); they are removed on exit and on SIGINT/SIGTERM, and only if the file is still a stub.
- **Dev mode did not report a relative import of a shader module** (it bundles the raw source); it is logged now. The post-build bundle check warns when it finds no output directory instead of passing silently.
- **The intermittent test** (`dev-server wrapper ... keeps rebuilding`): the test asserted on a log right after it saw the output file change; esbuild wrote the file in its own process, and the report came after the declarations, 116 to 263 ms later in 4 of 40 rebuilds. Writes and the report now happen in one synchronous step (0 of 40) and the test waits for the log. A new test fails on the earlier tool 3 of 3 times.
- **Real CLI after the fixes** (packed tarball): Angular 20, 21, 22 (npm) and 22 (pnpm) eight-step battery, SSR build, plugin mode, `ng test` without a TTY and a broken shader (exit 1), `ng build` next to a running `ng serve` (also with a broken shader), Ctrl-C.

