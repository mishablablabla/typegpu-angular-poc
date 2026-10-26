# QA_EXECUTION_LOG.md

Environment for all entries unless noted: macOS arm64 (Darwin 25.3), Node 24.21.0, npm 11.19.0, pnpm 12.10.1, Angular CLI 22.2.4 (`@angular/build` 22.2.4), package = packed tarball sha256 `d8d71d75…571a` built from the current worktree. Phase: **BASELINE** (no code modified yet in this QA run). Sandbox: `<scratch>/qa/lead/` (`base-plugin`, `base-prebuild`). Shared machine: up to 6 other lanes were running concurrently.

## Baseline — plugin mode (documented quick path), project `base-plugin`
| # | Command | Exit | Result | Evidence |
|---|---|---|---|---|
| 0 | `npx @angular/cli@22.2.4 new base-plugin --skip-git --style=css --ssr=false --routing=false --defaults` | 0 | PASS | CLI 22.2.4, npm install ok |
| 1-2 | `ng add <tgz> --skip-confirmation` | 0 | PASS | UPDATE angular.json, package.json; warns "unmet peer dependencies" (documented) |
| 3 | diff of changed files | — | PASS | angular.json: 3 builders → custom-esbuild, `plugins` entry, test options; package.json: deps `typegpu 0.12.8`, `@angular-builders/custom-esbuild ^22`, `@babel/core ^7.28`, `unplugin-typegpu 0.12.6`, `@typegpu-poc/angular file:../../pack/…tgz`, script `check:shaders`; tsconfigs and .gitignore unchanged |
| 3b | `ng generate @typegpu-poc/angular:component my-canvas` (+ wire into app) | 0 | PASS | CREATE .gpu.ts, .spec.ts, .ts |
| 4 | `ng serve --port 4501` | — | PASS | "Application bundle generation complete [1.9 s]"; HTTP 200 |
| 5-7 | load page in embedded Chromium (WebGPU on) | — | PASS | canvas 2016x480, gradient drawn, no console errors, no banner; served bundle has `__TYPEGPU_META__` ×1 |
| 8 | edit shader constant while serving | — | PASS | rebuild 0.26 s, "Page reload sent", new value in served bundle |
| 9 | `ng build --configuration development`; `ng build` (prod) | 0 / 0 | PASS | `check-shader-bundle`: "1 'use gpu' directive(s) … all transformed" (exit 0 both); value present in prod bundle; `npm run check:shaders` exit 0 |
| 10a | `ng test --watch=false` | 0 | PASS | 2 files, 4 tests passed |
| 10b | `NG_FORCE_TTY=true ng test` (watch), edit spec, shader, SIGINT to own process group | — | PASS (nuance) | first run 4 passed; "Changes detected. Rebuilding… complete"; a comment-only spec edit did not rerun tests (bundle identical: vitest semantics, not a defect); process group gone after SIGINT. Harness note: forced TTY triggers Angular's analytics prompt in a fresh project → use `NG_CLI_ANALYTICS=false` |
| 11 | broken shader (`try/catch` in `'use gpu'`): `ng build`, `npm run check:shaders`, `ng test --watch=false` | 1 / 1 / 1 | PASS | message `src/app/my-canvas/my-canvas.gpu.ts: Unsupported JS functionality: TryStatement [plugin typegpu-shaders]` (file, no line); dist not produced |
| 12 | second `ng add` | 0 | PASS | angular.json, package.json, package-lock.json, tsconfigs, .gitignore byte-identical |
| 13 | no dependence on unpublished workspace files | — | PASS (note) | node_modules package is a real copy (not symlink); no config/lock refers to the repo; the only external reference is the documented relative `file:` path to the tarball |

