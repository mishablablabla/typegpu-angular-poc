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

/** Remove this process's record; true when another live session is registered (records of dead processes are removed on the way). */
export function endSession(config, id) {
  let others = false;
  try {
    if (!insideOut(config.out, join(dir(config), id))) return false;
    rmSync(join(dir(config), id), { force: true });
    for (const name of readdirSync(dir(config))) {
      if (alive(Number(name.split('-')[0]))) others = true;
      else rmSync(join(dir(config), name), { force: true });
    }
  } catch {
    /* nothing registered */
  }
  return others;
}
