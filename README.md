# typegpu-angular-poc

An Angular integration for [TypeGPU](https://typegpu.com): one shared GPU root, buffers that are destroyed with their component, signals that feed the render loop, a canvas directive, and `ng add` / `ng generate` schematics that set up the `'use gpu'` shader build. Proof of concept; nothing is published (`@typegpu-poc/angular` and `@typegpu/angular` both return 404 on npm): the installable name is `@typegpu-poc/angular`, built from a tarball (`cd lib && npm ci && npm run pack`).

**Using it:** start with [`lib/README.md`](lib/README.md) (install, `ng add`, the generated component, API, limits). **Why it is built this way:** [`docs/DECISIONS.md`](docs/DECISIONS.md), and [`docs/REACT-COMPARISON.md`](docs/REACT-COMPARISON.md) for how it relates to `@typegpu/react`. **What was verified, and what was only reported:** `docs/VERIFICATION.md` and `FINDINGS.md`; both (with `docs/CORE-AUDIT.md` and `docs/BEFORE-AFTER.md`) are git-ignored local working material and are not on GitHub.

## Repository layout

| Path | What |
|---|---|
| `lib/` | The library: `src/` (service, resources, frame loop, canvas directive), `testing/` (fake GPU helpers, secondary entry point), `tools/` (shader build plugin and bundle check, shipped with the package), `schematics/` (`ng add` and the component generator). Built with ng-packagr plus `tsc` for the schematics. |
| `app/` | Development consumer app. Installs the **built package** (not the sources) and holds the library's specs (`src/lib-tests`), the shader tripwire spec, and examples (hand-written vs integrated gradient, a telemetry wall, a measurement harness). |
| `site/` | Showcase site: the documentation page and six live examples, each with and without the integration (see `site/README.md`). Not on GitHub yet, so its "Source on GitHub" links 404. |
| `app-ssr/` | The same package under SSR with hydration (`@angular/ssr`). |
| `scripts/` | `build-lib-and-install.sh`, the acceptance runs (`acceptance-clean-consumer.sh`, `acceptance-npm-workspaces.sh`), and checks for the plugin, watch mode and diagnostics (`verify-shader-plugin.mjs`, `verify-shader-watch.mjs`, `verify-diagnostics.sh`, `probes/`). |
| `docs/` | Architecture decisions and the React comparison. |

## Everyday commands

Requires Node 24 and npm 11.

```sh
./scripts/build-lib-and-install.sh          # build the library and install the tarball into app/ (rerun after every library change)
(cd lib && npm run build && npm run test:schematics)   # schematic specs (98 in 6 files; they read lib/dist/package.json, so build first on a clean checkout)
(cd app && npx ng test --watch=false)       # library specs, run against the built package (166 tests in 13 files)
(cd site && npx ng test --watch=false)      # site specs (320 tests in 20 files)
(cd app && npx ng build)                    # production build
(cd app && npx ng serve --port 4300)        # ?demo=raw | ?demo=telemetry | ?demo=sync | ?probe (GPU counters)
./scripts/acceptance-clean-consumer.sh      # new Angular app + ng add + ng generate + tests + builds + shader check (needs the network)
                                            #   ANGULAR_CLI=20|21|22, PM=pnpm, TYPEGPU_SPEC=<range> select the scenario
./scripts/acceptance-npm-workspaces.sh      # the same in an npm workspace with hoisted dependencies (ANGULAR_CLI=21|22)
```

SSR check:

```sh
cd app-ssr && npm install --no-save ../lib/typegpu-poc-angular-*.tgz && npx ng build --configuration development \
  && NG_ALLOWED_HOSTS=localhost PORT=4403 node dist/app/server/server.mjs
```
