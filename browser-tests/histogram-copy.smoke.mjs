// Focused smoke for the government histogram's reader-facing framing.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/histogram-copy.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve } from './server.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const NBSP = '\u00a0';
const HISTOGRAM_LINK = '#election-government-histogram';
const TARGET_GENERATION = '20260831T170410Z-1f5e0506';

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const settle = (ms = 180) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  await settle(300);
}

async function open(viewport, pointer = null, coarse = false) {
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch(viewport);
  if (coarse) {
    await browser.S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

const readCopy = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? flat(node.textContent) : null;
  };
  const link = document.querySelector('.eg-summary__histogram-link');
  const histogram = document.getElementById('election-government-histogram');
  const thresholdText = document.querySelector('.egh-threshold__label');
  const thresholdBg = document.querySelector('.egh-threshold__label-bg');
  return {
    summaryHidden: document.getElementById('election-government-results').hidden,
    summaryLine: text('.eg-summary__discoverability'),
    linkHref: link ? link.getAttribute('href') : null,
    heading: text('#election-government-histogram-heading'),
    context: text('#election-government-histogram-context'),
    majorityShare: text('#election-government-histogram-majority-share'),
    majorityDetail: text('#election-government-histogram-majority-detail'),
    bottom: text('#election-government-histogram-text'),
    statusHidden: document.getElementById('election-government-histogram-status').hidden,
    histogramHidden: histogram.hidden,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    threshold: thresholdText && thresholdBg ? {
      textLength: thresholdText.getAttribute('textLength'),
      lengthAdjust: thresholdText.getAttribute('lengthAdjust'),
      textAnchor: thresholdText.getAttribute('text-anchor'),
      computedLength: thresholdText.getComputedTextLength ? thresholdText.getComputedTextLength() : 0,
      bgWidth: Number(thresholdBg.getAttribute('width')),
    } : null,
  };
});

async function focusBuilder(browser) {
  await browser.evaluate(() => {
    document.getElementById('election-government-builder')
      .scrollIntoView({ block: 'center' });
  });
  await settle();
}

