#!/usr/bin/env bash
# Acceptance test for an npm-workspaces layout, where the dependencies are hoisted out of the application folder:
#   <repo>/package.json  {"workspaces": ["packages/*"]}   <repo>/node_modules (everything)   <repo>/packages/web (the app)
#   ng new -> npm install (at the repo root) -> ng add <tarball> (in packages/web) -> ng generate ...:component
#   -> ng build -> npm run check:shaders -> ng test -> hand-corrected plugin path is accepted and not duplicated.
# The schematic must write the REAL relative path (../../node_modules/@typegpu-poc/angular/tools/...), not the
# conventional node_modules/... that only exists in a flat install.
# Needs network (ng new, npm install). Everything happens in the work directory (created and wiped by this script).
#   scripts/acceptance-npm-workspaces.sh                       # Angular CLI 22 (default)
#   ANGULAR_CLI=21 scripts/acceptance-npm-workspaces.sh
#   PKG_TGZ=/path/to/typegpu-poc-angular-0.0.1.tgz scripts/acceptance-npm-workspaces.sh   # test this tarball; do not build lib/
#   ACCEPTANCE_WORK=/some/dir scripts/acceptance-npm-workspaces.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${ACCEPTANCE_WORK:-$root/acceptance/work-workspaces}"
cli="${ANGULAR_CLI:-22}"
pkg_name="@typegpu-poc/angular"
step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*"; exit 1; }

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
  step "build and pack the library (npm run pack)"
  (cd "$root/lib" && npm run pack >/dev/null)
  cp "$root"/lib/typegpu-poc-angular-*.tgz "$work/pkg.tgz"
fi

step "npm-workspaces repo with the application in packages/web (Angular CLI $cli)"
repo="$work/repo"
mkdir -p "$repo/packages" && cd "$repo"
printf '{ "name": "repo", "private": true, "workspaces": ["packages/*"] }\n' > package.json
npx -y "@angular/cli@$cli" new web --directory packages/web --defaults --skip-git --style=css --ssr=false --skip-install --package-manager=npm >"$work/new.log" 2>&1 || { tail -20 "$work/new.log"; exit 1; }
# typegpu as a RANGE, as the app of a monorepo usually has it: `ng add` would otherwise pin typegpu@0.12.8 inside
# packages/web, while npm installs the package's own peer (^0.12.8) at the repo root as the latest 0.12.x (0.12.9 at
# the time of writing): two copies of typegpu, and the generated component then fails to type-check (F32 is not
# AnyWgslData). Known issue of the exact pin, see the report; not what this script tests.
(cd packages/web && npm pkg set "dependencies.typegpu=^0.12.8" >/dev/null)
npm install >"$work/install.log" 2>&1 || { tail -20 "$work/install.log"; exit 1; }
[ -d node_modules/@angular/core ] && [ ! -d packages/web/node_modules/@angular/core ] || fail "dependencies are not hoisted to the repo root"
cd packages/web

step "ng add <tarball>, run inside packages/web"
npx ng add "$work/pkg.tgz" --skip-confirmation 2>&1 | tee "$work/ng-add.log" | tail -8
# Where npm puts the package depends on the peer ranges it can satisfy: with Angular 22, @angular/build needs
# @babel/core 8 at the root, so npm keeps this package (peer @babel/core ^7) and its Babel 7 inside packages/web;
# with Angular 20/21 (@babel/core 7) everything is hoisted to the repo root, which is the layout this test is for.
if [ -e "node_modules/$pkg_name" ]; then layout=local; else layout=hoisted; fi
echo "layout of the package after ng add: $layout"
if [ "$cli" -le 21 ]; then
  [ "$layout" = hoisted ] && [ -f "$repo/node_modules/$pkg_name/tools/typegpu-shaders.esbuild.mjs" ] || fail "expected the package hoisted to the repo root with Angular CLI $cli"
fi

step "angular.json and package.json point at the real files"
plugin_path="../../node_modules/$pkg_name/tools/typegpu-shaders.esbuild.mjs"
node --input-type=module -e "
import { readFileSync, existsSync } from 'node:fs';
const ws = JSON.parse(readFileSync('angular.json', 'utf8'));
const app = Object.values(ws.projects)[0].architect;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const plugins = app.build.options.plugins;
const expected = '$layout' === 'hoisted' ? '$plugin_path' : 'node_modules/$pkg_name/tools/typegpu-shaders.esbuild.mjs';
if (JSON.stringify(plugins) !== JSON.stringify([expected])) fail('plugins: ' + JSON.stringify(plugins) + ', expected ' + expected);
if (!existsSync(plugins[0])) fail('the plugin path does not resolve from packages/web');
const script = pkg.scripts['check:shaders'];
const tool = script.split(' ').find((t) => t.endsWith('check-shader-bundle.mjs'));
if (!tool || !existsSync(tool) || ('$layout' === 'hoisted' && !tool.startsWith('../../node_modules/'))) fail('check script: ' + script);
console.log('plugin: ' + plugins[0]);
console.log('script: ' + script);
"

