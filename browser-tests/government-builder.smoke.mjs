// Real-browser smoke test for the "Bygg din egen regering" coalition builder.
//
// Exercises the panel in a real DOM with the real stylesheet applied across
// published schemas 1.1, 1.2, and 1.3.
//
// The panel interaction:
//   - Colored .eg-bar__segment mandate blocks are draggable.
//   - The government and opposition bars are the drop targets.
//   - No separate white party-card lists.
//   - Mouse and touch drags move blocks across bars.
//   - L (0 median seats) is drawn as a zero-height draggable baseline marker.
//   - The two sides always partition the 8 parties:
//       government & opposition === 0
//       government | opposition === 255
//   - Summary and histogram reflect the published coalition lookup.
//   - The six preset buttons set the government to exactly their combination,
//     show an is-active / aria-pressed state only while it is exactly that,
//     and leave the drag interaction working afterwards.
//   - The histogram carries the four published summaries for the same entry.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/government-builder.smoke.mjs [path/to/_site]

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
const FULL_MASK = (1 << PARTY_ORDER.length) - 1; // 255
const SEATING = ['V', 'S', 'MP', 'C', 'L', 'KD', 'M', 'SD'];
const CHAMBER = 349;
const MAJORITY = 175;
const NBSP = '\u00a0';

// The six presets, named the way the page names them.  Masks are derived from
// PARTY_ORDER here too, so the test and the page agree only if both resolve
// the same names against the same published order.
const PRESETS = [
  ['S', 'V', 'MP'],
  ['S', 'C', 'MP'],
  ['S', 'C', 'MP', 'V'],
  ['S', 'KD', 'C', 'MP'],
  ['SD', 'L', 'M', 'KD'],
  ['S', 'M', 'C'],
];
const maskFor = (parties) => parties.reduce((mask, party) => mask | BIT[party], 0);

const GOVERNMENT = ['C', 'S', 'MP'];
const GOVERNMENT_MASK = BIT.C | BIT.S | BIT.MP;      // 84
const OPPOSITION_MASK = FULL_MASK ^ GOVERNMENT_MASK; // 171
const MAJORITY_MASK = GOVERNMENT_MASK | BIT.V;       // 116

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

function partitions(label, government, opposition) {
  const g = Number(government);
  const o = Number(opposition);
  check(`${label}: the two sides are disjoint`, Number.isInteger(g) && Number.isInteger(o) && (g & o) === 0,
    `government ${government} & opposition ${opposition} = ${g & o}`);
  check(`${label}: the two sides cover all eight parties`, (g | o) === FULL_MASK,
    `government ${government} | opposition ${opposition} = ${g | o}, want ${FULL_MASK}`);
}

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

const settle = (ms = 160) => new Promise((r) => setTimeout(r, ms));

