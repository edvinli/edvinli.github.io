// Real-browser smoke test for the per-party view of "Vägen till valdagen".
//
// It consumes the same static history artifact the page consumes and never
// invents expected values: the fixture is read first, and everything the
// browser draws is checked against it. Coalition mode is asserted to be
// unchanged, because the whole point of the switch is that the default
// experience did not move.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/party-timeseries.smoke.mjs [path/to/_site]

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './cdp.mjs';
import { serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';
const HISTORY_RELATIVE = join('files', 'election-simulator', 'history', 'coalition-timeseries.json');
const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
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

// The published artifact does not carry the party family until the simulator
// side ships, so the interaction contract is exercised against the committed
// fixture in a throwaway copy of _site. The checkout is never modified.
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
    const futureHost = document.getElementById('election-timeseries-future');
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
      selectedParty: svg?.getAttribute('data-selected-party') || null,
      metric: svg?.getAttribute('data-metric') || null,
      range: svg?.getAttribute('data-range') || null,
      yMin: Number(svg?.getAttribute('data-y-min')),
      yMax: Number(svg?.getAttribute('data-y-max')),
      yDomainMode: svg?.getAttribute('data-y-domain-mode') || null,
      thresholdVisible: svg?.getAttribute('data-threshold-visible') || null,
      futureView: svg?.getAttribute('data-future-view') || null,
      viewSwitchVisible: visible(viewHost),
      partyHostVisible: visible(partyHost),
      coalitionHostVisible: visible(coalitionHost),
      futureHostVisible: visible(futureHost),
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
      campaignPathCount: marks('[data-campaign-path]').length,
      campaignBands: marks('[data-campaign-band]').map((node) => node.getAttribute('data-campaign-band')),
      originStatePoints: marks('[data-origin-state-point]')
        .map((node) => node.getAttribute('data-coalition')),
      electionDayPoints: marks('[data-election-day-point]').map((node) => ({
        definition: node.getAttribute('data-coalition'),
        metric: node.getAttribute('data-metric'),
        p05: Number(node.getAttribute('data-p05')),
        p50: Number(node.getAttribute('data-p50')),
        p95: Number(node.getAttribute('data-p95')),
        seats: node.getAttribute('data-seat-quantiles'),
      })),
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
      futureRegion: marks('[data-future-region]').length,
      plot: (() => {
        const grid = svg?.querySelector('.election-timeseries__grid-line');
        return grid ? { top: Number(grid.getAttribute('y1')) } : null;
      })(),
      yTicks: marks('[data-y-tick]').map((node) => Number(node.getAttribute('data-y-tick'))),
      detailHeadings: Array.from(
        document.querySelectorAll('#election-timeseries-detail-body .election-timeseries__detail-group h4'),
      ).map((node) => (node.textContent || '').trim()),
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
    check('exactly one party is pressed',
      state.partyButtons.filter((button) => button.pressed === 'true').length === 1,
      state.partyButtons);
    equal('the deterministic default is the largest certified party', state.selectedParty, big);
    check('exactly one series is drawn', state.seriesDefinitions.length === 1, state.seriesDefinitions);
    equal('the drawn series is the selected party', state.seriesDefinitions, [state.selectedParty]);
    check('no coalition quantity is drawn in party mode',
      state.pollDefinitions.every((id) => PARTY_ORDER.includes(id)) &&
      state.electionDayPoints.every((point) => PARTY_ORDER.includes(point.definition)) &&
      state.originStatePoints.every((id) => PARTY_ORDER.includes(id)),
      { polls: state.pollDefinitions, election: state.electionDayPoints.map((p) => p.definition) });
    check('the secondary uncertainty view is not offered in party mode', !state.futureHostVisible);
    equal('the future region stays the campaign-path view', state.futureView, 'campaign_paths');
    check('the party domain differs from the coalition one',
      state.yMin !== coalitionDomain.min || state.yMax !== coalitionDomain.max,
      { party: [state.yMin, state.yMax], coalition: [coalitionDomain.min, coalitionDomain.max] });

    // ---- party poll dots are the published numbers -----------------------
    // Several institutes can publish on one date, so a drawn dot has to match
    // *some* poll from that date rather than a single lookup.
    const publishedPolls = new Map();
    (history.polls || []).forEach((poll) => {
      const values = publishedPolls.get(poll.publication_date) || [];
      values.push(poll.parties);
      publishedPolls.set(poll.publication_date, values);
    });
    const drawnPolls = state.polls.filter((poll) => poll.definition === state.selectedParty);
    const mismatched = drawnPolls.filter((poll) => {
      const published = publishedPolls.get(poll.date) || [];
      return !published.some((parties) =>
        Math.abs(poll.value - parties[state.selectedParty]) < 1e-9);
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
        return Math.abs(100 * published[state.selectedParty] / eight - poll.value) > 0.2;
      }), 'a renormalized denominator must not be indistinguishable');
    check('every drawn party poll is inside the visible domain',
      drawnPolls.every((poll) => poll.value >= state.yMin - 1e-9 && poll.value <= state.yMax + 1e-9),
      { min: state.yMin, max: state.yMax,
        outside: drawnPolls.filter((poll) => poll.value < state.yMin || poll.value > state.yMax) });

    // ---- election-day distribution is the certified party forecast -------
    const electionParty = state.electionDayPoints.find((point) => point.definition === state.selectedParty);
    const certifiedParty = certified.parties[state.selectedParty].vote;
    check('the election-day party distribution is the certified forecast',
      Boolean(electionParty) &&
      Math.abs(electionParty.p50 - certifiedParty.p50) < 1e-9 &&
      Math.abs(electionParty.p05 - certifiedParty.p05) < 1e-9 &&
      Math.abs(electionParty.p95 - certifiedParty.p95) < 1e-9,
    { drawn: electionParty, certified: certifiedParty });

    // ---- the campaign region ---------------------------------------------
    check('the future region is shaded', state.futureRegion > 0);
    check('both party opinion bands are drawn',
      state.campaignBands.includes('50') && state.campaignBands.includes('90'), state.campaignBands);
    check('a limited set of representative party trajectories is drawn',
      state.campaignPathCount > 0 && state.campaignPathCount <= 8, state.campaignPathCount);
    equal('the origin opinion state is drawn for the party', state.originStatePoints, [state.selectedParty]);
    check('every historical forecast point is inside the visible domain',
      state.forecastPoints.every((point) => point.p50 >= state.yMin - 1e-9 && point.p50 <= state.yMax + 1e-9),
      { min: state.yMin, max: state.yMax });

    // ---- selection persists across metric and range ----------------------
    check('the range control responds', await clickId(browser, 'election-timeseries-range-short'));
    await settle(260);
    let short = await readState(browser);
    equal('the party selection survives a range change', short.selectedParty, state.selectedParty);
    equal('the short range still uses the adaptive party window', short.yDomainMode, 'adaptive-party-window');
    check('the short-range party window is tighter than the four-year one',
      (short.yMax - short.yMin) <= (state.yMax - state.yMin),
      { short: short.yMax - short.yMin, full: state.yMax - state.yMin });
    check('the short-range window is fine enough for sub-point movement',
      (short.yMax - short.yMin) <= 8, short.yMax - short.yMin);
    check('the short-range axis has readable ticks',
      short.yTicks.length >= 3 && short.yTicks.length <= 9, short.yTicks);

    check('the mandate metric responds', await clickId(browser, 'election-timeseries-seats'));
    await settle(260);
    let seats = await readState(browser);
    equal('the party selection survives a metric change', seats.selectedParty, state.selectedParty);
    equal('the chart is still in party mode', seats.viewMode, 'parties');
    check('no intermediate party mandate path is drawn',
      seats.campaignPathCount === 0 && seats.campaignBands.length === 0 &&
      seats.originStatePoints.length === 0,
      { paths: seats.campaignPathCount, bands: seats.campaignBands,
        origin: seats.originStatePoints });
    check('the future period is still shaded in mandate mode', seats.futureRegion > 0);
    check('the election-day mandate distribution is drawn',
      seats.electionDayPoints.some((point) => point.definition === seats.selectedParty &&
        point.metric === 'seats' && Boolean(point.seats)),
      seats.electionDayPoints);
    check('no 4 % threshold line in the mandate view', seats.thresholdLine.length === 0);
    check('the secondary uncertainty view stays hidden in mandate mode', !seats.futureHostVisible);

    await clickId(browser, 'election-timeseries-vote');
    await clickId(browser, 'election-timeseries-range-full');
    await settle(260);

    // ---- the threshold appears only where it belongs ----------------------
    check('selecting a threshold-near party responds', await clickParty(browser, small));
    await settle(260);
    const near = await readState(browser);
    equal('the threshold-near party is selected', near.selectedParty, small);
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

    check('selecting a large party responds', await clickParty(browser, big));
    await settle(260);
    const large = await readState(browser);
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
      check('pointer inspection names the selected party',
        hovered.detailHeadings.length === 1 &&
        hovered.detailHeadings[0].includes(large.selectedParty),
      hovered.detailHeadings);
      if (viewport.coarse) {
        await tap(browser, box.left + box.width * 0.4, box.top + box.height / 2);
        const tapped = await readState(browser);
        check('touch inspection pins one party detail',
          tapped.detailHeadings.length === 1 &&
          tapped.detailHeadings[0].includes(large.selectedParty), tapped.detailHeadings);
      }
    }
    await browser.evaluate(() => document.getElementById('election-timeseries-svg')?.focus());
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    const keyboard = await readState(browser);
    check('chart-level arrow navigation works in party mode',
      keyboard.detailHeadings.length === 1 &&
      keyboard.detailHeadings[0].includes(large.selectedParty), keyboard.detailHeadings);

    // ---- direct navigation from the vote rows ----------------------------
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
    equal('the action selects the party it came from', navigated.selectedParty, 'L');
    equal('focus lands on the chart control that now holds the state', routed.focused, 'L');
    check('the party series really changed to the routed party',
      navigated.seriesDefinitions.length === 1 && navigated.seriesDefinitions[0] === 'L',
      navigated.seriesDefinitions);

    // ---- back to coalitions, unchanged ------------------------------------
    check('the Koalitioner control responds', await clickId(browser, 'election-timeseries-view-coalitions'));
    await settle(260);
    const back = await readState(browser);
    equal('the chart returns to coalition mode', back.viewMode, 'coalitions');
    equal('the coalition domain is exactly what it was', [back.yMin, back.yMax],
      [coalitionDomain.min, coalitionDomain.max]);
    equal('the coalition series are exactly what they were', back.seriesDefinitions, coalitionSeries);
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
    const paths = history.future_campaign_paths;
    if (paths) {
      (paths.bands || []).forEach((band) => { delete band.parties; });
      (paths.paths?.series || []).forEach((track) => { delete track.party_values; });
      delete paths.election_day.parties;
      delete paths.path_construction.party_vote_share_denominator;
      ['party_units', 'party_election_day_units', 'party_intermediate_seat_trajectory',
        'national_threshold_pct', 'national_threshold_label_sv']
        .forEach((key) => { delete paths.rendering[key]; });
    }
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
    check('the campaign region still renders', state.campaignPathCount > 0 && state.futureRegion > 0);
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
async function runFailClosed(label, transform) {
  console.log(`\nfail-closed: ${label}`);
  const site = await prepareSite(transform);
  const { server, browser } = await open(VIEWPORTS[0], site.root);
  try {
    const state = await readState(browser);
    equal('the chart stays in coalition mode', state.viewMode, 'coalitions');
    check('party mode is refused', state.partyViewState !== 'ready', state.partyViewState);
    check('the view switch is not offered', !state.viewSwitchVisible);
    check('the coalition chart is unaffected', state.seriesDefinitions.length === 2,
      state.seriesDefinitions);
    equal('no console errors', appErrors(browser).map((entry) => entry.text), []);
  } finally {
    await closeBrowser(browser, server);
    await site.cleanup();
  }
}

async function main() {
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

  await runFailClosed('an election-day party value that drifts from the certified point',
    (history) => {
      history.future_campaign_paths.election_day.parties.M.vote.p50 += 0.5;
      return history;
    });
  await runFailClosed('a party opinion band that also declares seats', (history) => {
    history.future_campaign_paths.bands[1].parties.M.seats =
      { p05: 50, p25: 55, p50: 60, p75: 65, p95: 70 };
    return history;
  });
  await runFailClosed('a declared intermediate party mandate trajectory', (history) => {
    history.future_campaign_paths.rendering.party_intermediate_seat_trajectory = true;
    return history;
  });
  await runFailClosed('a renormalized party denominator', (history) => {
    history.parties_view.vote_share_denominator = 'eight_parliamentary_parties';
    return history;
  });
  await runFailClosed('party uncertainty declared as reconstructed from coalitions', (history) => {
    history.parties_view.election_day_parity.reconstructed_from_coalitions = true;
    return history;
  });
  await runFailClosed('a party band missing from one campaign day', (history) => {
    delete history.future_campaign_paths.bands[2].parties;
    return history;
  });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
