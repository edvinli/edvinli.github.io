// Real-browser smoke test for the "Bygg din egen regering" coalition builder.
//
// This is the only coverage in either repository that exercises the panel in a
// real DOM with the real stylesheet applied. The Node contract tests in the
// election-simulator repository (tests.test_actual_browser_consumer and its
// neighbours) run the module against stub DOM objects: they verify the
// data/lookup contract only, and cannot observe computed style, layout or the
// `hidden` attribute actually taking effect. A regression that leaves a panel
// visible-but-empty, a bar drawn off its scale, or a 360px column overflowing
// the page passes those tests and fails this one.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/government-builder.smoke.mjs [path/to/_site]
//
// Dependencies: Node >= 22 (built-in WebSocket) and a local Chrome/Chromium.
// Override the binary with CHROME_BIN. Nothing is installed.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';

// The schema-1.2 publication that introduced the coalition builder, and the
// schema-1.1 publication that predates it. Both are committed under
// files/election-simulator/versions/.
const GENERATION_1_2 = '20260828T064703Z-1da59168';
const GENERATION_1_1 = '20260827T205828Z-e6c6ee97';

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const CHAMBER = 349;
const MAJORITY = 175;
// M | KD | SD, then that union with L as a support party.
const GOVERNMENT_MASK = 1 | 8 | 128;
const SUPPORT_MASK = 2;
const UNION_MASK = GOVERNMENT_MASK | SUPPORT_MASK;
// The regression case for the whole point of the cumulative bar: S + V govern
// with 138 seats, well short of 175, but with MP + C supporting them the union
// median is 190. Two independent bars would both sit below the rule.
const CROSSING_GOVERNMENT = ['S', 'V'];
const CROSSING_SUPPORT = ['MP', 'C'];
const CROSSING_GOVERNMENT_MASK = 16 | 32;
const CROSSING_SUPPORT_MASK = 64 | 4;
const CROSSING_UNION_MASK = CROSSING_GOVERNMENT_MASK | CROSSING_SUPPORT_MASK;
// Minimum interactive target for a party action, in CSS pixels.
const MIN_TARGET = 40;

const POOL = 'election-available-parties';
const GOVERNMENT = 'election-government-parties';
const SUPPORT = 'election-support-parties';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1400 },
  { name: 'narrow-360', width: 360, height: 900 },
];

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || detail === undefined ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tolerance) =>
  check(name, Math.abs(actual - expected) <= tolerance,
    `expected ${expected} +/- ${tolerance}, got ${actual}`);

/** Ignore asset noise that comes from serving a dev build, not from the app. */
const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  // Let the synchronous render pass following the load settle.
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------------------
// Page readers. Every one of these runs inside the real page.
// ---------------------------------------------------------------------------

const readPanel = (browser) => browser.evaluate(() => {
  // The page uses NBSP deliberately (Swedish typography puts one before %),
  // so collapse ordinary whitespace only -- /\s+/ would erase the difference.
  const flat = (value) => value.replace(/[\t\n\r ]+/g, ' ').trim();
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
  const tiles = (hostId) => Array.from(
    document.querySelectorAll(`#${hostId} .eg-party`)
  ).map((el) => Object.assign({
    party: el.getAttribute('data-party'),
    zone: el.getAttribute('data-zone'),
    draggable: el.getAttribute('draggable'),
    actions: Array.from(el.querySelectorAll('.eg-party__btn')).map((b) => b.getAttribute('data-action')),
  }, box(el)));
  const segments = (barId) => Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).map((el) => ({
    party: el.getAttribute('data-party'),
    height: Math.round(el.getBoundingClientRect().height * 100) / 100,
    label: el.textContent.trim(),
    support: el.classList.contains('eg-bar__segment--support'),
  }));
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? flat(el.textContent) : null;
  };
  const summary = document.getElementById('election-government-results');
  const coalitionHistogram = document.getElementById('election-government-histogram');
  const metrics = {};
  Array.from(summary.querySelectorAll('div[data-metric]')).forEach((row) => {
    metrics[row.getAttribute('data-metric')] = {
      term: flat(row.querySelector('dt').textContent),
      value: flat(row.querySelector('dd').textContent),
    };
  });

  const majority = document.querySelector('.eg-chart__majority');
  const plot = document.querySelector('.eg-chart__plot');
  const majorityRect = majority.getBoundingClientRect();
  const plotRect = plot.getBoundingClientRect();

  const stackHeight = (barId) => Math.round(Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) * 100) / 100;

  return {
    section: byId('election-government-builder'),
    empty: byId('election-government-empty'),
    summaryBox: byId('election-government-results'),
    histogram: coalitionHistogram ? Object.assign(box(coalitionHistogram), {
      mask: coalitionHistogram.getAttribute('data-coalition-mask'),
      total: coalitionHistogram.getAttribute('data-total-count'),
      bins: document.querySelectorAll('#election-government-histogram .egh-bin').length,
    }) : null,
    note: byId('election-government-note'),
    poolEmpty: byId('election-pool-empty'),
    pool: tiles('election-available-parties'),
    government: tiles('election-government-parties'),
    support: tiles('election-support-parties'),
    poolHost: byId('election-available-parties'),
    governmentBar: byId('election-government-bar'),
    unionBar: byId('election-union-bar'),
    governmentSegments: segments('election-government-bar'),
    unionSegments: segments('election-union-bar'),
    governmentBarLabel: document.getElementById('election-government-bar').getAttribute('aria-label'),
    unionBarLabel: document.getElementById('election-union-bar').getAttribute('aria-label'),
    governmentTotal: text('election-government-total'),
    unionTotal: text('election-union-total'),
    governmentStack: stackHeight('election-government-bar'),
    unionStack: stackHeight('election-union-bar'),
    poolTitle: text('election-pool-title'),
    governmentTitle: text('election-government-title'),
    unionTitle: text('election-union-title'),
    governmentZoneTitle: text('election-government-zone-title'),
    supportZoneTitle: text('election-support-zone-title'),
    // Smallest interactive party control anywhere in the panel.
    smallestAction: Math.min.apply(null, Array.from(
      document.querySelectorAll('.eg-party__btn')
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return Math.round(Math.min(rect.width, rect.height) * 100) / 100;
    })),
    shortestAction: Math.min.apply(null, Array.from(
      document.querySelectorAll('.eg-party__btn')
    ).map((el) => Math.round(el.getBoundingClientRect().height * 100) / 100)),
    intro: flat(document.querySelector('#election-government-builder .election-panel__head p').textContent),
    disclaimer: flat(document.querySelector('.eg-builder__disclaimer').textContent),
    hints: Array.from(document.querySelectorAll('.eg-zone__hint')).map((el) => el.textContent.trim()),
    masks: {
      government: document.getElementById('election-government-column').getAttribute('data-coalition-mask'),
      union: document.getElementById('election-union-column').getAttribute('data-coalition-mask'),
      summaryGovernment: summary.getAttribute('data-government-mask'),
      summarySupport: summary.getAttribute('data-support-mask'),
      summaryUnion: summary.getAttribute('data-coalition-mask'),
    },
    metrics,
    majority: {
      label: flat(majority.textContent),
      visible: getComputedStyle(majority).display !== 'none',
      borderStyle: getComputedStyle(majority).borderTopStyle,
      // Distance of the rule from the bottom of the plot, and the plot height
      // it has to be read against.
      fromBottom: Math.round((plotRect.bottom - majorityRect.top) * 100) / 100,
      plotHeight: Math.round(plotRect.height * 100) / 100,
      spansPlot: Math.abs(majorityRect.left - plotRect.left) < 1 &&
        Math.abs(majorityRect.right - plotRect.right) < 1,
    },
    announcement: text('election-government-announcement'),
  };
});

