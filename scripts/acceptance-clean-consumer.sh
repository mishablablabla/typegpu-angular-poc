#!/usr/bin/env bash
# Clean-consumer acceptance test for the PACKED package (not the sources):
#   ng new -> ng add <tarball> -> ng generate ...:component -> inspect -> ng test -> dev build -> prod build
#   -> shader bundle check (+ a negative check with the plugin disabled) -> second `ng add` is a no-op.
# Everything happens in acceptance/work/ (created and wiped by this script); the development app is not touched.
#   scripts/acceptance-clean-consumer.sh            # Angular CLI 22 (default)
#   ANGULAR_CLI=21 scripts/acceptance-clean-consumer.sh
#   PM=pnpm scripts/acceptance-clean-consumer.sh                  # a pnpm project (strict node_modules)
#   TYPEGPU_SPEC='^0.12.8' scripts/acceptance-clean-consumer.sh   # the app already has typegpu in this range (npm resolves it)
#   ACCEPTANCE_WORK=$PWD/acceptance/work-21 ANGULAR_CLI=21 scripts/acceptance-clean-consumer.sh   # keep several side by side
#   PKG_TGZ=/path/to/typegpu-poc-angular-0.0.1.tgz scripts/acceptance-clean-consumer.sh   # test this tarball; do not build or pack lib/
# Needs network (ng new and npm install). Runs the real `ng test`, `ng build`, `check:shaders` on the generated component.
# Afterwards, for the browser check:  cd acceptance/work/demo && npx ng serve
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${ACCEPTANCE_WORK:-$root/acceptance/work}"
cli="${ANGULAR_CLI:-22}"
pm="${PM:-npm}"            # npm (default) or pnpm; the CLI picks the same manager for `ng add`
pkg_name="@typegpu-poc/angular"
step() { printf '\n=== %s\n' "$*"; }