async function dragParty(browser, party) {
  await focusBuilder(browser);
  const points = await browser.evaluate((name) => {
    const block = document.querySelector(`.eg-bar__segment[data-party="${name}"]`);
    const target = document.getElementById('election-government-bar');
    if (!block || !target) return null;
    const from = block.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    return {
      fromX: from.left + from.width / 2,
      fromY: from.top + from.height / 2,
      toX: to.left + to.width / 2,
      toY: to.top + to.height / 2,
    };
  }, party);
  if (!points) return false;
  const send = (type, x, y) => browser.S('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await send('mousePressed', points.fromX, points.fromY);
  for (let index = 1; index <= 8; index += 1) {
    await send('mouseMoved',
      points.fromX + (points.toX - points.fromX) * index / 8,
      points.fromY + (points.toY - points.fromY) * index / 8);
  }
  await send('mouseReleased', points.toX, points.toY);
  await settle();
  return true;
}

async function hoverExactBin(browser, seat) {
  const point = await browser.evaluate((value) => {
    const hit = document.querySelector(
      `#election-government-histogram-svg .egh-bin[data-seat="${value}"] .egh-bin__hit`);
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    const rect = hit.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, seat);
  if (!point) return false;
  await browser.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await settle();
  return true;
}

async function clickReachesHistogram(browser) {
  await browser.evaluate(() => window.scrollTo(0, 0));
  await browser.click('.eg-summary__histogram-link');
  await settle(1200);
  return browser.evaluate(() => {
    const target = document.getElementById('election-government-histogram');
    const rect = target.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      targetTop: rect.top,
      targetVisible: rect.top < window.innerHeight && rect.bottom > 0,
    };
  });
}

async function desktop() {
  console.log('\ndesktop histogram copy');
  const { server, browser } = await open(DESKTOP);
  try {
    let copy = await readCopy(browser);
    equal('the link is absent with no government', copy.linkHref, null);
    equal('the summary is hidden with no government', copy.summaryHidden, true);

    for (const party of ['S', 'V', 'MP']) check(`${party} selects`, await dragParty(browser, party));
    copy = await readCopy(browser);
    equal('the compact summary uses the published values', copy.summaryLine,
      `Median: 164 mandat · Majoritet: 4,28${NBSP}% · Visa mandatfördelningen ↓`);
    equal('the link targets the histogram', copy.linkHref, HISTOGRAM_LINK);
    equal('the histogram heading is concise', copy.heading, 'Mandatfördelning');
    equal('the denominator is explained once and dynamically', copy.context,
      `S + V + MP. Varje stapel visar hur ofta regeringen fick ett visst antal mandat i modellens 100${NBSP}000 simuleringar.`);
    equal('the majority percentage is the published probability', copy.majorityShare, `4,28${NBSP}%`);
    equal('the majority count uses the exact histogram', copy.majorityDetail,
      `4${NBSP}283 av 100${NBSP}000 simuleringar gav minst 175 mandat.`);
    equal('the bottom summary is short and dynamic', copy.bottom,
      `S + V + MP fick majoritet i 4,28${NBSP}% av simuleringarna. Utfallet varierade mellan 132 och 195 mandat.`);
    check('the old repetitive prose is gone',
      !copy.context.includes('Fördelningen visar') &&
      !copy.bottom.includes('skrafferade') && !copy.bottom.includes('Fokusera'), copy);

    check('the focused 175-seat bin exists', await hoverExactBin(browser, 175));
    copy = await readCopy(browser);
    equal('the focused bin states an exact seat value',
      await browser.evaluate(() => document.getElementById('election-government-histogram-status').textContent),
      `Exakt 175 mandat: 1${NBSP}262 simuleringar (1,26${NBSP}%)`);
    const reached = await clickReachesHistogram(browser);
    check('clicking the summary link reaches the histogram',
      reached.targetVisible && reached.scrollY > 0 && reached.targetTop > -80 && reached.targetTop < 140,
      reached);

    check('the threshold label has no forced textLength', copy.threshold?.textLength === null, copy.threshold);
    check('the threshold label has no forced lengthAdjust', copy.threshold?.lengthAdjust === null, copy.threshold);
    equal('the threshold label is middle anchored', copy.threshold?.textAnchor, 'middle');
    check('the threshold background wraps natural text width with padding',
      (copy.threshold?.bgWidth || 0) > (copy.threshold?.computedLength || 0), copy.threshold);

    equal('schema 1.3 has no horizontal overflow', copy.overflow, 0);
    equal('schema 1.3 has no console errors', appErrors(browser), []);
    equal('schema 1.3 has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function mobile() {
  console.log('\nmobile histogram copy');
  const { server, browser } = await open(MOBILE, null, true);
  try {
    for (const party of ['S', 'V', 'MP']) check(`${party} selects on mobile`, await dragParty(browser, party));
    const copy = await readCopy(browser);
    check('the mobile summary link is visible', copy.linkHref === HISTOGRAM_LINK, copy);
    check('the mobile threshold label has no forced textLength', copy.threshold?.textLength === null, copy.threshold);
    check('the mobile threshold label has no forced lengthAdjust', copy.threshold?.lengthAdjust === null, copy.threshold);
    check('the mobile threshold background wraps natural text width with padding',
      (copy.threshold?.bgWidth || 0) > (copy.threshold?.computedLength || 0), copy.threshold);
    check('the mobile page has no horizontal overflow', copy.overflow <= 0, copy.overflow);
    const reached = await clickReachesHistogram(browser);
    check('the mobile link reaches the histogram', reached.targetVisible, reached);
    equal('mobile has no console errors', appErrors(browser), []);
    equal('mobile has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function sourceGuard() {
  const source = await readFile(new URL('../assets/js/election-simulator.js', import.meta.url), 'utf8');
  check('schema 1.2 link guard remains in source',
    source.includes('entry.seat_histogram && histogram && !histogram.hidden'));
}

await sourceGuard();
await desktop();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('FAIL');
  process.exit(1);
}
console.log(`PASS (${TARGET_GENERATION})`);
