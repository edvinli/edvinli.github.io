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

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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
  }));
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? flat(el.textContent) : null;
  };
  const summary = document.getElementById('election-government-results');
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

  return {
    section: byId('election-government-builder'),
    empty: byId('election-government-empty'),
    summaryBox: byId('election-government-results'),
    note: byId('election-government-note'),
    poolEmpty: byId('election-pool-empty'),
    pool: tiles('election-available-parties'),
    government: tiles('election-government-parties'),
    support: tiles('election-support-parties'),
    poolHost: byId('election-available-parties'),
    governmentBar: byId('election-government-bar'),
    supportBar: byId('election-support-bar'),
    governmentSegments: segments('election-government-bar'),
    supportSegments: segments('election-support-bar'),
    governmentBarLabel: document.getElementById('election-government-bar').getAttribute('aria-label'),
    supportBarLabel: document.getElementById('election-support-bar').getAttribute('aria-label'),
    governmentTotal: text('election-government-total'),
    supportTotal: text('election-support-total'),
    poolTitle: text('election-pool-title'),
    governmentTitle: text('election-government-title'),
    supportTitle: text('election-support-title'),
    intro: flat(document.querySelector('#election-government-builder .election-panel__head p').textContent),
    disclaimer: flat(document.querySelector('.eg-builder__disclaimer').textContent),
    hints: Array.from(document.querySelectorAll('.eg-zone__hint')).map((el) => el.textContent.trim()),
    masks: {
      government: document.getElementById('election-government-column').getAttribute('data-coalition-mask'),
      support: document.getElementById('election-support-column').getAttribute('data-coalition-mask'),
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

async function schema12(viewport, pointer, expected) {
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
    eq('support column label', initial.supportTitle, 'Stödpartier');
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
    eq('support total starts at zero', initial.supportTotal, '0');
    eq('no segments are drawn yet',
      initial.governmentSegments.length + initial.supportSegments.length, 0);
    eq('column masks start empty', [initial.masks.government, initial.masks.support], ['0', '0']);
    check('empty-state prompt is visible', initial.empty.visible, JSON.stringify(initial.empty));
    check('summary is hidden initially',
      !initial.summaryBox.visible && initial.summaryBox.display === 'none',
      JSON.stringify(initial.summaryBox));
    check('the medians note is hidden initially',
      !initial.note.visible && initial.note.display === 'none', JSON.stringify(initial.note));
    eq('screen-reader status asks for a government', initial.announcement, 'Välj minst ett regeringsparti.');

    // --- Shared scale and the majority rule ------------------------------
    near('both bars are the same height',
      initial.governmentBar.height, initial.supportBar.height, 0.5);
    near('both bars start at the same y', initial.governmentBar.top, initial.supportBar.top, 0.5);
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
    eq('the support column now carries only M', panel.masks.support, '1');
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
    eq('support mask', panel.masks.support, String(SUPPORT_MASK));
    eq('summary carries all three masks',
      [panel.masks.summaryGovernment, panel.masks.summarySupport, panel.masks.summaryUnion],
      [String(GOVERNMENT_MASK), String(SUPPORT_MASK), String(UNION_MASK)]);

    check('summary is revealed', panel.summaryBox.visible, JSON.stringify(panel.summaryBox));
    check('the medians note is revealed', panel.note.visible, JSON.stringify(panel.note));
    check('empty-state prompt is gone', !panel.empty.visible, JSON.stringify(panel.empty));

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
      [panel.governmentTotal, panel.supportTotal],
      [String(expected.government.median), String(expected.support.median)]);

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
    check('the support bar reports L below the threshold',
      panel.supportBarLabel === 'Stödpartier: L 0. Median tillsammans 0 av 349 mandat.',
      panel.supportBarLabel);
    check('the live region announces the union result',
      panel.announcement.includes('Tillsammans ' + expected.union.median + ' mandat') &&
      panel.announcement.includes(expected.union.probability),
      panel.announcement);

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
  return { government: of(GOVERNMENT_MASK), support: of(SUPPORT_MASK), union: of(UNION_MASK) };
}

const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer11 = await pointerFor(SITE, GENERATION_1_1);
if (pointer12.schema_version !== '1.2') throw new Error('fixture is not schema 1.2');
if (pointer11.schema_version !== '1.1') throw new Error('fixture is not schema 1.1');

const expected = await expectations();
for (const viewport of VIEWPORTS) await schema12(viewport, pointer12, expected);
await schema11FailsClosed(pointer11);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
