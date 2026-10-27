// Running the command after `--`: how it is found, how its arguments reach it, and how it is seen through (exit code, signals).
// The decisions take a `platform`, so the Windows branches run here on every machine against a fake file system; what only Windows can
// show (cmd.exe, real .cmd shims, a console Ctrl-C) is in the last block, which runs on Windows only.
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ES module without types
import * as command from '../../../../tools/typegpu-shaders/command.mjs';
import { CLI, waitFor } from './project';

const { binDirs, commandFor, escapeArgForCmd, exitCodeOf, parseNpmShim, quoteForCRuntime, resolveCommand, runCommand, withBinPath } = command;
const WIN = process.platform === 'win32';

// ---------- a fake file system ----------

type Entry = string | { text?: string; mode?: 'x' | '-' };
/** Files by path. A fake Windows file system ignores case, like the real one. */
function fakeFs(files: Record<string, Entry>, caseInsensitive = false) {
  const key = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
  const table = new Map(Object.entries(files).map(([path, entry]) => [key(path), typeof entry === 'string' ? { text: entry } : entry]));
  return {
    isFile: (path: string) => table.has(key(path)),
    isExecutable: (path: string) => table.get(key(path))?.mode !== '-',
    readText: (path: string) => table.get(key(path))?.text,
  };
}

// What `cmd-shim` (npm 11 / bin-links) writes into node_modules/.bin on Windows for a program with a `#!/usr/bin/env node` shebang;
// generated with cmd-shim 8.0.0 (the format has not changed since version 4).
const shim = (target: string, flags = '') =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${flags} "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');
const EXE_SHIM = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '"%dp0%\\..\\esbuild\\bin\\esbuild.exe"   %*', ''].join('\r\n');

const NG_SCRIPT = 'C:\\proj\\node_modules\\@angular\\cli\\bin\\ng.js';

