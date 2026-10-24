// Röstandel per valkrets: the constituency map of publication schema 1.5.
//
// What this suite guards:
//
// * compatibility both ways: a schema-1.4 publication has no map and loses
//   nothing, and a 1.5 publication keeps every coalition panel (the builder
//   rejected an unknown groups schema, which would have blanked them);
// * the map draws what geography.json says: 29 constituencies plus the three
//   city insets, darker fill for a larger value, a fixed scale per party and
//   measure, and a detail readout and table with the published numbers;
// * interaction: the party chips, the share/change toggle, hover, choosing a
//   constituency on the map or in the table, sorting, and following a party
//   chosen elsewhere on the page;
// * it fails closed: bytes that do not match the manifest, another forecast's
//   payload or sample count, probabilities that do not sum to one, or names
//   that do not match the outlines each leave the panel hidden and the rest of
//   the page intact;
// * no horizontal overflow at 360 px.
//
// The 1.5 publication is a SYNTHETIC fixture over a pinned 1.4 generation
// (geography-fixture.mjs): its local numbers are invented, so this suite
// checks rendering against the file, never the model.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/constituency-map.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';
import { buildGeographySite, GEOGRAPHY_SOURCE_GENERATION } from './geography-fixture.mjs';
import { resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const PARTIES = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];

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
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const median = (row, party) => row.parties[party].vote_share_quantiles.p50;

async function open(viewport, { root = SITE, pointer }) {
  const server = await serve(root, { port: 4000, pointer });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  const ready = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const builder = document.getElementById('election-government-builder');
    return Boolean(status) && (status.hidden || status.className.includes('error')) &&
      Boolean(builder) && !builder.hidden;
  }, 25000);
  if (!ready) throw new Error('the forecast page never finished loading');
  // geography.json and the outlines load after the bundle, independently.
  await browser.waitFor(() => !document.getElementById('election-geography').hidden, 3000);
  await settle(300);
  return { server, browser };
}

