# typegpu-angular-poc

An Angular integration for [TypeGPU](https://typegpu.com): one shared GPU root, buffers that are destroyed with their component, signals that feed the render loop, a canvas directive, and `ng add` / `ng generate` schematics that set up the `'use gpu'` shader build. Proof of concept; the package name `@typegpu-poc/angular` is provisional and nothing is published.

**Using it:** start with [`lib/README.md`](lib/README.md) (install, `ng add`, the generated component, API, limits). **Why it is built this way:** [`docs/DECISIONS.md`](docs/DECISIONS.md), and [`docs/REACT-COMPARISON.md`](docs/REACT-COMPARISON.md) for how it relates to `@typegpu/react`.

## Repository layout

| Path | What |
|---|---|
| `lib/` | The library: `src/` (service, resources, frame loop, canvas directive), `testing/` (fake GPU helpers, secondary entry point), `tools/` (shader build plugin and bundle check, shipped with the package), `schematics/` (`ng add` and the component generator). Built with ng-packagr plus `tsc` for the schematics. |
| `app/` | Development consumer app. Installs the **built package** (not the sources) and holds the library's specs (`src/lib-tests`), the shader tripwire spec, and examples (hand-written vs integrated gradient, a telemetry wall, a measurement harness). |
| `app-ssr/` | The same package under SSR with hydration (`@angular/ssr`). |
| `scripts/` | `build-lib-and-install.sh`, the clean-consumer acceptance run (`acceptance-clean-consumer.sh`), and checks for watch mode and diagnostics (`verify-shader-watch.mjs`, `verify-diagnostics.sh`, `probes/`). |
| `docs/` | Architecture decisions and the React comparison. |

## Everyday commands

Requires Node 24 and npm 11.

```sh
./scripts/build-lib-and-install.sh          # build the library and install the tarball into app/ (rerun after every library change)
(cd lib && npm run test:schematics)         # schematic specs (builds dist/schematics, then runs vitest)
(cd app && npx ng test --watch=false)       # library specs, run against the built package
(cd app && npx ng build)                    # production build
(cd app && npx ng serve --port 4300)        # ?demo=raw | ?demo=telemetry | ?demo=sync | ?probe (GPU counters)
./scripts/acceptance-clean-consumer.sh      # new Angular app + ng add + ng generate + tests + builds + shader check
                                            #   ANGULAR_CLI=20|21|22, PM=pnpm, TYPEGPU_SPEC=<range> select the scenario
```

SSR check:

```sh
cd app-ssr && npm install --no-save ../lib/typegpu-poc-angular-*.tgz && npx ng build --configuration development \
  && NG_ALLOWED_HOSTS=localhost PORT=4403 node dist/app/server/server.mjs
```
