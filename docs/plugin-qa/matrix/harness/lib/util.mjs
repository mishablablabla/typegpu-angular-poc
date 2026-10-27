// Process, filesystem and polling helpers. Plain Node ESM, no shell, no POSIX-only tools.
// Rule: the harness only ever kills processes it started itself (POSIX: its own process group; Windows: taskkill /T on its own pid).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

export const WIN = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Environment for every child: no analytics, no colours, CI=1 unless the caller overrides (a value of null removes the variable). */
export function childEnv(extra = {}) {
  const env = { ...process.env, NG_CLI_ANALYTICS: 'false', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

const live = new Set();
function killPid(pid, signal) {
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, signal); // negative pid: the process group this harness created with detached:true
  } catch {
    /* already gone */
  }
}
process.on('exit', () => {
  for (const p of live) killPid(p.child.pid, 'SIGKILL');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130)); // runs the 'exit' handler above: children the harness started never outlive it

/** A child started by the harness (own process group). Output is kept in memory and written to logFile when it ends. */
export class Proc {
  constructor(cmd, args, { cwd, env, logFile } = {}) {
    this.cmd = cmd;
    this.args = args;
    this.logFile = logFile;
    this.out = '';
    this.started = Date.now();
    this.code = null;
    this.signal = null;
    this.killed = false;
    this.child = spawn(cmd, args, { cwd, env: env ?? childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, windowsHide: true });
    live.add(this);
    const add = (d) => {
      if (this.out.length < 8e6) this.out += d.toString('utf8');
    };
    this.child.stdout.on('data', add);
    this.child.stderr.on('data', add);
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e) => {
        this.out += `\n[spawn error] ${e.message}\n`;
        this.code = -1;
        this.flush();
        resolve(this);
      });
      this.child.on('close', (code, signal) => {
        this.code = code;
        this.signal = signal;
        this.ms = Date.now() - this.started;
        live.delete(this);
        this.flush();
        resolve(this);
      });
    });
  }
  get text() {
    return stripAnsi(this.out);
  }
  flush() {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.writeFileSync(this.logFile, `$ ${this.cmd} ${this.args.join(' ')}\n[exit ${this.code} ${this.signal ?? ''}${this.killed ? ' killed-by-harness' : ''}]\n${this.text}`);
    } catch {}
  }
  get alive() {
    return this.code === null && this.signal === null && !this.child.killed;
  }
  /** Kill the whole tree (SIGKILL / taskkill /F) and wait for it. */
  async kill(signal = 'SIGKILL') {
    this.killed = true;
    killPid(this.child.pid, signal);
    await Promise.race([this.exited, sleep(10000)]);
    return this;
  }
  /** Polite stop (SIGTERM to the group), then SIGKILL after graceMs. */
  async stop(graceMs = 6000) {
    if (this.code !== null) return this;
    this.killed = true;
    if (!WIN) killPid(this.child.pid, 'SIGTERM');
    else killPid(this.child.pid, 'SIGKILL');
    const r = await Promise.race([this.exited.then(() => 'exit'), sleep(graceMs).then(() => 'grace')]);
    if (r === 'grace') await this.kill();
    // the group leader may be gone while grandchildren survive a SIGTERM: always finish with SIGKILL on the group
    if (!WIN) killPid(this.child.pid, 'SIGKILL');
    return this;
  }
  /** Poll until the output matches re (RegExp) or fn(text) is truthy, from offset `from`; null on deadline. */
  async waitFor(re, ms = 60000, from = 0) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = this.text.slice(from);
      if (re instanceof RegExp ? re.test(t) : re(t)) return true;
      if (this.code !== null) return re instanceof RegExp ? re.test(this.text.slice(from)) : !!re(this.text.slice(from));
      await sleep(150);
    }
    return false;
  }
}

/** Run to completion with a timeout (killing the tree on timeout). Never throws. */
export async function run(cmd, args, { cwd, env, timeout = 180000, logFile } = {}) {
  const p = new Proc(cmd, args, { cwd, env, logFile });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeout);
  await p.exited;
  clearTimeout(timer);
  p.ms = Date.now() - p.started;
  if (timedOut) p.out += `\n[harness] TIMEOUT after ${timeout} ms\n`;
  p.timedOut = timedOut;
  p.flush();
  return p;
}

/** Poll fn until truthy or deadline. Returns {ok, ms, value}. Deadline polling only: never a fixed sleep to prove a negative. */
export async function until(fn, { timeout = 30000, step = 200 } = {}) {
  const t0 = Date.now();
  let last;
  while (true) {
    try {
      last = await fn();
    } catch {
      last = null;
    }
    if (last) return { ok: true, ms: Date.now() - t0, value: last };
    if (Date.now() - t0 >= timeout) return { ok: false, ms: Date.now() - t0, value: last };
    await sleep(step);
  }
}

export function httpGet(url, { timeout = 5000, headers } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', err: e.message }));
  });
}

// ---- filesystem -------------------------------------------------------------------------------------------------
const toPosix = (p) => p.split(path.sep).join('/');
export function listTree(dir, { skipTop = [] } = {}) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skipTop.includes(e.name)) continue;
      out.push(e.isDirectory() ? r + '/' : r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}
export function hashTree(dir) {
  const m = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else m[r] = sha256(fs.readFileSync(path.join(d, e.name)));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return m;
}
export function diffHashes(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = [];
  for (const k of [...keys].sort()) if (a[k] !== b[k]) d.push(`${k}: ${a[k] ? 'A' : '-'} vs ${b[k] ? 'B' : '-'}`);
  return d;
}
/** rm -rf, but only below `root` (the harness work dir). */
export function rmUnder(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target);
  if (!t.startsWith(r)) throw new Error(`refusing to delete ${t}: not under ${root}`);
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
export function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // COPYFILE_FICLONE: copy-on-write where the file system supports it (APFS, btrfs, ReFS dev drives), a plain copy elsewhere.
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}
export const first = (text, n = 12) => text.split(/\r?\n/).slice(0, n).join('\n');
