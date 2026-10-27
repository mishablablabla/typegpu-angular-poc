# QA_PLAN.md — TypeGPU Angular integration (`@typegpu-poc/angular`)

> **Round 2 (2026-10-27, production-readiness).** This plan is the contract and matrix of round 1. Round 2 re-checked the repository state, reconciled every finding (`QA_FINDINGS.md`), ran the supported workflows again from a clean state on Angular 20/21/22 in both modes (real CLI, browser rendering on Angular 22), audited tests (mutation checks, flake loops, isolation), security and Windows, fixed what was confirmed, and added CI (Linux and Windows unit/integration, package contract, app, real-CLI jobs). Its commands and results are appended to `QA_EXECUTION_LOG.md`; the final verdict is in `QA_FINAL_REPORT.md`.


QA Lead plan. Status of the run is in `QA_EXECUTION_LOG.md`, defects in `QA_FINDINGS.md`, the verdict in `QA_FINAL_REPORT.md`.
Package under test: the PACKED tarball built from the current worktree on 2026-10-26 (sha256 `d8d71d75997699017abb94a341715605057ea803a3ec28f820e1cafe99d7571a`, `@typegpu-poc/angular@0.0.1`, 50 entries). Environment: macOS arm64 (Darwin 25.3), Node 24.21.0, npm 11.19.0, pnpm 12.10.1, Chrome headless / an embedded Chromium with WebGPU.

## 1. Product contract (what is promised, and where)

Sources: `lib/README.md` (R), `docs/SHADER-PREBUILD-POC.md` (P), `docs/VERIFICATION.md` (V). "Documented" = stated in R or P. "Expected" = reasonable but not written down.

### 1.1 Supported matrix (R "Compatibility")
- Angular 20, 21, 22 (peer `^20 || ^21 || ^22`), standalone apps on the esbuild application builder. Verified by the authors: CLI 22.2.4, 21.2.28, 20.3.41. Not claimed: 19 and older, 23+.
- `typegpu` `^0.12.8` with `unplugin-typegpu` 0.12.6/0.12.7; `@babel/core ^7.28`; `esbuild >= 0.24` and `typescript >= 5.5` (prebuild).
- npm (incl. workspaces), pnpm 22 (strict node_modules), Yarn 1 (one flow). Not claimed: Yarn 2+/PnP.
- macOS arm64 / Node 24.21.0 verified; Linux, Windows, other Node: not verified.
- Runners: Vitest (21/22 default); Karma on Angular 20 (plugin mode: no shader transform in tests; prebuild: wrapper `karma`).

### 1.2 Two shader modes
- **Plugin mode (default `ng add`)**: `@angular-builders/custom-esbuild` + `tools/typegpu-shaders.esbuild.mjs`. Limits (R "Limits"): no Web Workers, depends on Angular's un-namespaced `onLoad` ordering, community builder, stock `unit-test` ignores plugins, no decorators in `*.gpu.ts`, dev server reloads the whole page.
- **Prebuild mode (`ng add --shaders prebuild`)**: wrapper builders run `typegpu-shaders` (esbuild + unplugin-typegpu Babel, TS declarations) → `shaders-dist/` → official Angular builder. App imports `@shaders/<path>`.

### 1.3 `ng add` / `ng generate`
- Changes (R): `angular.json` builder names (+ plugin path in plugin mode; paths + gitignore + tsconfig `paths` in prebuild mode), `package.json` deps (`typegpu 0.12.8`, `@babel/core`, `unplugin-typegpu`, `esbuild` or `custom-esbuild`), script `check:shaders` (plugin mode). No edits to app code.
- Idempotent: second run changes nothing (documented, incl. byte-identity).
- Refuses (nothing changed except the package being installed): webpack builders, non-standalone expectations, unsupported versions, mode mix, `baseUrl`/`extends` forms, existing `@shaders/*` mapping etc. Karma test target left alone with a warning.
- `ng generate @typegpu-poc/angular:component <name>`: creates component, `.gpu.ts`, spec; refuses unconfigured projects and clashes; `--force` does not overwrite.

