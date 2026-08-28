// Minimal zero-dependency CDP driver over Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 1280, height = 1000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  const port = 9222 + Math.floor(Math.random() * 2000);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-extensions', '--disable-background-networking',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Chrome writes to stdout/stderr freely. Nothing here needs that output, but
  // the pipes must still be drained: once the OS pipe buffer fills, Chrome
  // blocks on write and the entire browser freezes. Every CDP command then
  // hangs forever at 0% CPU -- browser-level ones too, which makes it look
  // like the page under test is at fault. Keep a bounded tail for diagnostics.
  const browserLog = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      browserLog.push(chunk);
      if (browserLog.length > 100) browserLog.shift();
    });
    stream.on('error', () => {});
  }

  let wsUrl = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { await new Promise(r => setTimeout(r, 120)); }
  }
  if (!wsUrl) { proc.kill('SIGKILL'); throw new Error('Chrome did not expose CDP'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg));
    }
  };

  // A dead connection must fail the commands waiting on it. Without this a
  // crashed or killed Chrome leaves every pending promise unsettled, and the
  // run hangs with no error to explain it.
  let dead = null;
  const killPending = (reason) => {
    dead = dead || reason;
    pending.forEach(({ reject }) => reject(new Error(reason)));
    pending.clear();
  };
  ws.onclose = () => killPending('the CDP connection closed');
  ws.onerror = () => killPending('the CDP connection failed');
  proc.on('exit', (code, signal) =>
    killPending(`Chrome exited early (code ${code}, signal ${signal})`));

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(`${dead}; cannot send ${method}`)); return; }
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => send(method, params, sessionId);

  const consoleErrors = [];
  const consoleAll = [];
  const exceptions = [];
  const failedRequests = [];
  listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map(a =>
        a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      consoleAll.push({ type: msg.params.type, text });
      if (msg.params.type === 'error' || msg.params.type === 'assert') {
        consoleErrors.push({ type: msg.params.type, text });
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push({
        text: d.text,
        message: d.exception && (d.exception.description || d.exception.value),
        line: d.lineNumber, col: d.columnNumber, url: d.url,
      });
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') consoleErrors.push({ type: 'log:' + e.source, text: e.text + ' ' + (e.url || '') });
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push({ url: msg.params.requestId, error: msg.params.errorText });
    }
  });

  await S('Runtime.enable');
  await S('Page.enable');
  await S('Log.enable');
  await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  const evaluate = async (fn, ...args) => {
    const expr = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    const r = await S('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const goto = async (url) => {
    const loaded = new Promise((resolve) => {
      const h = (msg) => {
        if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
          listeners.splice(listeners.indexOf(h), 1); resolve();
        }
      };
      listeners.push(h);
    });
    await S('Page.navigate', { url });
    await loaded;
  };

  const waitFor = async (fn, timeout = 15000, arg) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(fn, arg)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };

  const setViewport = (w, h) => S('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: w < 600,
  });

  const screenshot = async (path) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
  };

  const click = async (selector) => evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, selector);

  const close = async () => {
    try { ws.close(); } catch {}
    proc.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  return { evaluate, goto, waitFor, click, close, screenshot, setViewport,
           consoleErrors, consoleAll, exceptions, failedRequests, S,
           browserLog: () => browserLog.join('') };
}
