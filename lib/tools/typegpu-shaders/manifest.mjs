// What a build leaves next to its output, so that `check` (and `run`) can tell whether the generated modules still match the sources.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { TMP_DIR, removeInside, writeIfChanged } from './atomic.mjs';

const MANIFEST = '.manifest.json';
/** Version of the manifest and of what its hash covers. 2: a digest of the generated files. 3: the list of the files the tool may have written (`generated`). */
export const SCHEMA = 3;
export const manifestPath = (config) => join(config.out, MANIFEST);

/** The generated files of one source module, relative to `out`. */
export function outputsOf(config, file) {
  const base = relative(config.src, file).replace(/\.ts$/, '');
  return [`${base}.js`, `${base}.js.map`, `${base}.d.ts`, `${base}.d.ts.map`];
}

/** The tsconfig the declarations are built with, and the files it extends by a relative path (a change there changes the output). */
function tsconfigBytes(config) {
  const seen = new Set();
  const parts = [];
  const visit = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      parts.push(`${file}:absent`);
      return;
    }
    parts.push(`${relative(config.root, file)}:${text}`);
    for (const [, spec] of text.matchAll(/"extends"\s*:\s*"(\.[^"]*)"/g)) visit(join(dirname(file), spec.endsWith('.json') ? spec : `${spec}.json`));
  };
  visit(config.tsconfig);
  return parts.join('\0');
}

/**
 * What the output depends on: the sources of the closure (read by `read`, a snapshot during a build so that the hash describes exactly
 * what was built), the versions of everything that transforms them (tool code included), the tsconfig, and the configuration.
 */
export function computeHash(config, files, versions, read = readFileSync) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ versions, suffix: config.suffix, schema: SCHEMA })).update('\0').update(tsconfigBytes(config)).update('\0');
  for (const file of files) hash.update(relative(config.root, file)).update('\0').update(read(file)).update('\0');
  return hash.digest('hex');
}

export function readManifest(config) {
  try {
    return JSON.parse(readFileSync(manifestPath(config), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeManifest(config, manifest) {
  writeIfChanged(config.out, manifestPath(config), JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * A digest of generated files, `[name relative to out, bytes]` pairs. The build records the digest of the files it wrote; `check` computes
 * it from the folder. They differ when the folder holds something else: files another build wrote meanwhile, a build that was killed half
 * way, an edit by hand. The source hash alone cannot tell (sources that were reverted match the old hash again).
 */
export function digestOf(entries) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

/** The digest of the generated files of `files` as they are on disk now. */
export function diskDigest(config, files) {
  const entries = [];
  for (const name of files.flatMap((file) => outputsOf(config, file))) {
    try {
      entries.push([name, readFileSync(join(config.out, name))]);
    } catch {
      /* absent: not part of the digest (check reports missing files separately) */
    }
  }
  return digestOf(entries);
}

/** What the tool writes: a name relative to `out` with one of its four extensions. */
const GENERATED_NAME = /^[^\0]+\.(js|js\.map|d\.ts|d\.ts\.map)$/;
const isGeneratedName = (name) => typeof name === 'string' && GENERATED_NAME.test(name) && !isAbsolute(name) && !name.split(/[\\/]/).includes('..');

/**
 * The files (relative to `out`) a build wrote or may have written, as the manifest recorded them; nothing else in `out` is the tool's to
 * delete. The manifest is a file like any other in a folder that may come from a cache or a shared checkout: an entry that is not a plain
 * relative name of a generated file (`../x`, an absolute path, a non-string) is ignored, never removed.
 */
export const generatedOf = (manifest) => (Array.isArray(manifest?.generated) ? manifest.generated.filter(isGeneratedName) : []);

/** Remove `dir` and its parents up to (not including) `out` while they are empty. */
function removeEmptyDirs(config, dir) {
  for (let current = dir; current.startsWith(config.out + sep) && current !== config.out; current = dirname(current)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmSync(current, { recursive: true });
    } catch {
      return;
    }
  }
}

function removeOutput(config, name) {
  const path = join(config.out, name);
  removeInside(config.out, path);
  removeEmptyDirs(config, dirname(path));
}

/**
 * Before a build writes anything: record in the manifest every file it may write, so a build that is killed half way still leaves the
 * list of what it may have left behind (a later build prunes by this list). The manifest stays what it was otherwise, except that one
 * of another version of the tool, or none, becomes a failed build: nothing in `out` is then known to be current.
 */
export function claimOutputs(config, previous, keep) {
  const generated = [...new Set([...generatedOf(previous), ...keep])].sort();
  const known = previous?.schema === SCHEMA;
  writeManifest(config, known ? { ...previous, generated } : { schema: SCHEMA, status: 'error', hash: undefined, outputs: undefined, stubs: false, files: [], errors: [{ source: 'config', text: 'The last build did not finish.' }], generated });
}

/**
 * Remove the generated files that belong to no module of the closure any more (a deleted or renamed source). Only files the manifest lists
 * are removed: whatever else is in `out` (a file of the user, a link) is left alone.
 */
export function prune(config, files, previous) {
  const keep = new Set(files.flatMap((file) => outputsOf(config, file)));
  const same = (a, b) => {
    try {
      // bigint: a Windows file id is 64 bits wide and does not survive being a double (two files could look like one)
      const x = statSync(join(config.out, a), { bigint: true });
      const y = statSync(join(config.out, b), { bigint: true });
      return x.ino === y.ino && x.dev === y.dev;
    } catch {
      return false;
    }
  };
  for (const name of generatedOf(previous)) {
    if (keep.has(name)) continue;
    // a file system that ignores case (macOS, Windows): `big.gpu.js` and `Big.gpu.js` are one file, and it is still wanted under its new name
    if ([...keep].some((kept) => kept.toLowerCase() === name.toLowerCase() && same(kept, name))) continue;
    removeOutput(config, name);
  }
}

/** The project has no shader module (any more): remove everything the tool generated, and the manifest. */
export function removeGenerated(config) {
  const manifest = readManifest(config);
  for (const name of generatedOf(manifest)) removeOutput(config, name);
  if (manifest) removeInside(config.out, manifestPath(config));
}
