// Which watch sessions (dev servers, `ng build --watch`, watching test runs) are alive on one output folder, so that the one that ends does
// not delete what another still needs (the stub of a failed module shows that module's error in the other session's page).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insideOut, TMP_DIR } from './atomic.mjs';

const dir = (config) => join(config.out, TMP_DIR, 'sessions');
let counter = 0;
/** One id per watcher: `<pid>-<n>` (a process can run more than one). */
export const newSessionId = () => `${process.pid}-${++counter}`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // exists, owned by someone else
  }
};

/** Record a session (`id` from `newSessionId`) on `config.out`. */
export function registerSession(config, id) {
  try {
    mkdirSync(dir(config), { recursive: true });
    if (!insideOut(config.out, join(dir(config), id))) return; // `.tmp` leads out of the output folder: no record is written there
    writeFileSync(join(dir(config), id), '');
  } catch {
    /* the folder is read-only: the build reports it */
  }
}

/** Windows: a file that something else has open (an indexer, a virus scanner) cannot be removed at once; a record left behind is removed by a later session (its process is gone). */
function removeRecord(path) {
  try {
    rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* one record that stays must not hide the others: whether another session is alive is still answered */
  }
}

/** Remove this process's record; true when another live session is registered (records of dead processes are removed on the way). */
export function endSession(config, id) {
  let others = false;
  try {
    if (!insideOut(config.out, join(dir(config), id))) return false;
    removeRecord(join(dir(config), id));
    for (const name of readdirSync(dir(config))) {
      if (name === id) continue; // our own record, when it could not be removed (an open handle on Windows): it is not another session
      if (alive(Number(name.split('-')[0]))) others = true;
      else removeRecord(join(dir(config), name));
    }
  } catch {
    /* nothing registered */
  }
  return others;
}
