// `writeIfChanged`: the rename onto a file another process has open (Windows) is retried for about three seconds, then fails with the
// original error and without a leftover temporary file. The rename and the wait are injected, so no test waits for real.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { RENAME_DELAYS, writeIfChanged } from '../../../../tools/typegpu-shaders/atomic.mjs';

let out: string;
beforeEach(() => {
  out = join(realpathSync(mkdtempSync(join(tmpdir(), 'typegpu-shaders-atomic-'))), 'dist');
  mkdirSync(out);
});
afterEach(() => rmSync(join(out, '..'), { recursive: true, force: true }));

const failing = (times: number, code = 'EPERM') => {
  const calls = { rename: 0 };
  const rename = (from: string, to: string, real: (a: string, b: string) => void) => {
    if (calls.rename++ < times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    real(from, to);
  };
  return { calls, rename };
};
const tmpLeft = () => {
  try {
    return readdirSync(join(out, '.tmp'));
  } catch {
    return [];
  }
};

describe('the rename retry budget', () => {
  it('waits about three seconds in all (not the former 1.15 s), growing but bounded per wait', () => {
    const total = (RENAME_DELAYS as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(3000);
    expect(total).toBeLessThanOrEqual(3500);
    expect(Math.max(...RENAME_DELAYS)).toBeLessThanOrEqual(250);
    expect(RENAME_DELAYS[0]).toBeLessThanOrEqual(10);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('a rename that fails %s a few times and then works: the file is written, with a wait before every retry', async (code) => {
    const { renameSync } = await import('node:fs');
    const { calls, rename } = failing(4, code);
    const slept: number[] = [];
    const path = join(out, 'a.js');
    expect(writeIfChanged(out, path, 'new bytes', { rename: (a: string, b: string) => rename(a, b, renameSync), sleep: (ms: number) => slept.push(ms) })).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('new bytes');
    expect(calls.rename).toBe(5);
    expect(slept).toEqual(RENAME_DELAYS.slice(0, 4));
    expect(tmpLeft()).toEqual([]);
  });

  it('survives as many failures as the budget has waits (the last attempt succeeds)', async () => {
    const { renameSync } = await import('node:fs');
    const { rename } = failing(RENAME_DELAYS.length);
    const path = join(out, 'a.js');
    expect(writeIfChanged(out, path, 'x', { rename: (a: string, b: string) => rename(a, b, renameSync), sleep: () => {} })).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('x');
  });

  it('a rename that never works: the ORIGINAL error is thrown after the whole budget, the old file is untouched and no temporary file is left', () => {
    const path = join(out, 'a.js');
    writeFileSync(path, 'old bytes');
    const slept: number[] = [];
    const error = Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    let calls = 0;
    expect(() =>
      writeIfChanged(out, path, 'new bytes', {
        rename: () => {
          calls++;
          throw error;
        },
        sleep: (ms: number) => slept.push(ms),
      }),
    ).toThrow(error); // the same object, not a wrapper
    expect(calls).toBe(RENAME_DELAYS.length + 1);
    expect(slept).toEqual(RENAME_DELAYS);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3000);
    expect(readFileSync(path, 'utf8')).toBe('old bytes');
    expect(tmpLeft()).toEqual([]);
  });

  it('any other error is not retried: no wait, thrown at once, no temporary file left', () => {
    const path = join(out, 'a.js');
    const slept: number[] = [];
    let calls = 0;
    expect(() =>
      writeIfChanged(out, path, 'x', {
        rename: () => {
          calls++;
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        },
        sleep: (ms: number) => slept.push(ms),
      }),
    ).toThrow(/ENOSPC/);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(tmpLeft()).toEqual([]);
  });

  it('bytes that are already there are not written, and nothing is renamed', () => {
    const path = join(out, 'a.js');
    writeFileSync(path, 'same');
    expect(writeIfChanged(out, path, 'same', { rename: () => { throw new Error('must not rename'); } })).toBe(false);
  });
});