### 1.4 Build/serve/test flows
- Plugin mode: `ng build` (dev/prod), `ng serve`, `ng test` (custom-esbuild `unit-test`), `npm run check:shaders` fails when no `'use gpu'` is transformed.
- Prebuild (P, R "Shader prebuild"): a bare `ng build|serve|test` first makes `shaders-dist` current (fast no-op when fresh), fails on shader error with file:line (or candidate lines), refuses relative imports of shader modules and unresolved `@shaders/...`, then runs the OFFICIAL builder with the same options; a finished application build is scanned for untransformed `'use gpu'` (browser and server dirs).
- Watch: `ng serve`, `ng build --watch`, `ng test` (watch only when the official builder would: `--watch`, interactive TTY outside CI, `--ui`) rebuild shaders on change; a failing shader becomes a stub (banner, throws), recovery by fixing the file; stubs removed at session end (also Ctrl-C).
- Exit codes: non-watch commands exit non-zero on shader errors.

### 1.5 Shader authoring (R "Shader authoring")
- `*.gpu.ts` modules, `'use gpu'` functions, imports matched in plugin mode (relative with/without ext, `.js`, tsconfig `paths`, `baseUrl`, dynamic import, barrels). Prebuild: only relative specifiers inside `src` are followed; others are NOT transformed (document-level limitation, to be confirmed).
- Known runtime limits: vector operators fail type checks, `__tsover_add` ReferenceError when a CPU-called function uses operators and no typegpu code ran, shader files in `node_modules` not transformed in tests.

### 1.6 Failure semantics (R "Failure behavior")
- Runtime: "no WebGPU", "init failed + Retry", "device lost" UI in the generated component; SSR: no WebGPU access on the server (R "SSR and hydration").

### 1.7 Explicitly unsupported (R "Known limitations", P "Unresolved")
Web Workers in plugin mode; Yarn PnP; Windows/Linux (unverified); Angular 19-/23+; Safari/Firefox; two sessions without a lock (no corruption claimed, duplicate work allowed); editors show `@shaders/...` unresolved until a first build; option flags newer than the schema copy.

### 1.8 Contradictions / gaps noticed while reading (to confirm in lanes)
- R says "`ng add` ... `check:shaders` ... fails until the build contains a shader"; prebuild mode adds no such script (by design?) → clarify.
- R "Quick path" says `ng add` needs an absolute tarball path; `package.json` then records a relative `file:` path (works only where the tarball sits at that relative place). Documented.
- P "Not run" list (Karma 21/22, TTY `ng test`, Angular 19/23+) vs R matrix wording "verified end to end" — check each claimed combination is really run.

## 2. Happy-path checklist (Lead lane 0) — status in `QA_EXECUTION_LOG.md`
1 install → 2 `ng add` → 3 inspect diff → 4 `ng serve` reachable → 5 component with `.gpu.ts` loads → 6 bundle inspected (META present, no raw directive) → 7 documented features → 8 edit→rebuild→reflected → 9 `ng build` dev+prod → 10 `ng test` watch + non-watch → 11 broken shader: message + non-zero exit → 12 second `ng add` idempotent → 13 works from the packed package only. Run for BOTH modes on Angular 22.2.4/npm, then widened by lanes.

## 3. Lanes (parallel subagents; they do not edit the repo, they report)
| Lane | Scope | Output |
|---|---|---|
| A | CLI lifecycle: first output, cancel (SIGINT/SIGTERM), exit codes, TTY/CI, flags, parallel CLIs, leaked processes/state; plugin vs prebuild | `qa/lane-A/REPORT.md` |
| B | Transform + resolution: directive patterns, import forms, conditions, source maps, same-basename files, paths with spaces, packed vs workspace | `qa/lane-B/REPORT.md` |
| C | Filesystem integrity: torn reads, races, cache keys, stale output, concurrent serve/build/test, stub ownership, kill -9 | `qa/lane-C/REPORT.md` |
| D | Test quality: vacuous tests, mock fidelity, flake hunting, mutation testing, regression tests vs old behaviour | `qa/lane-D/REPORT.md` + `survivors.md` |
| E | Tarball contents, `ng add`/`generate` across Angular 20/21/22, npm/pnpm, partially configured projects, refusals byte-identical | `qa/lane-E/REPORT.md` |
| F | Compatibility matrix, SSR, zone/zoneless, Node versions, Karma 21/22, Web Worker, WebGPU absent | `qa/lane-F/REPORT.md` |
| Lead | Failure recovery / state-machine correctness (see §4) + verification of all P0/P1 + fixes | `QA_FINDINGS.md` |

