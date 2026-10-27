// Everything that touches the file system next to the sources. A generator that writes into `src` must not be turned against anything else:
// directories and files that are symbolic links are never followed, a generated file is only ever replaced or removed when it is a plain
// file that carries this tool's own header, and every write is a rename of a fresh private file (never a write through an existing name).
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const HEADER = '// @typegpu-siblings v1';
export const TMP_SUFFIX = '.typegpu-tmp';
const GENERATED = /\.generated\.(js|d\.ts)$/;

/** The generated files next to an entry (`a/x.gpu.ts`): `a/x.gpu.generated.js` and `a/x.gpu.generated.d.ts`. */
export const outputsOf = (entry) => ({ js: entry.slice(0, -3) + '.generated.js', dts: entry.slice(0, -3) + '.generated.d.ts' });

/** `{ ts, generated, temps }` under `src`: source files, files that look generated, and leftovers of an interrupted write. Links are skipped. */
export function scan(config) {
  const found = { ts: [], generated: [], temps: [] };
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no such folder (yet), or removed meanwhile
    }
    for (const entry of names) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || (entry.isDirectory() && entry.name.startsWith('.'))) continue; // never a link; not `.git`, `.angular` and the like
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) continue;
      else if (entry.name.endsWith(TMP_SUFFIX)) found.temps.push(path);
      else if (GENERATED.test(entry.name)) found.generated.push(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.ts.push(path);
    }
  };
  walk(config.src);
  found.ts.sort();
  return { ...found, entries: found.ts.filter((path) => path.endsWith(config.suffix) && !path.endsWith('.spec.ts')) };
}

/** What a generated file says about itself: `{ status, source, body, text }`, `{ facade: true }`, or undefined when it has no header of ours. */
export function readOwned(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined; // absent
  }
  if (!stat.isFile()) return { foreign: true };
  const text = readFileSync(path, 'utf8');
  const line = text.slice(0, text.indexOf('\n') >>> 0);
  if (!line.startsWith(HEADER + ' ')) return { foreign: true };
  const fields = Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  return { ...fields, facade: line.endsWith(' facade'), text, body: fields.body, rest: text.slice(line.length + 1) };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The folder of `path` is really inside `src` (no link or junction on the way). */
function insideSrc(config, path) {
  try {
    const parent = realpathSync(dirname(path));
    return parent === config.src || parent.startsWith(config.src + sep);
  } catch {
    return false;
  }
}

/**
 * Write `text` to the generated file `path` unless it already has exactly these bytes. Refuses (throws `UNSAFE_OUTPUT`) when the name is taken
 * by something that is not our own plain file, or when the folder is not really inside `src`.
 */
export function writeGenerated(config, path, text) {
  const current = readOwned(path);
  if (current?.foreign || !insideSrc(config, path)) {
    throw Object.assign(new Error(`Refusing to write ${path}: ${current?.foreign ? 'the name is taken by a file that this tool did not generate (move or delete it)' : 'the folder is not inside the source folder (a symbolic link on the way)'}.`), { code: 'UNSAFE_OUTPUT' });
  }
  if (current?.text === text) return false;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(6).toString('hex')}${TMP_SUFFIX}`);
  writeFileSync(tmp, text, { flag: 'wx' }); // an unpredictable name and `wx`: a link planted at the name is not written through
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return true;
    } catch (error) {
      if (attempt < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) { // Windows: a file that another process has open cannot be replaced at once
        sleepSync(10 + attempt * 5);
        continue;
      }
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** Remove a generated file, but only our own plain file. Returns whether something was removed. */
export function removeGenerated(config, path) {
  const current = readOwned(path);
  if (!current || current.foreign || !insideSrc(config, path)) return false;
  rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 });
  return true;
}

/** Remove leftovers of a write that was killed (older than ten minutes: nothing that is being written is that old). */
export function cleanTemps(temps) {
  for (const path of temps) {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && Date.now() - stat.mtimeMs > 10 * 60_000) rmSync(path, { force: true });
    } catch {
      /* gone */
    }
  }
}

export const isInside = (parent, path) => resolve(path).startsWith(resolve(parent) + sep);