async function open(viewport, pointer, { coarse = false } = {}) {
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  if (coarse) {
    await browser.S('Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 });
  }
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

// --- DOM reader -------------------------------------------------------------

const readPanel = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      hiddenAttr: el.hidden,
      display: style.display,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
    };
  };
  const byId = (id) => {
    const el = document.getElementById(id);
    return el ? box(el) : null;
  };
  const segments = (barId) => Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).map((el) => {
    const style = getComputedStyle(el);
    return {
      party: el.getAttribute('data-party'),
      side: el.getAttribute('data-side'),
      zero: el.classList.contains('eg-bar__segment--zero'),
      height: Math.round(el.getBoundingClientRect().height * 100) / 100,
      label: flat(el.getAttribute('aria-label') || el.textContent),
      cursor: style.cursor,
      touchAction: style.touchAction,
    };
  });
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? flat(el.textContent) : null;
  };

  const summary = document.getElementById('election-government-results');
  const metrics = {};
  if (summary) {
    Array.from(summary.querySelectorAll('div[data-metric]')).forEach((row) => {
      metrics[row.getAttribute('data-metric')] = {
        term: flat(row.querySelector('dt')?.textContent),
        value: flat(row.querySelector('dd')?.textContent),
      };
    });
  }

  const majority = document.querySelector('.eg-chart__majority');
  const plot = document.querySelector('.eg-chart__plot');
  const majorityRect = majority ? majority.getBoundingClientRect() : null;
  const plotRect = plot ? plot.getBoundingClientRect() : null;

  const stackHeight = (barId) => Math.round(Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) * 100) / 100;

  const doc = document.documentElement;
  const histEl = document.getElementById('election-government-histogram');
  const histLink = document.querySelector('.eg-summary__histogram-link');

  const presets = Array.from(document.querySelectorAll('#election-builder-presets .eg-preset'))
    .map((el) => ({
      label: flat(el.querySelector('.eg-preset__label')?.textContent),
      mask: el.getAttribute('data-coalition-mask'),
      pressed: el.getAttribute('aria-pressed'),
      active: el.classList.contains('is-active'),
      tag: el.tagName,
      type: el.getAttribute('type'),
      swatches: el.querySelectorAll('.eg-preset__swatch').length,
    }));

  const statsEl = document.getElementById('election-government-histogram-stats');
  const stats = {};
  if (statsEl) {
    Array.from(statsEl.querySelectorAll('div[data-metric]')).forEach((row) => {
      stats[row.getAttribute('data-metric')] = {
        term: flat(row.querySelector('dt')?.textContent),
        value: flat(row.querySelector('dd')?.textContent),
      };
    });
  }

  return {
    // Obsolete white party-card containers must not exist.
    legacyCards: document.querySelectorAll('.eg-party, .eg-zone, .eg-chart__row--zones').length,
    legacyIds: ['election-government-parties', 'election-opposition-parties']
      .filter((id) => document.getElementById(id) !== null),

    section: byId('election-government-builder'),
    summaryBox: summary ? box(summary) : null,
    reset: byId('election-builder-reset'),
    resetLabel: text('election-builder-reset'),

    governmentSegments: segments('election-government-bar'),
    oppositionSegments: segments('election-opposition-bar'),
    governmentBarLabel: document.getElementById('election-government-bar')?.getAttribute('aria-label'),
    oppositionBarLabel: document.getElementById('election-opposition-bar')?.getAttribute('aria-label'),
    governmentTotal: text('election-government-total'),
    oppositionTotal: text('election-opposition-total'),
    governmentStack: stackHeight('election-government-bar'),
    oppositionStack: stackHeight('election-opposition-bar'),

    governmentMask: summary?.getAttribute('data-government-mask'),
    oppositionMask: summary?.getAttribute('data-opposition-mask'),
    coalitionMask: summary?.getAttribute('data-coalition-mask'),
    columnGovMask: document.getElementById('election-government-column')?.getAttribute('data-coalition-mask'),
    columnOppMask: document.getElementById('election-opposition-column')?.getAttribute('data-coalition-mask'),

    metrics,
    majority: majority && plot ? {
      label: flat(majority.textContent),
      visible: getComputedStyle(majority).display !== 'none',
      borderStyle: getComputedStyle(majority).borderTopStyle,
      fromBottom: Math.round((plotRect.bottom - majorityRect.top) * 100) / 100,
      plotHeight: Math.round(plotRect.height * 100) / 100,
      spansPlot: Math.abs(majorityRect.left - plotRect.left) < 1 &&
        Math.abs(majorityRect.right - plotRect.right) < 1,
    } : null,

    histogram: histEl ? {
      hiddenAttr: histEl.hidden,
      display: getComputedStyle(histEl).display,
      mask: histEl.getAttribute('data-coalition-mask'),
      bars: histEl.querySelectorAll('#election-government-histogram-svg rect').length,
    } : null,
    histogramLinkHref: histLink ? histLink.getAttribute('href') : null,

    presets,
    stats,
    statsBox: statsEl ? box(statsEl) : null,
    // The rows are a grid only when this page's own stylesheet is in effect,
    // so this doubles as proof the run is not asserting layout against a
    // stylesheet served by some other process on the same port.
    statsColumns: statsEl ? getComputedStyle(statsEl).gridTemplateColumns : null,

    // The section order the page is meant to read in.
    sectionOrder: Array.from(document.querySelectorAll('.election-app > section'))
      .filter((el) => el.id).map((el) => el.id),
    // The removed Majoritetsscenarier feature must leave nothing behind.
    legacyGroups: ['election-groups', 'election-group-pills', 'election-group-result',
      'election-group-histogram'].filter((id) => document.getElementById(id) !== null),

    overflow: doc.scrollWidth - doc.clientWidth,
  };
});

