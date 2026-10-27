// Every temporary folder a test makes lives in a private folder for this run (the tests read `os.tmpdir()`, which follows these variables),
// and the run FAILS when a spec leaves one of ours behind: a folder that is not removed is a test that did not clean up (a watcher or a child
// process that still ran when the folder was removed recreates it). A private folder also keeps concurrent runs, and whatever else is in the
// system temporary folder, out of the check.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the specs name the folders they make (`typegpu-shaders-`, `typegpu-shaders-run-`, `typegpu-shaders-atomic-`, `check-shader-`). */
export const OURS = /^(typegpu-shaders-|check-shader-)/;

export function setup() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'typegpu-test-run-')));
  const saved = { TMPDIR: process.env['TMPDIR'], TMP: process.env['TMP'], TEMP: process.env['TEMP'] };
  // `os.tmpdir()`: TMPDIR on POSIX, TEMP or TMP on Windows; the test workers and the processes they spawn inherit these
  process.env['TMPDIR'] = process.env['TMP'] = process.env['TEMP'] = sandbox;

  return function teardown() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    let leaked: string[] = [];
    try {
      leaked = readdirSync(sandbox).filter((name) => OURS.test(name));
    } catch {
      /* the sandbox itself is gone: nothing was left */
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (leaked.length > 0) {
      throw new Error(`The test run left ${leaked.length} temporary folder(s) behind (a spec did not clean up after itself; they were removed now): ${leaked.join(', ')}`);
    }
  };
}