# `rm -rf` below: only ever a folder under acceptance/ of this checkout, or one the caller names with ACCEPTANCE_FORCE=1
case "$work" in
  "$root"/acceptance/*) ;;
  *) [ -n "${ACCEPTANCE_FORCE:-}" ] || { echo "refusing to delete $work: it is not under $root/acceptance/ (set ACCEPTANCE_FORCE=1 to allow it)" >&2; exit 1; } ;;
esac
rm -rf "$work" && mkdir -p "$work"
if [ -n "${PKG_TGZ:-}" ]; then
  step "use the given tarball $PKG_TGZ (nothing is built)"
  cp "$PKG_TGZ" "$work/pkg.tgz"
else
  step "build and pack the library (npm run pack: ng-packagr + schematics)"
  (cd "$root/lib" && npm run pack >/dev/null)
  cp "$root"/lib/typegpu-poc-angular-*.tgz "$work/pkg.tgz"
fi
# (not `tar | grep -q`: grep exits at the first match, tar then dies of SIGPIPE and `pipefail` turns that into a failure)
tar tzf "$work/pkg.tgz" > "$work/pkg.list" && grep -q 'package/schematics/collection.json' "$work/pkg.list" || { echo "FAIL: no schematics in the tarball"; exit 1; }

step "ng new (Angular CLI $cli)"
cd "$work"
npx -y "@angular/cli@$cli" new demo --defaults --skip-git --style=css --ssr=false --package-manager="$pm" >new.log 2>&1 || { tail -20 new.log; exit 1; }
cd demo
npx ng version 2>/dev/null | grep -E "Angular CLI|Angular:|Node" || true

if [ -n "${TYPEGPU_SPEC:-}" ]; then
  step "the app already depends on typegpu@$TYPEGPU_SPEC"
  npm install "typegpu@$TYPEGPU_SPEC" >/dev/null 2>&1
  # npm saves the resolved version; write the range as given (what a project with `^0.12.8` has), keep what is installed
  npm pkg set "dependencies.typegpu=$TYPEGPU_SPEC" >/dev/null && npm install >/dev/null 2>&1
fi

if [ "$cli" -ge 21 ]; then
  step "stock-only unit-test options before ng add (runner, coverage$([ "$cli" -ge 22 ] && echo ", splitting"): ng add must drop what the custom builder's schema lacks)"
  npm install -D "@vitest/coverage-v8@$(node -p "require('vitest/package.json').version")" >/dev/null 2>&1
  node -e "
const fs=require('fs');const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
const test=Object.values(ws.projects)[0].architect.test;
test.options={...test.options,runner:'vitest',coverage:true,...(Number('$cli')>=22?{splitting:false}:{})};
fs.writeFileSync('angular.json',JSON.stringify(ws,null,2));
console.log('test target before ng add:',JSON.stringify(test));"
fi

step "ng add <tarball> (the real CLI command; the package is not on npm, so the tarball stands in for its name)"
npx ng add "$work/pkg.tgz" --skip-confirmation 2>&1 | tee "$work/ng-add.log" | tail -15

step "ng generate $pkg_name:component my-canvas"
npx ng generate "$pkg_name:component" my-canvas 2>&1 | tee "$work/generate.log"

step "ng generate refuses names that would give a broken selector"
if npx ng generate "$pkg_name:component" foo.bar >"$work/bad-name.log" 2>&1; then echo "FAIL: foo.bar was accepted"; exit 1; fi
grep -q "cannot be used as a component name" "$work/bad-name.log" || { cat "$work/bad-name.log"; echo "FAIL: no clear message for foo.bar"; exit 1; }
[ ! -e src/app/foo.bar ] && [ ! -e src/app/foo ] || { echo "FAIL: foo.bar left files behind"; exit 1; }
echo "ok: foo.bar refused with a clear message, nothing written"

step "inspect angular.json, package.json and the generated files"
node --input-type=module -e "
import { readFileSync, existsSync } from 'node:fs';
const ws = JSON.parse(readFileSync('angular.json','utf8'));
const app = Object.values(ws.projects)[0].architect;
const pkg = JSON.parse(readFileSync('package.json','utf8'));
const plugin = 'node_modules/$pkg_name/tools/typegpu-shaders.esbuild.mjs';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (app.build.builder !== '@angular-builders/custom-esbuild:application') fail('build builder ' + app.build.builder);
if (!app.build.options.plugins?.includes(plugin)) fail('plugin missing from build options');
if (app.serve.builder !== '@angular-builders/custom-esbuild:dev-server') fail('serve builder');
// Angular 20 scaffolds a Karma test target: ng add leaves it alone (and says so); 21+ scaffolds Vitest.
const karma = Number('$cli') < 21;
if (karma ? app.test.builder !== '@angular/build:karma' : app.test.builder !== '@angular-builders/custom-esbuild:unit-test') fail('test builder ' + app.test.builder);
for (const f of ['src/app/my-canvas/my-canvas.ts','src/app/my-canvas/my-canvas.gpu.ts','src/app/my-canvas/my-canvas.spec.ts']) if (!existsSync(f)) fail('missing ' + f);
for (const d of ['typegpu']) if (!pkg.dependencies[d]) fail('dependency ' + d);
for (const d of ['@angular-builders/custom-esbuild','@babel/core','unplugin-typegpu']) if (!pkg.devDependencies[d]) fail('devDependency ' + d);
if (!pkg.dependencies['$pkg_name']) fail('ng add did not save the package');
if (!pkg.scripts['check:shaders']) fail('no check:shaders script');
if (!karma && Number('$cli') >= 21) {
  const o = app.test.options;
  if ('runner' in o || 'splitting' in o) fail('stock-only test options were not removed: ' + JSON.stringify(o));
  if (o.coverage !== true) fail('coverage option was lost: ' + JSON.stringify(o));
}
console.log('angular.json build/serve/test builders, plugin, deps, script and 3 generated files: ok');
const installed = (n) => JSON.parse(readFileSync('node_modules/' + n + '/package.json', 'utf8')).version;
console.log('installed: typegpu ' + installed('typegpu') + ', unplugin-typegpu ' + installed('unplugin-typegpu') + ', @babel/core ' + installed('@babel/core') + ', custom-esbuild ' + installed('@angular-builders/custom-esbuild'));
console.log(JSON.stringify({ test: app.test.options, script: pkg.scripts['check:shaders'], deps: { typegpu: pkg.dependencies.typegpu, unplugin: pkg.devDependencies['unplugin-typegpu'], babel: pkg.devDependencies['@babel/core'], esbuild: pkg.devDependencies['@angular-builders/custom-esbuild'] } }, null, 1));
"

step "use the component in the app (the only manual edit a developer makes: import + tag)"
python3 - <<'PY'
import re
p='src/app/app.ts'
s=open(p).read()
s=s.replace("import { RouterOutlet } from '@angular/router';","import { RouterOutlet } from '@angular/router';\nimport { MyCanvas } from './my-canvas/my-canvas';",1)
assert 'MyCanvas' in s, 'app.ts layout changed'
s=re.sub(r"imports:\s*\[RouterOutlet\]","imports: [RouterOutlet, MyCanvas]",s,1)
assert 'RouterOutlet, MyCanvas' in s
open(p,'w').write(s)
h=open('src/app/app.html').read()
open('src/app/app.html','w').write('<app-my-canvas />\n'+h)
PY

step "ng test (unit tests: default app specs + the generated spec)"
if [ "$cli" -lt 21 ]; then
  # Karma (Angular 20 default): needs a local Chrome. Shader modules are not transformed in Karma tests; the generated spec fakes the GPU.
  export CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
  npx ng test --no-watch --browsers=ChromeHeadless 2>&1 | tee "$work/test.log" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Executed [0-9]+ of|FAILED|ERROR" | tail -3
  grep -q "TOTAL: .* SUCCESS" "$work/test.log" || { echo "FAIL: karma run did not succeed"; tail -20 "$work/test.log"; exit 1; }
else
  npx ng test --no-watch 2>&1 | tee "$work/test.log" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|FAIL|Test Files|Tests "
  grep -q "my-canvas.spec" "$work/test.log" || { echo "FAIL: generated spec did not run"; exit 1; }
fi

if [ "$cli" -ge 21 ]; then
  step "the generated shader resolves to WGSL with the installed typegpu / unplugin-typegpu pair"
  cp "$root/scripts/probes/shader-resolve.spec.ts" src/shader-resolve.spec.ts
  npx ng test --no-watch --include src/shader-resolve.spec.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "probe\]|Tests |×|Missing metadata" | tee "$work/resolve.log"
  grep -q "Tests  1 passed" "$work/resolve.log" || { echo "FAIL: the generated shader did not resolve"; exit 1; }
  rm -f src/shader-resolve.spec.ts
else
  step "(skipped on CLI $cli: its Karma tests do not transform shader modules; the bundle check below covers the transform)"
fi

step "ng build (development) + shader bundle check"
npx ng build --configuration development 2>&1 | grep -E "Application bundle|ERROR|WARN" || true
node "node_modules/$pkg_name/tools/check-shader-bundle.mjs" dist/demo/browser

step "npm run check:shaders (production build + check, the CI command)"
"$pm" run check:shaders 2>&1 | grep -E "Application bundle|Initial total|ERROR|WARN|ok:|untransformed|failed" 

step "negative: plugin disabled in the production configuration -> the check must exit non-zero"
cp angular.json angular.json.good
node -e "
const fs=require('fs');const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
Object.values(ws.projects)[0].architect.build.configurations.production.plugins=[];
fs.writeFileSync('angular.json',JSON.stringify(ws,null,2));"
npx ng build --configuration production 2>&1 | grep -E "Application bundle|ERROR" || true
if node "node_modules/$pkg_name/tools/check-shader-bundle.mjs" dist/demo/browser; then
  echo "FAIL: the shader check passed with the plugin disabled"; exit 1
else
  echo "ok: the check exited non-zero with the plugin disabled"
fi
mv angular.json.good angular.json

step "plugin scenarios: alias import, a directive outside *.gpu.ts, unique source maps"
mkdir -p src/app/shaders src/app/plain
cp src/app/my-canvas/my-canvas.gpu.ts src/app/shaders/alias-shader.gpu.ts
python3 - <<'PY'
import re
p='tsconfig.json'
s=open(p).read()
s=s.replace('"compilerOptions": {','"compilerOptions": {\n    "paths": { "@shaders/*": ["./src/app/shaders/*.gpu"] },',1)
assert '@shaders' in s
open(p,'w').write(s)
open('src/app/alias-user.ts','w').write("import { sceneFragment } from '@shaders/alias-shader';\nconsole.log(sceneFragment); // referenced, so the bundler keeps it\n")
open('src/app/plain/plain-directive.ts','w').write("export function plain(x: number) {\n  'use gpu';\n  return x;\n}\n// a string that only mentions it: 'use gpu';\nconsole.log(plain); // referenced, so the bundler keeps it\n")
m=open('src/main.ts').read()
open('src/main.ts','w').write("import './app/alias-user';\nimport './app/plain/plain-directive';\n"+m)
PY
npx ng build --configuration development >"$work/plugin-build.log" 2>&1 || { cat "$work/plugin-build.log"; echo "FAIL: build with a directive outside *.gpu.ts must still succeed (warning only)"; exit 1; }
sed 's/\x1b\[[0-9;]*m//g' "$work/plugin-build.log" | grep -A4 "WARNING" | head -8
grep -q "not named \*.gpu.ts" "$work/plugin-build.log" || { echo "FAIL: no build warning for the directive outside *.gpu.ts"; exit 1; }
grep -q "plain-directive.ts:2" "$work/plugin-build.log" || { echo "FAIL: warning without file and line"; exit 1; }
grep -q "alias-shader.gpu.ts" "$work/plugin-build.log" && { echo "FAIL: warned about a module the plugin transformed"; exit 1; }
if node "node_modules/$pkg_name/tools/check-shader-bundle.mjs" dist/demo/browser >"$work/plugin-check.log" 2>&1; then echo "FAIL: check passed with an untransformed plain-directive.ts"; exit 1; fi
grep -q "1 of 3" "$work/plugin-check.log" || { cat "$work/plugin-check.log"; echo "FAIL: expected exactly the plain-directive directive to fail (alias-shader and my-canvas transformed)"; exit 1; }
echo "ok: alias import transformed (only plain-directive.ts failed), build warned with file and line"
node -e "
const fs=require('fs');const m=JSON.parse(fs.readFileSync('dist/demo/browser/main.js.map','utf8'));
const own=m.sources.filter((s)=>!s.includes('node_modules'));
for (const want of ['src/app/my-canvas/my-canvas.gpu.ts','src/app/shaders/alias-shader.gpu.ts']) if (!own.includes(want)) { console.error('FAIL: source map lacks '+want+': '+own); process.exit(1); }
if (own.some((s)=>!s.includes('/'))) { console.error('FAIL: a bare file name in the source map: '+own); process.exit(1); }
console.log('ok: source map sources are workspace-relative: '+own.filter((s)=>s.includes('.gpu.')).join(', '));"
rm src/app/plain/plain-directive.ts && sed -i.bak "/plain-directive/d" src/main.ts && rm -f src/main.ts.bak
npx ng build --configuration development >/dev/null 2>&1
node "node_modules/$pkg_name/tools/check-shader-bundle.mjs" dist/demo/browser | tail -1

step "plugin scenario: a Web Worker bundle is not transformed, and says so (build warning + check hint)"
cp angular.json angular.json.pre-worker; cp src/main.ts src/main.ts.pre-worker
printf '/// <reference lib="webworker" />\nimport { sceneFragment } from "./shaders/alias-shader.gpu";\naddEventListener("message", () => postMessage(String(sceneFragment)));\n' > src/app/calc.worker.ts
echo '{ "extends": "./tsconfig.json", "compilerOptions": { "outDir": "./out-tsc/worker", "lib": ["es2022", "webworker"], "types": [] }, "include": ["src/**/*.worker.ts"] }' > tsconfig.worker.json
node -e "
const fs=require('fs');const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
Object.values(ws.projects)[0].architect.build.options.webWorkerTsConfig='tsconfig.worker.json';
fs.writeFileSync('angular.json',JSON.stringify(ws,null,2));"
printf '\nconst w = new Worker(new URL("./app/calc.worker", import.meta.url), { type: "module" });\nw.postMessage(1);\n' >> src/main.ts
npx ng build --configuration development >"$work/worker-build.log" 2>&1 || { cat "$work/worker-build.log"; echo "FAIL: the worker build failed"; exit 1; }
grep -q "Web Worker" "$work/worker-build.log" || { cat "$work/worker-build.log"; echo "FAIL: no worker warning in the build"; exit 1; }
if node "node_modules/$pkg_name/tools/check-shader-bundle.mjs" dist/demo/browser >"$work/worker-check.log" 2>&1; then echo "FAIL: check passed with an untransformed worker bundle"; exit 1; fi
grep -q "Web Workers are not supported.*worker-" "$work/worker-check.log" || { cat "$work/worker-check.log"; echo "FAIL: the check does not name the worker bundle"; exit 1; }
echo "ok: build warned about the worker and the check named the worker bundle"
mv angular.json.pre-worker angular.json; mv src/main.ts.pre-worker src/main.ts; rm -f src/app/calc.worker.ts tsconfig.worker.json

step "second ng add changes nothing"
cp angular.json "$work/acc-angular.before"; cp package.json "$work/acc-package.before"
npx ng add "$work/pkg.tgz" --skip-confirmation >/dev/null 2>&1
diff -q "$work/acc-angular.before" angular.json && diff -q "$work/acc-package.before" package.json && echo "ok: angular.json and package.json unchanged by a second ng add"
rm -f "$work/acc-angular.before" "$work/acc-package.before"

step "ACCEPTANCE PASSED (CLI $cli). Browser check: cd $work/demo && npx ng serve"