## Baseline — prebuild mode, project `base-prebuild`
| # | Command | Exit | Result | Evidence |
|---|---|---|---|---|
| 1-2 | `ng add <tgz> --shaders prebuild --skip-confirmation` | 0 | PASS | UPDATE angular.json, package.json, tsconfig.json, .gitignore |
| 3 | diff | — | PASS | builders → `@typegpu-poc/angular:application|dev-server|unit-test`; deps typegpu, @babel/core, esbuild, unplugin-typegpu; `tsconfig.json` `paths` `@shaders/*` → `./shaders-dist/*`; `.gitignore` `shaders-dist/` |
| 3b | generate component (+ wire) | 0 | PASS | component imports `@shaders/app/my-canvas/my-canvas.gpu` |
| 4 | `ng serve --port 4502` | — | PASS | "[typegpu-shaders] 1 modules (1146 ms)", build complete 2.5 s, HTTP 200 |
| 5-7 | embedded Chromium | — | PASS | canvas drawn, no console errors, no banner |
| 8 | edit shader while serving | — | PASS | 0.08 s rebuild, reload sent; new value in `shaders-dist` and served bundle; META in `shaders-dist/*.js` |
| 9 | `ng build -c development`, `ng build` | 0 / 0 | PASS | bundle check all transformed; value in prod bundle |
| 10a | `ng test --watch=false` | 0 | PASS | 4 passed |
| 10b | `NG_FORCE_TTY=true ng test` watch: real spec edit | — | PASS | 2nd run "3 passed" (vitest reruns the changed file); shader edit rebuilt shaders (264 ms); SIGINT: group gone |
| 11 | broken shader: `ng build`; `ng test --watch=false`; `CI=true ng test` (no flag, no TTY) | 1 / 1 / 1 | PASS | `[typegpu-shaders] src/app/my-canvas/my-canvas.gpu.ts - error: Unsupported JS functionality: TryStatement`; no dist |
| 11b | edit shader with nothing running, bare `ng build` | 0 | PASS | new value in bundle, old value 0 files |
| 12 | second `ng add --shaders prebuild` | 0 | PASS | all 7 files byte-identical |
| 13 | workspace references | — | PASS | none |

## Existing suites (baseline)
| Command | Exit | Result |
|---|---|---|
| `cd lib && npm run test:schematics` | 0 | 13 files, **262 tests passed** (41 s, under load from other lanes) |

## Post-baseline entries
(appended below as the run proceeds)

## Lead lane: failure recovery / state machine (real `ng` processes, packed package in `<scratch>/qa/lead/sm`, prebuild mode) — BASELINE package d8d71d75
Harness `sm.mjs` (scenarios s2s3 s4 s5 s5b s7 s8 s9 s10 s11 s12 s13 s14 s15). Values are made collision-proof (6-digit marker).
| Scenario | Result | Evidence |
|---|---|---|
| S1 valid build | PASS | exit 0, value in bundle |
| S2 invalid shader | PASS | exit 1, no dist, manifest `error`, previous good JS of the failed module removed, `typegpu-shaders check` exit 1 |
| S3 source restored | PASS | next build exit 0 with the new value; output digest equal to the earlier good build |
| S4/S5 SIGINT at 50/150/300/600/900/1300 ms | PASS ×6 | process ends by SIGINT; no partial dist; the next build correct and `check` ok |
| S5b kill -9 between "new JS visible" and manifest write, then source reverted | PASS 10/10 landed in the window | `check` exit 1 each time (digest mismatch), next build correct (old fresh-but-wrong hole closed) |
| S5 kill -9 at 12 time offsets | PASS | 0 wrong |
| S7 two cold builds at once ×4 | PASS | both exit 0, both bundles right, check ok |
| S7 serve + 11 concurrent `ng build`s during ~140 shader edits | PASS (no failed build; final served value = last edit) | note: my per-build value regex did not match, so "bundle matches a written value" for the intermediate builds is not evidenced |
| S8 kill -9 of `ng serve` with a stub; then plain builds | PASS ×3 | plain build fails while broken (stub not bundled), ok after fix, `.tmp` empty |
| S9 deleted/renamed/hand-edited output, deleted/corrupt manifest | PASS ×6 | rebuilt each time, hand-edit detected |
| S10 15 rounds of 2-5 rapid edits (0-160 ms apart) while serving | PASS | served and disk end on the last source every round |
| S11 custom/absolute `--output-path`; untransformed shader via tsconfig alias | PASS ×4 | alias case: build FAILS "1 of 2 'use gpu' directive(s) were not transformed" |
| S12 empty `shaders-dist`; junk module without manifest | PASS ×2 | rebuilt, junk not bundled |
| S13 removed module (≥2 shaders) | PASS ×3 | output pruned, dangling import fails |
| S14 `ng build` from a subfolder; rename of a shader while serving | PASS ×2 | transient "Cannot find module" between the two edits, then healthy |
| S14 delete the only shader while serving | **FAIL** → L1 | output not pruned |
| S15 last shader deleted but still imported, plain build | **FAIL** → L1 | exit 0, stale shader bundled |
| decoy: foreign files in the output folder | **FAIL** → L2 | both user files deleted by one build |
| read-only output folder | exit 127 → L3 (P4) | generic "unhandled exception … EACCES" |

