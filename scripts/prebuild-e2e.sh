#!/usr/bin/env bash
# Real-CLI test of the PREBUILD mode (`ng add --shaders prebuild`) against a packed tarball: the stock `ng build`, `ng test` and
# `ng extract-i18n` must build the shader modules by themselves, and each way it can go wrong must fail with a message that says why.
# A fresh Angular app is created in <work dir> (ng new, npm install: needs the network). About 2 minutes.
#
#   scripts/prebuild-e2e.sh <tarball> <work dir> [angular cli major, default 22]
#
# E2E_NEW_ARGS adds flags to `ng new`, E2E_TEST_ARGS to `ng test` (to try zone.js / zoneless apps and Angular 20's Karma).
# Plain bash for Linux, macOS and Git Bash: no GNU-only options, file edits through node. Exit code 0 when every check passes, 1 when one
# fails (all of them are run and listed), 2 when the app could not be set up. Check 13 needs a user that is not root (it is skipped otherwise).
set -euo pipefail

if [ "$#" -lt 2 ]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
tgz_dir="$(cd "$(dirname "$1")" && pwd)"
tgz="$tgz_dir/$(basename "$1")"
[ -f "$tgz" ] || { echo "no such tarball: $1" >&2; exit 2; }
mkdir -p "$2"
work="$(cd "$2" && pwd)"
cli="${3:-22}"
if command -v cygpath >/dev/null 2>&1; then tgz="$(cygpath -m "$tgz")"; work="$(cygpath -m "$work")"; fi # node and npm want C:/... on Windows

export NG_CLI_ANALYTICS=false CI=true NO_COLOR=1 FORCE_COLOR=0
failed=0
total=0
pass() { total=$((total + 1)); echo "PASS  $1"; }
fail() { total=$((total + 1)); failed=$((failed + 1)); echo "FAIL  $1"; }
log="$work/last.log"

