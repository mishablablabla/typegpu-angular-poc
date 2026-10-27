// `isInside`: where a path really is, by `relative` and not by a string prefix. The Windows rules run on every platform through `path.win32`.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { isInside, isSameOrInside } from '../../../../tools/typegpu-shaders/paths.mjs';
// @ts-expect-error plain ES module without types
import { insideOut } from '../../../../tools/typegpu-shaders/atomic.mjs';

const win = path.win32;
const posix = path.posix;

describe('isInside with Windows paths', () => {
  it.each([
    ['C:\\proj\\out', 'C:\\proj\\out\\a.js', true],
    ['C:\\proj\\out', 'C:\\proj\\out\\sub\\deep\\a.js', true],
    ['C:\\Proj\\Out', 'c:\\proj\\out\\A.JS', true], // the file system ignores case
    ['c:\\proj\\out', 'C:\\PROJ\\OUT\\sub', true],
    ['C:\\proj\\out\\', 'C:\\proj\\out\\a', true], // trailing separators
    ['C:\\proj\\out', 'C:\\proj\\out\\sub\\', true],
    ['C:/proj/out', 'C:\\proj\\out\\a', true], // forward slashes are separators too
    ['C:\\proj\\out', 'C:\\proj\\out\\sub\\..\\a.js', true],
    ['C:\\proj\\out', 'C:\\proj\\x\\..\\out\\a.js', true],
    ['C:\\proj\\out', 'C:\\proj\\out\\..hidden\\a', true], // a name that starts with dots is a name
    ['C:\\', 'C:\\x', true], // a root: `C:\` + `\` is not a prefix of anything
    ['\\\\srv\\share\\out', '\\\\SRV\\Share\\out\\a.js', true], // UNC, case-insensitive
    ['C:\\proj\\out', 'C:\\proj\\out-old\\a.js', false], // a sibling that starts with the same letters
    ['C:\\proj\\out', 'C:\\proj\\OUT2', false],
    ['C:\\proj\\out', 'C:\\proj\\out\\..\\x', false], // `..` leaves
    ['C:\\proj\\out', 'C:\\proj\\out\\..\\..\\other', false],
    ['C:\\proj\\out', 'C:\\proj', false],
    ['C:\\proj\\out', 'C:\\proj\\out', false], // a folder is not inside itself
    ['C:\\proj\\out', 'C:\\proj\\out\\', false],
    ['C:\\proj\\out', 'D:\\proj\\out\\a.js', false], // another drive: `relative` answers with an absolute path
    ['C:\\', 'D:\\x', false],
    ['\\\\srv\\share\\out', '\\\\srv\\share2\\out\\a', false], // another share
    ['\\\\srv\\share\\out', '\\\\other\\share\\out\\a', false],
  ])('%s contains %s: %s', (parent, child, expected) => {
    expect(isInside(parent, child, win)).toBe(expected);
  });

  it('isSameOrInside accepts the folder itself, in any case and with a trailing separator', () => {
    expect(isSameOrInside('C:\\proj\\out', 'c:\\PROJ\\out\\', win)).toBe(true);
    expect(isSameOrInside('C:\\proj\\out', 'C:\\proj\\out\\a', win)).toBe(true);
    expect(isSameOrInside('C:\\proj\\out', 'C:\\proj\\out-old', win)).toBe(false);
    expect(isSameOrInside('C:\\proj\\out', 'D:\\proj\\out', win)).toBe(false);
  });
});

describe('isInside with POSIX paths', () => {
  it.each([
    ['/p/out', '/p/out/a.js', true],
    ['/p/out/', '/p/out/sub/a.js', true],
    ['/p/out', '/p/out/..hidden/a', true],
    ['/', '/x', true],
    ['/p/out', '/p/out/../x', false],
    ['/p/out', '/p/out-old/a.js', false],
    ['/p/out', '/p/out', false],
    ['/p/Out', '/p/out/a.js', false], // case counts on a case-sensitive file system
  ])('%s contains %s: %s', (parent, child, expected) => {
    expect(isInside(parent, child, posix)).toBe(expected);
  });
});

describe('insideOut (the lexical part) is not fooled by a sibling folder', () => {
  it('rejects a path in a folder whose name starts like the output folder', () => {
    const base = path.resolve('/tmp/typegpu-paths-spec');
    expect(insideOut(path.join(base, 'shaders-dist'), path.join(base, 'shaders-dist-old', 'a.js'))).toBe(false);
    expect(insideOut(path.join(base, 'shaders-dist'), path.join(base, 'shaders-dist', 'a.js'))).toBe(true);
    expect(insideOut(path.join(base, 'shaders-dist'), path.join(base, 'shaders-dist', '..', 'a.js'))).toBe(false);
  });
});