/** Every layout fact needed to prove the page does not overflow sideways. */
const readOverflow = (browser) => browser.evaluate(() => {
  const root = document.documentElement;
  const panel = document.getElementById('election-government-builder');
  let worst = null;
  Array.from(panel.querySelectorAll('*')).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (!worst || rect.right > worst.right) {
      worst = { right: Math.round(rect.right * 100) / 100, cls: el.className || el.tagName };
    }
  });
  return {
    documentScrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    panelScrollWidth: panel.scrollWidth,
    panelClientWidth: panel.clientWidth,
    worst,
  };
});

/** Click the button that moves `party` into `zone`, from whichever zone holds it. */
const moveParty = (browser, party, zone) => browser.evaluate((arg) => {
  const [name, target] = arg;
  const button = document.querySelector(
    `#election-government-builder .eg-party[data-party="${name}"] .eg-party__btn[data-action="${target}"]`);
  if (!button) return { moved: false, reason: 'no button' };
  button.click();
  const active = document.activeElement;
  return {
    moved: true,
    // Focus must land back on the party the reader just moved, or a keyboard
    // user is dumped at the top of the document on every click.
    focusParty: active ? active.getAttribute('data-party') : null,
    focusZone: active && active.closest('.eg-zone') ? active.closest('.eg-zone').id : null,
  };
}, [party, zone]);

/** Where each party currently lives, straight from the DOM. */
const membership = (browser) => browser.evaluate(() => {
  const found = {};
  const duplicates = [];
  ['election-available-parties', 'election-government-parties', 'election-support-parties']
    .forEach((zone) => {
      Array.from(document.querySelectorAll(`#${zone} .eg-party`)).forEach((el) => {
        const party = el.getAttribute('data-party');
        if (found[party]) duplicates.push(party);
        found[party] = zone;
      });
    });
  return { found, duplicates };
});

/** Drive the drag handlers the way a mouse drag would, without native drag. */
const dragParty = (browser, party, zoneId) => browser.evaluate((arg) => {
  const [name, target] = arg;
  const tile = document.querySelector(`#election-government-builder .eg-party[data-party="${name}"]`);
  const zone = document.getElementById(target);
  if (!tile || !zone || typeof DataTransfer !== 'function') return false;
  const data = new DataTransfer();
  tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  return true;
}, [party, zoneId]);

