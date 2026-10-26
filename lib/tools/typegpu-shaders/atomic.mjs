// Writes of generated files that nothing reading the output folder meanwhile (another process's build, Angular's file watcher, an IDE) can
// see half done: the bytes go to a temporary file in `<out>/.tmp` and are renamed into place (atomic on the same file system), and a file
// that already has exactly these bytes is not touched at all (no new modification time, so nothing downstream is rebuilt for nothing).
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Folder (inside the output folder) for files being written; never part of the output. */
export const TMP_DIR = '.tmp';
let counter = 0;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** @returns {boolean} whether the file was written (false: it already had these bytes) */
export function writeIfChanged(out, path, data) {
  const bytes = Buffer.from(data);
  try {
    if (readFileSync(path).equals(bytes)) return false;
  } catch {
    /* not there yet */
  }
  const tmpDir = join(out, TMP_DIR);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(tmpDir, `${process.pid}-${++counter}`);
  writeFileSync(tmp, bytes);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return true;
    } catch (error) {
      // Windows refuses to replace a file that another process has open: wait for it a moment
      if (attempt < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        sleepSync(10 + attempt * 5);
        continue;
      }
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** Remove files a killed process left in the temporary folder (older than ten minutes: nothing that is being written is that old). */
export function cleanTmp(out) {
  const dir = join(out, TMP_DIR);
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isFile() && Date.now() - stat.mtimeMs > 10 * 60_000) rmSync(path, { force: true });
    }
  } catch {
    /* no temporary folder yet */
  }
}