async function withPage(viewport, options, body) {
  const { server, browser } = await open(viewport, options);
  try {
    await body(browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

function readPanel(browser) {
  return browser.evaluate(() => {
    const section = document.getElementById('election-geography');
    const map = document.getElementById('election-geography-map');
    const luminance = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return {
      hidden: section.hidden,
      display: getComputedStyle(section).display,
      party: section.getAttribute('data-party'),
      mode: section.getAttribute('data-mode'),
      pressedParty: Array.from(document.querySelectorAll('#election-geography-parties [aria-pressed="true"]'))
        .map((node) => node.getAttribute('data-party')),
      pressedMode: Array.from(document.querySelectorAll('#election-geography-modes [aria-pressed="true"]'))
        .map((node) => node.getAttribute('data-mode')),
      changeLabel: document.getElementById('election-geography-mode-change').textContent,
      mainShapes: Array.from(map.querySelectorAll('.egeo-shape')).map((node) => node.getAttribute('data-code')),
      lightness: Object.fromEntries(Array.from(map.querySelectorAll('.egeo-shape'))
        .map((node) => [node.getAttribute('data-code'), luminance(getComputedStyle(node).fill)])),
      insets: Array.from(document.querySelectorAll('#election-geography-insets [data-inset]')).map((svg) => ({
        code: svg.getAttribute('data-inset'),
        focus: svg.querySelector('[data-inset-focus]')?.getAttribute('data-code') || null,
        width: svg.getBoundingClientRect().width,
      })),
      caption: document.getElementById('election-geography-caption').textContent.trim(),
      legend: Array.from(document.querySelectorAll('#election-geography-legend .egeo-legend__labels span'))
        .map((node) => node.textContent),
      detailCode: document.getElementById('election-geography-detail').getAttribute('data-constituency'),
      detail: document.getElementById('election-geography-detail').textContent.replace(/\s+/g, ' ').trim(),
      chosen: Array.from(map.querySelectorAll('.egeo-shape.is-chosen')).map((node) => node.getAttribute('data-code')),
      rows: Array.from(document.querySelectorAll('#election-geography-table tbody tr'))
        .map((row) => row.getAttribute('data-code')),
      pressedRows: Array.from(document.querySelectorAll('#election-geography-table .egeo-pick[aria-pressed="true"]'))
        .map((node) => node.getAttribute('data-code')),
      sort: Array.from(document.querySelectorAll('#election-geography-table th[aria-sort]'))
        .map((th) => `${th.querySelector('[data-sort]').getAttribute('data-sort')}:${th.getAttribute('aria-sort')}`),
      note: document.getElementById('election-geography-note').textContent,
      alternatives: !document.getElementById('election-alternatives').hidden,
      builder: !document.getElementById('election-government-builder').hidden,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const press = (browser, selector) => browser.evaluate((wanted) => {
  const node = document.querySelector(wanted);
  if (!node) return false;
  node.click();
  return true;
}, selector);
const pointAt = (browser, code) => browser.evaluate((wanted) => {
  const node = document.querySelector(`#election-geography-map .egeo-shape[data-code="${wanted}"]`);
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}, code);
const leaveMap = (browser) => browser.evaluate(() => {
  document.getElementById('election-geography-map').dispatchEvent(new MouseEvent('mouseleave'));
});

// --- 1. a schema-1.4 publication has no map --------------------------------

console.log('schema 1.4 (pinned live generation)');
await withPage(DESKTOP, { pointer: await pointerFor(SITE, GEOGRAPHY_SOURCE_GENERATION) }, async (browser) => {
  const panel = await readPanel(browser);
  check('the panel stays hidden', panel.hidden && panel.display === 'none', panel.display);
  check('nothing is drawn', panel.mainShapes.length === 0, panel.mainShapes.length);
  check('the coalition panels render', panel.builder && panel.alternatives);
  equal('no console errors', appErrors(browser), []);
});

// --- 2. a valid schema-1.5 publication -------------------------------------

const fixture = await buildGeographySite(SITE);
const rows = fixture.geography.constituencies;
const meanMedian = (party) => rows.reduce((sum, row) => sum + median(row, party), 0) / rows.length;
const opening = PARTIES.reduce((best, party) => (meanMedian(party) > meanMedian(best) ? party : best));
try {
  console.log('schema 1.5 with geography.json (synthetic)');
  await withPage(DESKTOP, { root: fixture.root, pointer: fixture.pointer }, async (browser) => {
    let panel = await readPanel(browser);
    check('the panel is shown', !panel.hidden && panel.display !== 'none', panel.display);
    check('the coalition panels still render under schema 1.5', panel.builder && panel.alternatives);
    equal('every constituency is drawn once on the map, in order', panel.mainShapes,
      rows.map((row) => row.code));
    equal('three insets, each outlining its own constituency',
      panel.insets.map((inset) => [inset.code, inset.focus]), [['01', '01'], ['16', '16'], ['11', '11']]);
    equal('opens on the party with the largest typical constituency share', panel.party, opening);
    equal('one party chip is pressed', panel.pressedParty, [opening]);
    equal('share is the opening measure', [panel.mode, panel.pressedMode], ['share', ['share']]);
    equal('the change toggle names the baseline election', panel.changeLabel, 'Förändring sedan 2026');
    check('the caption names the party and the measure',
      panel.caption.includes(`(${opening}): prognosens median`), panel.caption);

    const ordered = rows.slice().sort((a, b) => median(a, opening) - median(b, opening));
    const inversions = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const lower = ordered[i - 1];
      const higher = ordered[i];
      if (median(higher, opening) > median(lower, opening) &&
          panel.lightness[higher.code] > panel.lightness[lower.code] + 1e-9) {
        inversions.push([lower.code, higher.code]);
      }
    }
    equal('a larger median is never drawn lighter', inversions, []);
    const low = Math.floor(median(ordered[0], opening));
    const high = Math.max(low + 2, Math.ceil(median(ordered.at(-1), opening)));
    equal('the legend spans the whole-percent range of the medians',
      panel.legend, [`${low} %`, `${high} %`]);
    check('the default readout names the highest and lowest constituency',
      panel.detail.includes(ordered.at(-1).name) && panel.detail.includes(ordered[0].name), panel.detail);
    check('the note says the intervals carry national uncertainty only',
      panel.note.includes('bara osäkerheten i riksresultatet'), panel.note);

    // Hover reads one constituency and lets go again.
    const probe = rows[4];
    await pointAt(browser, probe.code);
    await settle(100);
    panel = await readPanel(browser);
    equal('hovering reads that constituency', panel.detailCode, probe.code);
    const q = probe.parties[opening].vote_share_quantiles;
    check('the readout carries its median and 90 % interval',
      panel.detail.includes(probe.name) && panel.detail.includes(q.p50.toFixed(1).replace('.', ',')) &&
      panel.detail.includes(`${q.p05.toFixed(1).replace('.', ',')}–${q.p95.toFixed(1).replace('.', ',')}`),
      panel.detail);
    await leaveMap(browser);
    await settle(100);
    panel = await readPanel(browser);
    equal('leaving the map returns to the overview', panel.detailCode, '');

    // Choosing on the map persists and is mirrored in the table.
    await browser.evaluate((code) => document.querySelector(
      `#election-geography-map .egeo-shape[data-code="${code}"]`).dispatchEvent(
      new MouseEvent('click', { bubbles: true })), probe.code);
    await leaveMap(browser);
    await settle(100);
    panel = await readPanel(browser);
    equal('a clicked constituency stays chosen', [panel.detailCode, panel.chosen], [probe.code, [probe.code]]);
    equal('the table marks the same constituency', panel.pressedRows, [probe.code]);

    // The table is the keyboard route: one button per constituency.
    await press(browser, '#election-geography-table-wrap summary');
    await press(browser, '#election-geography-table .egeo-pick[data-code="16"]');
    await settle(100);
    panel = await readPanel(browser);
    equal('choosing in the table moves the map and readout', [panel.detailCode, panel.chosen], ['16', ['16']]);
    equal('focus stays on the chosen constituency\'s button',
      await browser.evaluate(() => document.activeElement?.getAttribute('data-code')), '16');
    equal('the table lists all 29 constituencies', panel.rows.length, 29);
    await press(browser, '#election-geography-table [data-sort="median"]');
    await settle(100);
    panel = await readPanel(browser);
    equal('sorting by median puts the highest first',
      panel.rows.slice(0, 3), ordered.slice().reverse().slice(0, 3).map((row) => row.code));
    check('the sorted column reports its order', panel.sort.includes('median:descending'), panel.sort);
    await press(browser, '#election-geography-table [data-sort="median"]');
    await settle(100);
    panel = await readPanel(browser);
    equal('sorting again reverses it', panel.rows[0], ordered[0].code);

    // Another party, then the change measure.
    await press(browser, '#election-geography-parties [data-party="M"]');
    await settle(100);
    panel = await readPanel(browser);
    equal('a party chip switches the map', [panel.party, panel.pressedParty], ['M', ['M']]);
    check('the caption follows', panel.caption.startsWith('Moderaterna (M): '), panel.caption);
    await press(browser, '#election-geography-modes [data-mode="change"]');
    await settle(100);
    panel = await readPanel(browser);
    equal('the change measure is selected', [panel.mode, panel.pressedMode], ['change', ['change']]);
    check('the change caption names the baseline', panel.caption.includes('minus valresultatet 2026'), panel.caption);
    check('the change legend is symmetric around zero',
      panel.legend.length === 3 && panel.legend[1] === '0' &&
      panel.legend[0].replace('−', '') === panel.legend[2].replace('+', ''), panel.legend);

    // A party chosen elsewhere on the page carries over to the map.
    await browser.evaluate(() => Array.from(document.querySelectorAll('#election-party-cards .ev-head'))
      .find((node) => node.getAttribute('aria-label').startsWith('Sverigedemokraterna (SD)')).click());
    await settle(100);
    panel = await readPanel(browser);
    equal('the map follows a party selected in the vote rows', panel.party, 'SD');
    equal('no console errors', appErrors(browser), []);
  });

  console.log('schema 1.5 at 360 px');
  await withPage(MOBILE, { root: fixture.root, pointer: fixture.pointer }, async (browser) => {
    const panel = await readPanel(browser);
    check('the panel is shown on a phone', !panel.hidden);
    check('no horizontal overflow', panel.overflow <= 0, panel.overflow);
    check('the insets are legible', panel.insets.every((inset) => inset.width >= 80), panel.insets);
  });
} finally {
  await fixture.cleanup();
}

// --- 3. fails closed ---------------------------------------------------------

const INVALID = 'not a valid constituency summary';
const broken = [
  ['bytes that do not match the manifest', 'manifest hash',
    { tamper: (text) => text.replace('"p50": ', '"p50":  ') }],
  ['another forecast\'s sample count', INVALID,
    { mutate: ({ geography }) => { geography.sample_count -= 1; } }],
  ['another simulation payload', INVALID,
    { mutate: ({ geography }) => { geography.deterministic_payload_sha256 = '0'.repeat(64); } }],
  ['largest-party chances that do not sum to one', INVALID, { mutate: ({ geography }) => {
    geography.constituencies[3].parties.M.prob_largest += 0.5;
  } }],
  ['a constituency name the outlines do not carry', 'boundaries do not match', { mutate: ({ geography }) => {
    geography.constituencies[0].name = 'Stockholm';
  } }],
  // Not an error at all: the publication simply has no map.
  ['a 1.5 publication that does not advertise the file', null, { withGeography: false }],
];
for (const [label, reason, options] of broken) {
  console.log(`fails closed: ${label}`);
  const site = await buildGeographySite(SITE, options);
  try {
    await withPage(DESKTOP, { root: site.root, pointer: site.pointer }, async (browser) => {
      const panel = await readPanel(browser);
      check('the panel stays hidden', panel.hidden && panel.mainShapes.length === 0, panel.mainShapes.length);
      check('the rest of the page renders', panel.builder && panel.alternatives);
      equal('no console errors', appErrors(browser), []);
      const warnings = browser.consoleAll.map((entry) => entry.text)
        .filter((text) => text.includes('Valkretskartan'));
      if (reason) {
        check(`rejected because: ${reason}`, warnings.some((text) => text.includes(reason)), warnings);
      } else {
        equal('nothing is reported', warnings, []);
      }
    });
  } finally {
    await site.cleanup();
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