/** Real Tab traversal, so :focus-visible actually matches. */
async function tabFocusOutline(browser) {
  await browser.evaluate(() => {
    document.querySelector('#election-available-parties .eg-party__btn').focus();
  });
  for (const type of ['rawKeyDown', 'keyUp']) {
    await browser.S('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab',
    });
  }
  return browser.evaluate(() => {
    const active = document.activeElement;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName,
      isBuilderButton: active.classList.contains('eg-party__btn'),
      matchesFocusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

// ---------------------------------------------------------------------------
// schema 1.2: the redesigned builder
// ---------------------------------------------------------------------------

async function schema12(viewport, pointer, expected, expectedCrossing) {
  console.log(`\n[schema 1.2 @ ${viewport.name} ${viewport.width}x${viewport.height}]`);
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);

    // --- Swedish copy ----------------------------------------------------
    const initial = await readPanel(browser);
    check('panel is visible', initial.section.visible, JSON.stringify(initial.section));
    eq('intro copy', initial.intro,
      'Välj regeringspartier och eventuella stödpartier. Diagrammet visar hur många mandat de brukar få tillsammans i simuleringarna.');
    eq('pool label', initial.poolTitle, 'Tillgängliga partier');
    eq('government column label', initial.governmentTitle, 'Regering');
    eq('cumulative column label', initial.unionTitle, 'Med stöd');
    eq('government drop zone label', initial.governmentZoneTitle, 'Regeringspartier');
    eq('support drop zone label', initial.supportZoneTitle, 'Stödpartier');
    check('disclaimer is preserved',
      initial.disclaimer.startsWith('Det här visar sannolikheten att de valda partierna tillsammans får minst 175 mandat'),
      initial.disclaimer);

    // --- Initial empty state ---------------------------------------------
    eq('all eight parties start in the pool', initial.pool.map((t) => t.party), PARTY_ORDER);
    eq('government column starts empty', initial.government.length, 0);
    eq('support column starts empty', initial.support.length, 0);
    eq('both empty columns explain themselves', initial.hints, ['Inga partier valda.', 'Inga partier valda.']);
    check('every pool tile has a real box',
      initial.pool.every((t) => t.visible && t.width > 0 && t.height > 0),
      JSON.stringify(initial.pool.filter((t) => !(t.visible && t.width > 0))));
    eq('pool tiles offer both destinations',
      initial.pool.map((t) => t.actions.join('+')),
      PARTY_ORDER.map(() => 'government+support'));
    eq('government total starts at zero', initial.governmentTotal, '0');
    eq('cumulative total starts at zero', initial.unionTotal, '0');
    eq('no segments are drawn yet',
      initial.governmentSegments.length + initial.unionSegments.length, 0);
    eq('column masks start empty', [initial.masks.government, initial.masks.union], ['0', '0']);
    check(`every party action is at least ${MIN_TARGET}px on its short side`,
      initial.smallestAction >= MIN_TARGET,
      `smallest ${initial.smallestAction}px, shortest height ${initial.shortestAction}px`);
    check('empty-state prompt is visible', initial.empty.visible, JSON.stringify(initial.empty));
    check('summary is hidden initially',
      !initial.summaryBox.visible && initial.summaryBox.display === 'none',
      JSON.stringify(initial.summaryBox));
    check('the medians note is hidden initially',
      !initial.note.visible && initial.note.display === 'none', JSON.stringify(initial.note));
    check('schema 1.2 histogram is hidden initially',
      initial.histogram && initial.histogram.hiddenAttr && initial.histogram.mask === '' &&
      initial.histogram.total === '0' && initial.histogram.bins === 0,
      JSON.stringify(initial.histogram));
    eq('screen-reader status asks for a government', initial.announcement, 'Välj minst ett regeringsparti.');

    // --- Shared scale and the majority rule ------------------------------
    near('both bars are the same height',
      initial.governmentBar.height, initial.unionBar.height, 0.5);
    near('both bars start at the same y', initial.governmentBar.top, initial.unionBar.top, 0.5);
    check('majority rule is drawn', initial.majority.visible && initial.majority.borderStyle === 'dashed',
      JSON.stringify(initial.majority));
    eq('majority rule is labelled in seats, not per cent',
      initial.majority.label, 'Majoritetsgräns: 175 mandat');
    check('majority label never says 50 %', !/50\s*%/.test(initial.majority.label), initial.majority.label);
    check('majority rule spans both columns', initial.majority.spansPlot, JSON.stringify(initial.majority));
    near('majority rule sits at 175 of 349',
      initial.majority.fromBottom,
      initial.majority.plotHeight * (MAJORITY / CHAMBER), 1.5);

    // --- Moving parties around -------------------------------------------
    const toGovernment = await moveParty(browser, 'M', 'government');
    check('pool tile moves M into Regering', toGovernment.moved, JSON.stringify(toGovernment));
    eq('focus follows M into Regering',
      [toGovernment.focusParty, toGovernment.focusZone], ['M', GOVERNMENT]);
    let where = await membership(browser);
    eq('M is now only in Regering', where.found.M, GOVERNMENT);
    eq('nothing is in two zones at once', where.duplicates, []);

    // The same party moved straight across must not leave a copy behind.
    const across = await moveParty(browser, 'M', 'support');
    check('M can move straight from Regering to Stödpartier', across.moved);
    where = await membership(browser);
    eq('M is now only in Stödpartier', where.found.M, SUPPORT);
    eq('a cross-column move leaves no duplicate', where.duplicates, []);
    let panel = await readPanel(browser);
    eq('the emptied government column reports mask 0', panel.masks.government, '0');
    eq('the cumulative column now carries only M', panel.masks.union, '1');
    check('an empty government still blocks the summary',
      !panel.summaryBox.visible && panel.empty.visible,
      JSON.stringify([panel.summaryBox, panel.empty]));

    // Back to the pool, then build the real selection.
    check('M can be removed back to the pool', (await moveParty(browser, 'M', 'pool')).moved);
    where = await membership(browser);
    eq('M is back in the pool', where.found.M, POOL);

    for (const party of ['M', 'KD', 'SD']) {
      check(`move ${party} into Regering`, (await moveParty(browser, party, 'government')).moved);
    }
    check('L is added as a support party by drag and drop',
      await dragParty(browser, 'L', SUPPORT));

    where = await membership(browser);
    eq('final membership', Object.keys(where.found).sort().map((p) => [p, where.found[p]]),
      Object.entries({
        C: POOL, KD: GOVERNMENT, L: SUPPORT, M: GOVERNMENT,
        MP: POOL, S: POOL, SD: GOVERNMENT, V: POOL,
      }).sort());
    eq('no party is in two zones', where.duplicates, []);

    // --- Masks and the published lookup ----------------------------------
    panel = await readPanel(browser);
    eq('government mask', panel.masks.government, String(GOVERNMENT_MASK));
    eq('cumulative column carries the union mask', panel.masks.union, String(UNION_MASK));
    eq('summary carries all three masks',
      [panel.masks.summaryGovernment, panel.masks.summarySupport, panel.masks.summaryUnion],
      [String(GOVERNMENT_MASK), String(SUPPORT_MASK), String(UNION_MASK)]);

    check('summary is revealed', panel.summaryBox.visible, JSON.stringify(panel.summaryBox));
    check('the medians note is revealed', panel.note.visible, JSON.stringify(panel.note));
    check('empty-state prompt is gone', !panel.empty.visible, JSON.stringify(panel.empty));
    check('schema 1.2 histogram stays hidden after coalition selection',
      panel.histogram && panel.histogram.hiddenAttr && panel.histogram.mask === '' &&
      panel.histogram.total === '0' && panel.histogram.bins === 0,
      JSON.stringify(panel.histogram));

    eq('government median', panel.metrics.government,
      { term: 'Regering', value: `${expected.government.median} mandat` });
    eq('support median', panel.metrics.support,
      { term: 'Stödpartier', value: `${expected.support.median} mandat` });
    eq('combined median', panel.metrics.union,
      { term: 'Tillsammans', value: `${expected.union.median} mandat` });
    eq('union 90 % interval', panel.metrics.interval,
      { term: '90 % prognosintervall', value: `${expected.union.p05}–${expected.union.p95} mandat` });
    eq('probability of at least 175 seats', panel.metrics.probability,
      { term: `Sannolikhet för minst ${MAJORITY} mandat`, value: expected.union.probability });
    eq('column totals match the lookup',
      [panel.governmentTotal, panel.unionTotal],
      [String(expected.government.median), String(expected.union.median)]);

    // --- The bar draws the number it prints ------------------------------
    // The track is column-reverse, so DOM order runs bottom to top.
    eq('government bar stacks the three coalition parties from the bottom up',
      panel.governmentSegments.map((s) => s.party), ['KD', 'M', 'SD']);
    eq('column tiles are listed in the bar\'s own top-to-bottom order',
      panel.government.map((t) => t.party), ['SD', 'M', 'KD']);
    const stacked = panel.governmentSegments.reduce((sum, s) => sum + s.height, 0);
    near('the stack height is the coalition median on the 0-349 scale',
      stacked, panel.majority.plotHeight * (expected.government.median / CHAMBER), 1.5);
    check('the bar describes itself for screen readers',
      panel.governmentBarLabel === `Regering: SD 69, M 68, KD 24. Median tillsammans ${expected.government.median} av ${CHAMBER} mandat.`,
      panel.governmentBarLabel);
    eq('the cumulative bar stacks government and support together',
      panel.unionSegments.map((s) => s.party).sort(), ['KD', 'L', 'M', 'SD']);
    check('the cumulative bar marks L as a support party',
      panel.unionBarLabel === `Med stöd: SD 69, M 68, KD 24, L 0 (stöd). Median tillsammans ${expected.union.median} av ${CHAMBER} mandat.`,
      panel.unionBarLabel);
    check('the live region announces the union result',
      panel.announcement.includes('Tillsammans ' + expected.union.median + ' mandat') &&
      panel.announcement.includes(expected.union.probability),
      panel.announcement);

    // --- The regression the cumulative bar exists for -----------------------
    // A government below 175 whose union with its support parties is above it.
    // Drawn as two independent masks, both bars would sit under the rule and
    // the panel would answer the majority question wrongly.
    for (const party of ['M', 'KD', 'SD', 'L']) {
      await moveParty(browser, party, 'pool');
    }
    for (const party of CROSSING_GOVERNMENT) {
      check(`move ${party} into Regering`, (await moveParty(browser, party, 'government')).moved);
    }
    for (const party of CROSSING_SUPPORT) {
      check(`move ${party} into Stödpartier`, (await moveParty(browser, party, 'support')).moved);
    }

    const crossing = await readPanel(browser);
    const rule = crossing.majority.fromBottom;
    eq('crossing government mask', crossing.masks.government, String(CROSSING_GOVERNMENT_MASK));
    eq('crossing cumulative mask', crossing.masks.union, String(CROSSING_UNION_MASK));
    eq('crossing masks are disjoint',
      CROSSING_GOVERNMENT_MASK & CROSSING_SUPPORT_MASK, 0);
    eq('the fixture still holds a crossing case',
      [expectedCrossing.government.median < MAJORITY, expectedCrossing.union.median >= MAJORITY],
      [true, true]);

    check('left bar remains below the majority rule',
      crossing.governmentStack < rule,
      `government stack ${crossing.governmentStack}px vs rule at ${rule}px from the plot floor`);
    check('right cumulative bar rises above the majority rule',
      crossing.unionStack > rule,
      `union stack ${crossing.unionStack}px vs rule at ${rule}px from the plot floor`);
    near('left bar draws the government median on the 0-349 scale',
      crossing.governmentStack,
      crossing.majority.plotHeight * (expectedCrossing.government.median / CHAMBER), 1.5);
    near('right bar draws the union median on the 0-349 scale',
      crossing.unionStack,
      crossing.majority.plotHeight * (expectedCrossing.union.median / CHAMBER), 1.5);

    eq('right bar total equals the union lookup median',
      crossing.unionTotal, String(expectedCrossing.union.median));
    eq('summary union median matches the same value',
      crossing.metrics.union.value, `${expectedCrossing.union.median} mandat`);
    eq('left column still reports the government alone',
      crossing.governmentTotal, String(expectedCrossing.government.median));
    eq('the support-only median is still reported',
      crossing.metrics.support.value, `${expectedCrossing.support.median} mandat`);

    eq('the cumulative bar stacks all four parties',
      crossing.unionSegments.map((s) => s.party).sort(), ['C', 'MP', 'S', 'V']);
    eq('the government bar stacks only the two governing parties',
      crossing.governmentSegments.map((s) => s.party).sort(), ['S', 'V']);
    eq('the support parties are the hatched ones',
      crossing.unionSegments.filter((s) => s.support).map((s) => s.party).sort(),
      CROSSING_SUPPORT.slice().sort());
    eq('the right-hand drop zone holds only the support tiles',
      crossing.support.map((t) => t.party).sort(), CROSSING_SUPPORT.slice().sort());
    eq('the left-hand drop zone holds only the governing tiles',
      crossing.government.map((t) => t.party).sort(), CROSSING_GOVERNMENT.slice().sort());
    check('the probability reflects the union, not the government alone',
      crossing.metrics.probability.value === expectedCrossing.union.probability,
      `${crossing.metrics.probability.value} vs ${expectedCrossing.union.probability}`);

    check(`party actions stay at least ${MIN_TARGET}px on their short side`,
      crossing.smallestAction >= MIN_TARGET,
      `smallest ${crossing.smallestAction}px, shortest height ${crossing.shortestAction}px`);

    // --- Keyboard --------------------------------------------------------
    const focus = await tabFocusOutline(browser);
    check('Tab reaches a builder control', focus.isBuilderButton, JSON.stringify(focus));
    check('keyboard focus is visibly outlined',
      focus.matchesFocusVisible && focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0,
      JSON.stringify(focus));

    // --- Layout ----------------------------------------------------------
    const overflow = await readOverflow(browser);
    eq('the document does not scroll sideways',
      overflow.documentScrollWidth <= overflow.clientWidth, true);
    check('the panel does not scroll sideways',
      overflow.panelScrollWidth <= overflow.panelClientWidth,
      JSON.stringify(overflow));
    check('nothing in the panel reaches past the viewport',
      overflow.worst.right <= overflow.clientWidth + 0.5, JSON.stringify(overflow.worst));

    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// schema 1.1: the fail-closed contract
// ---------------------------------------------------------------------------

async function schema11FailsClosed(pointer) {
  console.log('\n[schema 1.1 fails closed @ desktop]');
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: 1280, height: 1200 });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);
    // A publication without a coalition_builder must leave no trace of the
    // panel: this is the empty-shell regression that the `hidden` attribute
    // is responsible for preventing.
    const panel = await browser.evaluate(() => {
      const section = document.getElementById('election-government-builder');
      const style = getComputedStyle(section);
      return {
        hiddenAttr: section.hidden,
        display: style.display,
        height: section.getBoundingClientRect().height,
        tiles: document.querySelectorAll('#election-government-builder .eg-party').length,
        segments: document.querySelectorAll('#election-government-builder .eg-bar__segment').length,
        summary: document.getElementById('election-government-results').textContent.trim(),
      };
    });
    check('panel keeps the hidden attribute', panel.hiddenAttr === true, JSON.stringify(panel));
    check('panel is not rendered at all',
      panel.display === 'none' && panel.height === 0, JSON.stringify(panel));
    eq('no party tiles leak', panel.tiles, 0);
    eq('no bar segments leak', panel.segments, 0);
    eq('no summary text leaks', panel.summary, '');
    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// schema 1.3: exact contiguous coalition histograms
