# Scenario matrix harness (plugin mode and prebuild mode, one harness)

Plain Node ESM (Node >= 22), no dependencies, no shell: every child is `child_process.spawn` with an argv array,
Angular runs as `node <app>/node_modules/@angular/cli/bin/ng.js ...`, npm as `node <npm-cli.js> ...`.
Children are killed only by the harness: POSIX `process.kill(-pgid)` for groups it created (`detached: true`), Windows
`taskkill /PID <pid> /T /F` for pids it started. Ports come from `net.listen(0)`. Every child has a timeout; negatives are proved by deadline polling.

## Run

```sh
node harness/matrix.mjs --mode plugin|prebuild|both --angular 22|21|20 --tgz <abs path to typegpu-poc-angular-0.0.1.tgz> --work <dir> \
     [--only S01,S05,S22] [--out results.jsonl] [--keep] [--fixtures-only]
```

- `--work <dir>`: everything lives below it (`pkg/` the copied tarball, `a22/cli` the Angular CLI, `a22/base` the `ng new` app, `a22/<mode>/fx` the app
  after `ng add` + `ng generate` + wiring, `a22/<mode>/<scenario>/demo` one private copy per scenario, `ev/a22/<mode>/<scenario>/` the logs).
  The harness deletes only below `--work`. Scenario copies are removed after each scenario unless `--keep`.
- Fixtures are built once per Angular major (`ng new`, `ng new --ssr` for S09) and once per mode (`ng add`, `ng generate`, wiring); a scenario copies the
  mode fixture (copy-on-write where the file system supports it). The apps sit at the same depth, so the `file:` path npm records for the tarball stays valid.
- Running the two modes as two processes at the same time is fine once the fixtures exist: run `--fixtures-only` first (it creates the CLI and the base apps), then one process
  per mode with its own `--out`. (Two processes of the SAME mode share scenario folders: do not.)
- `--only` takes ids or a prefix of three characters (`S07` runs `S07`, `S07-relative`, ...).
- Exit code: 0 (also when scenarios fail: read the table), 3 when a harness error happened, 2 usage.

## Output

JSON lines, one per (scenario, mode): `{ id, mode, angular, platform, status, category, expected, title, detail, evidence, ms }` and a `<out>.meta.json` with the
sha256 of the tarball and of `lib/expectations.mjs` (the pre-registered expectations). `status`: `pass` (observed category is in the expected list), `fail`,
`skip` (N/A that the expectation did not list), `error` (harness problem). Categories: `CORRECT`, `LOUD`, `SILENT-WRONG`, `UNSUPPORTED`, `N/A`, `ERROR`.

Verdicts come from the artifact: every scenario plants unique numeric markers (`0.3141` in the shader body, `0.7007` in a helper only the shader imports,
fresh `0.40NN7` values for edits) and reads the built output, the dev server response or a test result. A shader is "transformed" when the output contains
the quoted marker (`"0.3141"`, how TypeGPU stores a literal in the `__TYPEGPU_META__` AST) next to a `__TYPEGPU_META__` write; a marker that exists only as a bare number is "raw".
(esbuild prints `0.4120` as `0.412`: markers never end in 0.)

## Files

- `matrix.mjs` orchestration, table, scenario registry (ids and titles).
- `lib/expectations.mjs` the pre-registered expectations (do not edit after seeing results; add notes instead).
- `lib/util.mjs` processes, polling, hashing, file listing. `lib/app.mjs` fixtures, the `App` helper, marker scanning, shader templates, `MATRIX_MUTATE` hook.
- `lib/kit.mjs` classification helper, dev-server fetching. `lib/s-*.mjs` the scenarios, grouped: basic (S01-S03, S08, S09, S13), watch (S04-S06, S17, S18),
  serve (S10-S12), misuse (S07, S14-S16, S19-S23), browser (S24: Chrome over CDP with the global `WebSocket`, a built-in PNG decoder).

## Harness self-check

`MATRIX_MUTATE=plugin-off|plugin-regex|wrappers-off node harness/matrix.mjs ...` breaks the product inside each scenario's private copy (plugin removed, plugin regex that never matches,
wrapper builders swapped for the stock ones after one build). Scenarios must flip; see the report for what flipped.

## Not portable yet (see the report for the reasoning)

S12/S11/S10 depend on timing and process groups (Windows branch: `taskkill`, written, not run); S22 `"` in a file name is N/A on Windows; S13 uses `tar` (present on Windows 10+, Linux, macOS);
S24 needs Chrome (`CHROME_BIN` or the usual install paths) and a GPU or a software WebGPU adapter; S08 on Angular 20 needs `CHROME_BIN`; S21 only runs with `--angular 21` and needs the network.
