// Copies what `tsc` does not emit into dist/schematics: manifests, schemas, templates and the CommonJS marker.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../schematics/', import.meta.url));
const out = fileURLToPath(new URL('../dist/schematics/', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'testing' ? [] : walk(path)) : [path];
  });
}

for (const file of walk(root)) {
  const rel = relative(root, file);
  const isAsset = (rel.endsWith('.json') && !rel.startsWith('tsconfig')) || rel.split(sep).includes('files');
  if (!isAsset) continue;
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  cpSync(file, join(out, rel));
}

// The compiled schematics read the package name from ../../package.json, i.e. dist/package.json, which only ng-packagr writes. On a clean
// checkout `npm run test:schematics` has no dist yet (found by QA: 102 tests failed with ENOENT): use the source manifest until the real
// build replaces it.
const manifest = fileURLToPath(new URL('../dist/package.json', import.meta.url));
if (!existsSync(manifest)) cpSync(fileURLToPath(new URL('../package.json', import.meta.url)), manifest);