// ---------------------------------------------------------------------------

// The real forecast intentionally remains immutable and schema 1.2 in this
// checkout.  This tiny deterministic seat matrix is used only to exercise the
// website consumer with a complete schema-1.3 publication contract.  It is
// assembled in a temporary copy of the built site at test time and is never
// written under files/election-simulator/versions in the repository.
const SYNTHETIC_1_3 = 'synthetic-schema-1-3-histogram';
const SYNTHETIC_ROWS = [
  [65, 0, 20, 20, 85, 40, 20, 99],
  [60, 1, 25, 18, 90, 40, 22, 93],
  [70, 0, 18, 23, 80, 45, 18, 95],
  [55, 0, 25, 15, 95, 40, 25, 94],
  [68, 0, 23, 21, 88, 41, 19, 89],
  [62, 0, 28, 17, 92, 42, 20, 88],
  [72, 0, 20, 22, 84, 43, 18, 90],
  [58, 0, 26, 16, 94, 41, 24, 90],
];

function syntheticValues(mask) {
  return SYNTHETIC_ROWS.map((row) => row.reduce(
    (sum, seats, index) => sum + ((mask & (1 << index)) ? seats : 0), 0));
}

function syntheticQuantile(values, quantile) {
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const gamma = position - lower;
  const difference = sorted[upper] - sorted[lower];
  const interpolated = gamma < 0.5
    ? sorted[lower] + difference * gamma
    : sorted[upper] - difference * (1 - gamma);
  return Math.floor(interpolated);
}

