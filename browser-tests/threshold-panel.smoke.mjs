// The 4 % threshold panel: who it shows, what it prints, and what it explains.
//
// The panel exists because the national threshold is the one place where a
// small move in vote share stops being a small move in seats. Its risk is not
// the arithmetic -- every number is published -- but the *selection*: a panel
// whose membership drifts with whoever last looked at the numbers is a panel
// that editorialises. So the rule is fixed in code and pinned here:
//
//   eligible_for_national_threshold && threshold_probability_defined
//   && ( prob_above_4pct <= 0.99 || vote_share_p05 <= 4 <= vote_share_p95 )
//
// Both limbs are load-bearing, and two *real* published generations show why:
//
//   * 20260906T081926Z-92521273 -- L at 10 %, interval 1,2–4,4 %. The interval
//     straddles the line, which is the obvious case.
//   * 20260827T205828Z-e6c6ee97 -- L at 0,01 %, interval 1,06–3,29 %. The
//     interval lies entirely *below* 4, so an interval-only rule would drop
//     precisely the party most at risk of falling out. The probability limb
//     is what keeps it.
//
// The remaining corners -- the 0.99 boundary in both directions, the interval
// limb rescuing a high-probability party, both eligibility flags, and the
// empty panel -- have no published generation, so they are driven by a
// synthetic parties.json served from a throwaway copy of the built site. That
// file is a fixture, never a release gate: see SYNTHETIC below.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/threshold-panel.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';
import { readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const VERSIONS = 'files/election-simulator/versions';

// L straddles the line here: interval 1,2–4,4 %, probability 10 %.
const STRADDLE_GENERATION = '20260906T081926Z-92521273';
// L sits entirely below the line here: interval 1,06–3,29 %, probability
// 0,01 %. Selected by the probability limb alone.
const BELOW_GENERATION = '20260827T205828Z-e6c6ee97';

const NBSP = '\u00a0';
const THRESHOLD_PCT = 4;
const NEAR_CERTAIN = 0.99;

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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));

// --- expectations ----------------------------------------------------------

// The page's rules, restated rather than imported: the point is to pin the
// behaviour, not to re-run the implementation against itself.
function thresholdRelevant(party) {
  if (party.eligible_for_national_threshold !== true) return false;
  if (party.threshold_probability_defined !== true) return false;
  const straddles = party.vote_share_p05 <= THRESHOLD_PCT &&
    THRESHOLD_PCT <= party.vote_share_p95;
  return party.prob_above_4pct <= NEAR_CERTAIN || straddles;
}

function headlineProbability(value) {
  if (value <= 0) return `0${NBSP}%`;
  if (value >= 1) return `100${NBSP}%`;
  const pct = value * 100;
  if (pct < 1) return `<1${NBSP}%`;
  if (pct > 99) return `>99${NBSP}%`;
  return `${Math.round(pct)}${NBSP}%`;
}

const swedish = (value, digits) => value.toFixed(digits).replace('.', ',');
const percent = (value) => `${swedish(value, 1)}${NBSP}%`;
const percentRange = (low, high) => `${swedish(low, 1)}–${swedish(high, 1)}${NBSP}%`;

async function expectedRows(generation) {
  const parties = await readJson(SITE, VERSIONS, generation, 'parties.json');
  const order = parties.party_order;
  return parties.parties
    .filter(thresholdRelevant)
    .sort((a, b) => order.indexOf(a.party) - order.indexOf(b.party))
    .map((party) => ({
      party: party.party,
      median: percent(party.vote_share_median),
      interval: percentRange(party.vote_share_p05, party.vote_share_p95),
      probability: headlineProbability(party.prob_above_4pct),
      exact: String(party.prob_above_4pct),
    }));
}

// --- the page --------------------------------------------------------------

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const cards = document.getElementById('election-party-cards');
    return Boolean(status) && (status.hidden || status.className.includes('error')) &&
      Boolean(cards) && cards.childElementCount > 0;
  }, 25000);
  if (!settled) throw new Error('the forecast page never finished loading');
  await settle(300);
}

