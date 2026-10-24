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
# Afterwards, for the browser check:  cd acceptance/work/demo && npx ng serve
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${ACCEPTANCE_WORK:-$root/acceptance/work}"
cli="${ANGULAR_CLI:-22}"
pm="${PM:-npm}"            # npm (default) or pnpm; the CLI picks the same manager for `ng add`
pkg_name="@typegpu-poc/angular"
step() { printf '\n=== %s\n' "$*"; }

step "build and pack the library (npm run pack: ng-packagr + schematics)"
(cd "$root/lib" && npm run pack >/dev/null)
rm -rf "$work" && mkdir -p "$work"
cp "$root"/lib/typegpu-poc-angular-*.tgz "$work/pkg.tgz"
tar tzf "$work/pkg.tgz" | grep -q 'package/schematics/collection.json' || { echo "FAIL: no schematics in the tarball"; exit 1; }

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

step "ng add <tarball> (the real CLI command; the package is not on npm, so the tarball stands in for its name)"
npx ng add "$work/pkg.tgz" --skip-confirmation 2>&1 | tee "$work/ng-add.log" | tail -15

step "ng generate $pkg_name:component my-canvas"
npx ng generate "$pkg_name:component" my-canvas 2>&1 | tee "$work/generate.log"

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

step "second ng add changes nothing"
cp angular.json /tmp/acc-angular.before; cp package.json /tmp/acc-package.before
npx ng add "$work/pkg.tgz" --skip-confirmation >/dev/null 2>&1
diff -q /tmp/acc-angular.before angular.json && diff -q /tmp/acc-package.before package.json && echo "ok: angular.json and package.json unchanged by a second ng add"
rm -f /tmp/acc-angular.before /tmp/acc-package.before

step "ACCEPTANCE PASSED (CLI $cli). Browser check: cd $work/demo && npx ng serve"
