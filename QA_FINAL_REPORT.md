# QA_FINAL_REPORT.md — TypeGPU Angular integration (`@typegpu-poc/angular`)

## Round 2 (2026-10-27): production-readiness report

### 1. Verdict
**Ready for its stated scope: an experimental, publicly visible proof of concept of an Angular integration, installable from a tarball. Not production-ready**, and it does not claim to be. What changed since round 1: the known defects of both rounds were fixed or explicitly classified, installation and CI are reproducible from a clean checkout, the supported workflows have evidence behind them on Angular 20, 21 and 22 in both shader modes, and Linux and Windows are covered at unit and integration level by CI. What still prevents a production claim (all real, none hidden): the prebuild mode depends on `@angular/build` exports that Angular marks experimental and keeps state on disk; the plugin mode depends on a community builder and an Angular implementation detail; the real-`ng` flows (serve, Ctrl-C, kill, concurrency, browser rendering) were run by hand on macOS and are not in CI; real Windows `ng` flows and a Windows console Ctrl-C are unverified; Yarn/PnP, pnpm/Yarn workspaces, Angular 19 and 23+, Safari and Firefox were not tested; the repository has no LICENSE file; nothing has run in the field.

### 2. Changes made (meaningful ones; the ledger with IDs is `QA_FINDINGS.md`)
- **Safety of the shader tool:** the output folder is not trusted (manifest entries validated; every write and removal must really lie inside `out`; links and junctions never followed; unpredictable `wx` temp names; `out` must stay inside the project), `--fix-imports` never writes through a link, path containment decided by `relative` (case-insensitive on Windows), retries for removals and renames, a watcher that survives `error` events and events without a file name.
- **Commands:** `typegpu-shaders run|dev -- <cmd>` starts the command without a shell, with its own PATH/PATHEXT resolution, npm shims run through node, `cmd.exe` escaping as a fallback, correct exit codes and signal forwarding.
- **Prebuild:** `extract-i18n` wrapper; shaders imported through a tsconfig alias refused before bundling (also in `serve`); server-safe stubs (an Angular 20/21 SSR dev server no longer answers 500 for ever after a broken shader); a failing shader step reported as such; TypeScript's scanner for imports; nested `@shaders` imports diagnosed.
- **`ng add` / `ng generate`:** the stock resolve conditions written in plugin mode (B1: the plugin bundle now equals the stock builder's); Angular 20 SSR `security.allowedHosts` handled; CRLF, indentation and the final newline preserved; warnings for untested dependency versions; refusal of mixed modes; the check script only built from plain words; hints after `ng generate`; zoneless-aware generated spec.
- **CI and packaging (D11):** the library is packed once on Linux, its contents verified by `scripts/verify-package.mjs`, and that exact tarball installed in every consumer job; `app/`'s lockfile no longer pins a tarball hash, nothing tracked is modified in CI, no integrity check is bypassed; actions pinned to SHAs, read-only permissions; jobs: `lib` (Ubuntu x2, Windows), `pack`, `app` (Ubuntu x2, Windows), `acceptance` (Angular 20/21/22), `prebuild-e2e` (28 checks).
- **Tests:** about 295 new tests in round 2 (332 at the start, 627 on Ubuntu at the end), each mutation-checked; infrastructure hardened (private TMPDIR with a leak check, junctions, timeouts, `pool: forks`, no write-through of a fake build into a real package, order-independent app tripwire).
- **Documentation:** `README.md`, `lib/README.md`, `docs/DECISIONS.md` (D11, D12), `docs/SHADER-BUILD-ALTERNATIVES.md` (measured hybrid), `QA_*`.
- **Decision on the hybrid (sibling generation):** prototyped and measured; not adopted for now (D12); the prototype is kept on `experiment/siblings-prototype`.

### 3. Verification (details and commands: `QA_EXECUTION_LOG.md`, "Round 2")
- GitHub Actions at `edf7d09` (run 40439829661, after the independent review's fixes), all 11 jobs green: `lib` Ubuntu Node 24 and 22.22.3 (619 passed, 8 skipped), `lib` Windows Node 24 (620 passed, 9 skipped), `pack`, `app` x3 (166 passed each), `acceptance` Angular 20/21/22, `prebuild-e2e` (28/28).
- By hand on macOS: both modes on Angular 20.3.41, 21.2.28 and 22.2.4 (build, test, serve with edit/break/recover, SSR, hydration, workers, extract-i18n, refusals, idempotency); a state machine with real processes, 48/48; WebGPU rendering in headless Chrome on Metal (Angular 22, both modes); a Linux container for the prebuild flow script (Node 24 and 20.19).

### 4. Skipped tests (exact)
See `QA_FINDINGS.md`, "Skipped tests". In short: Linux skips the 7 real-`cmd.exe` tests and the case-rename test (a case-sensitive file system); Windows skips the 6 POSIX signal tests, the real-SIGINT stub test (`TerminateProcess`, W2) and 2 `chmod` tests. All remain, each with a stated reason; the stub-cleanup behaviour is additionally covered on every platform by portable per-signal tests.

### 5. Packaging and the lockfile
The committed `app/package-lock.json` pinned the integrity of a locally packed tarball that never matched a rebuilt one, so `npm ci` failed on a clean checkout; the first CI answer deleted that hash in the runner and left stale metadata. Replaced by D11: the library is not in `app/`'s lockfile, the tarball is added with `--no-save` after `npm ci` and checked byte for byte against the verified tarball.

### 6. Known limitations (verified) and what is untested
Verified limitations: web workers in plugin mode; Karma on Angular 20 does not transform shaders in plugin mode; the plugin mode's dev server reloads the page; the prebuild's `@shaders/...` imports are unresolved in editors until a first build; vector operators fail type checks (TS2365); a transform error without a line names the candidate lines; Angular 19 stops in npm before the schematic. Open findings: A5b, B6 (two typegpu copies bundled when a shader lives outside the app), B7 (the modes transform different file sets), C11 (deleting `shaders-dist` under a running `ng serve`), D4, F-L6, E7 (no LICENSE). Untested, not unsupported: Windows real `ng` flows and console Ctrl-C, Yarn 2+/PnP, pnpm/Yarn workspaces, Angular 19 and 23+, TypeScript 7, Safari, Firefox, a real locked file on Windows, a library project through ng-packagr with generated files.

### 7. Git state
Branch `feat/angular-prebuild-shaders-qa`, PR #1 (draft) into `main`; the working tree has only the intentionally untracked local material (`site/`, `experiments/`, `perf/`, presentation files, and the performance notes); nothing is published to npm, no release, no tag.

### 8. Repository safety
The main TypeGPU repository was not modified (HEAD `bec5d554`, status `?? docs/`). A harness fault created agent worktrees in it for a few minutes without changing any file; see "Incidents" in `QA_EXECUTION_LOG.md`.

### 9. Remaining work (only what blocks readiness or was deferred)
1. Windows: a real `ng serve`/build/Ctrl-C run (a self-hosted or manual session) and a real locked-file test.
2. A LICENSE file (owner's decision; the manifest says MIT).
3. Move the real-`ng` serve/kill/concurrency scenarios into CI (a nightly job) so they stop being manual.
4. Re-evaluate the sibling-generation design after a Windows/Linux evidence round for the prototype (D12).
5. Watch Angular releases: the wrappers and the schema copies need a sync per major (`scripts/sync-builder-schemas.mjs`).

---

# Round 1 report (2026-10-26, historical)

*Kept as it was written; several statements are superseded by round 2 (CI exists, Linux and Windows are covered at unit level, B1/B2/F-L5 and others are fixed, the tarball/lockfile design changed).*

Date 2026-10-26. QA Lead run. Environment: macOS arm64 (Darwin 25.3), Node 24.21.0 (also Node 22.23, 20.20, 26.10 in lane F), npm 11.19.0, pnpm 12.10.1, Chrome 155 (headless) and an embedded Chromium with WebGPU. Packages under test: packed tarballs built from the worktree: `d8d71d75…` (before fixes, tested by lanes A–F), final `3387afde…a6fa47a` (pack6, tested by the Lead after the fixes). Detailed ledgers: `QA_PLAN.md` (contract, matrix, lanes), `QA_FINDINGS.md` (every finding), `QA_EXECUTION_LOG.md` (commands and results).

## 1. Executive summary
- **Happy path: works** in both shader modes (plugin, prebuild) on Angular 22.2.4/npm from the packed package, 13 of 13 steps, on the pre-fix and on the final tarball.
- **What the evidence supports:** the prebuild mode is a sound design that survived hostile testing on real `ng` processes; the testing found a real set of implementation defects in it (two P1, several P2), all fixed and now covered by regression tests that fail without the fix. The plugin mode has fewer moving parts and received far less adversarial testing; it has one confirmed P2 (lost default resolve conditions, upstream cause) that is documented, not fixed.
- **Not "production-ready".** Verified only on macOS; Windows, Linux, Yarn and Angular 19/23+ were not run. The wrappers depend on `@experimental` `@angular/build` exports that Angular may change. The prebuild is young: this run found defects in a code base that had already passed an earlier audit, so another pass would likely find more.

## 2. Happy path — exact status
| Mode | Environment | Result |
|---|---|---|
| plugin (`ng add <tgz>`) | fresh `ng new` Angular 22.2.4, npm | 13/13: `ng add` (diff reviewed), generate + wire, `ng serve` reachable, canvas drawn in WebGPU browser with clean console, bundle has `__TYPEGPU_META__`, edit→rebuild→served value, `ng build` dev + prod + `check-shader-bundle` ok, `ng test` non-watch 4/4 and watch (TTY, rerun on edit, SIGINT clean), broken shader → exit 1 for build/check/test, second `ng add` byte-identical, no reference to the repo |
| prebuild (`--shaders prebuild`) | same | 13/13 incl. `ng build` after editing with nothing running (fresh bundle), broken shader exit 1 for `ng build`, `ng test`, `CI=true ng test` |
Both repeated on the final tarball (`final-plugin`, `final-prebuild`, script `qa/lead/baseline.sh`). A harness slip (zsh word-splitting of `--shaders prebuild`) produced one false failure that was fixed in the harness.

## 3. Tests executed (exact counts as printed)
| Suite | Result |
|---|---|
| `lib` (`npm run test:schematics`) at baseline | 13 files, **262 passed** |
| `lib` final (run twice) | 16 files, **332 passed**, `tsc` (schematics and lib) clean, `node --check` of all shipped scripts clean |
| `app/` (`ng test --watch=false`, library runtime specs) | 13 files, **166 passed** (baseline-style record; app uses its own installed copy) |
| Lead real-CLI state machine `sm.mjs` (prebuild, packed package) | final tarball: **47/47** (S1–S16: failures, kill -9 inside the new-JS→manifest window ×10, SIGINT at 6 offsets, rapid edits, concurrent builds, two dev servers, rename/delete/stale/empty/hand-edited output, alias bypass, custom output path) |
| Angular 21 and 20 SSR + prebuild, `ng new --ssr` | final tarball: `ng build` exit 0 (was failing) |
| zone.js Angular 22 generated spec | 4/4 (was 1 failing) |
| Lane A (CLI lifecycle) | ~60 real-process scenarios, no P0/P1 |
| Lane B (transform/resolution) | 26 scenario groups incl. 8 fixture packages for conditions, 42-case lexer battery |
| Lane C (filesystem/concurrency) | ~375k validated reads, 30 random kill -9 rounds, concurrent builds/serves |
| Lane D (test quality) | 240 mutants (134 killed), 30 flake-loop runs without a flake |
| Lane E (schematics/install) | 12 clean configs × add1/add2 byte-compare, 26 refusal scenarios |
| Lane F (compatibility) | 6 core cells × Node 24/22/20/26, SSR, workers, Karma 21/22, i18n, base-href |
Mutation checks by the Lead on the new/changed code: every added test was mutation-checked (about 45 mutants, all killed after two weak tests were corrected).

## 4. Confirmed defects (severity; status)
**P1 — fixed**
- L2: `typegpu-shaders` deleted every file in the output folder it did not write, followed symlinks, and accepted an `out` that contains the project (a test of mine emptied `lib/node_modules` this way; restored with `npm ci`). Fix: manifest-listed ownership, no directory walk, `out` validation.
- C3: freshness could be "green" for output built from other sources (A→B→A during one build). Fix: single-read snapshot for hash, esbuild and TypeScript.
**P2 — fixed**: L1/C8/A1 last shader deleted → stale shader bundled; C4 older build prunes a newer module; C10 one dev server deletes another's stub; C6/B4 writes outside the output folder; F-L1 Angular 20/21 + prebuild + SSR build fails (schema copy: `ssr.platform` default); F-L3 generated spec fails under zone.js on 21/22; E1 `ng add` pin → two typegpu copies in npm workspaces.
**P2 — documented, not fixed**: B1 plugin mode loses default resolve conditions (reproduced independently; cause in CLI + community builder; workaround verified); F-L2 Angular 20.3 SSR + plugin (custom-esbuild 20.0.0 schema rejects `security`; `ng add` now warns).
**P3/P4 — fixed**: C2, C5, C7, C12, C13, A3, A5a (`--no-watch`), D1, D2, F-L4 (`webWorkerTsConfig`), E4, E7 (`--help`), B3 (whole-line comments), coverage gaps from lane D.
**Open (P3/P4)**: E2, E3 (partly), E5/E6/E8/E9, B2, B5, B6, B7, B8, B9, C9, C11, F-L5, F-L6, F-L7, A2, A5b, A7 (suspected, not reproduced), D3, D4. Full list with statuses in `QA_FINDINGS.md`.

## 5. Evidence for key results
- L1/S15: `sm.mjs s15` on d8d71d75: exit 0 with stale shader; on the final tarball: exit 1 and the module removed.
- L2: sandbox `decoy/t.mjs` (user files gone after one build); regression `ownership.spec.ts`.
- C3: lane C barrier scripts on d8d71d75 (outputs MARK_B, sources MARK_A, `check` ok); regression uses the test-only `createBuilder(config, { afterSnapshot })` seam (not reachable from the CLI or builders).
- F-L1: independent reproduction on Angular 21.2.28 (`Data path "/ssr" must NOT have additional properties(platform)`), then fixed; `schemas.spec.ts` validates every filled option set against the real 20/21/22 schemas.
- B1: fixture package with `production`/`development`/`default` exports: default `ng build` → `COND_default`; `--conditions module --conditions production` → `COND_prod`.
- Regression tests fail without their fix (lane D revert checks + Lead mutants): atomic write/digest, file-vs-log ordering (3/3 failures on the old tool, 0/40 early visibility on the new), stub ownership, watch skip, conditions, first-output streaming, cancellation (one window), L1/L2/C3/C4/C5/C6/C7/C10/C13, F-L1, F-L4.

## 6. Subagents
| Lane | Result | Lead's independent verification |
|---|---|---|
| A CLI lifecycle | no P0/P1; A1 = L1 | S15 reproduced and fixed; `--no-watch` fixed |
| B transform | B1 (P2) + 8 lower | B1 reproduced independently |
| C filesystem | C1–C13 | C1 = L2 (own repro), C3/C4/C10/C6 fixed with regression tests, C10 verified with two real dev servers |
| D test quality | 30 clean flake runs, 240 mutants, D1/D2 | orphans stopped, D1/D2 fixed, gaps closed |
| E schematics | E1 (P2) + lower | E1 verified fixed in an npm workspace |
| F compatibility | F-L1/L2/L3 (P2), matrix | F-L1 reproduced independently; F-L3 reproduced and fixed |
Two read-only research agents (architecture) returned studies; see QA_FINDINGS.md. Lanes could not write `REPORT.md` files (tool refusal); their texts were returned as messages and summarised in `QA_FINDINGS.md`.

## 7. Compatibility actually verified vs expected
- **Verified (packed package):** Angular 20.3.41, 21.2.28, 22.2.4 × plugin/prebuild × dev/prod build, bundle check, `ng test` (Vitest 21/22, Karma 20; Karma 21/22 via the wrappers), `ng serve` + render in headless Chrome; Node 24/22/20/26 (npm); pnpm 12 on 22; SSR (prebuild 20/21/22 after the fix, plugin 21/22; plugin 20 needs the documented `security` removal); hydration with and without WebGPU; Web Workers (prebuild yes, plugin no as documented); i18n, `--base-href`, `--deploy-url`.
- **Expected only:** Angular 19 and 23+, TypeScript 7, typegpu 0.13 (does not exist on npm), Yarn, pnpm/Yarn workspaces, Windows, Linux, Safari, Firefox, interactive TTY `ng test` beyond the forced-TTY runs, the `esbuild` deadlock trace on SIGINT (A7, not reproduced).

## 8. Remaining risks
1. Experimental `@angular/build` exports (all wrappers and `custom-esbuild` itself); schema copies drift every major (`scripts/sync-builder-schemas.mjs` + `schemas.spec.ts` guard the copy, not future majors).
2. Platform coverage: atomic rename over open files (Windows), case-insensitive FS handling, recursive `fs.watch` are macOS-verified only.
3. Prebuild's custom on-disk state is young; this run found new defect classes in code that had been audited once.
4. Plugin mode: B1 stays until `ng add` writes `conditions` (product decision) or custom-esbuild is fixed.
5. Open P3/P4 items above (notably B2: aliased imports of shaders are only caught after bundling in `ng build`; `serve`/`test` fail at runtime).
6. Process hygiene: 33 leftover `typegpu-shaders-*` temp dirs remain in the system temp folder (test fixtures from aborted runs; a sweep was not authorised and was not done).

## 9. Final repository state
- No commit, push, tag, publish, stash or branch change: `main` at `cf70b7f`, stash empty. The TypeGPU monorepo is unchanged (`?? docs/`, `bec5d554`, branch `fix/normalized-vertex-format-io`); one lane ran a stray command there that created and removed an untracked `mini/` directory (verified gone).
- Worktree (`git status --porcelain`): 72 entries at the start of the run (user's work), 78 now: the additional entries are the QA documents, the generated-spec template fix, `copy-schematic-assets.mjs`, `scripts/schema-union.mjs`; the rest of the QA fixes edited files that were already modified/untracked (`lib/builders/*`, `lib/tools/typegpu-shaders/*`, `lib/schematics/**`, `lib/README.md`, `docs/SHADER-PREBUILD-POC.md`) and are therefore not new entries. Nothing of the user's was reverted.
- Incident (disclosed): `lib/node_modules` was emptied once by a regression test of mine and restored with `npm ci` (228 packages, lockfile unchanged); a later test wrote one probe file into `lib/node_modules/.bin` through a symlink, found by its own mutant and removed (it was my file).

## 10. Next action
Run the architecture experiment (read-only studies, P1–P10 in the research text): a ~150-line prototype of per-file sibling generation with a wrapper preflight on Angular 20/21/22, answering the two open questions (TypeScript/bundler resolution of `.generated` siblings; Angular's watcher rebuilding on a neighbouring file) before any rewrite. In parallel, run the current suite on Linux and Windows CI, which is the single most valuable gap in the evidence.
