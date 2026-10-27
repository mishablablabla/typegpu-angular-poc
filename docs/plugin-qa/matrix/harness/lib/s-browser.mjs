// S24: serve the production build statically, open it in headless Chrome (own profile, CDP over the global WebSocket of Node >= 22),
// screenshot the canvas and count unique colours. No dependencies: a small PNG decoder is included.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { freshApp } from './app.mjs';
import { R, tail } from './kit.mjs';
import { Proc, freePort, childEnv, until, sleep, httpGet, rmUnder } from './util.mjs';

function findChrome() {
  const cands = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  return cands.find((p) => p && fs.existsSync(p));
}

export function decodePng(buf) {
  let o = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG ${bd}/${ct}`);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, cc = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
      px[y * stride + x] = r & 255;
    }
  }
  const colors = new Set();
  for (let i = 0; i < px.length; i += bpp) colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
  return { w, h, unique: colors.size };
}

function serveStatic(root, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

export async function s24(c) {
  if (typeof WebSocket === 'undefined') return R('N/A', 'this Node has no global WebSocket (needs Node >= 22)');
  const chrome = findChrome();
  if (!chrome) return R('N/A', 'no Chrome found (set CHROME_BIN)');
  const app = await freshApp(c);
  const b = await app.build([], { tag: 'build-prod' });
  if (b.code !== 0) return R('LOUD', 'production build failed: ' + tail(b.text, 4));
  const port = await freePort();
  const srv = await serveStatic(app.dist, port);
  const udd = path.join(c.w.root, `chrome-${c.mode}`);
  rmUnder(c.w.work, udd);
  const dbg = await freePort();
  const ch = new Proc(chrome, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', '--window-size=900,700', 'about:blank'], { env: childEnv(), logFile: path.join(c.ev, 'chrome.log') });
  try {
    const t = await until(async () => { const r = await httpGet(`http://127.0.0.1:${dbg}/json/list`); try { return JSON.parse(r.body).find((x) => x.type === 'page'); } catch { return null; } }, { timeout: 30000 });
    if (!t.ok) return R('ERROR', 'Chrome did not expose a page target: ' + tail(ch.text, 3));
    const cl = await cdp(t.value.webSocketDebuggerUrl);
    await cl.send('Page.enable');
    await cl.send('Page.navigate', { url: `http://localhost:${port}/` });
    let best = { unique: 0 }, info = '';
    const r = await until(async () => {
      const rect = await cl.send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, gpu: !!navigator.gpu, text: document.body.innerText.slice(0, 80) }); })()`, returnByValue: true });
      const v = rect.result?.result?.value;
      if (!v) return false;
      const o = JSON.parse(v);
      info = `gpu=${o.gpu} canvas ${Math.round(o.w)}x${Math.round(o.h)} text="${o.text.replace(/\s+/g, ' ')}"`;
      if (!o.w || !o.h) return false;
      const shot = await cl.send('Page.captureScreenshot', { format: 'png', clip: { x: o.x, y: o.y, width: o.w, height: o.h, scale: 1 } });
      const png = decodePng(Buffer.from(shot.result.data, 'base64'));
      if (png.unique > best.unique) { best = png; fs.writeFileSync(path.join(c.ev, 'canvas.png'), Buffer.from(shot.result.data, 'base64')); }
      return png.unique > 1000;
    }, { timeout: 25000, step: 800 });
    cl.close();
    const detail = `production build served statically, headless Chrome (${path.basename(chrome)}); ${info}; unique colours in the canvas: ${best.unique} (threshold 1000)`;
    return r.ok ? R('CORRECT', detail) : R(best.unique > 0 ? 'SILENT-WRONG' : 'ERROR', detail + ' (canvas did not render a gradient: no WebGPU, or a shader problem; see canvas.png)');
  } finally {
    await ch.kill();
    srv.close();
    await sleep(200);
  }
}