describe('the environment of the command', () => {
  it('puts node_modules/.bin of the project and of every folder above it in front of PATH', () => {
    expect(binDirs('/a/b', 'linux')).toEqual(['/a/b/node_modules/.bin', '/a/node_modules/.bin', '/node_modules/.bin']);
    expect(binDirs('C:\\a\\b', 'win32')).toEqual(['C:\\a\\b\\node_modules\\.bin', 'C:\\a\\node_modules\\.bin', 'C:\\node_modules\\.bin']);
    expect(withBinPath({ PATH: '/usr/bin' }, '/p', 'linux')['PATH']).toBe('/p/node_modules/.bin:/node_modules/.bin:/usr/bin');
  });

  it('on Windows keeps the one PATH variable under the name it has (Path), and never leaves two spellings', () => {
    const env = withBinPath({ Path: 'C:\\Windows', PATH: 'C:\\other', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'C:\\p', 'win32');
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toHaveLength(1);
    const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')![1];
    expect(value.startsWith('C:\\p\\node_modules\\.bin;C:\\node_modules\\.bin;')).toBe(true);
    expect(withBinPath({}, '/p', 'linux')['PATH']).toBe('/p/node_modules/.bin:/node_modules/.bin'); // no trailing separator (it would mean "the current folder")
  });
});

describe('resolveCommand on POSIX', () => {
  const fs = fakeFs({ '/p/node_modules/.bin/ng': { mode: 'x' }, '/usr/bin/ng': { mode: 'x' }, '/usr/bin/node': { mode: 'x' }, '/usr/bin/plain': { mode: '-' }, '/p/tools/run.sh': { mode: 'x' } });
  const at = (name: string, PATH = '/p/node_modules/.bin:/usr/bin') => resolveCommand(name, { platform: 'linux', env: { PATH }, root: '/p', fs });

  it('takes the first PATH entry that has it, so the project binary wins over a global one', () => {
    expect(at('ng')).toBe('/p/node_modules/.bin/ng');
    expect(at('ng', '/usr/bin:/p/node_modules/.bin')).toBe('/usr/bin/ng');
  });

  it('needs the execute bit', () => expect(at('plain')).toBeUndefined());
  it('a name with a slash is taken relative to the project, never looked up in PATH', () => {
    expect(at('./tools/run.sh')).toBe('/p/tools/run.sh');
    expect(at('tools/run.sh')).toBe('/p/tools/run.sh');
    expect(at('/usr/bin/node')).toBe('/usr/bin/node');
    expect(at('node/../ng')).toBeUndefined();
  });
  it('an empty PATH entry (the current folder to a shell) and an unknown name find nothing', () => {
    expect(at('run.sh', ':/usr/bin')).toBeUndefined();
    expect(at('nope')).toBeUndefined();
    expect(at('')).toBeUndefined();
  });
});

describe('resolveCommand on Windows', () => {
  const env = { Path: 'C:\\proj\\node_modules\\.bin;"C:\\Program Files\\nodejs";C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' };
  const fs = fakeFs(
    {
      'C:\\proj\\node_modules\\.bin\\ng': '#!/bin/sh\n', // the POSIX script next to the shim: never what Windows runs
      'C:\\proj\\node_modules\\.bin\\ng.cmd': shim('..\\@angular\\cli\\bin\\ng.js'),
      'C:\\proj\\node_modules\\.bin\\ng.ps1': 'ps1',
      'C:\\proj\\node_modules\\.bin\\only-js.js': 'x',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ',
      'C:\\Program Files\\nodejs\\npm.cmd': 'npm',
      'C:\\Windows\\System32\\where.exe': 'MZ',
      'C:\\proj\\tools\\x.bat': '@echo x',
      'C:\\proj\\local.exe': 'MZ',
    },
    true,
  );
  const at = (name: string, e: Record<string, string> = env) => resolveCommand(name, { platform: 'win32', env: e, root: 'C:\\proj', fs });

  it('appends the extensions of PATHEXT in order and never picks the extensionless POSIX script or a .ps1', () => {
    expect(at('ng')).toBe('C:\\proj\\node_modules\\.bin\\ng.cmd');
    expect(at('node')).toBe('C:\\Program Files\\nodejs\\node.exe'); // a quoted PATH entry with a space
    expect(at('where')).toBe('C:\\Windows\\System32\\where.exe');
    expect(at('ng.ps1')).toBeUndefined();
  });

  it('a name that has an extension of PATHEXT is taken as it is; other PATHEXT entries (.JS, .VBS) are not programs', () => {
    expect(at('ng.cmd')).toBe('C:\\proj\\node_modules\\.bin\\ng.cmd');
    expect(at('NG.CMD')).toBe('C:\\proj\\node_modules\\.bin\\NG.CMD');
    expect(at('only-js')).toBeUndefined();
    expect(at('only-js.js')).toBeUndefined();
  });

  it('PATHEXT decides which of two candidates wins; a missing PATHEXT means the default', () => {
    const both = fakeFs({ 'C:\\b\\t.exe': 'MZ', 'C:\\b\\t.cmd': 'x' }, true);
    const pick = (PATHEXT?: string) => resolveCommand('t', { platform: 'win32', env: { PATH: 'C:\\b', ...(PATHEXT ? { PATHEXT } : {}) }, root: 'C:\\', fs: both });
    expect(pick('.CMD;.EXE')).toBe('C:\\b\\t.cmd');
    expect(pick('.EXE;.CMD')).toBe('C:\\b\\t.exe');
    expect(pick()).toBe('C:\\b\\t.exe');
  });

  it('works with a lower case `path` variable and with a folder part (relative to the project, either slash)', () => {
    expect(at('ng', { path: env.Path, pathext: env.PATHEXT })).toBe('C:\\proj\\node_modules\\.bin\\ng.cmd');
    expect(at('tools\\x')).toBe('C:\\proj\\tools\\x.bat');
    expect(at('./tools/x.bat')).toBe('C:\\proj\\tools\\x.bat');
    expect(at('C:\\proj\\local')).toBe('C:\\proj\\local.exe');
  });

  it('does not look in the project folder for a bare name (cmd.exe would, first)', () => {
    expect(at('local')).toBeUndefined();
  });
});

describe('parseNpmShim', () => {
  // the files with a hostile name exist: only the check of the name itself can refuse them
  const fs = fakeFs({ [NG_SCRIPT]: 'js', 'C:\\proj\\node_modules\\esbuild\\bin\\esbuild.exe': 'MZ', 'C:\\proj\\node_modules\\a&calc\\ng.js': 'js', 'C:\\proj\\node_modules\\%EVIL%\\ng.js': 'js' }, true);
  const at = (text: string) => parseNpmShim(text, 'C:\\proj\\node_modules\\.bin\\ng.cmd', { fs });

  it('reads the shim cmd-shim writes for a node program: the script, as an absolute path', () => {
    expect(at(shim('..\\@angular\\cli\\bin\\ng.js'))).toEqual({ flags: [], script: NG_SCRIPT });
  });
  it('keeps the node flags of the shebang', () => {
    expect(at(shim('..\\@angular\\cli\\bin\\ng.js', '--harmony --max-old-space-size=4096'))).toEqual({ flags: ['--harmony', '--max-old-space-size=4096'], script: NG_SCRIPT });
  });
  it('reads the shim of a native program', () => {
    expect(at(EXE_SHIM)).toEqual({ exe: 'C:\\proj\\node_modules\\esbuild\\bin\\esbuild.exe' });
  });

  it.each([
    ['another interpreter', shim('..\\@angular\\cli\\bin\\ng.js').replace('SET "_prog=node"', 'SET "_prog=/bin/sh"')],
    ['an extra line (pnpm sets NODE_PATH here)', shim('..\\@angular\\cli\\bin\\ng.js').replace('SETLOCAL', 'SETLOCAL\r\nSET "NODE_PATH=C:\\x"')],
    ['a command chained after it', shim('..\\@angular\\cli\\bin\\ng.js').replace('%*', '%* & calc')],
    ['a variable in the target', shim('..\\%EVIL%\\ng.js')],
    ['a metacharacter in the target', shim('..\\a&calc\\ng.js')],
    ['a flag that is not a flag', shim('..\\@angular\\cli\\bin\\ng.js', '& calc')],
    ['a script that does not exist', shim('..\\gone\\ng.js')],
    ['a file that is not a shim', '@echo off\r\nnode "%~dp0\\..\\@angular\\cli\\bin\\ng.js" %*\r\n'],
    ['nothing', ''],
  ])('refuses (so cmd.exe runs it as written): %s', (_name, text) => {
    expect(at(text)).toBeUndefined();
  });
  it('accepts LF line ends as well', () => {
    expect(at(shim('..\\@angular\\cli\\bin\\ng.js').replaceAll('\r\n', '\n'))).toEqual({ flags: [], script: NG_SCRIPT });
  });
});

describe('escaping for cmd.exe', () => {
  it('quotes for the C runtime: backslashes only count in front of a quote', () => {
    expect(quoteForCRuntime('')).toBe('""');
    expect(quoteForCRuntime('a b')).toBe('"a b"');
    expect(quoteForCRuntime('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(quoteForCRuntime('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteForCRuntime('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteForCRuntime('\\\\server\\share\\\\')).toBe('"\\\\server\\share\\\\\\\\"');
  });

  // the first column: what cross-spawn 7.0.6 produces (compared in the QA run, 400 000 random arguments), for arguments it handles correctly
  it.each([
    ['', '^"^"', '^^^"^^^"'],
    ['plain', '^"plain^"', '^^^"plain^^^"'],
    ['a b', '^"a^ b^"', '^^^"a^^^ b^^^"'],
    ['x&y', '^"x^&y^"', '^^^"x^^^&y^^^"'],
    ['a|b', '^"a^|b^"', '^^^"a^^^|b^^^"'],
    ['100%', '^"100^%^"', '^^^"100^^^%^^^"'],
    ['%PATH%', '^"^%PATH^%^"', '^^^"^^^%PATH^^^%^^^"'],
    ['^', '^"^^^"', '^^^"^^^^^^^"'],
    ['!x!', '^"^!x^!^"', '^^^"^^^!x^^^!^^^"'],
    ['(a)', '^"^(a^)^"', '^^^"^^^(a^^^)^^^"'],
    ['<in>', '^"^<in^>^"', '^^^"^^^<in^^^>^^^"'],
    ["it's", `^"it's^"`, `^^^"it's^^^"`],
    ['a"b', '^"a\\^"b^"', '^^^"a\\^^^"b^^^"'],
    ['a\\', '^"a\\\\^"', '^^^"a\\\\^^^"'],
    ['$HOME', '^"$HOME^"', '^^^"$HOME^^^"'],
    ['é日', '^"é日^"', '^^^"é日^^^"'],
    ['-', '^"-^"', '^^^"-^^^"'],
    ['--', '^"--^"', '^^^"--^^^"'],
  ])('%j', (arg, single, double) => {
    expect(escapeArgForCmd(arg)).toBe(single);
    expect(escapeArgForCmd(arg, true)).toBe(double);
  });

  it('never leaves a bare metacharacter or a bare quote (the quotes are escaped too, so cmd.exe sees no quoted region)', () => {
    const everything = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    for (const doubled of [false, true]) {
      const text = escapeArgForCmd(everything, doubled);
      expect(text.replace(/\^./g, '')).toMatch(/^[#$'+\-./:=@_{}~\\]*$/); // only what cmd.exe does not treat specially is left outside a ^ pair
    }
  });
});

describe('commandFor on Windows', () => {
  const env = { Path: 'C:\\proj\\node_modules\\.bin;C:\\Program Files\\nodejs;C:\\Windows\\System32', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const fs = fakeFs(
    {
      'C:\\proj\\node_modules\\.bin\\ng.cmd': shim('..\\@angular\\cli\\bin\\ng.js'),
      'C:\\proj\\node_modules\\.bin\\odd.cmd': '@echo off\r\nREM not a shim\r\nnode "%~dp0\\..\\x.js" %*\r\n',
      'C:\\proj\\node_modules\\.bin\\esbuild.cmd': EXE_SHIM,
      'C:\\proj\\node_modules\\esbuild\\bin\\esbuild.exe': 'MZ',
      [NG_SCRIPT]: 'js',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ',
      'C:\\Windows\\System32\\cmd.exe': 'MZ',
      'C:\\proj\\scripts\\build.bat': '@echo off\r\n',
    },
    true,
  );
  const plan = (...argv: string[]) => commandFor({ argv, root: 'C:\\proj', env, platform: 'win32', fs, execPath: 'C:\\exec\\node.exe' });
  const TRICKY = ['a b', '', 'x&calc', 'a|b', '100%', '%PATH%', '^', '!x!', '(a)', '<f>', "it's", 'a;b', '$HOME', '--', '-', '--flag', '-x', 'é日'];

  it('an .exe is spawned directly with the argument array untouched (libuv quotes it for the C runtime): no shell', () => {
    const result = plan('node', 'script.js', ...TRICKY, 'with "quotes"');
    expect(result).toMatchObject({ command: 'C:\\Program Files\\nodejs\\node.exe', strategy: 'direct', options: {} });
    expect(result.args).toEqual(['script.js', ...TRICKY, 'with "quotes"']);
  });

  it('an npm shim becomes node on the script: no cmd.exe, the argument array untouched', () => {
    const result = plan('ng', 'build', ...TRICKY, 'with "quotes"');
    expect(result).toMatchObject({ command: 'C:\\Program Files\\nodejs\\node.exe', strategy: 'npm-shim', options: {} });
    expect(result.args).toEqual([NG_SCRIPT, 'build', ...TRICKY, 'with "quotes"']);
  });

  it('uses the node.exe next to the shim when there is one (what the shim does), else the running node when PATH has none', () => {
    const withLocal = fakeFs({ 'C:\\proj\\node_modules\\.bin\\ng.cmd': shim('..\\@angular\\cli\\bin\\ng.js'), [NG_SCRIPT]: 'js', 'C:\\proj\\node_modules\\.bin\\node.exe': 'MZ' }, true);
    expect(commandFor({ argv: ['ng'], root: 'C:\\proj', env, platform: 'win32', fs: withLocal }).command).toBe('C:\\proj\\node_modules\\.bin\\node.exe');
    const noNode = fakeFs({ 'C:\\proj\\node_modules\\.bin\\ng.cmd': shim('..\\@angular\\cli\\bin\\ng.js'), [NG_SCRIPT]: 'js' }, true);
    expect(commandFor({ argv: ['ng'], root: 'C:\\proj', env, platform: 'win32', fs: noNode, execPath: 'C:\\exec\\node.exe' }).command).toBe('C:\\exec\\node.exe');
  });

  it('the shim of a native program runs that program', () => {
    expect(plan('esbuild', '--version')).toMatchObject({ command: 'C:\\proj\\node_modules\\esbuild\\bin\\esbuild.exe', args: ['--version'], strategy: 'npm-shim' });
  });

  it('a .cmd that is not a plain shim goes through cmd.exe /d /s /c, verbatim, command and every argument escaped', () => {
    const result = plan('odd', 'a&calc', '100%', 'say "hi"');
    expect(result).toMatchObject({ command: 'C:\\Windows\\System32\\cmd.exe', strategy: 'cmd', options: { windowsVerbatimArguments: true } });
    expect(result.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // inside node_modules/.bin: the arguments are escaped twice (the batch file forwards them with %*, a second parse)
    expect(result.args[3]).toBe(`"C:\\proj\\node_modules\\.bin\\odd.cmd ${['a&calc', '100%', 'say "hi"'].map((a) => escapeArgForCmd(a, true)).join(' ')}"`);
    expect(result.args[3]).not.toMatch(/[^^][&|<>]/); // no unescaped control character anywhere in the line
  });

  it('a batch file outside node_modules/.bin gets single escaping, and refuses a double quote it cannot protect', () => {
    const ok = plan('scripts\\build.bat', 'a&calc', 'a b');
    expect(ok.strategy).toBe('cmd');
    expect(ok.args[3]).toBe(`"C:\\proj\\scripts\\build.bat ${['a&calc', 'a b'].map((a) => escapeArgForCmd(a)).join(' ')}"`);
    expect(() => plan('scripts\\build.bat', 'say "hi"')).toThrow(/double quote/);
  });

  it.each(['line\nbreak', 'cr\rhere', 'nul\0byte'])('refuses an argument for a batch file that cmd.exe cannot carry: %j', (arg) => {
    expect(() => plan('odd', arg)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
    expect(() => plan('scripts\\build.bat', arg)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
  });

  it('a command that is not there is ENOENT', () => {
    expect(() => plan('definitely-not-a-command')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(() => commandFor({ argv: [''], root: 'C:\\proj', env, platform: 'win32', fs })).toThrow(expect.objectContaining({ code: 'EINVAL' }));
  });
});

describe('commandFor on POSIX', () => {
  it('spawns the file that was found with the arguments untouched', () => {
    const fs = fakeFs({ '/p/node_modules/.bin/ng': { mode: 'x' } });
    expect(commandFor({ argv: ['ng', 'a b', '', '$HOME'], root: '/p', env: withBinPath({}, '/p', 'linux'), platform: 'linux', fs })).toEqual({
      command: '/p/node_modules/.bin/ng',
      args: ['a b', '', '$HOME'],
      options: {},
      strategy: 'direct',
      resolved: '/p/node_modules/.bin/ng',
    });
  });
});

describe('exitCodeOf', () => {
  it('is the code; 128 + n for a death by signal (what a shell reports)', () => {
    expect(exitCodeOf(0, null, 'linux')).toBe(0);
    expect(exitCodeOf(7, null, 'linux')).toBe(7);
    expect(exitCodeOf(null, 'SIGTERM', 'linux')).toBe(143);
    expect(exitCodeOf(null, 'SIGKILL', 'linux')).toBe(137);
    expect(exitCodeOf(null, 'SIGINT', 'linux')).toBe(130);
  });
  it('on Windows a child that ended by Ctrl-C (STATUS_CONTROL_C_EXIT) is 130', () => {
    expect(exitCodeOf(0xc000013a, null, 'win32')).toBe(130);
    expect(exitCodeOf(0xc000013a, null, 'linux')).toBe(0xc000013a);
  });
});

// ---------- seeing the child through (fake child and process, so every platform's rules run everywhere) ----------

describe('runCommand: signals and the end of the child', () => {
  const POSIX = fakeFs({ '/bin/tool': { mode: 'x' } });
  const WINDOWS = fakeFs({ 'C:\\bin\\tool.exe': 'MZ' }, true);
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(platform: 'linux' | 'win32', over: Record<string, unknown> = {}) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 4242 });
    const proc = Object.assign(new EventEmitter(), { stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const killTreeImpl = vi.fn();
    const log = vi.fn();
    const spawnImpl = vi.fn(() => child);
    const win = platform === 'win32';
    const done = runCommand(['tool', 'x'], win ? 'C:\\proj' : '/proj', {
      platform,
      env: win ? { Path: 'C:\\bin' } : { PATH: '/bin' },
      fs: win ? WINDOWS : POSIX,
      proc,
      spawnImpl,
      killTreeImpl,
      log,
      graceMs: 1000,
      ...over,
    });
    return { child, proc, killTreeImpl, log, spawnImpl, done };
  }

  it('starts the child in the project folder with the terminal and the PATH of the project', async () => {
    const { child, spawnImpl, done } = setup('linux');
    expect(spawnImpl).toHaveBeenCalledWith('/bin/tool', ['x'], expect.objectContaining({ cwd: '/proj', stdio: 'inherit', env: expect.objectContaining({ PATH: expect.stringContaining('/proj/node_modules/.bin') }) }));
    child.emit('exit', 7, null);
    expect(await done).toBe(7);
  });

  it('passes SIGTERM and SIGHUP on to the child (POSIX), and a SIGINT that did not come from the terminal', async () => {
    const { child, proc, done } = setup('linux', { sharesTerminal: false });
    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGHUP', 'SIGHUP');
    proc.emit('SIGINT', 'SIGINT');
    expect(child.kill.mock.calls.map(([signal]: string[]) => signal)).toEqual(['SIGTERM', 'SIGHUP', 'SIGINT']);
    child.emit('exit', null, 'SIGTERM');
    expect(await done).toBe(143);
  });

  // Found by the flake loop under load: a test that signals the tool as soon as the command's first output appears killed the tool by the
  // signal's default action now and then, leaving the command running. The command was started first and the handlers installed after it:
  // a parent that is held up between the two (a loaded machine) has no handler yet when the signal comes.
  it('has the signal handlers in place before the child is started', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 4242 });
    const proc = Object.assign(new EventEmitter(), { stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const seen: Record<string, number> = {};
    const done = runCommand(['tool', 'x'], '/proj', {
      platform: 'linux',
      env: { PATH: '/bin' },
      fs: POSIX,
      proc,
      log: vi.fn(),
      spawnImpl: () => {
        for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) seen[name] = proc.listenerCount(name);
        return child;
      },
    });
    expect(seen).toEqual({ SIGINT: 1, SIGTERM: 1, SIGHUP: 1 });
    child.emit('exit', 0, null);
    await done;
  });

  it('a signal that arrives before the child has been started is passed on to it as soon as it is', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 4242 });
    const proc = Object.assign(new EventEmitter(), { stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const done = runCommand(['tool', 'x'], '/proj', {
      platform: 'linux',
      env: { PATH: '/bin' },
      fs: POSIX,
      proc,
      sharesTerminal: false,
      log: vi.fn(),
      spawnImpl: () => {
        proc.emit('SIGTERM', 'SIGTERM'); // while the child is being started
        return child;
      },
    });
    expect(child.kill.mock.calls.map(([signal]: string[]) => signal)).toEqual(['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    expect(await done).toBe(143);
    expect(proc.eventNames()).toEqual([]);
  });

  it('a child that cannot be started leaves no signal listener behind', async () => {
    const proc = new EventEmitter();
    const code = await runCommand(['tool'], '/proj', { platform: 'linux', env: { PATH: '/bin' }, fs: POSIX, log: vi.fn(), proc, spawnImpl: () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); } });
    expect(code).toBe(126);
    expect(proc.eventNames()).toEqual([]);
  });

  it('does not send the child a second SIGINT after a Ctrl-C in a terminal (the terminal sent it to the whole group)', async () => {
    const { child, proc, done } = setup('linux', { sharesTerminal: true });
    proc.emit('SIGINT', 'SIGINT');
    expect(child.kill).not.toHaveBeenCalledWith('SIGINT');
    child.emit('exit', 130, null);
    expect(await done).toBe(130);
  });

  it('kills a child that is still there after the grace period (POSIX)', async () => {
    const { child, proc, done } = setup('linux', { sharesTerminal: false });
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    expect(await done).toBe(137);
  });

  it('on Windows the child already got the console event: it is only waited for, then its whole tree is ended', async () => {
    const { child, proc, killTreeImpl, done } = setup('win32');
    proc.emit('SIGINT', 'SIGINT');
    proc.emit('SIGBREAK', 'SIGBREAK');
    expect(child.kill).not.toHaveBeenCalled();
    expect(killTreeImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(killTreeImpl).toHaveBeenCalledTimes(1);
    child.emit('exit', 1, null);
    expect(await done).toBe(1);
  });

  it('listens for SIGBREAK on Windows only, and leaves no listener behind', async () => {
    const win = setup('win32');
    expect(win.proc.listenerCount('SIGBREAK')).toBe(1);
    win.child.emit('exit', 0, null);
    await win.done;
    expect(win.proc.eventNames()).toEqual([]);
    const posix = setup('linux');
    expect(posix.proc.listenerCount('SIGBREAK')).toBe(0);
    expect(posix.proc.listenerCount('SIGINT')).toBe(1);
    posix.child.emit('exit', 0, null);
    await posix.done;
    expect(posix.proc.eventNames()).toEqual([]);
  });

  it('127 for a command that is not there (also on Windows, where cmd.exe said 1), 126 for one that cannot be started', async () => {
    const missing = runCommand(['nope'], '/proj', { platform: 'linux', env: { PATH: '/bin' }, fs: POSIX, log: vi.fn(), proc: new EventEmitter() });
    expect(await missing).toBe(127);
    const winMissing = runCommand(['nope'], 'C:\\proj', { platform: 'win32', env: { Path: 'C:\\bin' }, fs: WINDOWS, log: vi.fn(), proc: new EventEmitter() });
    expect(await winMissing).toBe(127);
    const { child, log, done } = setup('linux');
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(await done).toBe(126);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot run "tool"'));
  });

  it('never throws, even when spawn itself does (EINVAL: an argument that cannot be passed)', async () => {
    const throwing = runCommand(['tool'], '/proj', { platform: 'linux', env: { PATH: '/bin' }, fs: POSIX, log: vi.fn(), proc: new EventEmitter(), spawnImpl: () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); } });
    expect(await throwing).toBe(126);
  });
});

// ---------- the real thing: a command line, real processes ----------

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'typegpu-shaders-run-')));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}'); // no shader module: `run` and `dev` just run the command
  writeFileSync(join(root, 'argv.cjs'), `require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n`);
});
// Windows: the folder is the working directory of a process that taskkill has only just ended, and cannot be removed until it is gone
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const cli = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...options.env }, input: options.input });
  return { code: result.status, signal: result.signal, out: result.stdout, err: result.stderr };
};
const argvSeenBy = (...args: string[]) => {
  const result = cli(['run', '--', 'node', 'argv.cjs', ...args]);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[];
};

