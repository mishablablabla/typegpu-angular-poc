// Running the command after `--` (`typegpu-shaders run -- ng build`, `dev -- ng serve`): find the executable the way a shell would, start it
// WITHOUT a shell (the arguments reach the program exactly as given: spaces, quotes, `$`, `&`, `%`, an empty string), and see it through
// (exit code, signals). Dependency free; every platform decision takes a `platform` argument, so the Windows branches run in unit tests on
// any machine (see lib/schematics/testing/tools/typegpu-shaders/command.spec.ts).
//
// Why not `spawn(cmd, args, { shell: true })` on Windows: Node does not quote the arguments then, so cmd.exe interprets `& | < > ^ % ( )`
// in them. And since Node 18.20.2 / 20.12.2 / 21.7.3 (CVE-2024-27980) `spawn('ng.cmd')` without a shell fails with EINVAL.
// What is done on Windows instead, in this order of preference:
//   1. `.exe` / `.com`: spawned directly (libuv quotes the argument array for the Microsoft C runtime; no cmd.exe is involved).
//   2. an npm/pnpm style `.cmd` shim in node_modules/.bin (`ng.cmd`): its text is read, and when it is the standard "run node on this script"
//      shim, node is spawned directly on that script (again no cmd.exe; also no "Terminate batch job (Y/N)?" prompt on Ctrl-C).
//   3. any other `.cmd` / `.bat`: through `cmd.exe /d /s /c` with every argument escaped (the scheme of cross-spawn and @npmcli/promise-spawn).
//      An argument cmd.exe cannot carry safely (a line break, NUL) is refused instead of being passed on.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { posix, win32 } from 'node:path';

const pathApi = (platform) => (platform === 'win32' ? win32 : posix);
const delimiterOf = (platform) => (platform === 'win32' ? ';' : ':');

/** A command that cannot be started. `code`: ENOENT (not found), EACCES (not executable), EINVAL (an argument cannot be passed). */
export class CommandError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** The file system the resolver needs (replaced by a fake in unit tests). */
export const realFs = {
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

// ---------- environment ----------

/** The real key of an environment variable: on Windows `Path`, `PATH` and `path` are one variable (a plain object copy of process.env is case sensitive). */
export function envKey(env, name, platform = process.platform) {
  if (platform !== 'win32') return name in env ? name : undefined;
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper);
}