eq('NumPy-compatible p95 lower branch',
  syntheticQuantile([84, 341, 278, 215, 199, 89, 281, 157], 0.95), 319);
eq('NumPy-compatible p95 upper branch',
  syntheticQuantile([71, 10, 241], 0.95), 224);

function syntheticEntry(base, mask) {
  const values = syntheticValues(mask);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const counts = Array.from({ length: maximum - minimum + 1 }, () => 0);
  values.forEach((value) => { counts[value - minimum] += 1; });
  return Object.assign({}, base, {
    mean_seats: values.reduce((sum, value) => sum + value, 0) / values.length,
    median_seats: syntheticQuantile(values, 0.50),
    p05_seats: syntheticQuantile(values, 0.05),
    p10_seats: syntheticQuantile(values, 0.10),
    p25_seats: syntheticQuantile(values, 0.25),
    p75_seats: syntheticQuantile(values, 0.75),
    p90_seats: syntheticQuantile(values, 0.90),
    p95_seats: syntheticQuantile(values, 0.95),
    prob_majority: values.filter((value) => value >= MAJORITY).length / values.length,
    seat_histogram: { min_seats: minimum, counts },
  });
}

async function syntheticSchema13Site() {
  const root = await mkdtemp(join(tmpdir(), 'election-ui-schema-13-'));
  await cp(SITE, root, { recursive: true });
  const source = join(root, 'files/election-simulator/versions', GENERATION_1_2);
  const version = join(root, 'files/election-simulator/versions', SYNTHETIC_1_3);
  await cp(source, version, { recursive: true });

  const groupsPath = join(version, 'groups.json');
  const groups = JSON.parse(await readFile(groupsPath, 'utf8'));
  groups.schema_version = '1.3';
  Object.keys(groups.coalition_builder.coalitions).forEach((key) => {
    const mask = Number(key);
    groups.coalition_builder.coalitions[key] = syntheticEntry(
      groups.coalition_builder.coalitions[key], mask);
  });
  await writeFile(groupsPath, `${JSON.stringify(groups, null, 2)}\n`);

  for (const name of ['forecast.json', 'parties.json', 'seats.json', 'calibration.json', 'metadata.json', 'manifest.json']) {
    const path = join(version, name);
    const contract = JSON.parse(await readFile(path, 'utf8'));
    contract.schema_version = '1.3';
    if (name === 'forecast.json') contract.total_samples = SYNTHETIC_ROWS.length;
    if (name === 'manifest.json') contract.publication_generation = SYNTHETIC_1_3;
    await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`);
  }
  return { root, pointer: await pointerFor(root, SYNTHETIC_1_3) };
}

const readHistogram = (browser) => browser.evaluate(() => {
  const flat = (value) => value.replace(/[\t\n\r ]+/g, ' ').trim();
  const host = document.getElementById('election-government-histogram');
  const svg = document.getElementById('election-government-histogram-svg');
  const bins = Array.from(document.querySelectorAll('#election-government-histogram-svg .egh-bin'));
  const threshold = document.querySelector('#election-government-histogram-svg .egh-threshold');
  const thresholdLabel = document.querySelector('#election-government-histogram-svg .egh-threshold__label');
  const axisTick = document.querySelector('#election-government-histogram-svg .egh-axis__tick');
  const svgRect = svg ? svg.getBoundingClientRect() : null;
  const labelRect = thresholdLabel ? thresholdLabel.getBoundingClientRect() : null;
  const scaleOf = (element) => {
    const matrix = element && element.getScreenCTM ? element.getScreenCTM() : null;
    return matrix ? Math.abs(matrix.a) : 0;
  };
  return {
    appStatus: document.getElementById('election-app-status') ? document.getElementById('election-app-status').textContent : null,
    hidden: !host || host.hidden,
    mask: host ? host.getAttribute('data-coalition-mask') : null,
    total: host ? Number(host.getAttribute('data-total-count')) : null,
    minSeats: host ? Number(host.getAttribute('data-min-seats')) : null,
    maxSeats: host ? Number(host.getAttribute('data-max-seats')) : null,
    heading: host ? flat(host.querySelector('.egh-histogram__title').textContent) : null,
    context: host ? flat(host.querySelector('.egh-histogram__context').textContent) : null,
    hasCoalitionKey: Boolean(host && host.querySelector('.egh-histogram__key-mark--coalition')),
    axisLabels: svg ? Array.from(svg.querySelectorAll('.egh-axis__label')).map((label) => Number(label.textContent)) : [],
    description: svg && svg.querySelector('desc') ? flat(svg.querySelector('desc').textContent) : '',
    textAlternative: host ? flat(host.querySelector('#election-government-histogram-text').textContent) : null,
    bins: bins.map((bin) => ({
      seat: Number(bin.getAttribute('data-seat')),
      count: Number(bin.getAttribute('data-count')),
      share: Number(bin.getAttribute('data-share')),
      majority: bin.getAttribute('data-majority'),
      mask: bin.getAttribute('data-coalition-mask'),
      label: bin.getAttribute('aria-label'),
      fill: bin.querySelector('.egh-bin__bar')?.getAttribute('fill') || null,
    })),
    threshold: threshold ? {
      seat: Number(threshold.getAttribute('data-seat')),
      dash: threshold.getAttribute('stroke-dasharray'),
      label: threshold.getAttribute('aria-label'),
    } : null,
    thresholdLabelVisible: Boolean(labelRect && svgRect &&
      labelRect.left >= svgRect.left - 1 && labelRect.right <= svgRect.right + 1),
    axisFontSize: axisTick ? parseFloat(getComputedStyle(axisTick).fontSize) : 0,
    thresholdLabelFontSize: thresholdLabel ? parseFloat(getComputedStyle(thresholdLabel).fontSize) : 0,
    effectiveAxisFontSize: axisTick ? parseFloat(getComputedStyle(axisTick).fontSize) * scaleOf(axisTick) : 0,
    effectiveThresholdLabelFontSize: thresholdLabel
      ? parseFloat(getComputedStyle(thresholdLabel).fontSize) * scaleOf(thresholdLabel) : 0,
    svgBounds: svgRect ? {
      left: svgRect.left, right: svgRect.right, top: svgRect.top, bottom: svgRect.bottom,
    } : null,
    thresholdLabelBounds: labelRect ? {
      left: labelRect.left, right: labelRect.right, top: labelRect.top, bottom: labelRect.bottom,
    } : null,
    svgWidth: svgRect ? svgRect.width : 0,
    svgHeight: svgRect ? svgRect.height : 0,
  };
});

async function schema13Histogram(viewport, synthetic) {
  console.log(`\n[schema 1.3 histogram @ ${viewport.name} ${viewport.width}x${viewport.height}]`);
  const server = await serve(synthetic.root, { port: 4000, pointer: synthetic.pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);

    const initial = await readHistogram(browser);
    check('histogram starts hidden with empty government', initial.hidden && initial.mask === '', JSON.stringify(initial));

    for (const party of ['M', 'KD', 'SD']) {
      check(`move ${party} into Regering for histogram`, (await moveParty(browser, party, 'government')).moved);
    }
    check('L is added as histogram support by drag and drop', await dragParty(browser, 'L', SUPPORT));

    const rendered = await readHistogram(browser);
    const table = JSON.parse(await readFile(
      join(synthetic.root, 'files/election-simulator/versions', SYNTHETIC_1_3, 'groups.json'), 'utf8'))
      .coalition_builder.coalitions;
    const expected = table[String(UNION_MASK)];
    const expectedBins = expected.seat_histogram.counts.map((count, index) => ({
      seat: expected.seat_histogram.min_seats + index, count,
    }));
    eq('histogram heading is exact Swedish copy', rendered.heading, 'Mandatfördelning i 100 000 simuleringar');
    check('histogram context stays concise and coalition-specific',
      rendered.context === 'M + L + KD + SD. Fördelningen visar hur ofta kombinationen hamnar på olika mandatnivåer i simuleringarna.',
      rendered.context);
    check('histogram is visible after selecting a government', !rendered.hidden, JSON.stringify(rendered));
    eq('histogram resolves the government/support union mask', rendered.mask, String(UNION_MASK));
    eq('histogram total is the published sample count', rendered.total, SYNTHETIC_ROWS.length);
    eq('rendered bin count matches contiguous published support', rendered.bins.length, expectedBins.length);
    eq('rendered seats and counts match the published bins',
      rendered.bins.map(({ seat, count }) => ({ seat, count })), expectedBins);
    eq('all rendered bins carry the current union mask',
      [...new Set(rendered.bins.map((bin) => bin.mask))], [String(UNION_MASK)]);
    eq('rendered counts sum to the published samples',
      rendered.bins.reduce((sum, bin) => sum + bin.count, 0), SYNTHETIC_ROWS.length);
    check('bins below and above majority are classified correctly',
      rendered.bins.every((bin) => bin.majority === (bin.seat >= MAJORITY ? 'majority' : 'below')),
      JSON.stringify(rendered.bins));
    eq('threshold is a dashed line at 175', rendered.threshold,
      { seat: MAJORITY, dash: '6 5', label: 'Majoritetsgräns: 175 mandat' });
    eq('displayed majority probability comes from the histogram',
      rendered.bins.filter((bin) => bin.seat >= MAJORITY).reduce((sum, bin) => sum + bin.count, 0) / rendered.total,
      expected.prob_majority);
    check('each bin has an accessible exact-frequency label',
      rendered.bins.every((bin) => bin.label.includes(`${bin.seat} mandat`) && bin.label.includes('simuleringar')),
      JSON.stringify(rendered.bins.slice(0, 2)));
    check('histogram uses restrained below/majority visual encodings',
      rendered.bins.filter((bin) => bin.count > 0).every((bin) =>
        bin.majority === 'majority'
          ? bin.fill.includes('egh-majority-hatch')
          : bin.fill === '#c5d0d9'),
      JSON.stringify(rendered.bins));
    check('histogram has no party rainbow legend',
      !rendered.hasCoalitionKey, 'unexpected coalition colour key');
    check('histogram includes readable five-seat axis ticks',
      rendered.axisLabels.some((value) => value % 5 === 0) && rendered.axisLabels.includes(MAJORITY),
      JSON.stringify(rendered));
    check('histogram has a useful text alternative',
      rendered.description.includes('simuleringar') && rendered.textAlternative.includes('skrafferade'),
      JSON.stringify(rendered));
    check('threshold label is not clipped', rendered.thresholdLabelVisible, JSON.stringify(rendered));
    if (viewport.name === 'narrow-360') {
      check('narrow histogram labels keep a readable computed font size',
        rendered.axisFontSize >= 13 && rendered.thresholdLabelFontSize >= 13 &&
        rendered.effectiveAxisFontSize >= 10 && rendered.effectiveThresholdLabelFontSize >= 10,
        JSON.stringify(rendered));
    }
    if (viewport.name === 'desktop') {
      check('desktop histogram uses the available content width', rendered.svgWidth >= 620, String(rendered.svgWidth));
    }
    const binFocus = await browser.evaluate(() => {
      const bin = document.querySelector('#election-government-histogram-svg .egh-bin');
      const status = document.getElementById('election-government-histogram-status');
      if (bin) bin.focus();
      return {
        focused: document.activeElement === bin,
        hidden: !status || status.hidden,
        text: status ? status.textContent : '',
      };
    });
    check('focusing a bin exposes its exact frequency',
      binFocus.focused && !binFocus.hidden && /164 mandat · 2 simuleringar · 25,00 %/.test(binFocus.text),
      JSON.stringify(binFocus));

    // Moving support back to the pool changes only the union lookup and must
    // replace the histogram, rather than leaving stale bins on screen.
    check('L can be removed before testing histogram replacement', (await moveParty(browser, 'L', 'pool')).moved);
    const replaced = await readHistogram(browser);
    const replacedExpected = table[String(GOVERNMENT_MASK)];
    eq('selecting another coalition replaces the histogram mask', replaced.mask, String(GOVERNMENT_MASK));
    eq('selecting another coalition replaces every bin',
      replaced.bins.map(({ seat, count }) => ({ seat, count })),
      replacedExpected.seat_histogram.counts.map((count, index) => ({
        seat: replacedExpected.seat_histogram.min_seats + index, count,
      })));
    eq('replacement total remains the published sample count', replaced.total, SYNTHETIC_ROWS.length);

    const overflow = await readOverflow(browser);
    eq('histogram page does not scroll sideways', overflow.documentScrollWidth <= overflow.clientWidth, true);
    check('histogram panel does not scroll sideways', overflow.panelScrollWidth <= overflow.panelClientWidth, JSON.stringify(overflow));
    check('histogram SVG stays inside the viewport',
      overflow.worst && overflow.worst.right <= overflow.clientWidth + 0.5,
      JSON.stringify(overflow.worst));
    eq('histogram has no uncaught exceptions', browser.exceptions, []);
    eq('histogram has no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------

/** Expected numbers come from the published fixture, never from the page. */
async function expectations() {
  const groups = JSON.parse(await readFile(
    join(SITE, 'files/election-simulator/versions', GENERATION_1_2, 'groups.json'), 'utf8'));
  const table = groups.coalition_builder.coalitions;
  const swedish = (probability) => {
    const pct = probability * 100;
    const digits = pct < 1 || pct > 99 ? 2 : 1;
    return `${pct.toFixed(digits).replace('.', ',')} %`;
  };
  const of = (mask) => ({
    median: table[String(mask)].median_seats,
    p05: table[String(mask)].p05_seats,
    p95: table[String(mask)].p95_seats,
    probability: swedish(table[String(mask)].prob_majority),
  });
  const set = (government, support) => ({
    government: of(government), support: of(support), union: of(government | support),
  });
  return {
    selection: set(GOVERNMENT_MASK, SUPPORT_MASK),
    crossing: set(CROSSING_GOVERNMENT_MASK, CROSSING_SUPPORT_MASK),
  };
}

const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer11 = await pointerFor(SITE, GENERATION_1_1);
if (pointer12.schema_version !== '1.2') throw new Error('fixture is not schema 1.2');
if (pointer11.schema_version !== '1.1') throw new Error('fixture is not schema 1.1');

const expected = await expectations();
for (const viewport of VIEWPORTS) {
  await schema12(viewport, pointer12, expected.selection, expected.crossing);
}
await schema11FailsClosed(pointer11);
const synthetic = await syntheticSchema13Site();
try {
  for (const viewport of VIEWPORTS) {
    await schema13Histogram(viewport, synthetic);
  }
} finally {
  await rm(synthetic.root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