# run <name> <expected exit code> <command...>: runs it in the app, keeps its output in $log
run() {
  local name="$1" want="$2" got=0
  shift 2
  "$@" >"$log" 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then pass "$name (exit $got)"; else fail "$name (wanted exit $want, got $got)"; tail -n 15 "$log" | sed 's/^/        | /'; fi
}
# said <name> <text>: the output of the last run contains the text (a file, not a pipe: `grep -q` closing the pipe early fails under pipefail)
said() {
  if grep -F -- "$2" "$log" >/dev/null; then pass "$1"; else fail "$1 (the output has no \"$2\")"; tail -n 15 "$log" | sed 's/^/        | /'; fi
}
# edit <file> <js expression over the text `s`>
edit() { node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");s=eval(process.argv[2]);fs.writeFileSync(f,s)' "$1" "$2"; }
digest() { node -e 'const c=require("crypto"),fs=require("fs");const h=c.createHash("sha256");for(const f of process.argv.slice(1))h.update(f).update(fs.readFileSync(f));console.log(h.digest("hex"))' "$@"; }

echo "== set up: Angular CLI $cli, $(node --version), tarball $tgz"
cd "$work"
rm -rf app
# shellcheck disable=SC2086 # E2E_NEW_ARGS: more flags for ng new (--zoneless or --no-zoneless)
npx --yes "@angular/cli@$cli" new app --skip-git --defaults --ssr=false --routing=false --skip-install --style=css ${E2E_NEW_ARGS:-} >new.log 2>&1 || { tail -n 20 new.log; echo "ng new failed" >&2; exit 2; }
cd app
npm install --no-audit --no-fund >"$work/install.log" 2>&1 || { tail -n 20 "$work/install.log"; echo "npm install failed" >&2; exit 2; }
# an application with messages to extract (`ng extract-i18n` builds the application too)
npm install --no-audit --no-fund "@angular/localize@$cli" >>"$work/install.log" 2>&1 || { tail -n 20 "$work/install.log"; echo "npm install @angular/localize failed" >&2; exit 2; }
edit angular.json 'const j=JSON.parse(s);const p=Object.keys(j.projects)[0];j.projects[p].architect["extract-i18n"]={builder:"@angular/build:extract-i18n"};JSON.stringify(j,null,2)'

echo "== ng add, generate"
run "1  ng add --shaders prebuild" 0 npx ng add "$tgz" --shaders prebuild --skip-confirmation
before="$(digest angular.json package.json tsconfig.json tsconfig.app.json tsconfig.spec.json)"
run "2  ng add again" 0 npx ng add "$tgz" --shaders prebuild --skip-confirmation
if [ "$before" = "$(digest angular.json package.json tsconfig.json tsconfig.app.json tsconfig.spec.json)" ]; then pass "2b the second ng add changed no configuration file"; else fail "2b the second ng add changed a configuration file"; fi
run "3  ng generate component" 0 npx ng generate @typegpu-poc/angular:component my-canvas
edit src/app/app.ts '"import { Component } from \"@angular/core\";\nimport { MyCanvas } from \"./my-canvas/my-canvas\";\n@Component({ imports: [MyCanvas], selector: \"app-root\", template: \"<h1 i18n>Hello</h1><app-my-canvas />\" })\nexport class App {}\n"'
rm -f src/app/app.html src/app/app.css src/app/app.spec.ts

echo "== the stock commands build the shaders themselves"
rm -rf shaders-dist dist
run "4  bare ng build on a clean checkout (no shaders-dist)" 0 npx ng build
if [ -f shaders-dist/app/my-canvas/my-canvas.gpu.js ]; then pass "4b it wrote the generated shader module"; else fail "4b shaders-dist/app/my-canvas/my-canvas.gpu.js was not written"; fi
rm -rf shaders-dist dist
run "5  ng extract-i18n on a clean checkout" 0 npx ng extract-i18n
if [ -f src/locale/messages.xlf ] || [ -f messages.xlf ]; then pass "5b messages file written"; else fail "5b no messages file"; fi
# shellcheck disable=SC2086 # E2E_TEST_ARGS is a list of flags (Angular 20's Karma needs --browsers=ChromeHeadless)
run "6  ng test (the generated spec passes)" 0 npx ng test --watch=false ${E2E_TEST_ARGS:-}
if [ "$cli" -ge 21 ]; then said "6b both generated specs ran and passed" "2 passed"; else said "6b both generated specs ran and passed" "Executed 2 of 2 SUCCESS"; fi
edit src/app/my-canvas/my-canvas.gpu.ts 's.replace("0.5 + 0.5 * Math.sin","0.25 + 0.75 * Math.sin")'
if grep -F "0.75" src/app/my-canvas/my-canvas.gpu.ts >/dev/null; then
  npx ng build >"$log" 2>&1 || true
  if grep -rF "0.75" dist --include=*.js >/dev/null; then pass "7  an edited shader reaches the bundle with a bare ng build"; else fail "7  an edited shader did not reach the bundle"; fi
else
  fail "7  the generated shader has no 0.5 + 0.5 * Math.sin to edit (the template changed: update this script)"
fi
cp src/app/my-canvas/my-canvas.gpu.ts "$work/gpu.good"
cp src/app/my-canvas/my-canvas.ts "$work/component.good"
cp tsconfig.json "$work/tsconfig.good"
restore() { cp "$work/gpu.good" src/app/my-canvas/my-canvas.gpu.ts; cp "$work/component.good" src/app/my-canvas/my-canvas.ts; cp "$work/tsconfig.good" tsconfig.json; chmod -R u+w shaders-dist 2>/dev/null || true; }

echo "== every way it can go wrong fails, and says why"
printf '\nexport const bad = (x: number) => { "use gpu"; try { return x; } catch (e) { return 0; } };\n' >>src/app/my-canvas/my-canvas.gpu.ts
run "8  a shader that cannot be transformed fails ng build" 1 npx ng build
said "8b ...naming the file" "my-canvas.gpu.ts"
# shellcheck disable=SC2086 # (a list of flags, as above)
run "9  ... and ng test" 1 npx ng test --watch=false ${E2E_TEST_ARGS:-}
said "9b ...naming the file" "my-canvas.gpu.ts"
restore

edit src/app/my-canvas/my-canvas.ts 's.replace("@shaders/app/my-canvas/my-canvas.gpu","./my-canvas.gpu")'
run "10 a relative import of a shader module fails ng build" 1 npx ng build
said "10b ...and says which import works" "@shaders/app/my-canvas/my-canvas.gpu"
restore

edit tsconfig.json 's.replace("\"compilerOptions\": {","\"compilerOptions\": {\n    \"paths\": { \"@app/*\": [\"./src/app/*\"] },")'
edit src/app/my-canvas/my-canvas.ts 's.replace("@shaders/app/my-canvas/my-canvas.gpu","@app/my-canvas/my-canvas.gpu")'
run "11 a shader module imported through a tsconfig paths alias fails ng build" 1 npx ng build
said "11b ...before bundling, naming the import" "@app/my-canvas/my-canvas.gpu"
restore

printf '\nexport { sceneFragment as again } from "@shaders/app/my-canvas/my-canvas.gpu";\n' >>src/app/my-canvas/my-canvas.gpu.ts
run "12 a shader module importing another through @shaders fails ng build" 1 npx ng build
said "12b ...naming the relative path to use" "Import './my-canvas.gpu' instead"
restore

echo "== a failing shader step is a failed run with a message, not 'An unhandled exception occurred'"
rm -rf shaders-dist dist
mkdir shaders-dist
chmod 555 shaders-dist
if (echo probe >shaders-dist/probe) 2>/dev/null; then
  rm -f shaders-dist/probe
  echo "SKIP  13 a read-only shaders-dist (this user can write to it anyway: root, or a file system without modes)"
else
  run "13 a read-only shaders-dist fails ng build" 1 npx ng build
  said "13b ...with the message of the shader step" "[typegpu-shaders] the shader step failed"
  if grep -F "unhandled exception" "$log" >/dev/null; then fail "13c ...and not as an unhandled exception"; else pass "13c ...and not as an unhandled exception"; fi
fi
chmod -R u+w shaders-dist
rm -rf shaders-dist dist
# (not esbuild or typescript: the Angular CLI itself needs them and would fail before any shader step; these two only the shader step needs)
mv node_modules/unplugin-typegpu node_modules/unplugin-typegpu.away
run "14 a missing unplugin-typegpu fails ng build" 1 npx ng build
mv node_modules/unplugin-typegpu.away node_modules/unplugin-typegpu
said "14b ...with the message of the shader step" "[typegpu-shaders] the shader step failed"
said "14c ...naming what to install" "npm i -D unplugin-typegpu"
run "15 and it builds again once it is back" 0 npx ng build

echo
if [ "$failed" -eq 0 ]; then echo "ALL $total CHECKS PASSED"; else echo "$failed of $total CHECKS FAILED"; fi
[ "$failed" -eq 0 ]