## Incident (QA process), 21:22 local
A regression test I wrote for L2 built with `out: '.'` in a temp project whose `node_modules` symlinks to the repository's `lib/node_modules`; before the fix the tool emptied that directory. Restored with `cd lib && npm ci` (228 packages, `esbuild` 0.28.2 and `vitest` 5.0.5 load); the lockfile and package.json were not changed by it. The test now only resolves configuration. Lane D was told to discard runs from that window.

## Post-fix unit evidence (worktree, before re-packing)
| Command | Exit | Result |
|---|---|---|
| `npx vitest run schematics/testing/builders/delegate.spec.ts schematics/testing/tools/typegpu-shaders/ownership.spec.ts` | 0 | 53 passed |
| `npx vitest run schematics/testing/tools schematics/testing/builders` | 0 | all passed (see final run) |
| mutants on the new code (4): no cleanup in ensure / in build; walk-and-delete prune; no `out` validation | — | 4/4 killed by `ownership.spec.ts` |

## Post-fix real-CLI verification (package pack3 sha256 `46d2c0c0…07a0`, built from the worktree after the lane B/C fixes) — Lead, `sm.mjs`
| Scenarios | Result | Notes |
|---|---|---|
| s2s3 s4 s5b s7 s8 s9 s10 s11 s12 s13 s14 s15 | 40/41 PASS | the one FAIL (`S8 .tmp leftovers`: 1 file) was the harness counting the new `.tmp/sessions` registry record of a SIGKILLed dev server; harness adjusted (`sessions` ignored), rerun below passes |
| s16 two dev servers; first SIGINT with a stub, fix, last SIGINT | 6/6 PASS | stub stays while a session lives, removed by the last |
| s8 (rerun) | 4/4 PASS | `.tmp` 0 files besides `sessions` |
| S15 (last shader deleted, still imported) | PASS | build exit 1, no stale module (was FAIL on d8d71d75) |
| S14 delete of the only shader while serving | PASS | output pruned (was FAIL) |
| B1 independent check (plugin mode `base-plugin`, fixture package) | CONFIRMED DEFECT | default `ng build`: `COND_default`; with `--conditions module --conditions production`: `COND_prod` |

## Post-fix unit evidence
| Command | Exit | Result |
|---|---|---|
| `cd lib && npm run test:schematics` (after C3/C4/C5/C6/C7/C10/C13 fixes) | 0 | **14 files, 281 tests passed** (was 13 files / 262 at baseline) |
| `npx tsc -p schematics/tsconfig.json --noEmit`; `npx tsc -p tsconfig.lib.json --noEmit` | 0 / 0 | clean |
| mutants of the new code (L1/L2: 4; C3/C5/C6: 4; C7 1; C10/C13/C4: 3) | — | 12/12 killed |

## Existing suite: `app/` (library runtime specs through Angular's `ng test`)
| Command | Exit | Result |
|---|---|---|
| `cd app && NG_CLI_ANALYTICS=false npx ng test --watch=false` | 0 | 13 files, **166 tests passed** (baseline-style record, worktree before final changes; app/ uses its own installed copy of the library, not the new tarball) |
