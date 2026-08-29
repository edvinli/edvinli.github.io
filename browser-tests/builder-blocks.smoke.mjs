// Targeted smoke for the mandate-block government builder.
//
// The coloured blocks inside the two bars are now the whole interaction:
// there is no card list under the chart any more. This file checks only that
// -- the blocks drag with a mouse and with a finger, the page still scrolls
// vertically, the zero-seat marker moves like any other block, Återställ puts
// everything back, and the histogram follows the government.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/builder-blocks.smoke.mjs [path/to/_site] [shot-dir]

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './cdp.mjs';
import { serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const SHOTS = resolve(process.argv[3] || join(HERE, '..', '_shots'));
const PAGE = '/election-simulator/';

const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const BIT = {};
PARTY_ORDER.forEach((p, i) => { BIT[p] = 1 << i; });

let failures = 0;
let checks = 0;
const ok = (label, pass, detail) => {
  checks += 1;
  if (pass) { console.log(`  ok   ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
  return false;
};
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected });

const settle = () => new Promise((r) => setTimeout(r, 160));

// The dev build ships no favicon or web manifest; those 404s are site chrome,
// not the panel, and the sibling suite filters them the same way.
const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const s = document.getElementById('election-app-status');
    return Boolean(s) && (s.hidden || s.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  await new Promise((r) => setTimeout(r, 300));
}

async function open(viewport, { coarse = false } = {}) {
  const server = await serve(SITE, { port: 4000 });
  const browser = await launch(viewport);
  if (coarse) {
    await browser.S('Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 });
  }
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

// --- page readers ----------------------------------------------------------

const readPanel = (browser) => browser.evaluate(() => {
  const bar = (id) => Array.from(
    document.getElementById(id).querySelectorAll('.eg-bar__segment'))
    .map((s) => ({
      party: s.getAttribute('data-party'),
      side: s.getAttribute('data-side'),
      zero: s.className.includes('eg-bar__segment--zero'),
      cursor: getComputedStyle(s).cursor,
      touchAction: getComputedStyle(s).touchAction,
      label: (s.getAttribute('aria-label') || '').slice(0, 2),
      height: Math.round(s.getBoundingClientRect().height),
    }));
  const summary = document.getElementById('election-government-results');
  const histogram = document.getElementById('election-government-histogram');
  const doc = document.documentElement;
  return {
    // The card list is gone: nothing white sits under the chart any more.
    legacyCards: document.querySelectorAll('.eg-party, .eg-zone, .eg-chart__row--zones').length,
    legacyIds: ['election-government-parties', 'election-opposition-parties']
      .filter((id) => document.getElementById(id) !== null),
    government: bar('election-government-bar'),
    opposition: bar('election-opposition-bar'),
    governmentTotal: document.getElementById('election-government-total').textContent,
    oppositionTotal: document.getElementById('election-opposition-total').textContent,
    governmentMask: summary.getAttribute('data-government-mask'),
    oppositionMask: summary.getAttribute('data-opposition-mask'),
    summaryHidden: summary.hidden,
    histogramHidden: histogram.hidden,
    histogramMask: histogram.getAttribute('data-coalition-mask'),
    histogramBars: histogram.querySelectorAll('#election-government-histogram-svg rect').length,
    // Nothing may push the page sideways at any viewport.
    overflow: doc.scrollWidth - doc.clientWidth,
    colors: ['M', 'KD', 'L'].map((p) => {
      const s = document.querySelector(`.eg-bar__segment[data-party="${p}"]`);
      return s ? getComputedStyle(s).backgroundColor : null;
    }),
  };
});

/** Centre of a party's block, and a point inside the target bar. */
const dragPoints = (browser, party, barId) => browser.evaluate(([p, id]) => {
  const block = document.querySelector(`.eg-bar__segment[data-party="${p}"]`);
  const bar = document.getElementById(id);
  if (!block || !bar) return null;
  const b = block.getBoundingClientRect();
  const t = bar.getBoundingClientRect();
  return {
    fromX: b.left + b.width / 2,
    fromY: b.top + b.height / 2,
    toX: t.left + t.width / 2,
    toY: t.top + t.height / 2,
  };
}, [party, barId]);

const focusPanel = async (browser) => {
  await browser.evaluate(() => {
    document.getElementById('election-government-builder')
      .scrollIntoView({ block: 'center' });
  });
  await settle();
};

async function mouseDrag(browser, party, barId) {
  await focusPanel(browser);
  const p = await dragPoints(browser, party, barId);
  if (!p) return false;
  const send = (type, x, y) => browser.S('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await send('mousePressed', p.fromX, p.fromY);
  for (let i = 1; i <= 8; i += 1) {
    await send('mouseMoved',
      p.fromX + (p.toX - p.fromX) * i / 8, p.fromY + (p.toY - p.fromY) * i / 8);
  }
  await send('mouseReleased', p.toX, p.toY);
  await settle();
  return true;
}

const touchSend = (browser, type, x, y) => browser.S('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
});

// A finger crossing to the other bar. It travels sideways first: that is the
// direction the panel claims, and what tells the gesture apart from a scroll.
async function touchDrag(browser, party, barId) {
  await focusPanel(browser);
  const p = await dragPoints(browser, party, barId);
  if (!p) return false;
  await touchSend(browser, 'touchStart', p.fromX, p.fromY);
  for (let i = 1; i <= 6; i += 1) {
    await touchSend(browser, 'touchMove', p.fromX + (p.toX - p.fromX) * i / 6, p.fromY);
  }
  for (let i = 1; i <= 4; i += 1) {
    await touchSend(browser, 'touchMove', p.toX, p.fromY + (p.toY - p.fromY) * i / 4);
  }
  await touchSend(browser, 'touchEnd', p.toX, p.toY);
  await settle();
  return true;
}

const parties = (blocks) => blocks.map((b) => b.party);

// --- desktop ---------------------------------------------------------------

async function desktop() {
  console.log('\ndesktop 1280x1000');
  const { server, browser } = await open(DESKTOP);
  try {
    let panel = await readPanel(browser);

    eq('no .eg-party / .eg-zone rows remain', panel.legacyCards, 0);
    eq('no party-list containers remain', panel.legacyIds, []);
    eq('every party starts in Opposition', parties(panel.opposition).sort(),
      PARTY_ORDER.slice().sort());
    eq('the government bar starts empty', panel.government, []);
    eq('blocks offer a grab cursor', panel.opposition[0].cursor, 'grab');
    eq('blocks hand vertical panning back', panel.opposition[0].touchAction, 'pan-y');
    ok('every block names its party', panel.opposition.every((b) => b.label.length > 0));
    eq('L is drawn as a zero-seat marker',
      panel.opposition.filter((b) => b.zero).map((b) => b.party), ['L']);
    eq('M / KD / L use the lighter blues', panel.colors,
      ['rgb(54, 87, 167)', 'rgb(91, 124, 155)', 'rgb(74, 154, 214)']);
    eq('no horizontal overflow', panel.overflow, 0);
    eq('the histogram is hidden with no government', panel.histogramHidden, true);

    await focusPanel(browser);
    await browser.screenshot(join(SHOTS, 'builder-desktop-initial.png'));

    // Opposition -> Regering, with a mouse.
    ok('S drags into Regering', await mouseDrag(browser, 'S', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('S is now a government block', parties(panel.government), ['S']);
    eq('S left the opposition bar', panel.opposition.includes('S'), false);
    eq('the government mask is S', panel.governmentMask, String(BIT.S));
    eq('the opposition mask is the complement', panel.oppositionMask, String(255 ^ BIT.S));
    eq('the government total is drawn', panel.governmentTotal, '110');
    eq('the summary is shown', panel.summaryHidden, false);
    eq('the histogram follows the government', panel.histogramMask, String(BIT.S));
    eq('the histogram is shown', panel.histogramHidden, false);
    ok('the histogram has bars', panel.histogramBars > 0, panel.histogramBars);
    const firstHistogram = panel.histogramBars;

    // The zero-seat marker moves like any other block.
    ok('the L marker drags into Regering',
      await mouseDrag(browser, 'L', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('L is now a government block', parties(panel.government).sort(), ['L', 'S']);
    eq('L is still drawn as a zero marker',
      panel.government.filter((b) => b.zero).map((b) => b.party), ['L']);
    eq('L adds no height to the scale',
      panel.governmentTotal, '110');

    // A couple more, for the screenshot and for the histogram to change.
    for (const party of ['M', 'KD', 'C']) {
      ok(`${party} drags into Regering`,
        await mouseDrag(browser, party, 'election-government-bar'));
    }
    panel = await readPanel(browser);
    eq('the government is S+L+M+KD+C', parties(panel.government).sort(),
      ['C', 'KD', 'L', 'M', 'S']);
    eq('the histogram follows the new government', panel.histogramMask,
      String(BIT.S | BIT.L | BIT.M | BIT.KD | BIT.C));
    ok('the histogram redrew', panel.histogramBars > 0 && panel.histogramBars !== firstHistogram,
      { before: firstHistogram, after: panel.histogramBars });
    eq('no horizontal overflow with a government', panel.overflow, 0);

    // The summary/histogram sit directly under the chart now.
    const gap = await browser.evaluate(() => {
      const chart = document.querySelector('.eg-chart').getBoundingClientRect();
      const dl = document.getElementById('election-government-results').getBoundingClientRect();
      return Math.round(dl.top - chart.bottom);
    });
    ok('the summary sits directly under the chart', gap >= 0 && gap < 60, gap);

    await focusPanel(browser);
    await browser.screenshot(join(SHOTS, 'builder-desktop-government.png'));

    // Regering -> Opposition, with a mouse.
    ok('M drags back into Opposition',
      await mouseDrag(browser, 'M', 'election-opposition-bar'));
    panel = await readPanel(browser);
    eq('M is back in the opposition bar', panel.government.some((b) => b.party === 'M'), false);
    ok('M is an opposition block', parties(panel.opposition).includes('M'));
    eq('the government mask dropped M', panel.governmentMask,
      String(BIT.S | BIT.L | BIT.KD | BIT.C));

    // Dropping onto the side a block is already on is a no-op.
    const before = await readPanel(browser);
    await mouseDrag(browser, 'S', 'election-government-bar');
    const after = await readPanel(browser);
    eq('a same-side drop changes nothing', after.governmentMask, before.governmentMask);

    // Återställ.
    await browser.click('#election-builder-reset');
    await settle();
    panel = await readPanel(browser);
    eq('reset empties the government bar', panel.government, []);
    eq('reset returns every party to Opposition', parties(panel.opposition).sort(),
      PARTY_ORDER.slice().sort());
    eq('reset clears the mask', panel.governmentMask, '');
    eq('reset hides the histogram', panel.histogramHidden, true);

    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- mobile ----------------------------------------------------------------

async function mobile() {
  console.log('\nmobile 390x844 (touch)');
  const { server, browser } = await open(MOBILE, { coarse: true });
  try {
    let panel = await readPanel(browser);
    eq('no party rows at 390px', panel.legacyCards, 0);
    eq('no horizontal overflow at 390px', panel.overflow, 0);

    ok('a finger drags SD into Regering',
      await touchDrag(browser, 'SD', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('SD is a government block', parties(panel.government), ['SD']);
    eq('the government mask is SD', panel.governmentMask, String(BIT.SD));
    eq('the histogram followed', panel.histogramMask, String(BIT.SD));

    ok('a finger drags the L marker across',
      await touchDrag(browser, 'L', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('L joined the government', parties(panel.government).sort(), ['L', 'SD']);

    ok('a finger drags SD back to Opposition',
      await touchDrag(browser, 'SD', 'election-opposition-bar'));
    panel = await readPanel(browser);
    eq('the government is L alone', parties(panel.government), ['L']);

    // A vertical swipe over a block is a scroll, not a drag: the browser keeps
    // the gesture and the page moves.
    await focusPanel(browser);
    const p = await dragPoints(browser, 'S', 'election-opposition-bar');
    const startY = await browser.evaluate(() => window.scrollY);
    const maskBefore = (await readPanel(browser)).governmentMask;
    await touchSend(browser, 'touchStart', p.fromX, p.fromY);
    for (let i = 1; i <= 8; i += 1) {
      await touchSend(browser, 'touchMove', p.fromX, p.fromY - i * 14);
    }
    await touchSend(browser, 'touchEnd', p.fromX, p.fromY - 112);
    await settle();
    const endY = await browser.evaluate(() => window.scrollY);
    ok('a vertical swipe over a block still scrolls the page', endY > startY,
      { startY, endY });
    eq('the vertical swipe moved nothing', (await readPanel(browser)).governmentMask,
      maskBefore);

    await browser.click('#election-builder-reset');
    await settle();
    panel = await readPanel(browser);
    eq('reset works on mobile', panel.governmentMask, '');
    eq('reset restores all eight blocks', parties(panel.opposition).sort(),
      PARTY_ORDER.slice().sort());

    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const { mkdirSync } = await import('node:fs');
mkdirSync(SHOTS, { recursive: true });
await desktop();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
