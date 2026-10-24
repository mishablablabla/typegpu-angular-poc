// Copies what `tsc` does not emit into dist/schematics: manifests, schemas, templates and the CommonJS marker.
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = new URL('../schematics/', import.meta.url).pathname;
const out = new URL('../dist/schematics/', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'testing' ? [] : walk(path)) : [path];
  });
}

for (const file of walk(root)) {
  const rel = relative(root, file);
  const isAsset = (rel.endsWith('.json') && !rel.startsWith('tsconfig')) || rel.split('/').includes('files');
  if (!isAsset) continue;
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  cpSync(file, join(out, rel));
}