async function open(viewport, { root = SITE, pointer = null } = {}) {
  const server = await serve(root, { port: 4000, pointer });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

const readPanel = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? flat(node.textContent) : null;
  };
  const section = document.getElementById('election-threshold');
  const app = document.getElementById('election-simulator-app');
  const zero = document.getElementById('election-threshold-zero-seats');
  const rowsHost = document.getElementById('election-threshold-rows');

  return {
    exists: Boolean(section),
    hidden: section ? section.hidden : null,
    display: section ? getComputedStyle(section).display : null,
    sectionOrder: Array.from(app.children).map((child) => child.id).filter(Boolean),
    heading: text('#election-threshold-title'),
    intro: text('#election-threshold-intro'),
    discontinuity: text('#election-threshold-discontinuity'),
    exception: text('#election-threshold-exception'),
    // Provenance moved out of the panel: a visitor does not need a field name.
    panelText: flat(section ? section.textContent : ''),
    technical: Array.from(document.querySelectorAll('#election-meta-list div'))
      .map((row) => `${flat(row.querySelector('dt').textContent)} = ` +
        `${flat(row.querySelector('dd').textContent)}`),
    zeroHidden: zero ? zero.hidden : null,
    zeroText: zero ? flat(zero.textContent) : null,
    listRole: rowsHost ? rowsHost.getAttribute('role') : null,
    headerHidden: (() => {
      const head = document.querySelector('.et-row--head');
      if (!head) return null;
      return { aria: head.getAttribute('aria-hidden'),
        display: getComputedStyle(head).display };
    })(),
    rows: Array.from(document.querySelectorAll('.et-row:not(.et-row--head)')).map((row) => ({
      party: row.getAttribute('data-threshold-party'),
      median: flat(row.querySelector('[data-threshold-median]').textContent),
      interval: flat(row.querySelector('[data-threshold-interval]').textContent),
      probability: flat(row.querySelector('[data-threshold-probability]').textContent),
      exact: row.getAttribute('data-prob-above-4pct'),
      exactMedian: row.getAttribute('data-vote-median'),
      exactLow: row.getAttribute('data-vote-p05'),
      exactHigh: row.getAttribute('data-vote-p95'),
      role: row.getAttribute('role'),
      label: row.getAttribute('aria-label'),
      abbr: flat(row.querySelector('.et-abbr').textContent),
      top: Math.round(row.getBoundingClientRect().top),
      bottom: Math.round(row.getBoundingClientRect().bottom),
      // Stacked when the party cell owns a line of its own.
      partyCellStacked: (() => {
        const party = row.querySelector('.et-cell--party').getBoundingClientRect();
        const median = row.querySelector('[data-threshold-median]')
          .closest('.et-cell').getBoundingClientRect();
        return median.top >= party.bottom - 1;
      })(),
      captionShown: getComputedStyle(row.querySelector('.et-label')).display !== 'none',
    })),
    // Everything the vote rows already show, to check the panel is a triage
    // and not a second copy of the party list.
    partyCardCount: document.querySelectorAll('#election-party-cards .ev-head').length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

async function assertServedGeneration(browser, generation) {
  const served = await browser.evaluate(async () => {
    const res = await fetch('/files/election-simulator/current.json', { cache: 'no-store' });
    return (await res.json()).publication_generation;
  });
  equal('the page was served the pinned generation', served, generation);
}

// --- real published generations --------------------------------------------

async function published(generation, title, documented) {
  console.log(`\n${title} (${generation})`);
  const parties = await readJson(SITE, VERSIONS, generation, 'parties.json');
  const rows = await expectedRows(generation);
  const byName = (name) => parties.parties.find((party) => party.party === name);

  const { server, browser } = await open(DESKTOP, { pointer: await pointerFor(SITE, generation) });
  try {
    await assertServedGeneration(browser, generation);
    const page = await readPanel(browser);

    equal('the panel is visible', [page.exists, page.hidden], [true, false]);
    check('the panel is painted, not just unhidden', page.display !== 'none', page.display);
    equal('the panel sits directly above the full vote-share list',
      page.sectionOrder.filter((id) =>
        id === 'election-threshold' || id === 'election-headline'),
      ['election-threshold', 'election-headline']);

    // --- selection ---
    equal('exactly the threshold-relevant parties are shown',
      page.rows.map((row) => row.party), rows.map((row) => row.party));
    equal('the documented selection for this generation', rows.map((row) => row.party),
      documented.parties);
    check('the panel is a triage, not a copy of the party list',
      page.rows.length < page.partyCardCount,
      { panel: page.rows.length, cards: page.partyCardCount });

    // --- values, straight from parties.json ---
    equal('each row prints the published median, interval and probability',
      page.rows.map((row) => ({
        party: row.party, median: row.median,
        interval: row.interval, probability: row.probability, exact: row.exact,
      })), rows);
    equal('the documented headline for this generation',
      page.rows.map((row) => row.probability), documented.printed);
    equal('the exact published values are kept on the row',
      page.rows.map((row) => [row.exact, row.exactMedian, row.exactLow, row.exactHigh]),
      rows.map((row) => {
        const party = byName(row.party);
        return [String(party.prob_above_4pct), String(party.vote_share_median),
          String(party.vote_share_p05), String(party.vote_share_p95)];
      }));
    check('the rounded headline is not what the data attribute carries',
      page.rows.every((row) => row.probability !== row.exact),
      page.rows.map((row) => [row.probability, row.exact]));
    check('the interval is the published p05 to p95, at one decimal',
      page.rows.every((row) => /^\d+,\d–\d+,\d\u00a0%$/.test(row.interval)),
      page.rows.map((row) => row.interval));

    // --- REST and anything else the publication marks ineligible ---
    check('REST is excluded even though it publishes a probability of its own',
      !page.rows.some((row) => row.party === 'REST') &&
      byName('REST').prob_above_4pct > 0 &&
      byName('REST').eligible_for_national_threshold === false,
      { rest: byName('REST').prob_above_4pct });
    check('every shown party is one the publication marks eligible and defined',
      page.rows.every((row) => {
        const party = byName(row.party);
        return party.eligible_for_national_threshold === true &&
          party.threshold_probability_defined === true;
      }), page.rows.map((row) => row.party));

    // --- what the panel explains ---
    check('the intro says 4 % is the national threshold',
      /4 ?%/.test(page.intro) && /hela landet/.test(page.intro), page.intro);
    check('the panel explains the discontinuity the threshold creates',
      /noll mandat/.test(page.discontinuity) &&
      /inte en jämn osäkerhet i mandat/.test(page.discontinuity), page.discontinuity);
    // The 4 % rule is the main rule, not the only one.
    check('the intro says 4 % is the main rule rather than an absolute one',
      /Huvudregeln/.test(page.intro) && !/krävs minst 4/.test(page.intro), page.intro);
    check('the constituency exception is stated, and scoped',
      new RegExp(`12${NBSP}%`).test(page.exception) &&
      /enskild valkrets/.test(page.exception) &&
      /fasta mandat/.test(page.exception) &&
      /Sannolikheten i tabellen gäller huvudregeln/.test(page.exception), page.exception);
    // ...but no probability is attached to it. The publication carries the
    // local exception in a field of its own (prob_local_12pct_exception_sub_4pct)
    // and this page does not speak for it, so the note states the two statutory
    // percentages and nothing that could read as a third, estimated one.
    equal('the exception states the two rule percentages and no third figure',
      page.exception.match(new RegExp(`\\d+(?:,\\d+)?${NBSP}%`, 'g')),
      [`12${NBSP}%`, `4${NBSP}%`]);
    check('and the panel never names the local-exception field',
      !/prob_local/.test(page.panelText), page.panelText);

    // Provenance is a technical fact, not reader copy.
    check('the panel carries no implementation vocabulary',
      !/prob_above_4pct/.test(page.panelText) &&
      !/räknas inte om/.test(page.panelText) &&
      !/parties\.json/.test(page.panelText), page.panelText);
    check('and the provenance is stated in the technical section instead',
      page.technical.some((row) => /^Spärrsannolikhet = /.test(row) &&
        /prob_above_4pct/.test(row) && /beräknas inte om/.test(row)),
      page.technical.filter((row) => /Spärr/.test(row)));

    // The zero-seat sentence is only claimed when a shown party actually has
    // a zero seat median and a non-zero chance -- never as decoration.
    const zeroSeatParties = rows.map((row) => byName(row.party))
      .filter((party) => party.seats_median === 0 && party.prob_above_4pct > 0);
    equal('the zero-seat explanation matches what is on screen',
      page.zeroHidden, zeroSeatParties.length === 0);
    if (zeroSeatParties.length) {
      check('and it names the parties it is about',
        /Noll mandat i median betyder inte noll chans/.test(page.zeroText) &&
        zeroSeatParties.every((party) => page.zeroText.includes(party.party)),
        page.zeroText);
    }

    // --- accessibility ---
    equal('the rows are a list, so the hidden header strip costs nothing',
      [page.listRole, page.rows.map((row) => row.role)],
      ['list', page.rows.map(() => 'listitem')]);
    equal('the header strip is decoration only', page.headerHidden.aria, 'true');
    check('each row speaks its own numbers',
      page.rows.every((row) => row.label.includes('sannolikhet att nå fyraprocentsspärren') &&
        row.label.includes(row.probability)), page.rows.map((row) => row.label));

    equal('no horizontal overflow', page.overflow, 0);
    equal('no console errors', appErrors(browser), []);
    equal('no uncaught exceptions', browser.exceptions, []);
    return page;
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- synthetic corners -----------------------------------------------------
//
// SYNTHETIC. These runs rewrite parties.json in a throwaway copy of the built
// site, keeping deterministic_payload_sha256 so the publication still
// validates. It is a fixture for the selection rule and must never be a
// release gate: the two published runs above are what assert real numbers.

// One party per corner of the rule, mapped onto the real party codes so names,
// colours and the vote rows below keep working. Expected to select L, C, KD.
const SYNTHETIC = {
  // interval limb only: probability reads high, interval still straddles 4
  C: { median: 4.2, p05: 3.9, p95: 6.0, prob: 0.999, eligible: true, defined: true },
  // probability limb only: interval lies entirely below 4
  L: { median: 2.0, p05: 1.0, p95: 3.2, prob: 0.004, eligible: true, defined: true },
  // the boundary, included: prob_above_4pct === 0.99 exactly
  KD: { median: 6.0, p05: 5.0, p95: 7.0, prob: 0.99, eligible: true, defined: true },
  // the boundary, excluded: a hair above it, interval clear of the line
  S: { median: 6.0, p05: 5.0, p95: 7.0, prob: 0.9901, eligible: true, defined: true },
  // would qualify on the numbers, but the publication says it cannot
  V: { median: 3.0, p05: 1.0, p95: 5.0, prob: 0.30, eligible: false, defined: true },
  // eligible, but the publication does not define a threshold probability
  MP: { median: 3.0, p05: 1.0, p95: 5.0, prob: 0.30, eligible: true, defined: false },
  // obviously safe
  M: { median: 18.0, p05: 15.0, p95: 21.0, prob: 1.0, eligible: true, defined: true },
  SD: { median: 19.0, p05: 17.0, p95: 21.0, prob: 1.0, eligible: true, defined: true },
};

const SAFE_EVERYWHERE = Object.fromEntries(Object.keys(SYNTHETIC).map((party) => [party,
  { median: 12.5, p05: 10.0, p95: 15.0, prob: 1.0, eligible: true, defined: true }]));

async function withSyntheticParties(spec, run) {
  const root = await mkdtemp(join(tmpdir(), 'threshold-panel-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    const relative = join(VERSIONS, STRADDLE_GENERATION, 'parties.json');
    const parties = await readJson(SITE, relative);
    parties.parties = parties.parties.map((party) => {
      const wanted = spec[party.party];
      if (!wanted) return party;
      return {
        ...party,
        vote_share_median: wanted.median,
        vote_share_p05: wanted.p05,
        vote_share_p95: wanted.p95,
        prob_above_4pct: wanted.prob,
        prob_below_4pct: 1 - wanted.prob,
        eligible_for_national_threshold: wanted.eligible,
        threshold_probability_defined: wanted.defined,
      };
    });
    await writeFile(join(root, relative), `${JSON.stringify(parties, null, 2)}\n`);
    await run(root, parties);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function selectionRule() {
  console.log('\nthe selection rule, corner by corner (synthetic parties.json)');
  await withSyntheticParties(SYNTHETIC, async (root) => {
    const { server, browser } =
      await open(DESKTOP, { root, pointer: await pointerFor(SITE, STRADDLE_GENERATION) });
    try {
      const page = await readPanel(browser);
      equal('only the threshold-relevant parties appear, in party_order',
        page.rows.map((row) => row.party), ['L', 'C', 'KD']);

      // Each exclusion, named, so a failure says which corner broke.
      check('a party a hair above the bound is excluded',
        !page.rows.some((row) => row.party === 'S'), page.rows.map((row) => row.party));
      check('a party exactly at the bound is included',
        page.rows.some((row) => row.party === 'KD'), page.rows.map((row) => row.party));
      check('an ineligible party is excluded however close it looks',
        !page.rows.some((row) => row.party === 'V'), page.rows.map((row) => row.party));
      check('a party with no defined threshold probability is excluded',
        !page.rows.some((row) => row.party === 'MP'), page.rows.map((row) => row.party));
      check('an obviously safe party never appears',
        !page.rows.some((row) => row.party === 'M' || row.party === 'SD'),
        page.rows.map((row) => row.party));
      check('the interval limb keeps a high-probability party that straddles the line',
        page.rows.some((row) => row.party === 'C' && row.probability === `>99${NBSP}%`),
        page.rows.map((row) => [row.party, row.probability]));
      check('the probability limb keeps a party whose interval is entirely below 4',
        page.rows.some((row) => row.party === 'L' && row.interval === `1,0–3,2${NBSP}%`),
        page.rows.map((row) => [row.party, row.interval]));

      // All three rounding behaviours, in one panel.
      equal('the panel rounds like the bloc headline does',
        page.rows.map((row) => row.probability),
        [`<1${NBSP}%`, `>99${NBSP}%`, `99${NBSP}%`]);
      equal('and keeps the exact values behind them',
        page.rows.map((row) => row.exact), ['0.004', '0.999', '0.99']);

      equal('the synthetic run has no console errors', appErrors(browser), []);
      equal('the synthetic run has no uncaught exceptions', browser.exceptions, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });
}

async function noPartyRelevant() {
  console.log('\nno party satisfies the rule (synthetic parties.json)');
  await withSyntheticParties(SAFE_EVERYWHERE, async (root, parties) => {
    check('no eligible party would qualify',
      !parties.parties.some(thresholdRelevant),
      parties.parties.filter(thresholdRelevant).map((party) => party.party));

    const { server, browser } =
      await open(DESKTOP, { root, pointer: await pointerFor(SITE, STRADDLE_GENERATION) });
    try {
      const page = await readPanel(browser);
      // Hidden, not an empty shell and not a panel announcing it has nothing
      // to say: every party's own threshold probability is on its card anyway.
      equal('the panel hides itself rather than showing an empty table',
        [page.hidden, page.rows.length], [true, 0]);
      equal('and it is not painted', page.display, 'none');
      check('the rest of the page still renders',
        page.partyCardCount === 9, page.partyCardCount);
      equal('the empty-state run has no console errors', appErrors(browser), []);
      equal('the empty-state run has no uncaught exceptions', browser.exceptions, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });
}

async function mobile() {
  console.log(`\nmobile structure (${STRADDLE_GENERATION})`);
  const rows = await expectedRows(STRADDLE_GENERATION);
  const { server, browser } =
    await open(MOBILE, { pointer: await pointerFor(SITE, STRADDLE_GENERATION) });
  try {
    const page = await readPanel(browser);
    equal('the same rows survive the narrow layout',
      page.rows.map((row) => row.party), rows.map((row) => row.party));
    equal('and print the same numbers',
      page.rows.map((row) => [row.median, row.interval, row.probability]),
      rows.map((row) => [row.median, row.interval, row.probability]));
    // Four columns do not fit a phone, so the row stacks and each number
    // brings back its own caption in place of the hidden header strip.
    equal('the header strip is gone at phone width', page.headerHidden.display, 'none');
    check('the party gets a line of its own',
      page.rows.every((row) => row.partyCellStacked), page.rows.map((row) => row.partyCellStacked));
    check('each number carries its own caption instead',
      page.rows.every((row) => row.captionShown), page.rows.map((row) => row.captionShown));
    check('the explanations survive',
      /Huvudregeln/.test(page.intro) && /enskild valkrets/.test(page.exception) &&
      /inte en jämn osäkerhet i mandat/.test(page.discontinuity),
      { intro: page.intro, exception: page.exception });
    check('the mobile page has no horizontal overflow', page.overflow <= 0, page.overflow);
    equal('mobile has no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// Two properties about how a number was obtained rather than what it reads.
async function sourceGuard() {
  console.log('\nsource guards');
  const source = await readFile(
    new URL('../assets/js/election-simulator.js', import.meta.url), 'utf8');
  const page = await readFile(
    new URL('../_pages/election_simulator.md', import.meta.url), 'utf8');
  const renderer = source.slice(
    source.indexOf('function renderThresholdPanel'),
    source.indexOf('// 2. Historical coalition forecast') === -1
      ? source.indexOf('Historical coalition forecast')
      : source.indexOf('// 2. Historical coalition forecast'));

  check('the panel reads the published probability and derives nothing',
    renderer.length > 0 &&
    renderer.includes('party.prob_above_4pct') &&
    !/seat_histogram|total_samples|Math\.(exp|log|sqrt)|normal|erf/.test(renderer),
    renderer.length);
  check('it never speaks for the local 12 % exception',
    !/prob_local_12pct|12\s*%|twelve/.test(renderer));
  // The publication decides who may be shown, not the party's name.
  check('eligibility is read from the published flags, not from a name list',
    source.includes('party.eligible_for_national_threshold !== true') &&
    source.includes('party.threshold_probability_defined !== true') &&
    !/thresholdRelevant[\s\S]{0,400}?"REST"/.test(source));
  check('the two limbs of the rule are both present',
    source.includes('probability <= THRESHOLD_NEAR_CERTAIN || straddles'));
  // The bound is the rounding convention's own, so the panel can never show a
  // row whose headline says there is nothing to worry about.
  check('the bound is where the headline stops printing a figure',
    source.includes('var THRESHOLD_NEAR_CERTAIN = 0.99;') &&
    source.includes('if (pct > 99) return ">99"'));
  check('the panel reuses the bloc headline rounding',
    /renderThresholdPanel[\s\S]{0,2000}?headlineProbability\(party\.prob_above_4pct\)/.test(source));
  check('the explanatory copy lives in the markup, not in a string',
    page.includes('election-threshold-discontinuity') &&
    page.includes('election-threshold-exception') &&
    page.includes('election-threshold-zero-seats'));
  check('the field name is named once, in the technical rows',
    (source.match(/prob_above_4pct \(publicerad/g) || []).length === 1 &&
    !page.includes('prob_above_4pct'));
  check('no forecasting logic was touched',
    source.includes('function probability(') &&
    source.includes('function histogramProbability(') &&
    source.includes('function headlineProbability('));
}

await sourceGuard();
await published(STRADDLE_GENERATION, 'a party straddling the line',
  { parties: ['L'], printed: [`10${NBSP}%`] });
await published(BELOW_GENERATION, 'a party entirely below the line',
  { parties: ['L'], printed: [`<1${NBSP}%`] });
await selectionRule();
await noPartyRelevant();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('FAIL');
  process.exit(1);
}
console.log(`PASS (${STRADDLE_GENERATION}, ${BELOW_GENERATION}, synthetic corners)`);
