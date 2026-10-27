# typegpu-angular-poc

An Angular integration for [TypeGPU](https://typegpu.com): one shared GPU root, buffers that are destroyed with their component, signals that feed the render loop, a canvas directive, and `ng add` / `ng generate` schematics that set up the `'use gpu'` shader build. **Proof of concept, not production-ready:** nothing is published (`@typegpu-poc/angular` and `@typegpu/angular` both return 404 on npm); the installable name is `@typegpu-poc/angular`, built from a tarball (`cd lib && npm ci && npm run pack`).

**Using it:** start with [`lib/README.md`](lib/README.md) (install, `ng add`, the generated component, API, shader modes, limits, what was verified where). **Why it is built this way:** [`docs/DECISIONS.md`](docs/DECISIONS.md), [`docs/SHADER-BUILD-ALTERNATIVES.md`](docs/SHADER-BUILD-ALTERNATIVES.md) and [`docs/REACT-COMPARISON.md`](docs/REACT-COMPARISON.md) for how it relates to `@typegpu/react`. **Quality evidence:** [`QA_FINAL_REPORT.md`](QA_FINAL_REPORT.md), [`QA_FINDINGS.md`](QA_FINDINGS.md) (every finding with its status), [`QA_PLAN.md`](QA_PLAN.md), [`QA_EXECUTION_LOG.md`](QA_EXECUTION_LOG.md).

## Two shader modes

| | Plugin (default `ng add`) | Prebuild (`ng add --shaders prebuild`, experimental) |
|---|---|---|
| How | `@angular-builders/custom-esbuild` + an esbuild plugin that transforms `*.gpu.ts` during Angular's build | wrapper builders run the `typegpu-shaders` tool (transform to a git-ignored `shaders-dist/`), then the official `@angular/build` builder |
| Needs | a community builder; relies on Angular's `onLoad` ordering | experimental `@angular/build` exports; keeps state on disk |
| Web Workers | not supported | supported |
| `ng test` | custom `unit-test` builder (Vitest); Karma on Angular 20 does not transform shaders | stock runners through the wrappers (Vitest and Karma) |
| `ng extract-i18n` | works | works (wrapper) |
| Import in your code | `./x.gpu` | `@shaders/<path>` (relative and other aliased imports are refused before bundling) |

An alternative core design for the prebuild (a generated file next to each shader, no output folder, no manifest) was prototyped and measured; it was not adopted for now: see [`docs/SHADER-BUILD-ALTERNATIVES.md`](docs/SHADER-BUILD-ALTERNATIVES.md). The prototype is kept on the branch `experiment/siblings-prototype`.

## Repository layout

| Path | What |
|---|---|
| `lib/` | The library: `src/` (service, resources, frame loop, canvas directive), `testing/` (fake GPU helpers, secondary entry point), `tools/` (the shader plugin, the `typegpu-shaders` tool and the bundle check, shipped with the package), `builders/` (the wrapper builders and their option schemas), `schematics/` (`ng add` and the component generator) and the specs of all of that (`schematics/testing/`). Built with ng-packagr plus `tsc` for the schematics. |
| `app/` | Development consumer app. Installs the **built package** (not the sources) and holds the library's specs (`src/lib-tests`), the shader tripwire spec, and examples. |
| `app-ssr/` | The same package under SSR with hydration (`@angular/ssr`). |
| `scripts/` | `build-lib-and-install.sh`, `verify-package.mjs` (the packed-tarball contract), the acceptance runs (`acceptance-clean-consumer.sh`, `acceptance-npm-workspaces.sh`, `prebuild-e2e.sh`), and checks for the plugin, watch mode and diagnostics (`verify-shader-plugin.mjs`, `verify-shader-watch.mjs`, `verify-diagnostics.sh`, `probes/`). |
| `docs/` | Architecture decisions, the shader build alternatives, the prebuild log, the React comparison. |
| `.github/workflows/ci.yml` | CI, described below. |

## Everyday commands

Node: CI runs Node 24 and 22.22.3; the package declares `engines.node` `^20.19.0 || ^22.12.0 || >=24.0.0` (what Angular 20/21 need; Angular 22 needs `^22.22.3 || ^24.15.0 || >=26`). npm 11 is what the lockfiles were made with.

```sh
(cd lib && npm ci)                          # dependencies of the package (lockfile)
(cd lib && npm run test:schematics)         # schematic, builder and tool specs: builds the schematics first, then vitest
(cd lib && npx tsc -p schematics/tsconfig.json --noEmit && npx tsc -p tsconfig.lib.json --noEmit)   # typechecks
(cd app && npm ci)                          # dependencies of the consumer app (lockfile; the library is NOT in it, see below)
./scripts/build-lib-and-install.sh          # pack the library and install the tarball into app/ (rerun after every library change)
(cd app && npx ng test --watch=false)       # library specs, run against the packed package
(cd app && npx ng build)                    # production build
(cd app && npx ng serve --port 4300)        # ?demo=raw | ?demo=telemetry | ?demo=sync | ?probe (GPU counters)
node scripts/verify-package.mjs lib/typegpu-poc-angular-0.0.1.tgz   # the tarball contains and declares everything it must
./scripts/acceptance-clean-consumer.sh      # new Angular app + ng add + ng generate + tests + builds + shader check (needs the network)
                                            #   ANGULAR_CLI=20|21|22, PM=pnpm, TYPEGPU_SPEC=<range>, PKG_TGZ=<tarball> select the scenario
./scripts/prebuild-e2e.sh <tarball> <workdir> [angular major]       # the prebuild mode with the real Angular CLI (27 checks)
./scripts/acceptance-npm-workspaces.sh      # the same in an npm workspace with hoisted dependencies (ANGULAR_CLI=21|22)
```

`app/` does **not** list the library in its `package.json` or lockfile: `npm ci` installs everything else from the lockfile, and `build-lib-and-install.sh` (or the CI job) then adds the packed tarball with `npm install --no-save`. A later plain `npm install` or `npm ci` in `app/` removes the library again, so rerun the script. SSR check:

```sh
cd app-ssr && npm install --no-save ../lib/typegpu-poc-angular-*.tgz && npx ng build --configuration development \
  && NG_ALLOWED_HOSTS=localhost PORT=4403 node dist/app/server/server.mjs
```

## Contributing and CI

There is no pull request template and no contribution guide yet; changes go through pull requests, and CI must be green. `.github/workflows/ci.yml` runs on every pull request, on pushes to `main` and manually (`workflow_dispatch`), with read-only permissions, no secrets, and actions pinned to commit SHAs:

| Job | What it proves |
|---|---|
| `lib` (Ubuntu Node 24, Ubuntu Node 22.22.3, Windows Node 24) | `npm ci` (lockfile), both typechecks, `npm run test:schematics`: the specs of the schematics, the wrapper builders and the `typegpu-shaders` tool, which run real processes and real files in temporary projects |
| `pack` (Ubuntu) | the library is packed **once** from the checkout; `scripts/verify-package.mjs` checks the tarball (every file the manifest, `collection.json` and `builders.json` point to exists, no specs or local paths, bin files executable with LF, manifest fields); the tarball is uploaded as an artifact |
| `app` (Ubuntu Node 24 and 22.22.3, Windows Node 24) | downloads that exact tarball, `npm ci` in `app/` from its lockfile, `npm install --no-save` of the tarball, checks the installed copy is byte-identical to the tarball, then `ng test`, `ng build` and the shader bundle check; fails if a tracked package file changed |
| `acceptance` (Angular 20, 21, 22; Ubuntu Node 24) | `ng new`, `ng add`, `ng generate`, builds, `ng test`, shader bundle check from the same tarball in plugin mode (`scripts/acceptance-clean-consumer.sh`) |
| `prebuild-e2e` (Angular 22; Ubuntu Node 24) | the prebuild mode with the real CLI from the same tarball: `scripts/prebuild-e2e.sh` (27 checks) |

**Why `app/` does not pin the tarball.** The hash of a tarball changes with any change of any shipped file, so a committed hash is stale after the next library change (the one that was committed here never matched, not even on the author's machine), and `npm ci` then fails with `EINTEGRITY` for everybody. Deleting that hash in CI would hide exactly the kind of inconsistency the check exists for, and packing on another operating system can change file modes (Windows has no executable bit), so a hash cannot be shared across operating systems either. The lockfile therefore pins every third-party package and says nothing about the library under test; the library is packed once on Linux, verified, and added from that exact tarball.

**What CI does not cover** (and where it was checked instead): the real-`ng` flows `ng serve`, Ctrl-C, `kill -9`, two dev servers and browser rendering were run by hand on macOS (the QA documents list them); the plugin and prebuild modes on Windows beyond the unit and integration specs; Yarn, pnpm workspaces, Angular 19 and 23+, Safari and Firefox. See `lib/README.md` ("Compatibility") for the exact list and `QA_FINDINGS.md` for the open findings.
