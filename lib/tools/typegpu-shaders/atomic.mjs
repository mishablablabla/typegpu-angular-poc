// Writes of generated files that nothing reading the output folder meanwhile (another process's build, Angular's file watcher, an IDE) can
// see half done: the bytes go to a temporary file in `<out>/.tmp` and are renamed into place (atomic on the same file system), and a file
// that already has exactly these bytes is not touched at all (no new modification time, so nothing downstream is rebuilt for nothing).
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isInside, isSameOrInside } from './paths.mjs';

/** Folder (inside the output folder) for files being written; never part of the output. */
export const TMP_DIR = '.tmp';
let counter = 0;

/** The real path of `path`, where the part that does not exist yet is taken as written (nothing exists there to follow). */
export function realExisting(path) {
  const tail = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      if (dirname(current) === current) return resolve(path);
      tail.push(basename(current));
    }
  }
}

/**
 * Whether `path` really lies inside `out`: not through `..` and not through a symbolic link or junction (a directory in `out` that points
 * elsewhere would make a write or a removal land in someone else's folder).
 */
export function insideOut(out, path) {
  if (!isInside(out, path)) return false;
  const root = realExisting(out);
  const parent = realExisting(dirname(path));
  return isSameOrInside(root, parent);
}

/** Remove one file the tool generated, unless it is not really inside `out`. */
export function removeInside(out, path) {
  // Windows: a file that something else has open cannot be removed at once
  if (insideOut(out, path)) rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Waits (ms) between the attempts to rename a file onto one that another process has open (Windows: an antivirus scan, an indexer, the dev
 * server reading the file; typically over in well under a second, under heavy load seconds): growing from 10 ms to 250 ms, about 3 s in
 * all. Beyond that the error is real and is thrown.
 */
export const RENAME_DELAYS = [10, 20, 40, 80, 160, ...Array(11).fill(250)];
const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

/**
 * @param {{ rename?: typeof renameSync, sleep?: (ms: number) => void, delays?: number[] }} io for tests only: the rename, the wait, and the waits' lengths
 * @returns {boolean} whether the file was written (false: it already had these bytes)
 */
export function writeIfChanged(out, path, data, io = {}) {
  const { rename = renameSync, sleep = sleepSync, delays = RENAME_DELAYS } = io;
  const bytes = Buffer.from(data);
  try {
    if (readFileSync(path).equals(bytes)) return false;
  } catch {
    /* not there yet */
  }
  const tmpDir = join(out, TMP_DIR);
  // containment first, folders after: a link in the way must not get a folder created behind it
  for (const target of [path, join(tmpDir, 'x')]) {
    if (!insideOut(out, target)) throw Object.assign(new Error(`Refusing to write ${target}: it is not inside the output folder ${out} (a symbolic link or \`..\` on the way).`), { code: 'UNSAFE_OUTPUT' });
  }
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  // an unpredictable name and `wx`: a link planted at the name would otherwise be written through
  const tmp = join(tmpDir, `${process.pid}-${++counter}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, bytes, { flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, path);
      return true;
    } catch (error) {
      // Windows refuses to replace a file that another process has open: wait for it a moment
      if (attempt < delays.length && RETRY_CODES.includes(error?.code)) {
        sleep(delays[attempt]);
        continue;
      }
      try {
        rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* the temporary file is left for `cleanTmp` (older than ten minutes); the error that matters is the failed rename */
      }
      throw error;
    }
  }
}

/** Remove files a killed process left in the temporary folder (older than ten minutes: nothing that is being written is that old). */
export function cleanTmp(out) {
  const dir = join(out, TMP_DIR);
  try {
    if (!insideOut(out, join(dir, 'x'))) return; // `.tmp` is a link to somewhere else: not ours to clean
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || Date.now() - stat.mtimeMs <= 10 * 60_000) continue;
      try {
        rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* open in another process (Windows), or removed meanwhile: the next build tries again, and one file must not stop the others */
      }
    }
  } catch {
    /* no temporary folder yet */
  }
}
