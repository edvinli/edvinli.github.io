// Real-browser smoke test for the per-party view of "Vägen till valdagen".
//
// Two modes, and the difference matters for release validation.
//
// FIXTURE MODE (default) overlays browser-tests/fixtures/coalition-timeseries.json
// onto a throwaway copy of the built site. That is what makes the mutation and
// fail-closed matrix deterministic -- every scenario is a controlled edit of a
// known artifact -- and it is why the default must keep overwriting history.
//
// REAL-ARTIFACT MODE (--real-artifact, or --no-fixture to match the screenshot
// helper) reads the history the supplied site actually ships, copies nothing
// and overwrites nothing, and validates it before driving the browser against
// it. This is the mode that proves a *newly generated production artifact*
// works: in fixture mode `party-timeseries.smoke.mjs _site` would look
// reassuring while testing the committed fixture, so the publication gate must
// use the real-artifact form.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/party-timeseries.smoke.mjs [path/to/_site]
//   node browser-tests/party-timeseries.smoke.mjs _site --real-artifact

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './cdp.mjs';
import { serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
// Position-independent, so both `_site --real-artifact` and
// `--real-artifact _site` work; the gate will use the former.
const REAL_ARTIFACT = ARGV.includes('--real-artifact') || ARGV.includes('--no-fixture');
const SITE = resolve(ARGV.find((value) => !value.startsWith('--')) || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';
const PUBLICATION_DIR = join('files', 'election-simulator');
const HISTORY_RELATIVE = join(PUBLICATION_DIR, 'history', 'coalition-timeseries.json');
const POINTER_RELATIVE = join(PUBLICATION_DIR, 'current.json');
const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const QUANTILES = ['p05', 'p25', 'p50', 'p75', 'p95'];
// parties.json field names for the five published quantiles.
const VOTE_FIELDS = ['vote_share_p05', 'vote_share_p25', 'vote_share_median',
  'vote_share_p75', 'vote_share_p95'];
const SEAT_FIELDS = ['seats_p05', 'seats_p25', 'seats_median', 'seats_p75', 'seats_p95'];
const VIEWPORTS = [
  { name: 'desktop (1280x1000)', diagnostic: 'desktop', width: 1280, height: 1000, coarse: false },
  { name: 'narrow-360 (360x900)', diagnostic: 'mobile', width: 360, height: 900, coarse: true },
];

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

const settle = (ms = 200) => new Promise((done) => setTimeout(done, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));

async function diagnostic(message) {
  if (!process.stdout.write(`[party-timeseries] ${message}\n`)) {
    await once(process.stdout, 'drain');
  }
}

async function closeBrowser(browser, server) {
  const results = await Promise.allSettled([browser?.close(), server?.close()]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

// FIXTURE MODE ONLY. This deliberately overwrites the site's history with the
// committed fixture, which is what makes the mutation matrix deterministic --
// and is exactly why it must never be the path a release gate takes. See
// readSiteHistory() for the real-artifact path.
async function prepareSite(transform = (history) => history) {
  const fixturePath = join(HERE, 'fixtures', 'coalition-timeseries.json');
  const history = transform(structuredClone(JSON.parse(await readFile(fixturePath, 'utf8'))));
  const root = await mkdtemp(join(tmpdir(), 'party-timeseries-site-'));
  await cp(SITE, root, { recursive: true });
  const historyPath = join(root, HISTORY_RELATIVE);
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history)}\n`);
  return { root, history, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const section = document.getElementById('election-timeseries');
    const svg = document.getElementById('election-timeseries-svg');
    return Boolean(status) && Boolean(section) && !section.hidden &&
      Boolean(svg) && svg.childElementCount > 2;
  }, 25000);
  if (!settled) throw new Error('the historical chart never finished loading');
  await settle(350);
}

async function open(viewport, siteRoot) {
  const server = await serve(siteRoot, { port: 4000 });
  let browser;
  try {
    browser = await launch({ width: viewport.width, height: viewport.height });
    if (viewport.coarse) {
      await browser.S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await browser.goto(`http://localhost:${server.port}${PAGE}`, { timeout: 30000 });
    await waitForApp(browser);
    return { server, browser };
  } catch (error) {
    await closeBrowser(browser, server);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Page probes
// ---------------------------------------------------------------------------

function readState(browser) {
  return browser.evaluate(() => {
    const section = document.getElementById('election-timeseries');
    const svg = document.getElementById('election-timeseries-svg');
    const partyHost = document.getElementById('election-timeseries-parties');
    const coalitionHost = document.getElementById('election-timeseries-coalitions');
    const viewHost = document.getElementById('election-timeseries-view');
    const partyNote = document.getElementById('election-timeseries-party-note');
    // getComputedStyle reports an element's *own* display, so a child of a
    // display:none parent still answers "inline". getClientRects() is empty
    // for anything not actually laid out, ancestors included, which is what
    // "visible" has to mean here.
    const visible = (node) => {
      if (!node || node.hidden) return false;
      const style = window.getComputedStyle(node);
      return node.getClientRects().length > 0 && style.visibility !== 'hidden';
    };
    const marks = (selector) => Array.from(svg ? svg.querySelectorAll(selector) : []);
    return {
      viewMode: section?.getAttribute('data-view-mode') || null,
      partyViewState: section?.getAttribute('data-party-view-state') || null,
      partyPointCount: Number(section?.getAttribute('data-party-point-count') || 0),
      selectedParties: (svg?.getAttribute('data-selected-parties') || '')
        .split(',').filter(Boolean),
      metric: svg?.getAttribute('data-metric') || null,
      range: svg?.getAttribute('data-range') || null,
      rangePressed: ['election-timeseries-range-full', 'election-timeseries-range-short']
        .map((id) => document.getElementById(id)?.getAttribute('aria-pressed') || null),
      yMin: Number(svg?.getAttribute('data-y-min')),
      yMax: Number(svg?.getAttribute('data-y-max')),
      yDomainMode: svg?.getAttribute('data-y-domain-mode') || null,
      thresholdVisible: svg?.getAttribute('data-threshold-visible') || null,
      viewSwitchVisible: visible(viewHost),
      partyHostVisible: visible(partyHost),
      coalitionHostVisible: visible(coalitionHost),
      partyNoteVisible: visible(partyNote),
      partyButtons: Array.from(partyHost ? partyHost.querySelectorAll('button') : [])
        .map((button) => ({
          party: button.getAttribute('data-party'),
          pressed: button.getAttribute('aria-pressed'),
          label: (button.textContent || '').trim(),
          tabIndex: button.tabIndex,
        })),
      seriesDefinitions: marks('[data-coalition][data-quantile="p50"]')
        .map((node) => node.getAttribute('data-coalition')),
      pollDefinitions: Array.from(new Set(marks('[data-poll-point]')
        .map((node) => node.getAttribute('data-coalition')))),
      polls: marks('[data-poll-point]').map((node) => ({
        definition: node.getAttribute('data-coalition'),
        date: node.getAttribute('data-date'),
        value: Number(node.getAttribute('data-value')),
        cy: Number(node.getAttribute('cy')),
      })),
      // The chart ends at the latest certified forecast, so every mark kind
      // that used to live to the right of it must be absent in both modes.
      forwardMarkCount: marks(
        '[data-future-region],[data-future-series="true"],[data-future-point="true"],'
        + '[data-future-band],[data-future-median="true"],[data-campaign-path],'
        + '[data-campaign-band],[data-campaign-point],[data-origin-state-point],'
        + '[data-origin-state-interval],[data-election-day-point],'
        + '[data-election-day-interval],[data-election-day-boundary],'
        + '[data-latest-forecast-boundary]',
      ).length,
      forwardControlIds: [
        'election-timeseries-future', 'election-timeseries-future-paths',
        'election-timeseries-future-stability', 'election-timeseries-campaign-cue',
      ].filter((id) => Boolean(document.getElementById(id))),
      forecastPoints: marks('[data-forecast-point]').map((node) => ({
        definition: node.getAttribute('data-coalition'),
        date: node.getAttribute('data-date'),
        p50: Number(node.getAttribute('data-p50')),
        cy: Number(node.getAttribute('cy')),
        tabIndex: node.tabIndex,
      })),
      thresholdLine: marks('[data-threshold-line]').map((node) => ({
        value: Number(node.getAttribute('data-national-threshold')),
        y: Number(node.getAttribute('y1')),
      })),
      thresholdLabel: marks('[data-threshold-label]').map((node) => (node.textContent || '').trim()),
      majorityLines: marks('[data-majority]').length,
      plot: (() => {
        const grid = svg?.querySelector('.election-timeseries__grid-line');
        return grid ? { top: Number(grid.getAttribute('y1')) } : null;
      })(),
      yTicks: marks('[data-y-tick]').map((node) => Number(node.getAttribute('data-y-tick'))),
      // The hover readout: one median per visible series, printed at the
      // crosshair. The detail panel it replaced must not come back.
      crosshairLabels: marks('[data-crosshair-label="true"]').map((node) => ({
        party: node.getAttribute('data-coalition'),
        date: node.getAttribute('data-date'),
        value: Number(node.getAttribute('data-value')),
        text: (node.textContent || '').replace(/\u00a0/g, ' ').trim(),
      })),
      endpointLabelCount: marks('[data-endpoint-label="true"]').filter(visible).length,
      retiredDetailCount: document.querySelectorAll(
        '#election-timeseries-detail, #election-timeseries-detail-body, .election-timeseries__detail-body',
      ).length,
      status: (document.getElementById('election-timeseries-status')?.textContent || '').trim(),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

function clickId(browser, id) {
  return browser.evaluate((wanted) => {
    const node = document.getElementById(wanted);
    if (!node) return false;
    node.click();
    return true;
  }, id);
}

function clickParty(browser, party) {
  return browser.evaluate((wanted) => {
    const node = document.querySelector(`#election-timeseries-parties button[data-party="${wanted}"]`);
    if (!node) return false;
    node.click();
    return true;
  }, party);
}

// Several checks -- the poll-dot denominator, the threshold, the per-party
// domain -- are statements about one party's own scale, so they need that
// party alone on screen. Pills are toggles now, so isolating is explicit.
function showOnlyParty(browser, party) {
  return browser.evaluate((wanted) => {
    const buttons = Array.from(
      document.querySelectorAll('#election-timeseries-parties button[data-party]'));
    if (!buttons.some((button) => button.getAttribute('data-party') === wanted)) return false;
    buttons.forEach((button) => {
      const on = button.getAttribute('aria-pressed') === 'true';
      const want = button.getAttribute('data-party') === wanted;
      if (on !== want) button.click();
    });
    return true;
  }, party);
}

function plotBox(browser) {
  return browser.evaluate(() => {
    const svg = document.getElementById('election-timeseries-svg');
    const rect = svg?.querySelector('.election-timeseries__hit');
    if (!svg || !rect) return null;
    const box = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scale = box.width / viewBox[2];
    return {
      left: box.left + Number(rect.getAttribute('x')) * scale,
      top: box.top + Number(rect.getAttribute('y')) * scale,
      width: Number(rect.getAttribute('width')) * scale,
      height: Number(rect.getAttribute('height')) * scale,
    };
  });
}

async function movePointer(browser, x, y) {
  await browser.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await settle(140);
}

async function tap(browser, x, y) {
  await browser.S('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y }],
  });
  await browser.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(180);
}

async function pressKey(browser, key, code) {
  await browser.S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: 0 });
  await browser.S('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: 0 });
  await settle(160);
}

// ---------------------------------------------------------------------------
// Fixture-derived expectations
// ---------------------------------------------------------------------------

function certifiedPoint(history) {
  return (history.series || []).filter((point) => point?.provenance === 'current_production')[0];
}

function largestParty(history) {
  const point = certifiedPoint(history);
  return PARTY_ORDER.reduce((best, party) =>
    (best === null || point.parties[party].vote.p50 > point.parties[best].vote.p50 ? party : best), null);
}

function thresholdNearParty(history) {
  const point = certifiedPoint(history);
  return PARTY_ORDER.reduce((best, party) =>
    (best === null || point.parties[party].vote.p50 < point.parties[best].vote.p50 ? party : best), null);
}

// ---------------------------------------------------------------------------
// Real-artifact mode
// ---------------------------------------------------------------------------

// Reads the history the site actually ships. No copy, no overwrite, and
// deliberately no knowledge of browser-tests/fixtures/.
async function readSiteHistory(root) {
  return JSON.parse(await readFile(join(root, HISTORY_RELATIVE), 'utf8'));
}

// Resolves the certified party rows through the publication pointer.
//
// The flat `files/election-simulator/parties.json` at the publication root is
// a *frozen legacy* artifact from before the versioned layout -- for the
// current checkout it still reports M at 18.621 while the pointer-resolved
// generation reports 18.087. Falling back to it would compare a fresh history
// against numbers from a different forecast entirely, which is precisely the
// kind of false reassurance this mode exists to prevent. So the pointer is
// required and there is no fallback.
async function readCertifiedPartyRows(root) {
  const pointer = JSON.parse(await readFile(join(root, POINTER_RELATIVE), 'utf8'));
  const path = String(pointer.path || '');
  if (!/^versions\/[A-Za-z0-9_-]+$/.test(path)) {
    throw new Error(`publication pointer has a malformed path: ${JSON.stringify(pointer.path)}`);
  }
  const parties = JSON.parse(
    await readFile(join(root, PUBLICATION_DIR, path, 'parties.json'), 'utf8'),
  );
  const rows = {};
  (parties.parties || []).forEach((row) => { rows[String(row.party)] = row; });
  return { generation: String(pointer.publication_generation || ''), path, rows };
}

function orderedNumbers(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const values = QUANTILES.map((key) => entry[key]);
  return values.every((value, index) => typeof value === 'number' && Number.isFinite(value) &&
    (index === 0 || value >= values[index - 1]));
}

// Everything the published artifact must satisfy before the UI may expose the
// party view. Returns a list of failures so it can be self-tested directly,
// without a browser and without a port.
function validateRealArtifact(history, certified) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const view = history?.parties_view;
  if (!view || typeof view !== 'object') {
    fail('parties_view is absent: the published history carries no party family. ' +
      'A full history regeneration (without --resume) is what creates it.');
    return problems;
  }
  if (view.schema_version !== '1.0') fail(`parties_view.schema_version is ${view.schema_version}`);
  if (view.role !== 'party_time_series') fail(`parties_view.role is ${view.role}`);
  if (view.vote_share_denominator !== 'all_nine_model_categories_including_rest') {
    fail(`parties_view.vote_share_denominator is ${view.vote_share_denominator}`);
  }
  if (view.vote_share_definition !== 'national_vote_share') {
    fail(`parties_view.vote_share_definition is ${view.vote_share_definition}`);
  }
  if (view.seat_definition !== 'statutory_mandate_allocation') {
    fail(`parties_view.seat_definition is ${view.seat_definition}`);
  }
  if (view.rest_is_a_party !== false) fail('parties_view declares REST as a party');
  if (view.intermediate_seat_trajectory !== false) {
    fail('parties_view declares an intermediate seat trajectory');
  }
  if (view.national_threshold_pct !== 4) {
    fail(`parties_view.national_threshold_pct is ${view.national_threshold_pct}`);
  }
  if (view.election_day_parity?.reconstructed_from_coalitions !== false) {
    fail('parties_view does not disclaim reconstruction from coalition data');
  }
  if (JSON.stringify(view.party_order) !== JSON.stringify(PARTY_ORDER)) {
    fail(`parties_view.party_order is ${JSON.stringify(view.party_order)}`);
  }
  if (JSON.stringify(Object.keys(view.party_names_sv || {})) !== JSON.stringify(PARTY_ORDER)) {
    fail('parties_view.party_names_sv does not name the eight parties in order');
  }

  // Coverage over the *plotted* set. Archived prospective points are not
  // drawn, so they are not required to carry the family -- which is also the
  // boundary the consumer uses.
  const series = Array.isArray(history.series) ? history.series : [];
  const plotted = series.filter((point) => point?.provenance !== 'prospective_archived');
  if (!plotted.length) fail('the history has no plotted points');
  const missing = plotted.filter((point) => {
    const parties = point?.parties;
    if (!parties || typeof parties !== 'object') return true;
    return !PARTY_ORDER.every((party) =>
      orderedNumbers(parties[party]?.vote) && orderedNumbers(parties[party]?.seats) &&
      QUANTILES.every((key) => Number.isInteger(parties[party].seats[key])));
  });
  if (missing.length) {
    fail(`${missing.length} of ${plotted.length} plotted history points lack complete party ` +
      `summaries (first: ${missing[0]?.date}, last: ${missing[missing.length - 1]?.date}). ` +
      'A resumed generation cannot create them: it preserves reused points byte for byte.');
  }

  const current = plotted.filter((point) => point?.provenance === 'current_production');
  if (current.length !== 1) {
    fail(`expected exactly one current_production point, found ${current.length}`);
  }

  // The published party endpoint quantiles must be the certified forecast's
  // own. History keeps six decimals and parties.json three, so votes are
  // compared at the coarser published precision and seats exactly.
  if (certified && current.length === 1) {
    const generation = String(current[0].publication_generation || '');
    if (generation && certified.generation && generation !== certified.generation) {
      fail(`the history's certified point is generation ${generation} but the publication ` +
        `pointer resolves ${certified.generation}: the artifact and the publication are out of step`);
    }
    PARTY_ORDER.forEach((party) => {
      const row = certified.rows[party];
      if (!row) {
        fail(`${certified.path}/parties.json has no row for ${party}`);
        return;
      }
      const entry = current[0].parties?.[party];
      if (!entry) return;
      QUANTILES.forEach((key, index) => {
        const published = Number(row[VOTE_FIELDS[index]]);
        const actual = Math.round(entry.vote[key] * 1000) / 1000;
        if (Math.abs(actual - published) > 1e-9) {
          fail(`${party} endpoint vote ${key} is ${actual}, published forecast says ${published}`);
        }
        const publishedSeats = Number(row[SEAT_FIELDS[index]]);
        if (entry.seats[key] !== publishedSeats) {
          fail(`${party} endpoint seats ${key} is ${entry.seats[key]}, ` +
            `published forecast says ${publishedSeats}`);
        }
      });
    });
  }
  return problems;
}

function runRealArtifact() {
  return runRealArtifactAt(SITE, 'real-artifact mode');
}

async function runRealArtifactAt(root, label) {
  console.log(`\n${label}: ${root}`);
  const history = await readSiteHistory(root);
  let certified = null;
  try {
    certified = await readCertifiedPartyRows(root);
    console.log(`  publication pointer -> ${certified.path}`);
  } catch (error) {
    check(`the publication pointer resolves its parties.json (${error.message})`, false);
  }
  const problems = validateRealArtifact(history, certified);
  problems.forEach((problem) => check(`artifact: ${problem}`, false));
  check('the published history satisfies every party-view precondition',
    problems.length === 0);
  if (problems.length) {
    console.log('\n  skipping the browser phase: the artifact is not fit to expose.');
    return;
  }
  const plotted = history.series.filter((point) => point?.provenance !== 'prospective_archived');
  console.log(`  ${plotted.length} plotted points, all eight parties, ` +
    `election day verified against ${certified?.path}`);
  // The identical browser checks fixture mode runs, against the real site.
  // One happy path, not two: a second implementation would drift.
  for (const viewport of VIEWPORTS) {
    await runViewport(viewport, { root: root, history: history });
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runViewport(viewport, site) {
  const history = site.history;
  const certified = certifiedPoint(history);
  const big = largestParty(history);
  const small = thresholdNearParty(history);
  console.log(`\n${viewport.name}`);
  const { server, browser } = await open(viewport, site.root);
  try {
    // ---- coalition mode is the default and is unchanged ------------------
    let state = await readState(browser);
    equal('opens in coalition mode', state.viewMode, 'coalitions');
    check('the view switch is offered', state.viewSwitchVisible);
    check('party mode reports itself ready', state.partyViewState === 'ready', state.partyViewState);
    check('the coalition selector is the visible one', state.coalitionHostVisible && !state.partyHostVisible);
    check('the party denominator note is hidden in coalition mode', !state.partyNoteVisible);
    check('the two default coalitions are drawn', state.seriesDefinitions.length === 2 &&
      state.seriesDefinitions.every((id) => id in (history.coalitions || {})),
    state.seriesDefinitions);
    check('no party series leaks into coalition mode',
      state.seriesDefinitions.every((id) => !PARTY_ORDER.includes(id)) &&
      state.pollDefinitions.every((id) => !PARTY_ORDER.includes(id)),
      { series: state.seriesDefinitions, polls: state.pollDefinitions });
    check('no 4 % threshold line in coalition mode', state.thresholdLine.length === 0);
    const coalitionDomain = { min: state.yMin, max: state.yMax, mode: state.yDomainMode };
    const coalitionSeries = state.seriesDefinitions.slice();
    const coalitionPollDefinitions = state.pollDefinitions.slice().sort();

    // ---- switching to party mode -----------------------------------------
    check('the Partier control responds', await clickId(browser, 'election-timeseries-view-parties'));
    await settle(260);
    state = await readState(browser);
    equal('the chart reports party mode', state.viewMode, 'parties');
    equal('the y-domain switches to the adaptive party window', state.yDomainMode, 'adaptive-party-window');
    check('the party selector replaces the coalition selector',
      state.partyHostVisible && !state.coalitionHostVisible);
    check('the party denominator note is shown', state.partyNoteVisible);
    equal('all eight parties are offered', state.partyButtons.map((button) => button.party), PARTY_ORDER);
    check('every party pill is reachable by tab',
      state.partyButtons.every((button) => button.tabIndex >= 0),
      state.partyButtons.map((button) => button.tabIndex));
    check('every party pill carries its abbreviation',
      state.partyButtons.every((button) => button.label.length > 0), state.partyButtons);
    // Party mode opens on the whole riksdag, and every pill is a toggle.
    equal('every party is pressed on entry',
      state.partyButtons.filter((button) => button.pressed === 'true').map((button) => button.party),
      PARTY_ORDER);
    equal('every party is reported as selected', state.selectedParties, PARTY_ORDER);
    equal('one series is drawn per party', state.seriesDefinitions.slice().sort(),
      PARTY_ORDER.slice().sort());
    equal('the detail panel the crosshair readout replaced is gone',
      state.retiredDetailCount, 0);
    check('no coalition quantity is drawn in party mode',
      state.pollDefinitions.every((id) => PARTY_ORDER.includes(id)), state.pollDefinitions);
    equal('party mode draws nothing beyond the latest forecast', state.forwardMarkCount, 0);
    equal('party mode offers no forward-view control', state.forwardControlIds, []);
    check('the party domain differs from the coalition one',
      state.yMin !== coalitionDomain.min || state.yMax !== coalitionDomain.max,
      { party: [state.yMin, state.yMax], coalition: [coalitionDomain.min, coalitionDomain.max] });

    // ---- toggling parties on and off -------------------------------------
    // The y-domain is derived from the selected set, so dropping the largest
    // party has to visibly tighten the axis rather than leave dead space where
    // its band used to be.
    const allOn = { min: state.yMin, max: state.yMax };
    check('the largest party toggles off', await clickParty(browser, big));
    await settle(280);
    const withoutBig = await readState(browser);
    check(`${big} is unpressed and its series is gone`,
      withoutBig.partyButtons.find((button) => button.party === big)?.pressed === 'false' &&
      !withoutBig.selectedParties.includes(big) &&
      !withoutBig.seriesDefinitions.includes(big), withoutBig.selectedParties);
    equal('the remaining seven still draw', withoutBig.seriesDefinitions.length, 7);
    check('the y-domain tightens when the largest party is dropped',
      withoutBig.yMax < allOn.max,
      { allOn, withoutBig: { min: withoutBig.yMin, max: withoutBig.yMax } });
    check('the same party toggles back on', await clickParty(browser, big));
    await settle(280);
    const backOn = await readState(browser);
    equal('toggling back restores the full set', backOn.selectedParties, PARTY_ORDER);
    equal('toggling back restores the domain', [backOn.yMin, backOn.yMax], [allOn.min, allOn.max]);

    // Every party off is a legal, empty chart -- the same as deselecting every
    // coalition -- and must not throw or leave a stale series behind.
    await browser.evaluate(() => {
      document.querySelectorAll('#election-timeseries-parties button[aria-pressed="true"]')
        .forEach((button) => button.click());
    });
    await settle(320);
    const noneOn = await readState(browser);
    equal('every party can be switched off', noneOn.selectedParties, []);
    equal('no series is drawn with nothing selected', noneOn.seriesDefinitions, []);
    equal('no readout is drawn with nothing selected', noneOn.crosshairLabels, []);
    await browser.evaluate((order) => {
      order.forEach((party) => document
        .querySelector(`#election-timeseries-parties button[data-party="${party}"]`)?.click());
    }, PARTY_ORDER);
    await settle(320);
    state = await readState(browser);
    equal('switching them all back on restores every series', state.selectedParties, PARTY_ORDER);

    // ---- party poll dots are the published numbers -----------------------
    // Several institutes can publish on one date, so a drawn dot has to match
    // *some* poll from that date rather than a single lookup.
    const publishedPolls = new Map();
    (history.polls || []).forEach((poll) => {
      const values = publishedPolls.get(poll.publication_date) || [];
      values.push(poll.parties);
      publishedPolls.set(poll.publication_date, values);
    });
    const drawnPolls = state.polls.filter((poll) => poll.definition === big);
    const mismatched = drawnPolls.filter((poll) => {
      const published = publishedPolls.get(poll.date) || [];
      return !published.some((parties) =>
        Math.abs(poll.value - parties[big]) < 1e-9);
    });
    check('party poll dots use the published party value, not a renormalization',
      drawnPolls.length > 0 && mismatched.length === 0, mismatched.slice(0, 3));
    // The renormalized value would be larger by the REST mass; assert the
    // difference is actually detectable, so this check cannot pass vacuously.
    check('the renormalized value would have been visibly different',
      drawnPolls.some((poll) => {
        const published = (publishedPolls.get(poll.date) || [])[0];
        if (!published) return false;
        const eight = PARTY_ORDER.reduce((sum, party) => sum + published[party], 0);
        return Math.abs(100 * published[big] / eight - poll.value) > 0.2;
      }), 'a renormalized denominator must not be indistinguishable');
    check('every drawn party poll is inside the visible domain',
      drawnPolls.every((poll) => poll.value >= state.yMin - 1e-9 && poll.value <= state.yMax + 1e-9),
      { min: state.yMin, max: state.yMax,
        outside: drawnPolls.filter((poll) => poll.value < state.yMin || poll.value > state.yMax) });

    // ---- the last drawn point is the certified party forecast ------------
    // The chart's closing claim: its rightmost mark is today's published
    // forecast for the selected party, value for value.
    // Asserted for every party on screen, not just one: eight series each
    // have to end on their own published number.
    const lastDrawnMismatches = PARTY_ORDER.filter((party) => {
      const published = certified.parties[party].vote.p50;
      const drawn = state.forecastPoints
        .filter((point) => point.definition === party)
        .sort((left, right) => (left.date < right.date ? -1 : 1)).at(-1);
      return !drawn || drawn.date !== certified.date ||
        Math.abs(drawn.p50 - published) > 1e-9;
    });
    equal('every drawn party series ends on its certified forecast for today',
      lastDrawnMismatches, []);
    check('every historical forecast point is inside the visible domain',
      state.forecastPoints.every((point) => point.p50 >= state.yMin - 1e-9 && point.p50 <= state.yMax + 1e-9),
      { min: state.yMin, max: state.yMax });

    // ---- selection persists across metric and range ----------------------
    check('the range control responds', await clickId(browser, 'election-timeseries-range-short'));
    await settle(260);
    let short = await readState(browser);
    equal('the party selection survives a range change', short.selectedParties, state.selectedParties);
    equal('the short range still uses the adaptive party window', short.yDomainMode, 'adaptive-party-window');
    check('the short-range party window is tighter than the four-year one',
      (short.yMax - short.yMin) <= (state.yMax - state.yMin),
      { short: short.yMax - short.yMin, full: state.yMax - state.yMin });
    // The bound guards against the four-year coalition ladder (20 pp minimum
    // span) leaking into the party window, not against the data itself. The
    // 30 days up to the latest forecast span about 7 pp of poll scatter for
    // the largest party, which snaps to a 10 pp tick domain.
    check('the short-range axis has readable ticks',
      short.yTicks.length >= 3 && short.yTicks.length <= 9, short.yTicks);
    // With one party on its own, the window has to be fine enough for
    // sub-point movement. The bound guards against the four-year coalition
    // ladder (20 pp minimum span) leaking in, not against the data: the 30
    // days up to the latest forecast span about 7 pp of poll scatter for the
    // largest party, which snaps to a 10 pp tick domain.
    check('one party alone gets a fine short-range window',
      await showOnlyParty(browser, big));
    await settle(280);
    const soloShort = await readState(browser);
    check('the solo short-range window is fine enough for sub-point movement',
      (soloShort.yMax - soloShort.yMin) <= 12, soloShort.yMax - soloShort.yMin);
    check('the solo window is no wider than the eight-party one',
      (soloShort.yMax - soloShort.yMin) <= (short.yMax - short.yMin),
      { solo: [soloShort.yMin, soloShort.yMax], all: [short.yMin, short.yMax] });
    await browser.evaluate((order) => {
      order.forEach((party) => {
        const button = document
          .querySelector(`#election-timeseries-parties button[data-party="${party}"]`);
        if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
      });
    }, PARTY_ORDER);
    await settle(320);

    check('the mandate metric responds', await clickId(browser, 'election-timeseries-seats'));
    await settle(260);
    let seats = await readState(browser);
    equal('the party selection survives a metric change', seats.selectedParties, state.selectedParties);
    equal('the chart is still in party mode', seats.viewMode, 'parties');
    equal('the mandate view draws nothing beyond the latest forecast',
      seats.forwardMarkCount, 0);
    check('the mandate view draws a historical mandate series per party',
      seats.metric === 'seats' &&
      seats.seriesDefinitions.slice().sort().join(',') === PARTY_ORDER.slice().sort().join(','),
      { series: seats.seriesDefinitions, points: seats.forecastPoints.length });
    check('no 4 % threshold line in the mandate view', seats.thresholdLine.length === 0);
    // The 175-seat rule is a question about a government, not about a party.
    check('no 175-mandate majority rule is drawn for a single party',
      seats.majorityLines === 0, seats.majorityLines);
    // It explains the vote-share denominator, which is not what is on screen.
    check('the vote-denominator note is withdrawn in the mandate view', !seats.partyNoteVisible);

    await clickId(browser, 'election-timeseries-vote');
    await clickId(browser, 'election-timeseries-range-full');
    await settle(260);

    // ---- the threshold appears only where it belongs ----------------------
    check('isolating a threshold-near party responds', await showOnlyParty(browser, small));
    await settle(280);
    const near = await readState(browser);
    equal('only the threshold-near party is selected', near.selectedParties, [small]);
    check('the 4 % threshold is drawn for the threshold-near party',
      near.thresholdVisible === 'true' && near.thresholdLine.length === 1 &&
      near.thresholdLine[0].value === 4 &&
      near.thresholdLabel.some((text) => text.includes('4')),
    { visible: near.thresholdVisible, line: near.thresholdLine, label: near.thresholdLabel });
    check('the threshold line sits inside the plot',
      near.thresholdLine.length === 1 && 4 >= near.yMin && 4 <= near.yMax,
      { min: near.yMin, max: near.yMax });
    check('the threshold-near domain is not stretched down to zero',
      near.yMin > 0 || near.yMax - near.yMin <= 8,
      { min: near.yMin, max: near.yMax });

    check('isolating a large party responds', await showOnlyParty(browser, big));
    await settle(280);
    const large = await readState(browser);
    equal('only the large party is selected', large.selectedParties, [big]);
    check('the 4 % threshold is absent for a large party, and the scale is not distorted',
      large.thresholdVisible === 'false' && large.thresholdLine.length === 0 && large.yMin > 4,
      { visible: large.thresholdVisible, min: large.yMin });

    // ---- pointer, touch and keyboard -------------------------------------
    // The chart sits below the hero, and CDP mouse events use viewport
    // coordinates: without scrolling it into view first, every synthetic
    // pointer lands somewhere else entirely and the checks pass or fail for
    // the wrong reason.
    await browser.evaluate(() => {
      document.getElementById('election-timeseries')
        ?.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await settle(280);
    const box = await plotBox(browser);
    check('the plot exposes a hit area', Boolean(box) && box.width > 0, box);
    if (box) {
      await movePointer(browser, box.left + box.width * 0.55, box.top + box.height / 2);
      const hovered = await readState(browser);
      check('pointer inspection prints the selected party\u2019s median at the crosshair',
        hovered.crosshairLabels.length === 1 &&
        hovered.crosshairLabels[0].party === big &&
        hovered.crosshairLabels[0].text.startsWith(big),
      hovered.crosshairLabels);
      check('the current-value label stands down while a date is inspected',
        hovered.endpointLabelCount === 0, hovered.endpointLabelCount);
      if (viewport.coarse) {
        await tap(browser, box.left + box.width * 0.4, box.top + box.height / 2);
        const tapped = await readState(browser);
        check('touch inspection pins the readout',
          tapped.crosshairLabels.length === 1 &&
          tapped.crosshairLabels[0].party === big, tapped.crosshairLabels);
      }
    }
    await browser.evaluate(() => document.getElementById('election-timeseries-svg')?.focus());
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    const keyboard = await readState(browser);
    check('chart-level arrow navigation works in party mode',
      keyboard.crosshairLabels.length === 1 &&
      keyboard.crosshairLabels[0].party === big, keyboard.crosshairLabels);
    check('the hidden live region announces the party and its median',
      keyboard.status.includes(big) && /\d/.test(keyboard.status), keyboard.status);

    // ---- direct navigation from the vote rows ----------------------------
    // Start from Mandatandel and the election-relative range. The action comes
    // from a vote-share section, so it must arrive on Röstandel; the range is
    // the reader's own choice and must survive.
    await clickId(browser, 'election-timeseries-seats');
    await clickId(browser, 'election-timeseries-range-short');
    await settle(260);
    const beforeRoute = await readState(browser);
    equal('the timeline starts in the mandate view', beforeRoute.metric, 'seats');
    equal('the timeline starts in the election-relative range', beforeRoute.range, 'short');
    const routed = await browser.evaluate((wanted) => {
      const rows = Array.from(document.querySelectorAll('#election-party-cards .ev-head'));
      const target = rows.find((node) => (node.getAttribute('aria-label') || '').includes(wanted.name));
      if (!target) return { found: false };
      target.click();
      const link = document.querySelector(`button[data-party-timeline="${wanted.party}"]`);
      if (!link) return { found: false };
      const hidden = link.hidden;
      link.click();
      return {
        found: true,
        hidden,
        focused: document.activeElement?.getAttribute('data-party') || null,
        headOpen: target.getAttribute('aria-expanded'),
      };
    }, { name: 'Liberalerna', party: 'L' });
    await settle(300);
    const navigated = await readState(browser);
    check('the "Visa utveckling" action exists and is offered', routed.found && routed.hidden === false, routed);
    equal('the action switches the chart to party mode', navigated.viewMode, 'parties');
    // The action asks for one party's development, so it isolates that party
    // rather than adding it to whatever set happened to be on screen.
    equal('the action selects only the party it came from', navigated.selectedParties, ['L']);
    equal('focus lands on the chart control that now holds the state', routed.focused, 'L');
    check('the party series really changed to the routed party',
      navigated.seriesDefinitions.length === 1 && navigated.seriesDefinitions[0] === 'L',
      navigated.seriesDefinitions);
    equal('the action lands on the vote view it came from', navigated.metric, 'vote');
    equal('the action preserves the range the reader chose', navigated.range, 'short');
    equal('the range control agrees with the rendered range',
      navigated.rangePressed, ['false', 'true']);
    check('the routed vote view really drew the party vote series',
      navigated.pollDefinitions.length === 1 && navigated.pollDefinitions[0] === 'L',
      navigated.pollDefinitions);
    await clickId(browser, 'election-timeseries-range-full');
    await settle(260);

    // ---- back to coalitions, unchanged ------------------------------------
    check('the Koalitioner control responds', await clickId(browser, 'election-timeseries-view-coalitions'));
    await settle(260);
    const back = await readState(browser);
    equal('the chart returns to coalition mode', back.viewMode, 'coalitions');
    equal('the coalition domain is exactly what it was', [back.yMin, back.yMax],
      [coalitionDomain.min, coalitionDomain.max]);
    equal('the coalition series are exactly what they were', back.seriesDefinitions, coalitionSeries);
    check('the coalition mandate view keeps its 175-seat rule', await (async () => {
      await clickId(browser, 'election-timeseries-seats');
      await settle(240);
      const coalitionSeats = await readState(browser);
      const kept = coalitionSeats.majorityLines > 0;
      await clickId(browser, 'election-timeseries-vote');
      await settle(240);
      return kept;
    })());
    equal('the coalition poll cloud is exactly what it was',
      back.pollDefinitions.slice().sort(), coalitionPollDefinitions);
    check('the coalition selector is visible again',
      back.coalitionHostVisible && !back.partyHostVisible);
    check('no threshold line returns with coalition mode', back.thresholdLine.length === 0);
    check('the party denominator note is hidden again', !back.partyNoteVisible);

    // ---- layout and console ----------------------------------------------
    check('no horizontal overflow at this viewport', !back.horizontalOverflow);
    await clickId(browser, 'election-timeseries-view-parties');
    await settle(220);
    const partyLayout = await readState(browser);
    check('no horizontal overflow in party mode', !partyLayout.horizontalOverflow);
    equal('no console errors', appErrors(browser).map((entry) => entry.text), []);
  } finally {
    await closeBrowser(browser, server);
  }
}

// A publication with no party family must look exactly like the old page.
async function runFallback() {
  console.log('\nfallback: a publication with no party family');
  const site = await prepareSite((history) => {
    delete history.parties_view;
    (history.series || []).forEach((point) => { delete point.parties; });
    return history;
  });
  const { server, browser } = await open(VIEWPORTS[0], site.root);
  try {
    const state = await readState(browser);
    equal('the chart stays in coalition mode', state.viewMode, 'coalitions');
    equal('the party family reports itself absent', state.partyViewState, 'absent');
    check('the view switch is not offered', !state.viewSwitchVisible);
    check('the party selector is not shown', !state.partyHostVisible);
    check('the coalition chart still renders', state.seriesDefinitions.length === 2,
      state.seriesDefinitions);
    equal('the fallback chart draws nothing beyond the latest forecast',
      state.forwardMarkCount, 0);
    const link = await browser.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#election-party-cards .ev-head'));
      const target = rows.find((node) => (node.getAttribute('aria-label') || '').includes('Moderaterna'));
      if (target) target.click();
      const button = document.querySelector('button[data-party-timeline="M"]');
      return { exists: Boolean(button), hidden: button ? button.hidden : null };
    });
    check('the direct-navigation action stays hidden with no party data',
      link.exists && link.hidden === true, link);
    equal('no console errors in fallback', appErrors(browser).map((entry) => entry.text), []);
  } finally {
    await closeBrowser(browser, server);
    await site.cleanup();
  }
}

// A declared-but-broken party family must not be half-rendered.
// A forward-looking artifact the chart no longer reads must not be able to
// change anything: neither the party view's availability nor a single mark.
async function runUnreadForwardArtifact(label, transform) {
  console.log(`\nunread forward artifact: ${label}`);
  const site = await prepareSite(transform);
  const { server, browser } = await open(VIEWPORTS[0], site.root);
  try {
    const state = await readState(browser);
    equal('party mode is still offered', state.partyViewState, 'ready');
    check('the view switch is still offered', state.viewSwitchVisible);
    check('the coalition chart is unaffected', state.seriesDefinitions.length === 2,
      state.seriesDefinitions);
    equal('nothing is drawn beyond the latest forecast', state.forwardMarkCount, 0);
    equal('no console errors', appErrors(browser).map((entry) => entry.text), []);
  } finally {
    await closeBrowser(browser, server);
    await site.cleanup();
  }
}

async function runFailClosed(label, transform, options) {
  console.log(`\nfail-closed: ${label}`);
  const site = await prepareSite(transform);
  const { server, browser } = await open(VIEWPORTS[0], site.root);
  try {
    const state = await readState(browser);
    equal('the chart stays in coalition mode', state.viewMode, 'coalitions');
    check('party mode is refused', state.partyViewState !== 'ready', state.partyViewState);
    if (options && options.expectState) {
      equal('the refusal names its own reason', state.partyViewState, options.expectState);
    }
    check('the view switch is not offered', !state.viewSwitchVisible);
    check('the party selector is not shown', !state.partyHostVisible);
    check('the coalition chart is unaffected', state.seriesDefinitions.length === 2,
      state.seriesDefinitions);
    check('the direct-navigation action stays hidden', await browser.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#election-party-cards .ev-head'));
      const target = rows.find((node) =>
        (node.getAttribute('aria-label') || '').includes('Moderaterna'));
      if (target) target.click();
      const button = document.querySelector('button[data-party-timeline="M"]');
      return Boolean(button) && button.hidden === true;
    }));
    equal('no console errors', appErrors(browser).map((entry) => entry.text), []);
  } finally {
    await closeBrowser(browser, server);
    await site.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Proving real-artifact mode is not vacuous
// ---------------------------------------------------------------------------

// Seeds ONLY the history into a throwaway copy of the site, leaving the real
// publication bundle untouched.
//
// It deliberately does not fabricate a matching parties.json: the bundle is
// hash-validated end to end by the frozen publication subsystem, so a
// hand-written version directory would be rejected, `renderVotes` would never
// run, and the browser phase would be testing a broken page rather than the
// party view. The parity comparator is proven separately, against certified
// rows built in memory.
async function seedRealHistory(history) {
  const root = await mkdtemp(join(tmpdir(), 'party-real-site-'));
  await cp(SITE, root, { recursive: true });
  const historyPath = join(root, HISTORY_RELATIVE);
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history)}\n`);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// The certified rows a coherent publication of this history would carry.
function certifiedRowsFor(history, generation) {
  const current = certifiedPoint(history);
  const rows = {};
  PARTY_ORDER.forEach((party) => {
    const entry = current.parties[party];
    const row = { party };
    QUANTILES.forEach((key, index) => {
      row[VOTE_FIELDS[index]] = Math.round(entry.vote[key] * 1000) / 1000;
      row[SEAT_FIELDS[index]] = entry.seats[key];
    });
    rows[party] = row;
  });
  return { generation: generation, path: `versions/${generation}`, rows: rows };
}

async function selfTestRealArtifactMode() {
  console.log('\nself-test: real-artifact mode');
  const authentic = JSON.parse(
    await readFile(join(HERE, 'fixtures', 'coalition-timeseries.json'), 'utf8'),
  );
  const GENERATION = '29990101T000000Z-selftest';
  const complete = structuredClone(authentic);
  certifiedPoint(complete).publication_generation = GENERATION;
  const certified = certifiedRowsFor(complete, GENERATION);

  // ---- the comparator, on its passing path --------------------------------
  equal('a complete artifact passes with no findings',
    validateRealArtifact(complete, certified), []);

  // ---- every precondition, broken one at a time ---------------------------
  // `expect` is a substring the finding must mention, so a mutation cannot be
  // "caught" by an unrelated check firing.
  const mutations = [
    ['no party family at all', (h) => { delete h.parties_view; }, 'parties_view is absent'],
    ['one plotted point missing its parties', (h) => {
      delete h.series.find((point) =>
        point.provenance === 'reconstructed_current_model' && point.parties).parties;
    }, 'lack complete party summaries'],
    ['every reconstructed point missing its parties', (h) => {
      h.series.forEach((point) => {
        if (point.provenance !== 'current_production') delete point.parties;
      });
    }, 'lack complete party summaries'],
    ['a party seat quantile published as a non-integer', (h) => {
      certifiedPoint(h).parties.M.seats.p50 = 66.5;
    }, 'lack complete party summaries'],
    ['a second certified point', (h) => {
      const clone = structuredClone(certifiedPoint(h));
      clone.date = '2026-09-04';
      h.series.push(clone);
    }, 'exactly one current_production'],
    ['a renormalized denominator', (h) => {
      h.parties_view.vote_share_denominator = 'eight_parliamentary_parties';
    }, 'vote_share_denominator'],
    ['REST declared as a party', (h) => { h.parties_view.rest_is_a_party = true; },
      'declares REST as a party'],
    ['uncertainty declared as reconstructed from coalitions', (h) => {
      h.parties_view.election_day_parity.reconstructed_from_coalitions = true;
    }, 'reconstruction from coalition data'],
    ['a history from a different generation than the pointer', (h) => {
      certifiedPoint(h).publication_generation = '19990101T000000Z-elsewhere';
    }, 'out of step'],
    ['an endpoint vote quantile that disagrees with parties.json', (h) => {
      certifiedPoint(h).parties.S.vote.p50 += 0.25;
    }, 'published forecast says'],
    ['an endpoint seat quantile that disagrees with parties.json', (h) => {
      certifiedPoint(h).parties.S.seats.p50 += 3;
    }, 'published forecast says'],
  ];
  for (const [label, mutate, expect] of mutations) {
    const broken = structuredClone(complete);
    mutate(broken);
    const found = validateRealArtifact(broken, certified);
    check(`real-artifact mode rejects ${label}`,
      found.some((problem) => problem.includes(expect)), { expect, found });
  }

  // ---- the pointer resolution, including its refusal to fall back ---------
  const real = await readCertifiedPartyRows(SITE);
  check('the pointer resolves the real publication and yields all nine rows',
    /^versions\//.test(real.path) &&
    PARTY_ORDER.every((party) => Boolean(real.rows[party])) && Boolean(real.rows.REST),
    { path: real.path, rows: Object.keys(real.rows) });
  const pointerless = await seedRealHistory(complete);
  try {
    // The frozen flat parties.json at the publication root is a *different
    // forecast*. Silently falling back to it is the exact false reassurance
    // this mode exists to prevent, so its absence must be an error.
    await rm(join(pointerless.root, POINTER_RELATIVE));
    let threw = false;
    try {
      await readCertifiedPartyRows(pointerless.root);
    } catch { threw = true; }
    check('a missing pointer is an error, never a fall back to the frozen flat file', threw);
    await writeFile(join(pointerless.root, POINTER_RELATIVE),
      JSON.stringify({ publication_generation: 'x', path: '../escape' }));
    let rejected = false;
    try {
      await readCertifiedPartyRows(pointerless.root);
    } catch { rejected = true; }
    check('a malformed pointer path is rejected', rejected);
  } finally {
    await pointerless.cleanup();
  }

  // ---- the plumbing and the browser phase, end to end --------------------
  const marker = structuredClone(complete);
  marker.model_commit = 'f'.repeat(40);
  const site = await seedRealHistory(marker);
  try {
    const readBack = await readSiteHistory(site.root);
    equal('the reader returns the site history, not the committed fixture',
      readBack.model_commit, 'f'.repeat(40));
    check('the committed fixture is a different artifact, so that check can fail',
      authentic.model_commit !== 'f'.repeat(40));
    equal('the site-read history validates structurally',
      validateRealArtifact(readBack, null), []);
    // The real browser happy path, driven from a site whose *genuine* history
    // is a complete party artifact. Desktop only: the mobile pass is already
    // covered above on the same content, and this is about the plumbing.
    await runViewport(VIEWPORTS[0], { root: site.root, history: readBack });
  } finally {
    await site.cleanup();
  }
}

async function main() {
  if (REAL_ARTIFACT) {
    await diagnostic(`real-artifact site=${SITE}`);
    await runRealArtifact();
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures) process.exit(1);
    return;
  }
  await diagnostic(`site=${SITE}`);
  const site = await prepareSite();
  check('the fixture publishes the party family', Boolean(site.history.parties_view));
  check('the fixture certified point carries party summaries',
    Boolean(certifiedPoint(site.history)?.parties));
  try {
    for (const viewport of VIEWPORTS) {
      await runViewport(viewport, site);
    }
  } finally {
    await site.cleanup();
  }

  await runFallback();

  await runFailClosed('a renormalized party denominator', (history) => {
    history.parties_view.vote_share_denominator = 'eight_parliamentary_parties';
    return history;
  });
  await runFailClosed('party uncertainty declared as reconstructed from coalitions', (history) => {
    history.parties_view.election_day_parity.reconstructed_from_coalitions = true;
    return history;
  });
  // The shape a normal incremental publication produces before a full history
  // regeneration: the certified point has party data and the reused
  // reconstructed points behind it do not. Party mode must stay closed rather
  // than draw a party series that starts days ago beside a coalition series
  // that starts in 2022.
  await runFailClosed('one reconstructed history point missing its party summaries',
    (history) => {
      const point = history.series.find((item) =>
        item.provenance === 'reconstructed_current_model' && item.parties);
      delete point.parties;
      return history;
    }, { expectState: 'incomplete-history' });
  await runFailClosed('every reconstructed point missing its party summaries, as after an incremental publication',
    (history) => {
      history.series.forEach((point) => {
        if (point.provenance !== 'current_production') delete point.parties;
      });
      return history;
    }, { expectState: 'incomplete-history' });
  // The forward-looking artifacts are published but unread, so a broken one
  // must be inert rather than able to close the party view or leave a mark.
  await runUnreadForwardArtifact('a campaign-path object that fails normalization',
    (history) => {
      history.future_campaign_paths.model_id = 'not_the_published_model';
      return history;
    });
  await runUnreadForwardArtifact('both forward artifacts removed entirely', (history) => {
    delete history.future_campaign_paths;
    delete history.future_projection;
    return history;
  });

  await selfTestRealArtifactMode();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
