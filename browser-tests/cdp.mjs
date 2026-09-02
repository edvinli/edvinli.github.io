// Minimal zero-dependency CDP driver over Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_REQUEST_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 30000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 15000;

const timeoutText = (milliseconds) => milliseconds % 1000 === 0
  ? `${milliseconds / 1000}s`
  : `${milliseconds}ms`;

async function waitForWebSocketOpen(ws, timeout = WEBSOCKET_OPEN_TIMEOUT_MS) {
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', opened);
      ws.removeEventListener('error', failed);
      ws.removeEventListener('close', closed);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('the CDP WebSocket connection failed')); };
    const closed = () => { cleanup(); reject(new Error('the CDP WebSocket closed before opening')); };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP WebSocket open timed out after ${timeoutText(timeout)}`));
    }, timeout);
    ws.addEventListener('open', opened, { once: true });
    ws.addEventListener('error', failed, { once: true });
    ws.addEventListener('close', closed, { once: true });
  });
}

async function waitForProcessExit(proc, timeout) {
  if (proc.exitCode != null || proc.signalCode != null) return true;
  return new Promise((resolve) => {
    let timer;
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      proc.off('exit', exited);
      resolve(false);
    }, timeout);
    proc.once('exit', exited);
  });
}

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
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
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
      const remaining = Math.max(1, deadline - Date.now());
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.min(1000, remaining)),
      });
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { await new Promise(r => setTimeout(r, 120)); }
  }
  if (!wsUrl) {
    const exitState = `exitCode=${proc.exitCode ?? 'running'}, signal=${proc.signalCode ?? 'none'}`;
    const logTail = browserLog.join('').trim().slice(-12000);
    proc.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    throw new Error(
      `Chrome did not expose CDP after 30s (${exitState})` +
      (logTail ? `\nChromium output:\n${logTail}` : ''),
    );
  }

  const ws = new WebSocket(wsUrl);
  try {
    await waitForWebSocketOpen(ws);
  } catch (error) {
    try { ws.close(); } catch {}
    proc.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    throw error;
  }

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const request = pending.get(msg.id);
      msg.error ? request.reject(new Error(JSON.stringify(msg.error))) : request.resolve(msg.result);
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
    [...pending.values()].forEach(({ reject }) => reject(new Error(reason)));
  };
  ws.onclose = () => killPending('the CDP connection closed');
  ws.onerror = () => killPending('the CDP connection failed');
  proc.on('exit', (code, signal) =>
    killPending(`Chrome exited early (code ${code}, signal ${signal})`));

  const send = (
    method,
    params = {},
    sessionId,
    { timeout = CDP_REQUEST_TIMEOUT_MS, timeoutLabel = method } = {},
  ) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(`${dead}; cannot send ${method}`)); return; }
    const n = ++id;
    let timer;
    const finish = (handler, value) => {
      if (!pending.has(n)) return;
      pending.delete(n);
      clearTimeout(timer);
      handler(value);
    };
    const request = {
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    };
    pending.set(n, request);
    timer = setTimeout(() => {
      request.reject(new Error(`${timeoutLabel} timed out after ${timeoutText(timeout)}`));
    }, timeout);
    try {
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    } catch (error) {
      request.reject(error);
    }
  });

  let closed = false;
  const shutdown = async (reason = 'browser closed') => {
    if (closed) return;
    closed = true;
    killPending(reason);
    listeners.length = 0;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch {}
    try {
      if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGTERM');
      if (!await waitForProcessExit(proc, 2000)) {
        proc.kill('SIGKILL');
        if (!await waitForProcessExit(proc, 2000)) {
          throw new Error('Chromium did not exit within 4s after SIGTERM/SIGKILL');
        }
      }
    } finally {
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  };

  let sessionId;
  try {
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;
  } catch (error) {
    await shutdown('CDP initialization failed');
    throw error;
  }
  const S = (method, params, options) => send(method, params, sessionId, options);

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

  try {
    await S('Runtime.enable');
    await S('Page.enable');
    await S('Log.enable');
    await S('Network.enable');
    await S('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  } catch (error) {
    await shutdown('CDP setup failed');
    throw error;
  }

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

  // Page.loadEventFired is deliberately not awaited. It can be lost during a
  // renderer stall and was the source of an unbounded Promise. The caller's
  // application-specific readiness check is the authoritative post-navigation
  // gate after this bounded Page.navigate acknowledgement.
  const goto = (url, { timeout = NAVIGATION_TIMEOUT_MS, label = 'navigation' } = {}) =>
    S('Page.navigate', { url }, { timeout, timeoutLabel: label });

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

  const close = () => shutdown();

  return { evaluate, goto, waitFor, click, close, screenshot, setViewport,
           consoleErrors, consoleAll, exceptions, failedRequests, S,
           browserLog: () => browserLog.join('') };
}