describe('the arguments after `--` reach the command exactly as given (the command line, a real node)', () => {
  const ARGS = [
    'plain',
    'with space',
    '  leading and trailing  ',
    'single \' and double " quotes',
    `a"b"c`,
    'back\\slash',
    'C:\\dir with space\\',
    '\\\\server\\share\\\\',
    '$HOME',
    '${HOME}',
    '`id`',
    '$(id)',
    'a;b',
    'a&b',
    'a&&b',
    'a|b',
    'a||b',
    '*',
    '?',
    '[x]',
    '~',
    '#comment',
    '<in',
    '>out',
    '2>&1',
    '(group)',
    '%PATH%',
    '%1',
    '!HOME!',
    '^caret',
    '100%',
    'tab\there',
    'unicode é日本語😀',
    '',
    '-',
    '--',
    '-x',
    '--flag=value',
    '--flag',
    'key=va lue',
  ];

  it('every argument arrives as one argument, unchanged', () => {
    expect(argvSeenBy(...ARGS)).toEqual(ARGS);
  });
  it('a lone empty string, a lone `-` and a second `--` are kept', () => {
    expect(argvSeenBy('')).toEqual(['']);
    expect(argvSeenBy('-')).toEqual(['-']);
    expect(argvSeenBy('--', '--')).toEqual(['--', '--']);
  });
  it('an argument with a line break arrives unchanged', () => {
    expect(argvSeenBy('line1\nline2')).toEqual(['line1\nline2']);
  });
  it('options of the tool itself are not read out of the command after `--`', () => {
    expect(argvSeenBy('--root', '/elsewhere', '--out', 'x', '--help')).toEqual(['--root', '/elsewhere', '--out', 'x', '--help']);
  });
});