(`qa/` = the QA scratch directory of the session, outside the repository.)

## 4. Lead lane: state machine and invariants
Resources: `shaders-dist/` files (`*.js`, `*.js.map`, `*.d.ts`, `*.d.ts.map`), `.manifest.json` (hash + digest + status), `.tmp/`, stubs, watcher handles, official builder runs.
| # | Transition | Invariant |
|---|---|---|
| S1 | valid build → output | manifest ok, digest == disk, outputs transformed |
| S2 | valid → invalid shader (one-shot) | command exits ≠0, no dist, previous good output not left as "fresh" |
| S3 | failed → source restored | next build succeeds; no manual cleanup |
| S4 | cancelled before official builder start | official builder never starts; no outputs claimed fresh |
| S5 | cancelled during transform | state is re-checkable: next ensure rebuilds (manifest/digest mismatch) |
| S6 | dev server: shader edit | rebuild reflected once; unrelated edits rewrite nothing |
| S7 | dev server + concurrent `ng build` | neither deletes/overwrites the other's active state; both outputs correct |
| S8 | kill -9 (watcher / build) | next run recovers; no misleading "fresh" |
| S9 | output file deleted/renamed | `check/ensure` rebuilds; never false-green |
| S10 | two rapid edits, older build completes last | final output matches final sources (hash/digest) |
| S11 | missing output directory | bundle check does not pass silently |
| S12 | empty output directory | treated as missing, rebuilt |
| S13 | stale artifacts (removed modules) | pruned or ignored; never bundled |

## 5. Risk-based test matrix
Legend: E = existing automated test (file), M = missing, ✔ = evidence in this run (see log), — = not yet.
| Contract item | Existing test | Evidence needed | Lane |
|---|---|---|---|
| ng add plugin changes/idempotency | `schematics/ng-add/index.spec.ts`, `real-fs.spec.ts` | real CLI, byte compare | Lead ✔ baseline, E |
| ng add prebuild + refusals | `ng-add/prebuild.spec.ts` | real CLI on 20/21/22/pnpm, refusals byte-identical | E |
| generator both modes | `component/index.spec.ts` | real generate + build + spec | Lead ✔, E |
| prebuild freshness (bare build) | `builders/delegate.spec.ts`, `tools/*` | real `ng` stale/fresh/error/stray | Lead ✔, A |
| first output / cancel / TTY semantics | `delegate.spec.ts` (stand-in builders) | real CLI processes | A |
| atomic write / digest / watch skip / stub ownership | `tools/{build,check,watch}.spec.ts` | concurrent real processes | C, Lead |
| conditions on serve/test | `delegate.spec.ts` | real CLI vs stock | B |
| plugin mode transform forms | `scripts/verify-shader-plugin.mjs` | inspected bundles | B |
| SSR / worker / Karma 21-22 | (manual earlier) | real runs | F |
| test quality / mutation | n/a | survivors list | D |
| failure recovery S1–S13 | partial | real subprocesses | Lead |

## 6. Exit criteria
Happy path verified in both modes from the packed package; all lanes reported or blocked with reason; every P0/P1 independently reproduced; each fix has a regression test that fails before the fix (where feasible); final suites re-run on the final worktree; git status inspected (no commit/push/publish); QA_FINAL_REPORT.md separates demonstrated confidence from assumptions.
