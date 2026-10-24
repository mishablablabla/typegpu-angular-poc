# app

Development consumer of `@typegpu-poc/angular`. It installs the **packed library** (run `scripts/build-lib-and-install.sh` from the repository root first), so it exercises the package the way a user would.

- `src/lib-tests/`: the library's behavioural specs, run against the built package with a fake GPU (`@typegpu-poc/angular/testing`).
- `src/shaders/`: a `*.gpu.ts` module and the tripwire spec that fails when the shader build plugin stops transforming it.
- `src/examples/`: the same gradient feature written by hand and with the library (`compare.spec.ts` runs the same tests on both), a telemetry wall, and a measurement harness for signal-to-uniform latency.
- `src/browser-probe.ts`: with `?probe` in the URL, counts buffer creation/destruction and queue writes on a real device (read `window.__gpuProbe`).

```sh
npx ng test --watch=false    # specs
npx ng serve --port 4300     # ?demo=raw | ?demo=telemetry | ?demo=sync | ?probe
npx ng build                 # production build
```

The build uses `@angular-builders/custom-esbuild` with the shader plugin from the package (see `angular.json`).