describe('exit codes and the terminal of the command (real processes)', () => {
  const node = (code: string) => {
    writeFileSync(join(root, 'probe.cjs'), code);
    return ['run', '--', 'node', 'probe.cjs'];
  };
  it.each([0, 1, 7, 255])('the exit code %i of the command is the exit code of the tool', (exit) => {
    expect(cli(node(`process.exit(${exit})`)).code).toBe(exit);
  });
  it('127 when the command is not found, and it says which', () => {
    const result = cli(['run', '--', 'definitely-not-a-command', 'x']);
    expect(result.code).toBe(127);
    expect(result.err).toContain('cannot run "definitely-not-a-command"');
  });
  it('the command gets the standard input and its output is the tool\'s output', () => {
    const result = cli(node(`let t='';process.stdin.on('data',d=>t+=d).on('end',()=>{console.log('got:'+t.trim());console.error('err-line')})`), { input: 'hello\n' });
    expect(result).toMatchObject({ code: 0, out: expect.stringContaining('got:hello'), err: expect.stringContaining('err-line') });
  });
  it('the command runs in the project folder', () => {
    expect(cli(node(`process.exit(process.cwd() === ${JSON.stringify(root)} ? 0 : 9)`)).code).toBe(0);
  });
  it('dev: the exit code of the command is the exit code, also when it ends by itself right away', () => {
    expect(cli(['dev', '--', 'node', '-e', 'process.exit(4)']).code).toBe(4);
  });
  it('a command that is a program from node_modules/.bin of the project is found there', () => {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    if (WIN) {
      writeFileSync(join(root, 'node_modules', 'probe-bin.cjs'), `require('fs').writeFileSync('bin-ran.txt', process.argv.slice(2).join('|'));process.exit(6)`);
      writeFileSync(join(root, 'node_modules', '.bin', 'qa-bin.cmd'), shim('..\\probe-bin.cjs'));
    } else {
      writeFileSync(join(root, 'node_modules', '.bin', 'qa-bin'), '#!/bin/sh\nprintf "%s|" "$@" > bin-ran.txt\nexit 6\n', { mode: 0o755 });
    }
    expect(cli(['run', '--', 'qa-bin', 'a b', '&']).code).toBe(6);
    expect(readFileSync(join(root, 'bin-ran.txt'), 'utf8').replace(/\|$/, '')).toBe('a b|&');
  });
});