step "ng generate $pkg_name:component my-canvas, then use it"
npx ng generate "$pkg_name:component" my-canvas 2>&1 | tee "$work/generate.log"
python3 - <<'PY'
import re
p='src/app/app.ts'
s=open(p).read()
s=s.replace("import { RouterOutlet } from '@angular/router';","import { RouterOutlet } from '@angular/router';\nimport { MyCanvas } from './my-canvas/my-canvas';",1)
s=re.sub(r"imports:\s*\[RouterOutlet\]","imports: [RouterOutlet, MyCanvas]",s,1)
assert 'RouterOutlet, MyCanvas' in s
open(p,'w').write(s)
h=open('src/app/app.html').read()
open('src/app/app.html','w').write('<app-my-canvas />\n'+h)
PY

step "ng build (development) and npm run check:shaders (production build + bundle check)"
npx ng build --configuration development 2>&1 | grep -E "Application bundle|ERROR|WARN" || true
npm run check:shaders 2>&1 | tee "$work/check.log" | grep -E "Application bundle|ERROR|WARN|ok:|untransformed|failed|scanning"
grep -q "ok: .*all transformed" "$work/check.log" || fail "check:shaders did not pass"

if [ "$cli" -ge 21 ]; then
  step "ng test (the generated spec runs through the plugin in the hoisted layout)"
  npx ng test --no-watch 2>&1 | tee "$work/test.log" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|FAIL|Test Files|Tests "
  grep -q "my-canvas.spec" "$work/test.log" && ! grep -q "FAIL" "$work/test.log" || fail "ng test did not pass"
else
  step "(ng test skipped on CLI $cli: Karma needs a local Chrome; acceptance-clean-consumer.sh covers it)"
fi

if [ "$layout" = hoisted ]; then
  step "stale flat-install paths (written before the dependencies moved to the repo root) are repaired by a second ng add"
  node -e "
const fs=require('fs');
const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
Object.values(ws.projects)[0].architect.build.options.plugins=['node_modules/$pkg_name/tools/typegpu-shaders.esbuild.mjs'];
fs.writeFileSync('angular.json',JSON.stringify(ws,null,2));
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.scripts['check:shaders']=pkg.scripts['check:shaders'].replace('../../node_modules','node_modules');
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));"
  npx ng add "$work/pkg.tgz" --skip-confirmation 2>&1 | grep -E "Replaced the plugin path|Fixed the path" || fail "the second ng add did not report repairing the stale paths"
  node -e "
const fs=require('fs');
const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
const plugins=Object.values(ws.projects)[0].architect.build.options.plugins;
if (JSON.stringify(plugins)!==JSON.stringify(['$plugin_path'])) { console.error('FAIL: plugins after repair: '+JSON.stringify(plugins)); process.exit(1); }
const script=JSON.parse(fs.readFileSync('package.json','utf8')).scripts['check:shaders'];
if (!script.includes(' ../../node_modules/')) { console.error('FAIL: script after repair: '+script); process.exit(1); }
console.log('ok: plugin entry replaced in place (not duplicated), check script path fixed');"
  npm run check:shaders 2>&1 | grep -E "ok:|FAIL|ERROR" | head -3
fi

step "a hand-corrected path is accepted by ng generate and not duplicated by a second ng add"
cp angular.json "$work/angular.before"
node -e "
const fs=require('fs');const ws=JSON.parse(fs.readFileSync('angular.json','utf8'));
const b=Object.values(ws.projects)[0].architect.build;
const cur=b.options.plugins[0];
b.options.plugins=['./'+cur.replace('/tools/typegpu-shaders','/tools/../tools/typegpu-shaders')];
fs.writeFileSync('angular.json',JSON.stringify(ws,null,2));"
cp angular.json "$work/angular.corrected"
npx ng generate "$pkg_name:component" second-canvas >/dev/null 2>&1 || fail "ng generate refused a path that resolves to the plugin"
npx ng add "$work/pkg.tgz" --skip-confirmation >/dev/null 2>&1
diff -q "$work/angular.corrected" angular.json >/dev/null || fail "a second ng add changed (duplicated?) the hand-corrected plugin entry"
echo "ok: the corrected path was accepted by ng generate and left alone by ng add"

step "ACCEPTANCE (npm workspaces) PASSED (CLI $cli). Work dir: $work"
