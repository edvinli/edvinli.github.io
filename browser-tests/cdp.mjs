// Minimal zero-dependency CDP driver over Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_REQUEST_TIMEOUT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 30000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 15000;

// How long Chrome gets to expose its debugging endpoint.
//
// Configurable because 30s is not comfortably above what a loaded CI runner
// needs: a passing publication was observed launching in 23.7s, a 6.3s margin,
// and a rendering job -- which drives the browser after reconstruction and
// projection work in the same job -- lost that race at 30.2s. Bounded at 60s
// because a longer wait stops being a slow start and starts being a hang that
// should fail the suite rather than delay it.
//
// Raising this does not fix a browser that cannot start. `launch` now
// distinguishes the two: an exited process fails immediately, whatever the
// deadline.
const CDP_READY_TIMEOUT_DEFAULT_MS = 30000;
const CDP_READY_TIMEOUT_CEILING_MS = 60000;

export function resolveCdpReadyTimeout(raw = process.env.CDP_READY_TIMEOUT_MS) {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return CDP_READY_TIMEOUT_DEFAULT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CDP_READY_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.min(Math.round(parsed), CDP_READY_TIMEOUT_CEILING_MS);
}

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
  // First, before a profile directory exists or a browser is running. A
  // misconfigured deadline is a configuration error, and throwing it after
  // the spawn leaked both the process and the profile -- so the one failure
  // that is entirely our own fault was also the one that left rubbish behind.
  const readyTimeout = resolveCdpReadyTimeout();
  const profile = mkdtempSync(join(tmpdir(), 'cdp-profile-'));
  // Port 0 means "pick one and tell me". Chrome writes the port it actually
  // bound to DevToolsActivePort in the profile directory, once the DevTools
  // server is listening. Picking a port ourselves and polling it was a guess
  // that could be wrong in a way nothing recovered from: if the port was
  // already taken, Chrome bound a different one, announced *that* one, and we
  // polled ours until the deadline -- reporting "did not expose CDP" about a
  // browser whose endpoint was up and reachable the whole time.
  const activePortFile = join(profile, 'DevToolsActivePort');
  // Which binary, and which build of it. The selection happens outside this
  // repository -- CI resolves CHROME_BIN from whatever the runner image has --
  // so a launch failure is not diagnosable without naming what was launched.
  // Read from CDP's own /json/version on success; only guessed at on failure.
  const launchStarted = Date.now();
  let browserVersion = null;
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
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

  // Every polling error used to be discarded. That is what made a launch
  // failure undiagnosable: the message could say only that some deadline had
  // passed, never what had been tried or what had come back, so the same text
  // covered a dead browser, an unreachable port and a malformed reply -- and
  // the standing response was to raise the deadline, which fixed none of them.
  let discoveredPort = null;
  let pollAttempts = 0;
  let lastPollError = null;

  const exitState = () =>
    `exitCode=${proc.exitCode ?? 'running'}, signal=${proc.signalCode ?? 'none'}`;
  const abandon = (reason) => {
    const logTail = browserLog.join('').trim().slice(-12000);
    proc.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    return new Error(
      `${reason} [browser=${CHROME}, version=${browserVersion ?? 'unknown'}, ` +
      `port=${discoveredPort ?? 'never announced'}, polls=${pollAttempts}, ` +
      `lastError=${lastPollError ?? 'none'}, ` +
      `startup=${((Date.now() - launchStarted) / 1000).toFixed(3)}s, ${exitState()}]` +
      (logTail ? `\nChromium output:\n${logTail}` : ''),
    );
  };

  let wsUrl = null;
  let versionPayload = null;
  const deadline = Date.now() + readyTimeout;
  const pause = () => new Promise(r => setTimeout(r, 120));
  while (Date.now() < deadline && !wsUrl) {
    // A browser that has already exited is never going to answer. Polling on
    // regardless made a crash indistinguishable from a slow start: both
    // reported the same "did not expose CDP" after the full deadline, which is
    // how a dbus failure looked like a timeout worth waiting longer for.
    if (proc.exitCode != null || proc.signalCode != null) {
      throw abandon('Chrome exited before exposing CDP');
    }
    // Phase one: which port did it bind? Cheap, local, and the answer comes
    // from Chrome rather than from us.
    if (discoveredPort === null) {
      try {
        const announced = Number(readFileSync(activePortFile, 'utf8').split('\n')[0].trim());
        if (Number.isInteger(announced) && announced > 0) discoveredPort = announced;
        else lastPollError = `DevToolsActivePort held ${JSON.stringify(announced)}`;
      } catch (error) {
        lastPollError = `DevToolsActivePort unreadable: ${error.code ?? error.message}`;
      }
      if (discoveredPort === null) { await pause(); continue; }
    }
    // Phase two: is it answering yet, and with a target to attach to?
    try {
      pollAttempts += 1;
      const remaining = Math.max(1, deadline - Date.now());
      const r = await fetch(`http://127.0.0.1:${discoveredPort}/json/version`, {
        signal: AbortSignal.timeout(Math.min(1000, remaining)),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      versionPayload = await r.json();
      wsUrl = versionPayload.webSocketDebuggerUrl;
      if (!wsUrl) {
        lastPollError = '/json/version answered without a webSocketDebuggerUrl: '
          + JSON.stringify(versionPayload).slice(0, 200);
      }
    } catch (error) {
      lastPollError = `/json/version: ${error.name}: ${error.message}`;
    }
    // Unconditional, because an answer without a debugger URL is not an
    // exception: leaving the sleep to the catch turned that case into a hot
    // loop that spun a core until the deadline.
    if (!wsUrl) await pause();
  }
  if (!wsUrl) {
    throw abandon(`Chrome did not expose CDP after ${timeoutText(readyTimeout)}`);
  }
  browserVersion = versionPayload?.Browser ?? browserVersion;
  // Reported on success too. A launch that is quietly creeping toward the
  // deadline is the warning that precedes the failure, and it is invisible if
  // the elapsed time is only printed when it is already too late.
  process.stderr.write(
    `[cdp] launched browser=${CHROME} version=${browserVersion ?? 'unknown'} ` +
    `startup=${((Date.now() - launchStarted) / 1000).toFixed(3)}s ` +
    `deadline=${timeoutText(readyTimeout)}\n`,
  );

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

// --- self-test -------------------------------------------------------------
// Runs in CI, as select-suites.mjs does. The launch path has exactly two
// failure shapes and they used to be indistinguishable: a browser that is
// slow, and a browser that is dead. Reporting both as "did not expose CDP
// after 30s" is what made a dbus failure look like a deadline worth raising.
//
// Driven with a fake browser rather than Chrome: these assertions are about
// this module's waiting and reporting, which a real browser cannot be made to
// fail on demand.

async function selfTest() {
  const { existsSync, mkdtempSync, readdirSync, writeFileSync } = await import('node:fs');
  const failures = [];
  const check = (label, pass, detail) => {
    if (pass) { console.log(`  ok   ${label}`); return; }
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
  };

  // --- the configurable deadline ---
  const cases = [
    [undefined, CDP_READY_TIMEOUT_DEFAULT_MS], ['', CDP_READY_TIMEOUT_DEFAULT_MS],
    ['45000', 45000], ['60000', 60000],
    ['90000', CDP_READY_TIMEOUT_CEILING_MS], [' 40000 ', 40000],
  ];
  for (const [raw, expected] of cases) {
    check(`deadline ${JSON.stringify(raw)} resolves to ${expected}`,
      resolveCdpReadyTimeout(raw) === expected, resolveCdpReadyTimeout(raw));
  }
  check('the ceiling is a bound, not a default',
    CDP_READY_TIMEOUT_DEFAULT_MS < CDP_READY_TIMEOUT_CEILING_MS);
  for (const raw of ['0', '-1', 'soon', 'NaN']) {
    let refused = false;
    try { resolveCdpReadyTimeout(raw); } catch { refused = true; }
    check(`deadline ${JSON.stringify(raw)} is refused`, refused);
  }

  // --- a fake browser, so the waiting itself can be tested ---
  const workspace = mkdtempSync(join(tmpdir(), 'cdp-selftest-'));
  const fake = (body) => {
    const file = join(workspace, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return file;
  };
  // Chrome is asked for port 0 and answers in DevToolsActivePort, so a fake
  // that hardcodes a port no longer resembles it. These fakes bind an
  // ephemeral port and announce it the same way, which is what lets the
  // port-discovery path be tested at all.
  const profileFromArgv = `process.argv.find((a) => \
a.startsWith('--user-data-dir='))?.split('=')[1]`;
  const announce = (portExpr) => `
    const { writeFileSync } = await import('node:fs');
    writeFileSync(${profileFromArgv} + '/DevToolsActivePort',
      ${portExpr} + '\\n/devtools/browser/fake\\n');
  `;
  const servesVersion = (payload) => `
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(${payload}));
    });
    server.listen(0, '127.0.0.1', async () => {
      ${announce('server.address().port')}
    });
  `;

  const exitsImmediately = fake(`
    process.stderr.write('fake browser refusing to start\\n');
    process.exit(3);
  `);
  const staysSilent = fake(`setInterval(() => {}, 1000);`);
  const readyLate = fake(`
    setTimeout(async () => {
      ${servesVersion(`{
        Browser: 'FakeChrome/1.2.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
      }`)}
    }, 600);
  `);
  // The failure this repair is about: the browser is listening and reachable,
  // but not on any port the launcher would have guessed. Reading the announced
  // port is the whole difference between this launching and timing out.
  const listensOnAnUnguessablePort = fake(`
    ${servesVersion(`{
      Browser: 'FakeChrome/9.9.9',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
    }`)}
  `);
  // Announces a port that nothing is listening on. Distinct from silence: the
  // launcher got an answer to "which port", and no answer on it.
  const announcesADeadPort = fake(`
    const { createServer } = await import('node:http');
    const probe = createServer(() => {});
    probe.listen(0, '127.0.0.1', async () => {
      const dead = probe.address().port;
      probe.close();
      ${announce('dead')}
    });
    setInterval(() => {}, 1000);
  `);
  // Answers, but with nothing to attach to. This used to spin a core: no
  // exception meant no sleep, so the poll loop ran flat out to the deadline.
  const answersWithoutATarget = fake(`
    ${servesVersion(`{ Browser: 'FakeChrome/0.0.0' }`)}
    setInterval(() => {}, 1000);
  `);

  // `deadline` is passed through verbatim so an invalid value can be tested.
  const attempt = async (binary, deadline) => {
    const previousChrome = process.env.CHROME_BIN;
    const previousTimeout = process.env.CDP_READY_TIMEOUT_MS;
    process.env.CHROME_BIN = binary;
    process.env.CDP_READY_TIMEOUT_MS = String(deadline);
    const started = Date.now();
    try {
      // `CHROME` is captured at module load, so the child is spawned through a
      // fresh import of this module with the environment already in place.
      const fresh = await import(`${import.meta.url}?case=${Math.random()}`);
      const browser = await fresh.launch({ width: 400, height: 300 });
      await browser.close();
      return { error: null, elapsed: Date.now() - started };
    } catch (error) {
      return { error, elapsed: Date.now() - started };
    } finally {
      if (previousChrome === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previousChrome;
      if (previousTimeout === undefined) delete process.env.CDP_READY_TIMEOUT_MS;
      else process.env.CDP_READY_TIMEOUT_MS = previousTimeout;
    }
  };

  // Early process exit: fails at once, and says the process exited rather
  // than blaming the deadline. The 4000ms budget is deliberately far above
  // what an immediate failure needs and far below the deadline.
  const dead = await attempt(exitsImmediately, 8000);
  check('a browser that exits fails immediately',
    dead.error !== null && dead.elapsed < 4000, dead.elapsed);
  check('...and names the exit rather than the deadline',
    /exited before exposing CDP/.test(dead.error?.message ?? ''), dead.error?.message?.slice(0, 200));
  check('...and reports the exit status',
    /exitCode=3/.test(dead.error?.message ?? ''), dead.error?.message?.slice(0, 300));
  check('...and includes the bounded browser output',
    /refusing to start/.test(dead.error?.message ?? ''), dead.error?.message?.slice(0, 300));
  check('...and names the binary it launched',
    (dead.error?.message ?? '').includes(exitsImmediately));

  // A misconfigured deadline must be caught before anything exists to clean
  // up. Proven by the browser recording that it ran: asserting only that
  // `launch` throws would pass just as well with a spawned browser and a
  // profile directory left behind.
  const ranMarker = join(workspace, 'the-browser-ran');
  const recordsThatItRan = fake(`
    const { writeFileSync } = await import('node:fs');
    writeFileSync(${JSON.stringify(ranMarker)}, 'ran');
    setInterval(() => {}, 1000);
  `);
  const profilesBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('cdp-profile-')).length;
  const misconfigured = await attempt(recordsThatItRan, 'not-a-number');
  check('an invalid deadline is refused',
    /CDP_READY_TIMEOUT_MS must be a positive number/.test(misconfigured.error?.message ?? ''),
    misconfigured.error?.message?.slice(0, 200));
  check('...before any browser is started',
    !existsSync(ranMarker));
  check('...and before any profile directory is created',
    readdirSync(tmpdir()).filter((n) => n.startsWith('cdp-profile-')).length === profilesBefore);
  check('...and fails fast, without waiting on anything',
    misconfigured.elapsed < 2000, misconfigured.elapsed);

  // A live but silent browser is waited for, to the deadline and no further.
  const silent = await attempt(staysSilent, 2000);
  check('a live but silent browser is waited for, then fails on the deadline',
    /did not expose CDP after 2s/.test(silent.error?.message ?? ''),
    silent.error?.message?.slice(0, 200));
  check('...having waited roughly the deadline, not longer',
    silent.elapsed >= 1900 && silent.elapsed < 7000, silent.elapsed);
  check('...and reports it was still running',
    /exitCode=running/.test(silent.error?.message ?? ''), silent.error?.message?.slice(0, 300));

  // Delayed readiness: the endpoint appearing after a pause is accepted, so a
  // slow start is not failed. This fake serves /json/version and no
  // WebSocket, so the attempt still fails -- at the *next* stage, which is
  // what proves the poll loop got past waiting.
  const late = await attempt(readyLate, 8000);
  check('an endpoint that appears late is accepted',
    late.error !== null && !/did not expose CDP/.test(late.error.message)
      && !/exited before exposing CDP/.test(late.error.message),
    late.error?.message?.slice(0, 200));
  check('...and the failure is the WebSocket stage, past the wait',
    /WebSocket/.test(late.error?.message ?? ''), late.error?.message?.slice(0, 200));

  // --- the port is Chrome's to choose, not ours to guess ---
  // A browser on a port the launcher never picked must still be found. Under
  // the old guess-a-port launcher this timed out while fully reachable, which
  // is the failure that cost a publication on 2026-09-11.
  const unguessable = await attempt(listensOnAnUnguessablePort, 8000);
  check('a browser on its own chosen port is reached, not timed out',
    unguessable.error !== null && !/did not expose CDP/.test(unguessable.error.message),
    unguessable.error?.message?.slice(0, 200));
  check('...promptly, rather than creeping toward the deadline',
    unguessable.elapsed < 4000, unguessable.elapsed);

  // --- a rejection has to say what was tried ---
  // A whole number of seconds, because timeoutText only abbreviates those.
  const deadPort = await attempt(announcesADeadPort, 3000);
  check('an announced port that answers nothing fails on the deadline',
    /did not expose CDP after 3s/.test(deadPort.error?.message ?? ''),
    deadPort.error?.message?.slice(0, 200));
  check('...and names the port it actually polled',
    /port=\d+/.test(deadPort.error?.message ?? ''), deadPort.error?.message?.slice(0, 300));
  check('...and reports that it polled, rather than discarding every attempt',
    /polls=[1-9]/.test(deadPort.error?.message ?? ''), deadPort.error?.message?.slice(0, 300));
  check('...and carries the last error instead of only the deadline',
    /lastError=\/json\/version: /.test(deadPort.error?.message ?? ''),
    deadPort.error?.message?.slice(0, 400));

  // Silence must still be distinguishable: no port was ever announced.
  check('a silent browser is reported as never having announced a port',
    /port=never announced/.test(silent.error?.message ?? ''),
    silent.error?.message?.slice(0, 300));

  // --- an answer without a target is waited out, not spun on ---
  const targetless = await attempt(answersWithoutATarget, 2000);
  check('an endpoint with no debugger URL fails on the deadline',
    /did not expose CDP after 2s/.test(targetless.error?.message ?? ''),
    targetless.error?.message?.slice(0, 200));
  check('...saying so, rather than blaming the port',
    /webSocketDebuggerUrl/.test(targetless.error?.message ?? ''),
    targetless.error?.message?.slice(0, 400));
  // The hot loop managed thousands of polls in two seconds. Paced polling
  // cannot exceed roughly one per 120ms, so this bounds the spin without
  // pinning a timing-sensitive exact count.
  const pacedCeiling = 2000 / 120 * 3;
  const targetlessPolls = Number(/polls=(\d+)/.exec(targetless.error?.message ?? '')?.[1] ?? -1);
  check('...having polled at a paced rate, not spun a core',
    targetlessPolls > 0 && targetlessPolls < pacedCeiling, targetlessPolls);

  try { rmSync(workspace, { recursive: true, force: true }); } catch {}

  console.log(failures.length === 0
    ? `\ncdp launch self-test: all checks passed`
    : `\ncdp launch self-test: ${failures.length} failed`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
    && process.argv.includes('--self-test')) {
  process.exit(await selfTest());
}
