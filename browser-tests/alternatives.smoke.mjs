// Real-browser smoke test for the "Regeringsalternativ" comparison section.
//
// The section replaced the old Majoritetsscenarier pill selector.  It draws
// the same six combinations the builder offers as presets, as six rows on one
// shared seat scale:
//
//   - exactly six rows, in the published order of the six named coalitions;
//   - one x-axis for all six: every track has the same box, and the 175 rule
//     lands on the same pixel in every row;
//   - the domain covers all six published 90 % intervals and always 175;
//   - a thin/light 90 % band, a thicker/darker 50 % band, a median marker;
//   - no party-coloured seat segments are stacked inside the bars — a
//     coalition's quantiles are joint, not a sum of party medians;
//   - every printed number is the coalition_builder lookup for that mask.
//
// Schema 1.2 carries the summaries the section needs, so it renders there.
// Schema 1.1 has no coalition_builder at all and must fail closed.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/alternatives.smoke.mjs [path/to/_site]

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';

const GENERATION_1_1 = '20260827T205828Z-e6c6ee97';
const GENERATION_1_2 = '20260828T064703Z-1da59168';
const GENERATION_1_3 = '20260828T201250Z-1da59168';

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const BIT = {};
PARTY_ORDER.forEach((party, index) => { BIT[party] = 1 << index; });
const MAJORITY = 175;
const NBSP = '\u00a0';

// The six alternatives, named the way the page names them.  Masks are derived
// from PARTY_ORDER here as well, so the test and the page agree only if both
// resolve the same names against the same published order.
const ALTERNATIVES = [
  ['S', 'V', 'MP'],
  ['S', 'C', 'MP'],
  ['S', 'C', 'MP', 'V'],
  ['S', 'KD', 'C', 'MP'],
  ['SD', 'L', 'M', 'KD'],
  ['S', 'M', 'C'],
];
const maskFor = (parties) => parties.reduce((mask, party) => mask | BIT[party], 0);

const VIEWPORTS = [
  { name: 'desktop (1280x1000)', width: 1280, height: 1000 },
  { name: 'narrow-360 (360x900)', width: 360, height: 900 },
];

let failures = 0;
let checks = 0;
const check = (name, ok, detail) => {
  checks += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || detail === undefined ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  await new Promise((r) => setTimeout(r, 300));
}

async function open(viewport, pointer) {
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

// --- DOM reader -------------------------------------------------------------

const readSection = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const round = (value) => Math.round(value * 100) / 100;
  const section = document.getElementById('election-alternatives');
  const host = document.getElementById('election-alternatives-rows');
  const doc = document.documentElement;

  const boxOf = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      display: style.display,
      left: round(rect.left),
      right: round(rect.right),
      width: round(rect.width),
      height: round(rect.height),
    };
  };

  const rows = Array.from(document.querySelectorAll('.ea-row')).map((row) => {
    const track = row.querySelector('.ea-track');
    const trackRect = track ? track.getBoundingClientRect() : null;
    const fraction = (el) => {
      if (!el || !trackRect || trackRect.width <= 0) return null;
      const rect = el.getBoundingClientRect();
      return {
        start: round(((rect.left - trackRect.left) / trackRect.width) * 1000) / 1000,
        end: round(((rect.right - trackRect.left) / trackRect.width) * 1000) / 1000,
      };
    };
    const band = (selector) => {
      const el = row.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        ...fraction(el),
        height: round(el.getBoundingClientRect().height),
        background: style.backgroundColor,
      };
    };
    const threshold = row.querySelector('.ea-threshold');
    return {
      mask: row.getAttribute('data-coalition-mask'),
      medianSeats: row.getAttribute('data-median-seats'),
      name: flat(row.querySelector('.ea-name__text')?.textContent),
      swatches: row.querySelectorAll('.ea-name__swatches .ev-swatch').length,
      probability: flat(row.querySelector('.ea-prob__value')?.textContent),
      probabilityWord: flat(row.querySelector('.ea-prob__word')?.textContent),
      label: flat(row.getAttribute('aria-label')),
      track: track ? boxOf(track) : null,
      band90: band('.ea-band--90'),
      band50: band('.ea-band--50'),
      median: fraction(row.querySelector('.ea-median-mark')),
      thresholdLeftStyle: threshold ? threshold.style.left : null,
      thresholdX: threshold
        ? round(threshold.getBoundingClientRect().left - track.getBoundingClientRect().left)
        : null,
      // A stacked party breakdown would show up as per-party marks inside the
      // bar.  There must be none: the bands are the coalition's own quantiles.
      partyMarks: row.querySelectorAll('.ea-track [data-party], .ea-track [style*="background"]').length,
      bands: row.querySelectorAll('.ea-band').length,
    };
  });

  return {
    sectionHidden: section ? section.hidden : null,
    sectionDisplay: section ? getComputedStyle(section).display : null,
    heading: flat(section?.querySelector('h2')?.textContent),
    rows,
    rowCount: rows.length,
    domainStart: host?.getAttribute('data-domain-start') ?? null,
    domainEnd: host?.getAttribute('data-domain-end') ?? null,
    axisTicks: Array.from(
      document.querySelectorAll('#election-alternatives-axis .ex-tick')
    ).map((tick) => ({
      label: flat(tick.querySelector('.ex-tick__label')?.textContent),
      emphasised: tick.classList.contains('ex-tick--emph'),
    })),
    axisUnit: flat(document.querySelector('#election-alternatives-axis .ea-axis__unit')?.textContent),
    axisTrack: (() => {
      const el = document.querySelector('#election-alternatives-axis .ea-axis__track');
      return el ? boxOf(el) : null;
    })(),
    legendKeys: Array.from(
      document.querySelectorAll('#election-alternatives .election-key')
    ).map((key) => flat(key.textContent)),
    overflow: doc.scrollWidth - doc.clientWidth,
  };
});

