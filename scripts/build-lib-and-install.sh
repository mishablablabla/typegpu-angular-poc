#!/usr/bin/env bash
# Builds lib/ with ng-packagr, packs it, and installs the tarball into app/ the way a consumer would.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/lib"
npm run pack
cd "$root/app"
npm install --no-save "$root"/lib/typegpu-poc-angular-*.tgz