export function envGet(env, name, platform = process.platform) {
  const key = envKey(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/** `<dir>/node_modules/.bin` of `root` and of every folder above it (npm puts all of them in front of PATH for a script; a workspace member finds the root's `ng`). */
export function binDirs(root, platform = process.platform) {
  const api = pathApi(platform);
  const dirs = [];
  for (let dir = api.resolve(root); ; dir = api.dirname(dir)) {
    dirs.push(api.join(dir, 'node_modules', '.bin'));
    if (api.dirname(dir) === dir) break;
  }
  return dirs;
}

/** A copy of `env` whose single PATH variable starts with the `.bin` folders of the project (the variable keeps the casing it has: `Path` on Windows). */
export function withBinPath(env, root, platform = process.platform) {
  const key = envKey(env, 'PATH', platform) ?? 'PATH';
  const next = { ...env };
  if (platform === 'win32') for (const other of Object.keys(next)) if (other !== key && other.toUpperCase() === 'PATH') delete next[other]; // two spellings would be ambiguous in the child's environment block
  next[key] = [...binDirs(root, platform), env[key]].filter(Boolean).join(delimiterOf(platform));
  return next;
}

// ---------- finding the executable ----------

const RUNNABLE = ['.com', '.exe', '.bat', '.cmd'];

/** The extensions of PATHEXT a process can be started from (`.js`, `.vbs`... in PATHEXT are for the shell's file associations), lower case, in PATHEXT's order. */
export function runnableExtensions(pathext) {
  const listed = String(pathext ?? '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => RUNNABLE.includes(ext));
  return listed.length ? [...new Set(listed)] : ['.com', '.exe', '.bat', '.cmd'];
}

const hasDirectory = (command, platform) => (platform === 'win32' ? /[\\/]|^[a-zA-Z]:/.test(command) : command.includes('/'));

/**
 * The absolute path of the file `command` starts, or undefined. Like a shell, minus the surprises:
 *  - a name with a folder part is taken relative to `root` (the working folder of the command), anything else is looked up in PATH;
 *  - the current folder is NOT searched for a bare name (cmd.exe and libuv do that first on Windows: a planted `node.exe` in the project would win);
 *  - POSIX: a regular file with the execute bit. Windows: only the extensions of PATHEXT a process can be started from, so the extensionless
 *    POSIX script `ng` that sits next to `ng.cmd` in node_modules/.bin is never chosen.
 */
export function resolveCommand(command, { platform = process.platform, env = process.env, root = process.cwd(), fs = realFs } = {}) {
  if (!command) return undefined;
  const api = pathApi(platform);
  const win = platform === 'win32';
  const exts = win ? runnableExtensions(envGet(env, 'PATHEXT', platform)) : [];
  const usable = (path) => fs.isFile(path) && (win || fs.isExecutable(path));
  const tryBase = (base) => {
    if (!win) return usable(base) ? base : undefined;
    // `ng.cmd` is taken as it is; `ng` gets each extension of PATHEXT appended, in order
    if (exts.some((ext) => base.toLowerCase().endsWith(ext))) return usable(base) ? base : undefined;
    return exts.map((ext) => base + ext).find(usable);
  };
  if (hasDirectory(command, platform)) return tryBase(api.resolve(root, command));
  const entries = String(envGet(env, 'PATH', platform) ?? '')
    .split(delimiterOf(platform))
    .map((entry) => (win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry))
    .filter(Boolean); // an empty entry means "the current folder" in a POSIX shell: not searched, see above
  for (const entry of entries) {
    const found = tryBase(api.join(api.resolve(root, entry), command));
    if (found) return found;
  }
  return undefined;
}

// ---------- npm style `.cmd` shims ----------

/**
 * What a `.cmd` file of node_modules/.bin runs, when it is one of the shims `cmd-shim` (npm, bin-links) writes for a Node program:
 * `{ flags, script }` (`node [flags] <script> %*`, `script` absolute), or `{ exe }` (a native program: `"%dp0%\x.exe" %*`), else undefined.
 * Strict on purpose: every line must be one the template writes. A shim that sets environment variables (pnpm's NODE_PATH), another
 * interpreter, or anything unrecognised returns undefined and then runs through cmd.exe, which does what the file says.
 * Reads the shim format of cmd-shim 4 to 8 (npm 7 to 11); the older format falls back to cmd.exe too.
 */
export function parseNpmShim(text, shimPath, { fs = realFs } = {}) {
  if (typeof text !== 'string' || text.length > 4096) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const HEAD = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'];
  if (HEAD.some((line, i) => lines[i]?.toLowerCase() !== line.toLowerCase())) return undefined;
  const body = lines.slice(HEAD.length);
  const dir = win32.dirname(shimPath);
  const target = (text) => {
    // `"%dp0%\..\pkg\bin\x.js"`: %dp0% is the shim's own folder (with a trailing backslash); no other % may be in it
    const match = /^"%dp0%\\([^"%\r\n]+)"$/.exec(text);
    return match && !/[&|<>^]/.test(match[1]) ? win32.resolve(dir, match[1]) : undefined;
  };
  const flagsOk = (tokens) => tokens.every((token) => /^-[\w.=:@/+-]*$/.test(token));
  if (body.length === 1) {
    // the shim of a native program: "%dp0%\..\pkg\x.exe"   %*
    const match = /^("%dp0%\\[^"%\r\n]+")\s+%\*$/.exec(body[0]);
    const exe = match && target(match[1]);
    return exe && /\.(exe|com)$/i.test(exe) && fs.isFile(exe) ? { exe } : undefined;
  }
  // the shim of a Node program
  const expected = [/^IF EXIST "%dp0%\\node\.exe" \($/i, /^SET "_prog=%dp0%\\node\.exe"$/i, /^\) ELSE \($/, /^SET "_prog=node"$/i, /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i, /^\)$/];
  if (body.length !== expected.length + 1 || expected.some((pattern, i) => !pattern.test(body[i]))) return undefined;
  const last = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+(.*?)\s*%\*$/i.exec(body[expected.length]);
  if (!last) return undefined;
  const tokens = last[1].match(/"[^"]*"|\S+/g) ?? [];
  const script = tokens.length ? target(tokens[tokens.length - 1]) : undefined;
  if (!script || !flagsOk(tokens.slice(0, -1)) || !fs.isFile(script)) return undefined;
  return { flags: tokens.slice(0, -1), script };
}

// ---------- cmd.exe ----------

// the characters cmd.exe treats specially (from cross-spawn, which took them from https://www.robvanderwoude.com/escapechars.php)
const META = /([()\][%!^"`<>&|;, *?])/g;

/** The path of a batch file for a cmd.exe command line (caret-escaped, as cross-spawn does; the quotes stay out of it so a path with spaces works). */
export const escapeCommandForCmd = (path) => path.replace(META, '^$1');

/** `arg` quoted for the Microsoft C runtime (CommandLineToArgvW): always in double quotes; backslashes are literal except in front of a quote (and at the end, in front of the closing one). */
export function quoteForCRuntime(arg) {
  let result = '"';
  let backslashes = 0;
  for (const char of `${arg}`) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    result += char === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return result + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * One argument for a cmd.exe command line that is started with `cmd /d /s /c "..."` and windowsVerbatimArguments: quoted for the C runtime
 * (https://qntm.org/cmd) and then every meta character, the quotes too, is prefixed with ^ so that cmd.exe never sees a quoted region.
 * With `doubleEscape` once more: a `.cmd` shim forwards its arguments with `%*`, which cmd.exe parses a second time.
 * The same scheme as cross-spawn 7's escapeArgument, except for the quoting step: that one (a regular expression with a look-ahead) leaves
 * an argument that ends in two or more backslashes (`x\\\\`) with an odd number of them in front of the closing quote, which swallows the
 * quote. A unit test compares both on arguments without that ending.
 */
export function escapeArgForCmd(arg, doubleEscape = false) {
  const text = quoteForCRuntime(arg).replace(META, '^$1');
  return doubleEscape ? text.replace(META, '^$1') : text;
}

const CMD_SHIM_PATH = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

// ---------- the plan ----------

/**
 * How to start `argv` (`[command, ...arguments]`) on `platform`: `{ command, args, options, strategy, resolved }` for `spawn(command, args, options)`.
 * `strategy`: 'direct' (an executable), 'npm-shim' (node on the script of a node_modules/.bin shim), 'cmd' (through cmd.exe, escaped).
 * @throws {CommandError} ENOENT (not found), EINVAL (an argument that cmd.exe cannot pass on safely)
 */
export function commandFor({ argv, root, env = process.env, platform = process.platform, fs = realFs, execPath = process.execPath }) {
  const [name, ...args] = argv;
  if (typeof name !== 'string' || name === '') throw new CommandError('no command given', 'EINVAL');
  const resolved = resolveCommand(name, { platform, env, root, fs });
  if (!resolved) throw new CommandError(`"${name}" was not found in PATH (nor in node_modules/.bin of the project)`, 'ENOENT');
  if (platform !== 'win32') return { command: resolved, args, options: {}, strategy: 'direct', resolved };

  const ext = win32.extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: resolved, args, options: {}, strategy: 'direct', resolved };

  const shim = parseNpmShim(fs.readText(resolved), resolved, { fs });
  if (shim?.exe) return { command: shim.exe, args, options: {}, strategy: 'npm-shim', resolved };
  if (shim) {
    // what the shim itself does: node.exe next to it, else `node` from PATH (ours when there is none)
    const beside = win32.join(win32.dirname(resolved), 'node.exe');
    const node = fs.isFile(beside) ? beside : (resolveCommand('node', { platform, env, root, fs }) ?? execPath);
    return { command: node, args: [...shim.flags, shim.script, ...args], options: {}, strategy: 'npm-shim', resolved };
  }

  // a batch file that is not a plain shim: cmd.exe has to run it
  const bad = args.findIndex((arg) => /[\0\r\n]/.test(arg));
  if (bad !== -1) throw new CommandError(`argument ${bad + 1} contains a line break or NUL, which cannot be passed to "${win32.basename(resolved)}" through cmd.exe safely`, 'EINVAL');
  if (/["\r\n\0]/.test(resolved)) throw new CommandError(`cannot run "${resolved}" through cmd.exe: unsupported character in the path`, 'EINVAL');
  const double = CMD_SHIM_PATH.test(resolved);
  // A batch file that is not a `%*` forwarder of node_modules/.bin parses its arguments itself (once): a double quote in one of them cannot be
  // protected for sure (cmd.exe toggles its quote state on every one), so such an argument is refused rather than guessed.
  const quoted = double ? -1 : args.findIndex((arg) => arg.includes('"'));
  if (quoted !== -1) throw new CommandError(`argument ${quoted + 1} contains a double quote, which cannot be passed to the batch file "${win32.basename(resolved)}" safely`, 'EINVAL');
  const line = [escapeCommandForCmd(win32.normalize(resolved)), ...args.map((arg) => escapeArgForCmd(arg, double))].join(' ');
  const comspec = envGet(env, 'ComSpec', platform) || 'cmd.exe';
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true }, strategy: 'cmd', resolved };
}

// ---------- running it ----------

/** The exit code of this process for a child's `(code, signal)`: the code; 128 + the signal number for a death by signal (what a shell reports). */
export function exitCodeOf(code, signal, platform = process.platform) {
  if (typeof code === 'number') return platform === 'win32' && code === 0xc000013a ? 130 : code; // STATUS_CONTROL_C_EXIT: ended by Ctrl-C without a handler
  if (signal) return 128 + (osConstants.signals[signal] ?? 1);
  return 0;
}

/** Windows: end the child and everything it started (child.kill() is TerminateProcess of that one process only). */
function killTree(child) {
  try {
    if (child.pid !== undefined) {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (result.status === 0) return;
    }
  } catch {
    /* fall through */
  }
  child.kill();
}

const signalsOf = (platform) => (platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Starts `argv` in `root` with this process's terminal and sees it through. Resolves with the exit code this process should end with
 * (the command's; 127 when it was not found, 126 when it cannot be started). Never rejects.
 *
 * Signals (the command is a child of this process, usually `ng serve`, and must not outlive it):
 *  - POSIX: SIGTERM and SIGHUP are passed on to the child. SIGINT too, except from a terminal Ctrl-C: the terminal sent that one to the
 *    whole foreground group, the child has it already (a second one would count as "Ctrl-C twice"). If the child is still there after
 *    `graceMs` it is killed (SIGKILL).
 *  - Windows (no POSIX signals): Ctrl-C / Ctrl-Break / closing the console reach every process of the console, the child included, and
 *    this process only has to wait (killing the child here would cut its own clean-up short). After `graceMs`, `taskkill /T /F` ends it
 *    and what it started.
 * @param {{ env?: object, platform?: string, log?: (text: string) => void, tag?: string, graceMs?: number, proc?: NodeJS.Process, spawnImpl?: typeof spawn, fs?: object, killTreeImpl?: (child: object) => void, sharesTerminal?: boolean }} options
 */
export function runCommand(argv, root, options = {}) {
  const { env = process.env, platform = process.platform, log = (text) => console.error(text), tag = '[typegpu-shaders]', graceMs = 10_000, proc = process, spawnImpl = spawn, fs = realFs, killTreeImpl = killTree } = options;
  const sharesTerminal = options.sharesTerminal ?? Boolean(proc.stdin?.isTTY || proc.stdout?.isTTY || proc.stderr?.isTTY);
  return new Promise((resolve) => {
    const childEnv = withBinPath(env, root, platform);
    let plan;
    try {
      plan = commandFor({ argv, root, env: childEnv, platform, fs });
    } catch (error) {
      log(`${tag} cannot run "${argv[0]}": ${error.message}`);
      resolve(error.code === 'ENOENT' ? 127 : 126);
      return;
    }
    if (envGet(env, 'TYPEGPU_SHADERS_DEBUG', platform)) log(`${tag} ${plan.strategy}: ${JSON.stringify([plan.command, ...plan.args])}`);
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, { cwd: root, stdio: 'inherit', env: childEnv, ...plan.options });
    } catch (error) {
      log(`${tag} cannot run "${argv[0]}": ${error.message}`);
      resolve(error.code === 'ENOENT' ? 127 : 126);
      return;
    }
    let finished = false;
    let timer;
    const names = signalsOf(platform);
    const handlers = Object.fromEntries(
      names.map((signal) => [
        signal,
        () => {
          if (platform === 'win32') {
            if (!timer) (timer = setTimeout(() => killTreeImpl(child), graceMs)).unref();
            return;
          }
          if (!(signal === 'SIGINT' && sharesTerminal)) child.kill(signal);
          if (!timer) (timer = setTimeout(() => child.kill('SIGKILL'), graceMs)).unref();
        },
      ]),
    );
    for (const name of names) proc.on(name, handlers[name]);
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const name of names) proc.off(name, handlers[name]);
      resolve(code);
    };
    child.on('exit', (code, signal) => finish(exitCodeOf(code, signal, platform)));
    child.on('error', (error) => {
      log(`${tag} cannot run "${argv[0]}": ${error.message}`);
      finish(error.code === 'ENOENT' ? 127 : 126);
    });
  });
}

/** End this process the way a signal would have, after the clean-up: `process.kill` where the platform can (Windows: SIGINT/SIGTERM end the process at once; SIGBREAK/SIGHUP are not supported there), else the shell's 128 + n. */
export function endBySignal(signal, proc = process) {
  try {
    proc.kill(proc.pid, signal);
  } catch {
    proc.exit(128 + (osConstants.signals[signal] ?? 1));
  }
}