// Signals: a POSIX process can be sent any signal, Windows has none (see the last block there).
describe.skipIf(WIN)('signals reach the command (POSIX)', () => {
  const SERVER = `
    const fs = require('fs');
    const log = (text) => fs.appendFileSync('events.txt', text + '\\n');
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => { log(signal); process.exit(signal === 'SIGTERM' ? 42 : 43); });
    log('ready');
    setInterval(() => {}, 1000);
  `;
  const events = () => {
    try {
      return readFileSync(join(root, 'events.txt'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  async function start(command: 'run' | 'dev') {
    writeFileSync(join(root, 'server.cjs'), SERVER);
    const child = spawn(process.execPath, [CLI, command, '--', 'node', 'server.cjs'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(() => events().includes('ready'), 'the command to start');
    return { child, ended };
  }

  it.each(['run', 'dev'] as const)('%s: SIGTERM sent to the tool reaches the command, whose exit code is the tool\'s', async (command) => {
    const { child, ended } = await start(command);
    child.kill('SIGTERM');
    expect(await ended).toEqual({ code: 42, signal: null });
    expect(events()).toEqual(['ready', 'SIGTERM']);
  });
  it.each(['run', 'dev'] as const)('%s: SIGINT (not from a terminal here) and SIGHUP are passed on once each', async (command) => {
    const first = await start(command);
    first.child.kill('SIGINT');
    expect(await first.ended).toEqual({ code: 43, signal: null });
    expect(events()).toEqual(['ready', 'SIGINT']);
    rmSync(join(root, 'events.txt'));
    const second = await start(command);
    second.child.kill('SIGHUP');
    expect(await second.ended).toEqual({ code: 43, signal: null });
    expect(events()).toEqual(['ready', 'SIGHUP']);
  });
  it('a command that dies by a signal makes the tool exit 128 + n (it used to be 0 under `dev`)', () => {
    for (const command of ['run', 'dev']) {
      const result = cli([command, '--', 'node', '-e', `process.kill(process.pid, 'SIGKILL')`]);
      expect(result.code, command).toBe(137);
    }
  });
});

// ---------- Windows only: the three ways of starting a program, with real files and a real cmd.exe ----------
// Written on macOS, NOT YET RUN on Windows: the first run on windows-latest decides which of these hold (see the report's validation plan).
describe.skipIf(!WIN)('Windows: shims, batch files and the injection-shaped arguments (real cmd.exe)', () => {
  const HOSTILE = ['a b', '', 'x&echo INJECTED>injected.txt', 'a|b', 'a^b', '100%', '%PATH%', '!x!', '(a)', '<f>', 'say "hi"', "it's", 'a;b', 'a,b', '$HOME', '--', '-', '--flag', 'é日', 'trailing\\', 'two\\\\', 'C:\\dir with space\\'];
  const bin = () => join(root, 'node_modules', '.bin');
  const arrange = () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'argv-tool.cjs'), `require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n`);
  };
  const seen = (name: string, args: string[]) => {
    const result = cli(['run', '--', name, ...args], { env: { TYPEGPU_SHADERS_DEBUG: '1' } });
    return { result, argv: JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[] };
  };

  it('a cmd-shim of node_modules/.bin (what `ng.cmd` is): started as node on the script, the arguments exactly as given', () => {
    arrange();
    writeFileSync(join(bin(), 'argv-shim.cmd'), shim('..\\argv-tool.cjs'));
    const { result, argv } = seen('argv-shim', HOSTILE);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain('npm-shim');
    expect(argv).toEqual(HOSTILE);
    expect(readFileSyncOrNothing(join(root, 'injected.txt'))).toBeUndefined();
  });

  it('a .cmd that is not a plain shim (cmd.exe /d /s /c, double escaping): the arguments exactly as given', () => {
    arrange();
    writeFileSync(join(bin(), 'argv-odd.cmd'), '@echo off\r\nREM not a plain shim\r\nnode "%~dp0..\\argv-tool.cjs" %*\r\n');
    const { result, argv } = seen('argv-odd', HOSTILE);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain('cmd: [');
    expect(argv).toEqual(HOSTILE);
    expect(readFileSyncOrNothing(join(root, 'injected.txt'))).toBeUndefined();
  });

  it('a batch file in a folder with spaces and parentheses, single escaping: the arguments without a double quote arrive as given', () => {
    const dir = join(root, 'my tools (x86)');
    mkdirSync(dir, { recursive: true });
    arrange();
    writeFileSync(join(dir, 'argv-bat.bat'), `@echo off\r\nnode "${join(root, 'node_modules', 'argv-tool.cjs')}" %*\r\n`);
    const args = HOSTILE.filter((arg) => !arg.includes('"'));
    const { result, argv } = seen(join(dir, 'argv-bat.bat'), args);
    expect(result.code, result.err).toBe(0);
    expect(argv).toEqual(args);
    expect(readFileSyncOrNothing(join(root, 'injected.txt'))).toBeUndefined();
  });

  it('a batch file is refused an argument with a double quote (EINVAL -> exit 126), and nothing is run', () => {
    arrange();
    writeFileSync(join(root, 'plain.bat'), '@echo off\r\necho ran> ran.txt\r\n');
    const result = cli(['run', '--', '.\\plain.bat', 'say "hi"']);
    expect(result.code).toBe(126);
    expect(readFileSyncOrNothing(join(root, 'ran.txt'))).toBeUndefined();
  });

  it('the exit code of a shim, of a .bat and of an .exe is the exit code of the tool', () => {
    arrange();
    writeFileSync(join(root, 'node_modules', 'exit7.cjs'), 'process.exit(7)');
    writeFileSync(join(bin(), 'exit7.cmd'), shim('..\\exit7.cjs'));
    writeFileSync(join(root, 'exit8.bat'), '@echo off\r\nexit /b 8\r\n');
    expect(cli(['run', '--', 'exit7']).code).toBe(7);
    expect(cli(['run', '--', '.\\exit8.bat']).code).toBe(8);
    expect(cli(['run', '--', 'node', '-e', 'process.exit(9)']).code).toBe(9);
  });

  // The only way to end a Windows child with a signal-like event from a test is to run the supervisor in a process of its own and hand it the
  // event the console would (`process.emit`); what it then has to do is end the child AND what the child started (taskkill /T /F).
  it('after the grace period the child and the grandchild it started are both gone (taskkill /T /F)', async () => {
    writeFileSync(join(root, 'grandchild.cjs'), `setInterval(() => {}, 1000);`);
    writeFileSync(
      join(root, 'server.cjs'),
      `const fs = require('fs');\nconst g = require('child_process').spawn(process.execPath, ['grandchild.cjs'], { stdio: 'ignore' });\nfs.writeFileSync('pids.json', JSON.stringify([process.pid, g.pid]));\nsetInterval(() => {}, 1000);`,
    );
    const tool = pathToFileURL(join(__dirname, '../../../../tools/typegpu-shaders/command.mjs')).href;
    const supervisor = `import { runCommand } from ${JSON.stringify(tool)};\nsetTimeout(() => process.emit('SIGINT', 'SIGINT'), 1500);\nconsole.log('exit ' + await runCommand(['node', 'server.cjs'], ${JSON.stringify(root)}, { graceMs: 500 }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', supervisor], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let printed = '';
    child.stdout.on('data', (chunk) => (printed += chunk));
    await waitFor(() => printed.includes('exit '), 'the supervisor to give up on the child', 30_000);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const [serverPid, grandchildPid] = JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8')) as number[];
    await waitFor(() => !alive(serverPid!) && !alive(grandchildPid!), 'the server and its grandchild to be gone');
  });

  it('the variable is `Path` here, and the project .bin is found through it', () => {
    arrange();
    expect(Object.keys(process.env).some((key) => key.toUpperCase() === 'PATH')).toBe(true);
    writeFileSync(join(bin(), 'argv-shim.cmd'), shim('..\\argv-tool.cjs'));
    expect(cli(['run', '--', 'argv-shim', 'x']).code).toBe(0);
  });
});

function readFileSyncOrNothing(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
