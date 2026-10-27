#!/usr/bin/env bash
# Reproduces the diagnostics the README promises, in an app that `ng add` has configured:
#   scripts/verify-diagnostics.sh acceptance/work-22/demo
# 1) error codes (NG0203, NG0303, NG0951, injectRoot message) via a probe spec; 2) NG8116 at build time;
# 3) missing unplugin-typegpu / @babel/core at build start; 4) TYPEGPU_SHADERS_LOG output.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "${1:?usage: verify-diagnostics.sh <configured app dir>}" && pwd)"
cd "$app"
bak="$(mktemp)"
cp src/main.ts "$bak"
cleanup() { cp "$bak" src/main.ts; rm -f src/wrong-usage.spec.ts src/probe-ng8116.ts "$bak"; for m in unplugin-typegpu @babel/core; do [ -d "node_modules/$m.off" ] && mv "node_modules/$m.off" "node_modules/$m"; done; }
trap cleanup EXIT
fail=0
check() { if [ "$2" = ok ]; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

echo "--- 1) error codes, via ng test"
if grep -q '"@angular/build:karma"' angular.json; then
  echo "skip (the test target is Karma; the probe spec uses Vitest globals)"
else
cp "$here/probes/wrong-usage.spec.ts" src/wrong-usage.spec.ts
out="$(npx ng test --no-watch --include src/wrong-usage.spec.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
echo "$out" | grep -E "^\[probe\]|Tests |×" | cut -c1-200
echo "$out" | grep -q "Tests  5 passed" && check "NG0203, injectRoot message, NG0303, NG0951 and the failed state are as documented" ok || check "probe spec" bad
rm -f src/wrong-usage.spec.ts
fi

echo "--- 2) NG8116 (a structural directive used without its import) at build time"
cat > src/probe-ng8116.ts <<'EOT'
import { Component } from '@angular/core';
@Component({ selector: 'app-probe', template: `<span *tgpuReady="let root"></span>` })
export class Probe {}
EOT
printf "\nimport { Probe } from './probe-ng8116';\nconsole.log(Probe);\n" >> src/main.ts
build="$(npx ng build -c development 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
echo "$build" | grep -E "NG8116|Application bundle" | cut -c1-200
echo "$build" | grep -q "WARNING.*NG8116" && check "NG8116 is a warning and the build still completes" ok || check "NG8116 warning" bad
echo "$build" | grep -q "Application bundle generation complete" || check "build completes" bad
cp "$bak" src/main.ts; rm -f src/probe-ng8116.ts

echo "--- 3) a missing peer stops the build at start with an install hint"
for pkg in unplugin-typegpu @babel/core; do
  mv "node_modules/$pkg" "node_modules/$pkg.off"
  msg="$(npx ng build -c development 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
  mv "node_modules/$pkg.off" "node_modules/$pkg"
  echo "$msg" | grep -m1 "Cannot load" | cut -c1-220
  echo "$msg" | grep -q "Cannot load \"" && echo "$msg" | grep -q "npm i -D @babel/core unplugin-typegpu" && check "missing $pkg: actionable message" ok || check "missing $pkg message" bad
done

echo "--- 4) TYPEGPU_SHADERS_LOG lists the matched imports"
log="$(TYPEGPU_SHADERS_LOG=1 npx ng build -c development 2>&1 | grep -E "^\[typegpu-shaders\]")"
echo "$log" | head -3 | cut -c1-200
echo "$log" | grep -q "onResolve ./my-canvas.gpu" && echo "$log" | grep -q "onLoad .*my-canvas.gpu.ts meta writes" && check "log shows onResolve and onLoad for the shader" ok || check "log output" bad
exit $fail