// --- Real input -------------------------------------------------------------

const dragPoints = (browser, party, barId) => browser.evaluate(([name, target]) => {
  const block = document.querySelector(`.eg-bar__segment[data-party="${name}"]`);
  const bar = document.getElementById(target);
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

async function focusPanel(browser) {
  await browser.evaluate(() => {
    document.getElementById('election-government-builder')
      ?.scrollIntoView({ block: 'center' });
  });
  await settle();
}

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

// --- Expectations loader ----------------------------------------------------

async function loadExpectations(generation) {
  const groups = JSON.parse(await readFile(
    join(SITE, 'files/election-simulator/versions', generation, 'groups.json'), 'utf8'));
  const table = groups.coalition_builder.coalitions;

  const swedish = (probability) => {
    if (probability === 0) return `0,0${NBSP}%`;
    if (probability === 1) return `100,0${NBSP}%`;
    const pct = probability * 100;
    if (pct < 0.005) return `<0,01${NBSP}%`;
    if (pct > 99.995) return `>99,99${NBSP}%`;
    const digits = pct < 1 || pct > 99 ? 2 : 1;
    return `${pct.toFixed(digits).replace('.', ',')}${NBSP}%`;
  };

  const of = (mask) => {
    const entry = table[String(mask)];
    if (!entry) return null;
    return {
      median: entry.median_seats,
      p05: entry.p05_seats,
      p95: entry.p95_seats,
      prob: entry.prob_majority,
      probability: swedish(entry.prob_majority),
      intervalText: `${entry.p05_seats}–${entry.p95_seats} mandat`,
      medianText: `${entry.median_seats} mandat`,
      // The four summaries the histogram view prints beside the chart.
      stats: {
        median: String(entry.median_seats),
        p50: `${entry.p25_seats}–${entry.p75_seats}`,
        p80: `${entry.p10_seats}–${entry.p90_seats}`,
        p90: `${entry.p05_seats}–${entry.p95_seats}`,
      },
    };
  };

  return {
    of,
    government: of(GOVERNMENT_MASK),
    opposition: of(OPPOSITION_MASK),
    majority: of(MAJORITY_MASK),
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Schema 1.2 compatibility
// ---------------------------------------------------------------------------

async function testSchema12(viewport, pointer, expected) {
  console.log(`\n[schema 1.2] ${viewport.name}`);
  const { server, browser } = await open(viewport, pointer);
  try {
    let panel = await readPanel(browser);

    eq('no legacy .eg-party cards in DOM', panel.legacyCards, 0);
    eq('no legacy card-list containers in DOM', panel.legacyIds, []);
    eq('the removed Majoritetsscenarier nodes are gone', panel.legacyGroups, []);

    // Röstandelar -> Bygg din egen regering -> Mandat -> Regeringsalternativ.
    eq('page section order', panel.sectionOrder, [
      'election-headline',
      'election-government-builder',
      'election-seats',
      'election-alternatives',
      'election-changes',
      'election-how-it-works',
      'election-validation',
      'election-meta',
    ]);

    // --- Preset governments -------------------------------------------------
    eq('there are exactly six presets', panel.presets.length, PRESETS.length);
    eq('preset labels', panel.presets.map((p) => p.label),
      PRESETS.map((parties) => parties.join(' + ')));
    eq('preset masks are derived from party_order', panel.presets.map((p) => p.mask),
      PRESETS.map((parties) => String(maskFor(parties))));
    eq('presets are native buttons', panel.presets.map((p) => `${p.tag}:${p.type}`),
      PRESETS.map(() => 'BUTTON:button'));
    eq('each preset carries one swatch per party', panel.presets.map((p) => p.swatches),
      PRESETS.map((parties) => parties.length));
    eq('no preset is pressed while the government is empty',
      panel.presets.map((p) => p.pressed), PRESETS.map(() => 'false'));

    for (let index = 0; index < PRESETS.length; index += 1) {
      const parties = PRESETS[index];
      const wanted = maskFor(parties);
      await browser.evaluate((i) => {
        document.querySelectorAll('#election-builder-presets .eg-preset')[i].click();
      }, index);
      await settle();
      panel = await readPanel(browser);
      const name = parties.join(' + ');
      eq(`preset ${name} sets exactly that government`, panel.governmentMask, String(wanted));
      eq(`preset ${name} leaves the complement in opposition`,
        panel.oppositionMask, String(FULL_MASK ^ wanted));
      partitions(`preset ${name}`, panel.governmentMask, panel.oppositionMask);
      eq(`preset ${name} puts exactly those blocks in the government bar`,
        panel.governmentSegments.map((s) => s.party).sort(), parties.slice().sort());
      eq(`preset ${name} is the only pressed preset`,
        panel.presets.map((p) => p.pressed),
        PRESETS.map((_, i) => (i === index ? 'true' : 'false')));
      eq(`preset ${name} is the only active preset`,
        panel.presets.filter((p) => p.active).map((p) => p.label), [name]);
      eq(`preset ${name} median matches the published lookup`,
        panel.metrics.government?.value, expected.of(wanted).medianText);
      eq(`preset ${name} probability matches the published lookup`,
        panel.metrics.probability?.value, expected.of(wanted).probability);
    }

    // Dragging away from a preset clears its active state, and the manual
    // drag interaction still works after a preset has been used.
    const lastPreset = PRESETS[PRESETS.length - 1];          // S + M + C
    check('drag M out of the preset government',
      await mouseDrag(browser, 'M', 'election-opposition-bar'));
    panel = await readPanel(browser);
    eq('dragging away leaves the preset mask behind',
      panel.governmentMask, String(maskFor(lastPreset) & ~BIT.M));
    eq('dragging away clears every active preset',
      panel.presets.filter((p) => p.active).map((p) => p.label), []);
    eq('dragging away clears every pressed preset',
      panel.presets.map((p) => p.pressed), PRESETS.map(() => 'false'));
    check('drag M back in after a preset',
      await mouseDrag(browser, 'M', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('dragging back re-activates the preset',
      panel.presets.filter((p) => p.active).map((p) => p.label), [lastPreset.join(' + ')]);

    // Återställ still empties the government, and no preset survives it.
    await browser.click('#election-builder-reset');
    await settle();
    panel = await readPanel(browser);
    eq('reset empties the government after a preset', panel.governmentSegments, []);
    eq('reset clears every pressed preset',
      panel.presets.map((p) => p.pressed), PRESETS.map(() => 'false'));

    // Initial state: Government 0, Opposition 255
    eq('government bar starts empty', panel.governmentSegments, []);
    eq('opposition bar has all 8 parties',
      panel.oppositionSegments.map((s) => s.party).sort(),
      PARTY_ORDER.slice().sort());
    partitions('initial', panel.columnGovMask || 0, panel.columnOppMask || 255);
    eq('opposition total is 349', panel.oppositionTotal, '349');
    eq('summary is hidden initially', panel.summaryBox.hiddenAttr, true);
    eq('summary display is none', panel.summaryBox.display, 'none');

    // Mandate block attributes
    const sBlock = panel.oppositionSegments.find((s) => s.party === 'S');
    check('blocks offer a grab cursor', sBlock?.cursor === 'grab', sBlock?.cursor);
    check('blocks have touchAction pan-y', sBlock?.touchAction === 'pan-y', sBlock?.touchAction);
    const lBlock = panel.oppositionSegments.find((s) => s.party === 'L');
    check('L is drawn as a zero-seat marker', lBlock?.zero === true, lBlock);

    // 349-seat scale and 175 majority rule
    check('majority line is visible', panel.majority?.visible, panel.majority);
    check('majority line is dashed', panel.majority?.borderStyle === 'dashed', panel.majority?.borderStyle);
    check('majority line label', panel.majority?.label?.includes('Majoritetsgräns: 175 mandat'), panel.majority?.label);
    const majorityFraction = panel.majority ? panel.majority.fromBottom / panel.majority.plotHeight : 0;
    check('majority line placed at 175/349 of plot',
      Math.abs(majorityFraction - (MAJORITY / CHAMBER)) < 0.02,
      { majorityFraction, target: MAJORITY / CHAMBER });

    // Drag C, S, MP into government (mask 84)
    for (const p of GOVERNMENT) {
      check(`drag ${p} to Regering`, await mouseDrag(browser, p, 'election-government-bar'));
    }
    panel = await readPanel(browser);

    eq('government has C, S, MP', panel.governmentSegments.map((s) => s.party).sort(), ['C', 'MP', 'S']);
    eq('opposition has complement', panel.oppositionSegments.map((s) => s.party).sort(), ['KD', 'L', 'M', 'SD', 'V']);
    partitions('C+S+MP', panel.governmentMask, panel.oppositionMask);
    eq('government mask is 84', panel.governmentMask, String(GOVERNMENT_MASK));
    eq('opposition mask is 171', panel.oppositionMask, String(OPPOSITION_MASK));

    // Published numbers check
    eq('summary is visible', panel.summaryBox.visible, true);
    eq('government median matches published', panel.metrics.government?.value, expected.government.medianText);
    eq('90% interval matches published', panel.metrics.interval?.value, expected.government.intervalText);
    eq('majority probability matches published', panel.metrics.probability?.value, expected.government.probability);
    eq('government total text', panel.governmentTotal, String(expected.government.median));

    // Under schema 1.2, histogram is not present
    eq('schema 1.2 has no histogram link', panel.histogramLinkHref, null);
    if (panel.histogram) {
      eq('schema 1.2 histogram is hidden', panel.histogram.hiddenAttr, true);
    }

    // Add V to cross majority threshold (mask 116, median 190)
    check('drag V to Regering', await mouseDrag(browser, 'V', 'election-government-bar'));
    panel = await readPanel(browser);
    eq('government mask is 116', panel.governmentMask, String(MAJORITY_MASK));
    eq('majority government median matches published (190)',
      panel.metrics.government?.value, expected.majority.medianText);
    eq('majority government probability (97,42 %)',
      panel.metrics.probability?.value, expected.majority.probability);
    check('government bar stands above majority line',
      Number(panel.governmentTotal) >= MAJORITY, panel.governmentTotal);

    // Drag V back to opposition
    check('drag V back to Opposition', await mouseDrag(browser, 'V', 'election-opposition-bar'));
    panel = await readPanel(browser);
    eq('government mask restored to 84', panel.governmentMask, String(GOVERNMENT_MASK));

    // Reset (Återställ)
    await browser.click('#election-builder-reset');
    await settle();
    panel = await readPanel(browser);
    eq('reset empties government bar', panel.governmentSegments, []);
    eq('reset restores all 8 parties to opposition',
      panel.oppositionSegments.map((s) => s.party).sort(),
      PARTY_ORDER.slice().sort());
    eq('reset hides summary', panel.summaryBox.hiddenAttr, true);

    eq('no horizontal overflow', panel.overflow, 0);
    eq('no console errors', appErrors(browser), []);
    eq('no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Suite 2: Schema 1.3 histogram rendering & discoverability
// ---------------------------------------------------------------------------

async function testSchema13(viewport, pointer, expected13) {
  console.log(`\n[schema 1.3] ${viewport.name}`);
  const { server, browser } = await open(viewport, pointer);
  try {
    let panel = await readPanel(browser);

    eq('schema 1.3 starts with hidden histogram', panel.histogram?.hiddenAttr, true);
    eq('schema 1.3 has no histogram link initially', panel.histogramLinkHref, null);
    eq('the statistics grid starts hidden', panel.statsBox?.hiddenAttr, true);

    // Drag S, V, MP into government (mask 112: S+V+MP)
    for (const p of ['S', 'V', 'MP']) {
      check(`drag ${p} to Regering`, await mouseDrag(browser, p, 'election-government-bar'));
    }
    panel = await readPanel(browser);
    const mask112 = BIT.S | BIT.V | BIT.MP; // 112
    eq('government mask is 112', panel.governmentMask, String(mask112));

    const exp112 = expected13.of(mask112);
    if (exp112) {
      eq('S+V+MP median matches published', panel.metrics.government?.value, exp112.medianText);
      eq('S+V+MP probability matches published', panel.metrics.probability?.value, exp112.probability);
    }

    // The four published summaries printed beside the chart, for the same
    // entry the chart was drawn from.  The prominent Majoritet result stays.
    eq('the statistics grid is visible with a government', panel.statsBox?.visible, true);
    eq('statistics labels', {
      median: panel.stats.median?.term,
      p50: panel.stats.p50?.term,
      p80: panel.stats.p80?.term,
      p90: panel.stats.p90?.term,
    }, {
      median: 'Medianmandat',
      p50: `50${NBSP}% prognosintervall`,
      p80: `80${NBSP}% prognosintervall`,
      p90: `90${NBSP}% prognosintervall`,
    });
    eq('median statistic is median_seats', panel.stats.median?.value, exp112.stats.median);
    eq('50 % statistic is p25–p75', panel.stats.p50?.value, exp112.stats.p50);
    eq('80 % statistic is p10–p90', panel.stats.p80?.value, exp112.stats.p80);
    eq('90 % statistic is p05–p95', panel.stats.p90?.value, exp112.stats.p90);
    check('the prominent Majoritet result is still shown',
      Boolean(panel.histogram) && panel.histogram.hiddenAttr === false, panel.histogram);

    // Discoverability link and histogram visibility
    eq('summary includes link to histogram', panel.histogramLinkHref, '#election-government-histogram');
    eq('histogram is visible with government', panel.histogram?.hiddenAttr, false);
    eq('histogram mask follows government', panel.histogram?.mask, String(mask112));
    check('histogram has rendered seat bars', (panel.histogram?.bars || 0) > 0, panel.histogram?.bars);

    // Reset clears histogram
    await browser.click('#election-builder-reset');
    await settle();
    panel = await readPanel(browser);
    eq('reset hides histogram in schema 1.3', panel.histogram?.hiddenAttr, true);
    eq('reset hides the statistics grid', panel.statsBox?.hiddenAttr, true);
    eq('reset empties the statistics grid', panel.stats, {});

    eq('schema 1.3 no horizontal overflow', panel.overflow, 0);
    eq('schema 1.3 no console errors', appErrors(browser), []);
    eq('schema 1.3 no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Suite 3: Schema 1.1 fail-closed behavior
// ---------------------------------------------------------------------------

async function testSchema11FailClosed(pointer) {
  console.log('\n[schema 1.1 fail-closed] desktop');
  const { server, browser } = await open(VIEWPORTS[0], pointer);
  try {
    const panel = await readPanel(browser);
    check('builder section is hidden under schema 1.1',
      panel.section?.hiddenAttr === true || panel.section?.display === 'none',
      panel.section);
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

const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer13 = await pointerFor(SITE, GENERATION_1_3);
const pointer11 = await pointerFor(SITE, GENERATION_1_1);

if (pointer12.schema_version !== '1.2') throw new Error('pointer12 is not schema 1.2');
if (pointer13.schema_version !== '1.3') throw new Error('pointer13 is not schema 1.3');
if (pointer11.schema_version !== '1.1') throw new Error('pointer11 is not schema 1.1');

const expected12 = await loadExpectations(GENERATION_1_2);
const expected13 = await loadExpectations(GENERATION_1_3);

for (const viewport of VIEWPORTS) {
  await testSchema12(viewport, pointer12, expected12);
}

for (const viewport of VIEWPORTS) {
  await testSchema13(viewport, pointer13, expected13);
}

await testSchema11FailClosed(pointer11);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\nFAIL (${failures})`);
  process.exit(1);
}
console.log('\nPASS');