// --- Expectations loader ----------------------------------------------------

async function loadExpectations(generation) {
  const groups = JSON.parse(await readFile(
    join(SITE, 'files/election-simulator/versions', generation, 'groups.json'), 'utf8'));
  const table = groups.coalition_builder.coalitions;
  // Two decimals, the same convention the exact histogram prints.
  const swedish = (probability) =>
    `${(probability * 100).toFixed(2).replace('.', ',')}${NBSP}%`;
  return {
    of: (mask) => {
      const entry = table[String(mask)];
      return entry ? { ...entry, probability: swedish(entry.prob_majority) } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite: the six rows on one shared scale
// ---------------------------------------------------------------------------

async function testAlternatives(schema, viewport, pointer, expected) {
  console.log(`\n[schema ${schema}] ${viewport.name}`);
  const { server, browser } = await open(viewport, pointer);
  try {
    const view = await readSection(browser);

    eq('the section is visible', view.sectionHidden, false);
    check('the section is painted', view.sectionDisplay !== 'none', view.sectionDisplay);
    eq('the heading is Regeringsalternativ', view.heading, 'Regeringsalternativ');
    eq('there are exactly six rows', view.rowCount, ALTERNATIVES.length);

    // --- The rows are the six named coalitions, looked up by mask ----------
    eq('row masks are derived from party_order', view.rows.map((r) => r.mask),
      ALTERNATIVES.map((parties) => String(maskFor(parties))));
    eq('row names', view.rows.map((r) => r.name),
      ALTERNATIVES.map((parties) => parties.join(' + ')));
    eq('each row carries one swatch per party', view.rows.map((r) => r.swatches),
      ALTERNATIVES.map((parties) => parties.length));
    eq('every row prints the word majoritet',
      view.rows.map((r) => r.probabilityWord),
      ALTERNATIVES.map(() => 'majoritet'));

    // --- Every printed value is the published coalition lookup -------------
    const wanted = ALTERNATIVES.map((parties) => expected.of(maskFor(parties)));
    eq('row medians come from the coalition lookup',
      view.rows.map((r) => r.medianSeats), wanted.map((e) => String(e.median_seats)));
    eq('row probabilities come from the coalition lookup',
      view.rows.map((r) => r.probability), wanted.map((e) => e.probability));
    view.rows.forEach((row, index) => {
      const entry = wanted[index];
      const name = ALTERNATIVES[index].join(' + ');
      check(`${name}: the label states the published 50 % interval`,
        row.label.includes(`${entry.p25_seats}–${entry.p75_seats}`), row.label);
      check(`${name}: the label states the published 90 % interval`,
        row.label.includes(`${entry.p05_seats}–${entry.p95_seats}`), row.label);
      check(`${name}: the label states the published majority probability`,
        row.label.includes(entry.probability), row.label);
    });

    // --- One shared x-axis --------------------------------------------------
    const trackBoxes = view.rows.map((r) => `${r.track.left}x${r.track.width}`);
    eq('all six tracks are the same box', new Set(trackBoxes).size, 1);
    eq('all six threshold rules use the same offset',
      new Set(view.rows.map((r) => r.thresholdLeftStyle)).size, 1);
    check('the 175 rule lands on the same pixel in every row',
      new Set(view.rows.map((r) => r.thresholdX)).size === 1,
      view.rows.map((r) => r.thresholdX));

    // --- The domain covers all six intervals, and always 175 ---------------
    const domainStart = Number(view.domainStart);
    const domainEnd = Number(view.domainEnd);
    const lowest = Math.min(...wanted.map((e) => e.p05_seats));
    const highest = Math.max(...wanted.map((e) => e.p95_seats));
    check('the domain contains every published 90 % interval',
      domainStart <= lowest && domainEnd >= highest,
      { domainStart, domainEnd, lowest, highest });
    check('the domain always includes 175',
      domainStart <= MAJORITY && domainEnd >= MAJORITY, { domainStart, domainEnd });
    check('the domain is padded below the data', domainStart < lowest,
      { domainStart, lowest });
    check('the domain is padded above the data', domainEnd > highest,
      { domainEnd, highest });
    check('the domain snaps to whole five-seat marks',
      domainStart % 5 === 0 && domainEnd % 5 === 0, { domainStart, domainEnd });

    // Every mark sits where that seat value falls on the shared domain.
    const at = (seats) => (seats - domainStart) / (domainEnd - domainStart);
    view.rows.forEach((row, index) => {
      const entry = wanted[index];
      const name = ALTERNATIVES[index].join(' + ');
      const near = (actual, want, tolerance = 0.01) => Math.abs(actual - want) <= tolerance;
      check(`${name}: the 90 % band starts at p05 on the shared scale`,
        near(row.band90.start, at(entry.p05_seats)),
        { got: row.band90.start, want: at(entry.p05_seats) });
      check(`${name}: the 90 % band ends at p95 on the shared scale`,
        near(row.band90.end, at(entry.p95_seats)),
        { got: row.band90.end, want: at(entry.p95_seats) });
      check(`${name}: the 50 % band starts at p25 on the shared scale`,
        near(row.band50.start, at(entry.p25_seats)),
        { got: row.band50.start, want: at(entry.p25_seats) });
      check(`${name}: the 50 % band ends at p75 on the shared scale`,
        near(row.band50.end, at(entry.p75_seats)),
        { got: row.band50.end, want: at(entry.p75_seats) });
      check(`${name}: the median marker sits at median_seats`,
        near(row.median.start, at(entry.median_seats), 0.02),
        { got: row.median.start, want: at(entry.median_seats) });
      check(`${name}: the 175 rule sits at 175 on the shared scale`,
        near(row.thresholdX / row.track.width, at(MAJORITY)),
        { got: row.thresholdX / row.track.width, want: at(MAJORITY) });
    });

    // --- Band weights, and no stacked party segments -----------------------
    view.rows.forEach((row, index) => {
      const name = ALTERNATIVES[index].join(' + ');
      check(`${name}: the 50 % band is thicker than the 90 % band`,
        row.band50.height > row.band90.height,
        { p50: row.band50.height, p90: row.band90.height });
      check(`${name}: exactly two interval bands are drawn`, row.bands === 2, row.bands);
      eq(`${name}: no party-coloured segments are stacked in the bar`, row.partyMarks, 0);
    });
    eq('all six rows use the same neutral 90 % ink',
      new Set(view.rows.map((r) => r.band90.background)).size, 1);
    eq('all six rows use the same neutral 50 % ink',
      new Set(view.rows.map((r) => r.band50.background)).size, 1);
    check('the 50 % ink is darker than the 90 % ink',
      view.rows[0].band50.background !== view.rows[0].band90.background,
      [view.rows[0].band50.background, view.rows[0].band90.background]);

    // --- The shared axis and the legend -------------------------------------
    const emphasised = view.axisTicks.filter((tick) => tick.emphasised);
    eq('the axis has exactly one emphasised tick', emphasised.length, 1);
    eq('the emphasised tick is the majority rule', emphasised[0]?.label, String(MAJORITY));
    check('the axis carries plain seat ticks as well',
      view.axisTicks.length >= 3, view.axisTicks);
    eq('the axis names its unit', view.axisUnit, 'mandat');
    check('every axis tick is inside the domain',
      view.axisTicks.every((tick) => Number(tick.label) >= domainStart &&
        Number(tick.label) <= domainEnd), view.axisTicks);
    eq('the legend explains median, 50 %, 90 % and the 175 rule',
      view.legendKeys, [
        'median',
        '50 % prognosintervall',
        '90 % prognosintervall',
        '175 mandat = majoritet',
      ]);

    eq('no horizontal overflow', view.overflow, 0);
    eq('no console errors', appErrors(browser), []);
    eq('no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Suite: schema 1.1 fail-closed
// ---------------------------------------------------------------------------

async function testSchema11FailClosed(pointer) {
  console.log('\n[schema 1.1 fail-closed] desktop');
  const { server, browser } = await open(VIEWPORTS[0], pointer);
  try {
    const view = await readSection(browser);
    check('the section stays hidden without a coalition_builder',
      view.sectionHidden === true || view.sectionDisplay === 'none',
      { hidden: view.sectionHidden, display: view.sectionDisplay });
    eq('no rows are drawn under schema 1.1', view.rowCount, 0);
    eq('no console errors under schema 1.1', appErrors(browser), []);
    eq('no uncaught exceptions under schema 1.1', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

const pointer11 = await pointerFor(SITE, GENERATION_1_1);
const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer13 = await pointerFor(SITE, GENERATION_1_3);

if (pointer11.schema_version !== '1.1') throw new Error('pointer11 is not schema 1.1');
if (pointer12.schema_version !== '1.2') throw new Error('pointer12 is not schema 1.2');
if (pointer13.schema_version !== '1.3') throw new Error('pointer13 is not schema 1.3');

const expected12 = await loadExpectations(GENERATION_1_2);
const expected13 = await loadExpectations(GENERATION_1_3);

for (const viewport of VIEWPORTS) {
  await testAlternatives('1.3', viewport, pointer13, expected13);
}
// The section needs only the summaries, so a 1.2 publication still renders it.
await testAlternatives('1.2', VIEWPORTS[0], pointer12, expected12);

await testSchema11FailClosed(pointer11);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\nFAIL (${failures})`);
  process.exit(1);
}
console.log('\nPASS');
