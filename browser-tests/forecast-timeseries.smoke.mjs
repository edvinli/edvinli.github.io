// Real-browser smoke test for the "Vägen till valdagen" chart.
//
// This test deliberately consumes the same static history artifact that the
// page consumes.  It does not invent expected values (or ask the browser to
// simulate anything): the fixture is validated first, and the visible chart
// is then checked against that fixture and its public interaction contract.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/forecast-timeseries.smoke.mjs [path/to/_site]

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
const ELECTION_DATE = '2026-09-13';
const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const DEFAULT_COALITIONS = [
  ['V', 'MP', 'S', 'C'],
  ['L', 'KD', 'M', 'SD'],
];
const EXTRA_COALITIONS = [
  ['S', 'M'],
  ['V', 'S', 'MP'],
  ['S', 'MP', 'C'],
  ['C', 'KD', 'L', 'M'],
  ['S', 'MP', 'C', 'KD'],
];
const ALL_COALITIONS = DEFAULT_COALITIONS.concat(EXTRA_COALITIONS);
const VIEWPORTS = [
  { name: 'desktop (1280x1000)', diagnostic: 'desktop', width: 1280, height: 1000, coarse: false },
  { name: 'narrow-360 (360x900)', diagnostic: 'mobile', width: 360, height: 900, coarse: true },
];

// Keep the expected short range in calendar space.  Parsing at UTC midnight
// avoids a browser's local timezone changing the boundary around DST.
function calendarDateOffset(iso, offsetDays) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return null;
  const shifted = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays,
  ));
  return shifted.toISOString().slice(0, 10);
}

function shortRangeStart(history) {
  return calendarDateOffset(history?.election_date, -30);
}

function dateTime(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

function publishedDate(item) {
  return item?.publication_date || item?.date || item?.published || item?.publicationDate || null;
}

function inDateRange(iso, start, end) {
  return typeof iso === 'string' && iso >= start && iso <= end;
}

// The chart draws the historical series and, for vote share, the individual
// polls beside it.  The aggregate Poll of Polls series is published but no
// longer plotted, so it does not take part in either extent.
function fullRangeStart(history, metric) {
  const collections = [history?.series || []];
  if (metric === 'vote') collections.push(history?.polls || []);
  return collections.flatMap((items) => items.map(publishedDate))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    .sort()[0] || null;
}

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

const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
const compact = (value) => flat(value).replace(/\s*\+\s*/g, '+').toLowerCase();
const sameParties = (left, right) => left.length === right.length &&
  left.every((party) => right.includes(party));
const labelFor = (parties) => parties.join(' + ');
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const settle = (ms = 180) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function diagnostic(message) {
  if (!process.stdout.write(`[forecast-timeseries] ${message}\n`)) {
    await once(process.stdout, 'drain');
  }
}

async function boundary(scope, stage, action) {
  const label = `${scope} ${stage}`;
  const started = Date.now();
  await diagnostic(`${label} START`);
  try {
    const value = await action();
    await diagnostic(`${label} DONE elapsed=${((Date.now() - started) / 1000).toFixed(3)}s`);
    return value;
  } catch (error) {
    await diagnostic(
      `${label} FAIL elapsed=${((Date.now() - started) / 1000).toFixed(3)}s reason=${error.message}`,
    );
    throw error;
  }
}

async function closeBrowser(scope, browser, server) {
  const results = await Promise.allSettled([browser?.close(), server?.close()]);
  await diagnostic(`${scope} close DONE`);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function coalitionKey(history, parties) {
  const match = Object.entries(history.coalitions || {}).find(([, members]) =>
    Array.isArray(members) && sameParties(members, parties));
  return match ? match[0] : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateQuantiles(value, label) {
  const names = ['p05', 'p25', 'p50', 'p75', 'p95'];
  const okNumbers = names.every((name) => finite(value && value[name]));
  if (!okNumbers) return `${label}: non-finite or missing quantile`;
  if (!(value.p05 <= value.p25 && value.p25 <= value.p50 &&
    value.p50 <= value.p75 && value.p75 <= value.p95)) return `${label}: quantiles not ordered`;
  return null;
}

function validateFutureProjection(history) {
  const projection = history?.future_projection;
  const current = (history?.series || []).filter((point) => point?.provenance === 'current_production');
  check('fixture has one current production anchor', current.length === 1, current.map((point) => point.date));
  check('future projection election matches history election',
    projection?.election_date === history?.election_date, projection?.election_date);
  check('future projection anchor exactly matches current production', current.length === 1 &&
    projection?.anchor?.date === current[0].date && projection.anchor.samples === current[0].samples &&
    JSON.stringify(projection.anchor.groups) === JSON.stringify(current[0].groups), projection?.anchor);
  const future = Array.isArray(projection?.series) ? projection.series : [];
  const origin = Date.parse(`${projection?.origin_date}T00:00:00Z`);
  const election = Date.parse(`${projection?.election_date}T00:00:00Z`);
  const expected = Math.round((election - origin) / 86400000);
  check('fixture has one daily future point through election day', future.length === expected &&
    future.every((point, index) => point.date === new Date(origin + (index + 1) * 86400000)
      .toISOString().slice(0, 10) && point.remaining_horizon_days === expected - index - 1),
  future.map((point) => point.date));
  check('fixture future groups contain ordered vote and seat quantiles', future.every((point) =>
    ALL_COALITIONS.every((parties) => {
      const key = coalitionKey(history, parties);
      return !validateQuantiles(point?.groups?.[key]?.vote, `${point.date} ${key} vote`) &&
        !validateQuantiles(point?.groups?.[key]?.seats, `${point.date} ${key} seats`);
    })), future.length);
  const rendering = projection?.rendering;
  check('fixture rendering metadata spans anchor to election day and forbids future polls',
    rendering?.x_axis_max === projection?.election_date &&
    rendering?.future_region?.start === projection?.origin_date &&
    rendering?.future_region?.end === projection?.election_date &&
    rendering?.poll_observations_in_future === false &&
    rendering?.poll_of_polls_observations_in_future === false &&
    rendering?.connect_from_history_anchor === true &&
    ['latest_forecast_label', 'election_day_label', 'legend_label'].every((key) =>
      typeof rendering?.[key] === 'string' && rendering[key].length > 0), rendering);
}

function validateCampaignPaths(history) {
  const paths = history?.future_campaign_paths;
  const current = (history?.series || []).filter((point) => point?.provenance === 'current_production');
  check('fixture publishes the primary campaign-path object',
    paths?.projection_type === 'coherent_campaign_paths' &&
    paths?.model_id === 'coherent_campaign_paths_v1' &&
    paths?.role === 'primary_future_view' &&
    paths?.quantity === 'underlying_opinion_share' &&
    paths?.future_measurements_known === false,
  { type: paths?.projection_type, role: paths?.role, quantity: paths?.quantity });
  const origin = Date.parse(`${paths?.origin_date}T00:00:00Z`);
  const election = Date.parse(`${paths?.election_date}T00:00:00Z`);
  const days = Math.round((election - origin) / 86400000);
  check('fixture campaign paths run from the certified origin to election day',
    paths?.election_date === history?.election_date && paths?.state_cutoff_date === paths?.origin_date &&
    paths?.path_days === days && current.length === 1 && current[0].date === paths?.origin_date,
  { origin: paths?.origin_date, election: paths?.election_date, pathDays: paths?.path_days });
  check('fixture campaign construction is joint CLR with one whole-path sign',
    paths?.path_construction?.space === 'clr' && paths.path_construction.categories === 9 &&
    paths.path_construction.sign_policy === 'single_sign_per_whole_trajectory' &&
    paths.path_construction.transition_pool === 'all_history_leakage_safe' &&
    paths.path_construction.leakage_rule === 'trajectory_end_le_origin',
  paths?.path_construction);
  check('fixture publishes day zero as current-state uncertainty only',
    paths?.path_construction?.origin_day_quantity === 'opinion_state_only' &&
    paths?.rendering?.continues_from === 'current_opinion_state' &&
    typeof paths?.rendering?.origin_state_label === 'string' &&
    paths.rendering.origin_state_label.length > 0 &&
    typeof paths?.rendering?.origin_state_tooltip_sv === 'string' &&
    paths.rendering.origin_state_tooltip_sv.length > 0,
  { quantity: paths?.path_construction?.origin_day_quantity,
    continuesFrom: paths?.rendering?.continues_from });
  check('fixture day zero is a different, narrower distribution than the certified forecast',
    (() => {
      const key = coalitionKey(history, DEFAULT_COALITIONS[0]);
      const state = paths?.bands?.[0]?.groups?.[key]?.vote;
      const forecast = paths?.election_day?.groups?.[key]?.vote;
      if (!state || !forecast) return false;
      return (state.p95 - state.p05) < (forecast.p95 - forecast.p05);
    })(), 'origin state must be narrower than the election-day forecast');
  check('fixture disclosure matches the published day map',
    paths?.path_construction?.time_warp === 'identity'
      ? /av samma längd/.test(paths.tooltip_sv)
      : /tidsutsträckt/.test(paths.tooltip_sv),
  { warp: paths?.path_construction?.time_warp, tooltip: paths?.tooltip_sv });
  check('fixture campaign construction disclaims polls, random walk and momentum',
    paths?.path_construction?.synthesized_future_polls === false &&
    paths.path_construction.daily_independent_random_walk === false &&
    paths.path_construction.directional_momentum === false,
  paths?.path_construction);
  check('fixture campaign trajectories never end after the origin',
    paths?.path_construction?.latest_trajectory_end <= paths?.origin_date,
  paths?.path_construction?.latest_trajectory_end);
  check('fixture endpoint parity with production is verified and exactly zero',
    paths?.endpoint_parity?.guarantee === 'bitwise_identical_to_production_election_day_draws' &&
    paths.endpoint_parity.verified === true &&
    paths.endpoint_parity.max_abs_vote_share_difference_pp === 0 &&
    paths.endpoint_parity.election_day_summaries_source === 'certified_current_production_point',
  paths?.endpoint_parity);
  check('fixture election-day distribution is the certified production one',
    current.length === 1 && paths?.election_day?.samples === current[0].samples &&
    JSON.stringify(paths.election_day.groups) === JSON.stringify(current[0].groups) &&
    paths.election_day.includes_election_noise === true &&
    paths.election_day.includes_geography_and_mandates === true,
  { samples: paths?.election_day?.samples, expected: current[0]?.samples });
  const bands = Array.isArray(paths?.bands) ? paths.bands : [];
  check('fixture bands are daily from the origin through election day',
    bands.length === days + 1 && bands.every((band, index) => band.path_day === index &&
      band.date === new Date(origin + index * 86400000).toISOString().slice(0, 10)),
  bands.map((band) => band.date));
  check('fixture bands publish ordered vote quantiles and no seats',
    bands.every((band) => ALL_COALITIONS.every((parties) => {
      const key = coalitionKey(history, parties);
      const group = band?.groups?.[key];
      return group && Object.keys(group).length === 1 &&
        !validateQuantiles(group.vote, `${band.date} ${key} vote`);
    })), bands.length);
  check('fixture uncertainty widens from the origin to election day',
    (() => {
      const key = coalitionKey(history, DEFAULT_COALITIONS[0]);
      const width = (band) => band.groups[key].vote.p95 - band.groups[key].vote.p05;
      return bands.length > 1 && width(bands.at(-1)) > width(bands[0]);
    })(), bands.length);
  check('fixture median path stays approximately flat under sign symmetry',
    (() => {
      const key = coalitionKey(history, DEFAULT_COALITIONS[0]);
      const first = bands[0].groups[key].vote.p50;
      return bands.every((band) => Math.abs(band.groups[key].vote.p50 - first) < 0.5);
    })(), bands.length);
  check('fixture publishes a limited number of complete trajectories',
    paths?.paths?.selection === 'evenly_spaced_draw_indices' &&
    paths.paths.count === paths.paths.series.length && paths.paths.count > 1 &&
    paths.paths.count <= 64 &&
    paths.paths.series.every((track) => ALL_COALITIONS.every((parties) =>
      track.values[coalitionKey(history, parties)]?.length === days + 1)),
  { count: paths?.paths?.count, selection: paths?.paths?.selection });
  check('fixture rendering forbids future observations and future seat paths',
    paths?.rendering?.x_axis_max === history?.election_date &&
    paths.rendering.future_region.start === paths.origin_date &&
    paths.rendering.future_region.end === paths.election_date &&
    paths.rendering.future_region.background === 'light_distinct' &&
    JSON.stringify(paths.rendering.path_units) === JSON.stringify(['vote']) &&
    JSON.stringify(paths.rendering.election_day_units) === JSON.stringify(['vote', 'seats']) &&
    paths.rendering.intermediate_seat_trajectory === false &&
    paths.rendering.median_may_be_flat === true &&
    paths.rendering.poll_observations_in_future === false &&
    paths.rendering.poll_of_polls_observations_in_future === false &&
    paths.rendering.continues_from === 'current_opinion_state',
  paths?.rendering);
  check('fixture demotes the shrinking-horizon fan to a secondary view',
    history?.future_projection?.role === 'secondary_analytical_view' &&
    history.future_projection.primary === false &&
    typeof history.future_projection.description_sv === 'string' &&
    history.future_projection.description_sv.length > 0,
  { role: history?.future_projection?.role, primary: history?.future_projection?.primary });
}

function validateHistory(history) {
  check('history JSON has schema 1.1', history && history.schema_version === '1.1', history?.schema_version);
  equal('history party order is the eight parliamentary parties', history?.party_order, PARTY_ORDER);
  check('history names the 2026 election', history?.election_date === ELECTION_DATE,
    history?.election_date);
  check('history carries a model provenance identifier',
    typeof history?.model_commit === 'string' && history.model_commit.length > 0,
    history?.model_commit);
  const hash = history?.poll_source_sha256 || history?.poll_data_sha256 || history?.poll_data_hash;
  check('history carries a poll-source hash', typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash), hash);

  for (const parties of ALL_COALITIONS) {
    const key = coalitionKey(history, parties);
    check(`history contains ${labelFor(parties)}`, key !== null, history?.coalitions);
  }

  const series = Array.isArray(history?.series) ? history.series : [];
  check('history has forecast observations', series.length > 0, series.length);
  const dates = series.map((point) => point && point.date).filter((date) => typeof date === 'string');
  check('forecast dates are ISO calendar dates', dates.length === series.length &&
    dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)), dates.slice(0, 3));
  // A date may legitimately have both a reconstructed and a prospective
  // archived point.  Require chronological ordering, while allowing those
  // provenance-distinguished observations to share a date.
  check('forecast dates are sorted', dates.every((date, index) =>
    index === 0 || date >= dates[index - 1]), dates.slice(0, 4));
  check('history starts no later than the 2022 election month',
    dates.length > 0 && dates[0] <= '2022-09-30', dates[0]);

  const allowedProvenance = new Set(['reconstructed_current_model', 'prospective_archived', 'current_production']);
  const pointIssues = [];
  const quantileIssues = [];
  for (const [index, point] of series.entries()) {
    const prefix = `history point ${index} (${point?.date || '?'})`;
    if (!(Number.isInteger(point?.samples) && point.samples > 0)) pointIssues.push(`${prefix}: invalid samples`);
    if (!allowedProvenance.has(point?.provenance)) pointIssues.push(`${prefix}: invalid provenance`);
    if (!(Number.isInteger(point?.horizon_days) && point.horizon_days >= 0 &&
      Number.isInteger(point?.dynamics_horizon_days) && point.dynamics_horizon_days >= 0)) {
      pointIssues.push(`${prefix}: invalid horizon metadata`);
    } else if (point.dynamics_horizon_days > point.horizon_days) {
      pointIssues.push(`${prefix}: dynamics horizon exceeds actual horizon`);
    }
    for (const parties of ALL_COALITIONS) {
      const key = coalitionKey(history, parties);
      const group = key && point.groups && point.groups[key];
      const voteIssue = validateQuantiles(group?.vote, `${prefix} ${labelFor(parties)} vote`);
      const seatIssue = validateQuantiles(group?.seats, `${prefix} ${labelFor(parties)} seats`);
      if (voteIssue) quantileIssues.push(voteIssue);
      if (seatIssue) quantileIssues.push(seatIssue);
    }
  }
  check('every forecast point has valid count/provenance/horizon metadata', pointIssues.length === 0,
    pointIssues.slice(0, 3).concat(pointIssues.length > 3 ? [`… and ${pointIssues.length - 3} more`] : []));
  check('every forecast group has ordered p05–p95 quantiles', quantileIssues.length === 0,
    quantileIssues.slice(0, 3).concat(quantileIssues.length > 3 ? [`… and ${quantileIssues.length - 3} more`] : []));

  const pop = Array.isArray(history?.poll_of_polls) ? history.poll_of_polls : [];
  check('history has Poll of Polls observations', pop.length > 0, pop.length);
  const popIssues = [];
  for (const [index, item] of pop.entries()) {
    const prefix = `pop ${index}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.date || '')) popIssues.push(`${prefix}: date`);
    if (JSON.stringify(Object.keys(item?.parties || {}).sort()) !== JSON.stringify([...PARTY_ORDER].sort())) {
      popIssues.push(`${prefix}: party keys are not exactly the eight parliamentary parties`);
    }
    if (!PARTY_ORDER.every((party) => finite(item?.parties?.[party]) && item.parties[party] >= 0)) {
      popIssues.push(`${prefix}: non-finite or negative party value`);
    }
  }
  check('every Poll of Polls point has valid date and eight party values', popIssues.length === 0,
    popIssues.slice(0, 3).concat(popIssues.length > 3 ? [`… and ${popIssues.length - 3} more`] : []));

  const polls = Array.isArray(history?.polls) ? history.polls : [];
  validateFutureProjection(history);
  validateCampaignPaths(history);
  return { series, pop, polls };
}

async function readHistoryFile(root) {
  const path = join(root, HISTORY_RELATIVE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const wrapped = new Error(`history artifact is missing at ${path}: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  }
  let history;
  try {
    history = JSON.parse(text);
  } catch (error) {
    throw new Error(`history artifact is not valid JSON: ${error.message}`);
  }
  validateHistory(history);
  return history;
}

// The published artifact does not carry future_projection until the backend
// feature ships.  Exercise the additive consumer deterministically by always
// overlaying the contract fixture onto a throwaway copy of the built site.
// Publication validation covers the real artifact separately; this smoke test
// owns the real-browser interaction contract and never modifies the checkout.
async function prepareSite(transform = (history) => history, validate = true) {
  const fixturePath = join(HERE, 'fixtures', 'coalition-timeseries.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const history = transform(structuredClone(fixture));
  const root = await mkdtemp(join(tmpdir(), 'election-timeseries-site-'));
  await cp(SITE, root, { recursive: true });
  const historyPath = join(root, HISTORY_RELATIVE);
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history)}\n`);
  if (validate) await readHistoryFile(root);
  console.log('\nusing deterministic forecast-history browser fixture');
  return { root, history, fallback: true, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const history = document.querySelector(
      '#election-timeseries, #election-forecast-history, [data-election-timeseries]');
    const svg = history?.querySelector('#election-timeseries-svg, #election-timeseries-chart, .election-timeseries__svg');
    return Boolean(status) && Boolean(history) &&
      (status.className.includes('error') || (!history.hidden && Boolean(svg) && svg.childElementCount > 2));
  }, 25000);
  if (!settled) throw new Error('the forecast app or historical chart never finished loading');
  await settle(350);
}

async function open(viewport, siteRoot = SITE) {
  const server = await serve(siteRoot, { port: 4000 });
  let browser;
  try {
    browser = await boundary(viewport.diagnostic, 'launch', async () => {
      const launched = await launch({ width: viewport.width, height: viewport.height });
      if (viewport.coarse) {
        await launched.S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
      return launched;
    });
    await boundary(viewport.diagnostic, 'navigate', () => browser.goto(
      `http://localhost:${server.port}${PAGE}`,
      { timeout: 30000, label: `${viewport.diagnostic} navigate` },
    ));
    await boundary(viewport.diagnostic, 'app-ready', () => waitForApp(browser));
    return { server, browser };
  } catch (error) {
    await closeBrowser(viewport.diagnostic, browser, server);
    throw error;
  }
}

// The exact ids/classes below are intentionally narrow first and semantic
// second.  The first names are the chart's public DOM contract; the fallbacks
// let this smoke test survive a harmless BEM rename without weakening any
// assertion about what is actually visible.
const SELECTORS = {
  section: '#election-timeseries, #election-forecast-history, [data-election-timeseries]',
  svg: '#election-timeseries-svg, #election-timeseries-chart, #election-forecast-history-chart, .election-timeseries__svg, .et-chart',
  viewButtons: '#election-timeseries-view button, #election-timeseries-controls button[data-view], .election-timeseries__mode button, .election-timeseries__views button',
  rangeGroup: '#election-timeseries-range, .election-timeseries__range, [data-timeseries-range]',
  rangeButtons: '#election-timeseries-range button, .election-timeseries__range button, [data-timeseries-range] button',
  coalitionButtons: '#election-timeseries-coalitions button, #election-timeseries-legend button, .election-timeseries__legend button',
  series: '[data-timeseries-series], .election-timeseries__series-group, .et-series, .eht-series',
  median: '.et-median, .eht-median, .election-timeseries__median, [data-timeseries-median], [data-role="median"]',
  band90: '.et-band--90, .eht-band--90, .election-timeseries__band--90, [data-timeseries-band="90"], [data-interval="90"]',
  band50: '.et-band--50, .eht-band--50, .election-timeseries__band--50, [data-timeseries-band="50"], [data-interval="50"]',
  popLine: '.election-timeseries__pop-line, [data-series="poll_of_polls"]',
  polls: '[data-poll-point], [data-poll="true"], .et-poll-dot, .eht-poll-dot, .election-timeseries__poll, circle.poll',
  marker: '[data-dynamics-marker], [data-marker="dynamics-horizon"], .et-dynamics-marker, .eht-dynamics-marker, .election-timeseries__dynamics-marker',
  crosshair: '[data-timeseries-crosshair], .election-timeseries__crosshair, .et-crosshair, .eht-crosshair',
  inspection: '[data-inspection-marker], .election-timeseries__inspection-point, .election-timeseries__selected-point',
  endpoint: '[data-endpoint-label], .election-timeseries__endpoint-label',
  campaignSeries: '[data-campaign-path-series="true"]',
  campaignPaths: '[data-campaign-path="true"]',
  campaignBands: '[data-campaign-band]',
  campaignMedians: '[data-campaign-median="true"]',
  campaignPoints: '[data-campaign-point="true"]',
  originStatePoints: '[data-origin-state-point="true"]',
  originStateIntervals: '[data-origin-state-interval]',
  originStateMedians: '[data-origin-state-median="true"]',
  electionDayPoints: '[data-election-day-point="true"]',
  electionDayIntervals: '[data-election-day-interval]',
  electionDayMedians: '[data-election-day-median="true"]',
  futureSeries: '[data-future-series="true"]',
  futurePoints: '[data-future-point="true"]',
  futureBands: '[data-future-band]',
  futureMedians: '[data-future-median="true"]',
  details: '#election-timeseries-detail, #election-timeseries-status, #election-forecast-history-detail, [data-timeseries-detail], .election-timeseries__detail, .et-detail, .eht-detail',
};

function readPage(browser) {
  return browser.evaluate((selectors) => {
    const section = document.querySelector(selectors.section);
    const svg = section?.querySelector(selectors.svg) || document.querySelector(selectors.svg);
    const rangeGroup = section?.querySelector(selectors.rangeGroup) || document.querySelector(selectors.rangeGroup);
    const hero = document.getElementById('election-hero');
    const navigation = hero?.querySelector('.election-hero__links');
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' &&
        style.opacity !== '0' && (rect.width > 0 && rect.height > 0 ||
          (element.ownerSVGElement && (rect.width > 0 || rect.height > 0)));
    };
    const buttonText = (button) => String(button?.textContent || '').replace(/[\t\n\r ]+/g, ' ').trim();
    const buttons = section ? Array.from(section.querySelectorAll('button')) : [];
    const views = buttons.filter((button) => /röstandel|mandatandel/i.test(buttonText(button)));
    const ranges = rangeGroup ? Array.from(rangeGroup.querySelectorAll('button')) : [];
    const coalitions = buttons.filter((button) => /\b[MVLCKSDP]{1,2}\b\s*\+/i.test(buttonText(button)));
    const series = svg ? Array.from(svg.querySelectorAll(selectors.series)) : [];
    const genericSeries = svg ? Array.from(svg.querySelectorAll('[data-coalition]')).filter((element) =>
      element.tagName.toLowerCase() === 'g' || element.matches('path,polyline')) : [];
    const seriesNodes = series.length ? series : genericSeries;
    const popLines = svg ? Array.from(svg.querySelectorAll(selectors.popLine)) : [];
    const popPoints = svg ? Array.from(svg.querySelectorAll('[data-pop-point="true"]')) : [];
    const polls = svg ? Array.from(svg.querySelectorAll(selectors.polls)) : [];
    const forecastPoints = svg ? Array.from(svg.querySelectorAll('[data-forecast-point="true"]')) : [];
    const markerCandidates = section ? Array.from(section.querySelectorAll(selectors.marker)) : [];
    const marker = markerCandidates.find(visible) || null;
    const dateAttrs = ['data-date', 'data-forecast-date', 'data-history-date'];
    const dates = svg ? Array.from(svg.querySelectorAll('[data-date], [data-forecast-date], [data-history-date]'))
      .map((element) => dateAttrs.map((name) => element.getAttribute(name)).find(Boolean)).filter(Boolean) : [];
    const tooltip = section?.querySelector('#election-timeseries-tooltip, .election-timeseries__tooltip') || null;
    const status = section?.querySelector('#election-timeseries-status, .election-timeseries__status') || null;
    const details = section ? Array.from(section.querySelectorAll(selectors.details)) : [];
    // The static status prompt is intentionally visible before a point is
    // chosen.  Treat it as a detail only after the app has replaced that
    // prompt with a selected-date summary; a visible tooltip always wins.
    const statusIsPrompt = status && /välj en punkt|choose a point/i.test(status.textContent || '');
    const detail = (tooltip && visible(tooltip)) ? tooltip :
      (status && visible(status) && !statusIsPrompt ? status :
        details.find((element) => visible(element) && !/välj en punkt|choose a point/i.test(element.textContent || '')) || null);
    const detailMeta = section?.querySelector('.election-timeseries__detail-meta') || null;
    const detailMetaEntries = detailMeta ? Array.from(detailMeta.children).map((entry) => {
      const term = entry.querySelector('dt')?.getBoundingClientRect();
      const value = entry.querySelector('dd')?.getBoundingClientRect();
      const rect = entry.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        termLeft: term ? Math.round(term.left) : null,
        valueLeft: value ? Math.round(value.left) : null,
      };
    }) : [];
    const box = (element) => element ? (() => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    })() : null;
    const title = svg?.querySelector('title');
    const description = svg?.querySelector('desc');
    const futureRegion = svg?.querySelector('[data-future-region="true"]');
    const latestBoundary = svg?.querySelector('[data-latest-forecast-boundary="true"]');
    const electionBoundary = svg?.querySelector('[data-election-day-boundary="true"]');
    const futurePoints = svg ? Array.from(svg.querySelectorAll(selectors.futurePoints)) : [];
    const futureMedians = svg ? Array.from(svg.querySelectorAll(selectors.futureMedians)) : [];
    const campaignPathLines = svg ? Array.from(svg.querySelectorAll(selectors.campaignPaths)) : [];
    const campaignPointMarks = svg ? Array.from(svg.querySelectorAll(selectors.campaignPoints)) : [];
    const originStateMarks = svg ? Array.from(svg.querySelectorAll(selectors.originStatePoints)) : [];
    const electionDayMarks = svg ? Array.from(svg.querySelectorAll(selectors.electionDayPoints)) : [];
    const regionLabel = svg?.querySelector('[data-future-region-label="true"]');
    const electionDayLabel = svg?.querySelector('[data-election-day-distribution-label="true"]');
    const plotClip = svg?.querySelector('#election-timeseries-plot-clip rect');
    const majority = svg?.querySelector('[data-majority="175"]');
    return {
      section: section ? {
        hidden: section.hidden,
        display: getComputedStyle(section).display,
        text: section.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
        box: box(section),
        futureState: section.getAttribute('data-future-projection') || '',
        futurePointCount: Number(section.getAttribute('data-future-projection-point-count')),
        campaignState: section.getAttribute('data-campaign-paths') || '',
        campaignPathCount: Number(section.getAttribute('data-campaign-path-count')),
        campaignPathDays: Number(section.getAttribute('data-campaign-path-days')),
        campaignWarp: section.getAttribute('data-campaign-path-warp') || '',
        campaignCue: (() => {
          const cue = section.querySelector('#election-timeseries-campaign-cue');
          if (!cue) return null;
          return {
            text: cue.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
            hidden: cue.hidden || getComputedStyle(cue).display === 'none',
            tag: cue.tagName,
          };
        })(),
        futurePathControl: (() => {
          const button = section.querySelector('#election-timeseries-future-paths');
          if (!button) return null;
          return {
            text: buttonText(button),
            ariaLabel: button.getAttribute('aria-label') || '',
            pressed: button.getAttribute('aria-pressed'),
          };
        })(),
        futureViewHidden: (() => {
          const host = section?.querySelector('#election-timeseries-future');
          return host ? host.hidden || getComputedStyle(host).display === 'none' : null;
        })(),
        heading: section.querySelector('h2')?.textContent?.trim() || '',
        futureView: section.getAttribute('data-future-view') || '',
        range: section.getAttribute('data-time-range') || section.getAttribute('data-range') || '',
        rangeStart: section.getAttribute('data-time-range-start') || '',
        rangeEnd: section.getAttribute('data-time-range-end') || '',
      } : null,
      sectionOrder: Array.from(document.querySelectorAll('.election-app > section')).map((element) => element.id),
      hero: hero ? {
        facts: Array.from(hero.querySelectorAll('.election-hero__fact')).map((fact) => ({
          label: fact.querySelector('dt')?.textContent?.trim() || '',
          value: fact.querySelector('dd')?.textContent?.trim() || '',
        })),
        lede: hero.querySelector('#election-hero-lede')?.textContent?.trim() || '',
      } : null,
      navigation: navigation ? Array.from(navigation.querySelectorAll('a')).map((link) => ({
        href: link.getAttribute('href') || '',
        text: link.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
      })) : [],
      svg: svg ? {
        role: svg.getAttribute('role'),
        tabindex: svg.getAttribute('tabindex'),
        labelledby: svg.getAttribute('aria-labelledby'),
        title: title?.textContent?.trim() || '',
        description: description?.textContent?.trim() || '',
        metric: svg.getAttribute('data-metric') || '',
        yMin: Number(svg.getAttribute('data-y-min')),
        yMax: Number(svg.getAttribute('data-y-max')),
        selectedDate: svg.getAttribute('data-selected-date') || '',
        range: svg.getAttribute('data-time-range') || svg.getAttribute('data-range') || '',
        xMin: svg.getAttribute('data-x-axis-min') || '',
        xMax: svg.getAttribute('data-x-axis-max') || '',
        futureOrigin: svg.getAttribute('data-future-projection-origin') || '',
        futureElection: svg.getAttribute('data-future-projection-election') || '',
        futureView: svg.getAttribute('data-future-view') || '',
        yDomainMode: svg.getAttribute('data-y-domain-mode') || '',
        campaignVisiblePathCount: Number(svg.getAttribute('data-campaign-visible-path-count')),
        campaignOrigin: svg.getAttribute('data-campaign-path-origin') || '',
        campaignElection: svg.getAttribute('data-campaign-path-election') || '',
        box: box(svg),
      } : null,
      views: views.map((button) => ({
        text: buttonText(button),
        pressed: button.getAttribute('aria-pressed'),
        tag: button.tagName,
        type: button.getAttribute('type'),
      })),
      rangeGroup: rangeGroup ? {
        role: rangeGroup.getAttribute('role'),
        label: rangeGroup.getAttribute('aria-label'),
        box: box(rangeGroup),
      } : null,
      ranges: ranges.map((button) => ({
        text: buttonText(button),
        pressed: button.getAttribute('aria-pressed'),
        controls: button.getAttribute('aria-controls'),
        tag: button.tagName,
        type: button.getAttribute('type'),
      })),
      coalitions: coalitions.map((button) => ({
        text: buttonText(button),
        pressed: button.getAttribute('aria-pressed'),
        key: button.getAttribute('data-coalition') || button.getAttribute('data-coalition-key') || '',
        tag: button.tagName,
        type: button.getAttribute('type'),
      })),
      series: seriesNodes.map((element) => ({
        key: element.getAttribute('data-coalition') || element.getAttribute('data-coalition-key') || element.getAttribute('data-series') || '',
        visible: visible(element),
        className: String(element.className?.baseVal || element.className || ''),
      })),
      medianCount: svg ? Array.from(svg.querySelectorAll(selectors.median)).filter(visible).length : 0,
      archivedCount: svg
        ? Array.from(svg.querySelectorAll('.election-timeseries__archived, [data-provenance="prospective_archived"]'))
          .filter(visible).length
        : 0,
      popLineCount: popLines.filter(visible).length,
      popPointCount: popPoints.filter(visible).length,
      popDates: [...new Set(popPoints.filter(visible).map((point) => point.getAttribute('data-date')))].sort(),
      popLegendCount: section ? section.querySelectorAll('#election-timeseries-key-pop').length : 0,
      band90Count: svg ? Array.from(svg.querySelectorAll(selectors.band90)).filter(visible).length : 0,
      band50Count: svg ? Array.from(svg.querySelectorAll(selectors.band50)).filter(visible).length : 0,
      currentCount: svg ? Array.from(svg.querySelectorAll('.election-timeseries__current, [data-current="true"]')).filter(visible).length : 0,
      pollCount: polls.filter(visible).length,
      pollDates: [...new Set(polls.filter(visible).map((point) => point.getAttribute('data-date')))].sort(),
      forecastDates: [...new Set(forecastPoints.filter(visible)
        .map((point) => point.getAttribute('data-date')))].sort(),
      crosshairCount: svg ? Array.from(svg.querySelectorAll(selectors.crosshair)).filter(visible).length : 0,
      inspectionCount: svg ? Array.from(svg.querySelectorAll(selectors.inspection)).filter(visible).length : 0,
      endpointCount: svg ? Array.from(svg.querySelectorAll(selectors.endpoint)).filter(visible).length : 0,
      // Horizontal position is a semantic encoding of time, so it gets its own
      // measurement block: client rects only, never a mix of client pixels and
      // viewBox attribute units.
      geometry: svg ? (() => {
        const centre = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return rect.x + rect.width / 2;
        };
        const dayMarks = Array.from(svg.querySelectorAll(selectors.campaignPoints))
          .map(centre).filter((value) => value !== null);
        return {
          originBoundary: centre(svg.querySelector('[data-latest-forecast-boundary="true"]')),
          electionBoundary: centre(svg.querySelector('[data-election-day-boundary="true"]')),
          originState: centre(svg.querySelector('[data-origin-state-point="true"]')),
          electionDay: centre(svg.querySelector('[data-election-day-point="true"]')),
          dayCount: dayMarks.length,
          dayMin: dayMarks.length ? Math.min(...dayMarks) : null,
          dayMax: dayMarks.length ? Math.max(...dayMarks) : null,
        };
      })() : null,
      certifiedX: (() => {
        const dot = svg?.querySelector('.election-timeseries__current');
        return dot ? dot.getBoundingClientRect().right : null;
      })(),
      campaign: svg ? {
        seriesCount: Array.from(svg.querySelectorAll(selectors.campaignSeries)).filter(visible).length,
        pathCount: campaignPathLines.filter(visible).length,
        pathSampleIndices: [...new Set(campaignPathLines
          .map((line) => Number(line.getAttribute('data-sample-index'))))].sort((a, b) => a - b),
        bandCount: Array.from(svg.querySelectorAll(selectors.campaignBands)).filter(visible).length,
        medianCount: Array.from(svg.querySelectorAll(selectors.campaignMedians)).filter(visible).length,
        medianOpacities: [...new Set(Array.from(svg.querySelectorAll(selectors.campaignMedians))
          .map((line) => getComputedStyle(line).opacity))],
        pointCount: campaignPointMarks.filter(visible).length,
        pointTargetCount: campaignPointMarks.length,
        pointFocusableCount: campaignPointMarks.filter((mark) => mark.getAttribute('tabindex') === '0').length,
        pointTabindexValues: [...new Set(campaignPointMarks.map((mark) => mark.getAttribute('tabindex')))],
        pointRoles: [...new Set(campaignPointMarks.map((mark) => mark.getAttribute('role')))],
        pointAriaHiddenValues: [...new Set(campaignPointMarks.map((mark) => mark.getAttribute('aria-hidden')))],
        pointAriaLabelValues: [...new Set(campaignPointMarks.map((mark) => mark.getAttribute('aria-label')))],
        pointDates: [...new Set(campaignPointMarks.map((mark) => mark.getAttribute('data-date')))].sort(),
        pathDays: [...new Set(campaignPointMarks.map((mark) => Number(mark.getAttribute('data-path-day'))))]
          .sort((a, b) => a - b),
        originStateCount: originStateMarks.filter(visible).length,
        originStateRoles: [...new Set(originStateMarks.map((m) => m.getAttribute('role')))],
        originStateTabindexValues: [...new Set(originStateMarks.map((m) => m.getAttribute('tabindex')))],
        originStateDates: [...new Set(originStateMarks.map((m) => m.getAttribute('data-date')))],
        originStateTags: [...new Set(originStateMarks.map((m) => m.tagName.toLowerCase()))],
        originStateLabels: [...new Set(originStateMarks
          .map((m) => m.getAttribute('data-origin-state-label')))],
        originStateIntervals: [...new Set(Array.from(svg.querySelectorAll(selectors.originStateIntervals))
          .filter(visible).map((m) => m.getAttribute('data-origin-state-interval')))].sort(),
        originStateMedianCount: Array.from(svg.querySelectorAll(selectors.originStateMedians))
          .filter(visible).length,
        originStateX: originStateMarks.length
          ? originStateMarks[0].getBoundingClientRect().left : null,
        regionLabel: regionLabel?.textContent?.trim() || '',
        electionDayLabel: electionDayLabel?.textContent?.trim() || '',
        electionDayPointCount: electionDayMarks.filter(visible).length,
        electionDayRoles: [...new Set(electionDayMarks.map((mark) => mark.getAttribute('role')))],
        electionDayTabindexValues: [...new Set(electionDayMarks.map((mark) => mark.getAttribute('tabindex')))],
        electionDayDates: [...new Set(electionDayMarks.map((mark) => mark.getAttribute('data-date')))],
        electionDayIntervals: [...new Set(Array.from(svg.querySelectorAll(selectors.electionDayIntervals))
          .filter(visible).map((mark) => mark.getAttribute('data-election-day-interval')))].sort(),
        electionDayMedianCount: Array.from(svg.querySelectorAll(selectors.electionDayMedians))
          .filter(visible).length,
      } : null,
      future: svg ? {
        seriesCount: Array.from(svg.querySelectorAll(selectors.futureSeries)).filter(visible).length,
        bandCount: Array.from(svg.querySelectorAll(selectors.futureBands)).filter(visible).length,
        medianCount: Array.from(svg.querySelectorAll(selectors.futureMedians)).filter(visible).length,
        medianDashes: [...new Set(futureMedians.filter(visible)
          .map((line) => line.getAttribute('stroke-dasharray') || getComputedStyle(line).strokeDasharray))],
        pointCount: futurePoints.filter(visible).length,
        pointRoles: [...new Set(futurePoints.map((point) => point.getAttribute('role')))],
        pointDates: [...new Set(futurePoints.map((point) => point.getAttribute('data-date')))].sort(),
        region: futureRegion ? {
          start: futureRegion.getAttribute('data-region-start'),
          end: futureRegion.getAttribute('data-region-end'),
          x: Number(futureRegion.getAttribute('x')),
          width: Number(futureRegion.getAttribute('width')),
        } : null,
        latestBoundary: latestBoundary ? {
          date: latestBoundary.getAttribute('data-date'),
          x: Number(latestBoundary.getAttribute('x1')),
        } : null,
        electionBoundary: electionBoundary ? {
          date: electionBoundary.getAttribute('data-date'),
          x: Number(electionBoundary.getAttribute('x1')),
        } : null,
        latestLabel: svg.querySelector('[data-latest-forecast-label="true"]')?.textContent?.trim() || '',
        electionLabel: svg.querySelector('[data-election-day-label="true"]')?.textContent?.trim() || '',
        pollsAfterOrigin: polls.filter((poll) =>
          String(poll.getAttribute('data-date') || '') > String(svg.getAttribute('data-future-projection-origin') || '')
        ).length,
      } : null,
      plot: plotClip ? {
        x: Number(plotClip.getAttribute('x')),
        width: Number(plotClip.getAttribute('width')),
      } : null,
      majority: majority ? {
        seats: majority.getAttribute('data-majority'),
        percent: Number(majority.getAttribute('data-majority-percent')),
        y: Number(majority.getAttribute('y1')),
      } : null,
      marker: marker ? {
        visible: visible(marker),
        text: marker.textContent.trim(),
        date: marker.getAttribute('data-date') || marker.getAttribute('data-marker-date') || '',
        markerType: marker.getAttribute('data-marker') || marker.getAttribute('data-horizon') || '',
      } : null,
      dates,
      detail: detail ? { text: detail.textContent.replace(/[\t\n\r ]+/g, ' ').trim(), visible: visible(detail) } : null,
      detailMeta: detailMeta ? {
        display: getComputedStyle(detailMeta).display,
        entries: detailMetaEntries,
      } : null,
      tooltip: tooltip ? { hidden: tooltip.hidden, text: tooltip.textContent.replace(/[\t\n\r ]+/g, ' ').trim(), visible: visible(tooltip) } : null,
      status: status ? { hidden: status.hidden, text: status.textContent.replace(/[\t\n\r ]+/g, ' ').trim(), visible: visible(status) } : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, SELECTORS);
}

function findLabel(buttons, wanted) {
  const target = compact(labelFor(wanted));
  return buttons.find((button) => compact(button.text) === target) ||
    buttons.find((button) => compact(button.text).includes(target));
}

function numberInText(text, value) {
  if (!finite(value) || !text) return false;
  const candidates = new Set([
    value.toFixed(0), value.toFixed(1), value.toFixed(2),
    value.toFixed(0).replace('.', ','), value.toFixed(1).replace('.', ','), value.toFixed(2).replace('.', ','),
  ]);
  const normalized = String(text).replace(/\u00a0/g, '').replace(/\s+/g, '');
  return [...candidates].some((candidate) => {
    const escaped = candidate.replace('.', '[,.]');
    return new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`).test(normalized);
  });
}

function findPointFor(history, parties, point) {
  const key = coalitionKey(history, parties);
  return { key, group: key && point.groups[key], date: point.date };
}

async function readRenderedPoint(browser, history, parties, point) {
  const wanted = findPointFor(history, parties, point);
  return browser.evaluate(({ selectors, key, date }) => {
    const section = document.querySelector(selectors.section);
    const svg = section?.querySelector(selectors.svg) || document.querySelector(selectors.svg);
    if (!svg) return null;
    const identity = (element) => [
      element.getAttribute('data-coalition'), element.getAttribute('data-coalition-key'),
      element.getAttribute('data-group'), element.getAttribute('data-series'),
    ].filter(Boolean).join('|');
    const ownsKey = (element) => {
      let current = element;
      while (current && current !== svg) {
        const value = identity(current);
        if (value && (value === key || value.includes(key))) return true;
        current = current.parentElement;
      }
      return false;
    };
    const dateOf = (element) => element.getAttribute('data-date') ||
      element.getAttribute('data-forecast-date') || element.getAttribute('data-history-date');
    const aliases = {
      p05: ['data-p05', 'data-p05-value', 'data-v05', 'data-lower-90'],
      p25: ['data-p25', 'data-p25-value', 'data-v25', 'data-lower-50'],
      p50: ['data-p50', 'data-p50-value', 'data-median', 'data-value', 'data-v50'],
      p75: ['data-p75', 'data-p75-value', 'data-v75', 'data-upper-50'],
      p95: ['data-p95', 'data-p95-value', 'data-v95', 'data-upper-90'],
    };
    const read = (element, name) => {
      for (const attr of aliases[name]) {
        const value = element.getAttribute(attr);
        if (value !== null && value !== '') return Number(value);
      }
      for (const attr of ['data-quantiles', 'data-values', 'data-forecast']) {
        const raw = element.getAttribute(attr);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const value = parsed[name] ?? parsed[name.toUpperCase()];
          if (value !== undefined) return Number(value);
        } catch { /* data-* may be a non-JSON label */ }
      }
      return null;
    };
    const candidates = Array.from(svg.querySelectorAll('[data-date], [data-forecast-date], [data-history-date], [data-p50], [data-median], [data-values]'))
      .filter((element) => dateOf(element) === date && ownsKey(element));
    for (const element of candidates) {
      const values = { p05: read(element, 'p05'), p25: read(element, 'p25'), p50: read(element, 'p50'), p75: read(element, 'p75'), p95: read(element, 'p95') };
      if (Object.values(values).every((value) => Number.isFinite(value))) return { date: dateOf(element), values, source: 'data-attributes' };
    }
    return null;
  }, { selectors: SELECTORS, key: wanted.key, date: wanted.date });
}

async function historicalPointCoordinates(browser, date) {
  return browser.evaluate((wantedDate) => {
    const point = document.querySelector(`[data-forecast-point="true"][data-date="${wantedDate}"]`);
    if (!point) return null;
    point.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = point.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, date);
}

async function futurePointCoordinates(browser, date) {
  return browser.evaluate((wantedDate) => {
    const point = document.querySelector(`[data-future-point="true"][data-date="${wantedDate}"]`);
    if (!point) return null;
    point.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = point.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, date);
}

async function markCoordinates(browser, attribute, date) {
  return browser.evaluate(({ selector }) => {
    const point = document.querySelector(selector);
    if (!point) return null;
    point.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = point.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { selector: `[${attribute}="true"][data-date="${date}"]` });
}

async function focusMark(browser, attribute, date) {
  return browser.evaluate(({ selector }) => {
    const point = document.querySelector(selector);
    if (!point) return null;
    point.focus();
    const active = document.activeElement;
    if (active !== point) return null;
    return { role: point.getAttribute('role'), date: point.getAttribute('data-date') };
  }, { selector: `[${attribute}="true"][data-date="${date}"]` });
}

// The future-view control is only present when both views are published.
async function switchFutureView(browser, view, label) {
  const clicked = await browser.evaluate((wanted) => {
    const normalize = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
    const button = Array.from(document.querySelectorAll('#election-timeseries-future button')).find((element) =>
      normalize(element.textContent) === wanted || normalize(element.getAttribute('aria-label')) === wanted);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  const state = await browser.evaluate(() => ({
    section: document.getElementById('election-timeseries')?.getAttribute('data-future-view') || '',
    paths: document.getElementById('election-timeseries-future-paths')?.getAttribute('aria-pressed'),
    stability: document.getElementById('election-timeseries-future-stability')?.getAttribute('aria-pressed'),
  }));
  check(`future view switches to ${view}`, clicked === true && state.section === view,
    { clicked, state, expected: view });
  return state;
}

async function focusFuturePoint(browser, date) {
  return browser.evaluate((wantedDate) => {
    const point = document.querySelector(`[data-future-point="true"][data-date="${wantedDate}"]`);
    if (!point) return null;
    point.focus();
    return { role: point.getAttribute('role'), date: point.getAttribute('data-date') };
  }, date);
}

async function plotCoordinates(browser, ratio) {
  return browser.evaluate(({ selectors, position }) => {
    const section = document.querySelector(selectors.section);
    const svg = section?.querySelector(selectors.svg) || document.querySelector(selectors.svg);
    const hit = svg?.querySelector('.election-timeseries__hit');
    if (!hit) return null;
    const rect = hit.getBoundingClientRect();
    return {
      x: rect.left + rect.width * Math.max(0, Math.min(1, position)),
      y: rect.top + rect.height / 2,
    };
  }, { selectors: SELECTORS, position: ratio });
}

async function hoverAt(browser, point) {
  if (!point) return;
  await browser.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await settle();
}

async function clickAt(browser, point) {
  if (!point) return;
  await browser.S('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await browser.S('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await settle();
}

async function tapAt(browser, point) {
  if (!point) return;
  await browser.S('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await browser.S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle();
}

async function pressKey(browser, key, code = key) {
  await browser.S('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code,
    windowsVirtualKeyCode: key === 'Enter' ? 13 : key === ' ' ? 32 : undefined,
  });
  await browser.S('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code,
    windowsVirtualKeyCode: key === 'Enter' ? 13 : key === ' ' ? 32 : undefined,
  });
  await settle();
}

async function clickButton(browser, buttonText) {
  return browser.evaluate((text) => {
    const normalize = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
    const host = document.getElementById('election-timeseries');
    const button = Array.from(host?.querySelectorAll('button') || []).find((element) =>
      normalize(element.textContent) === text || normalize(element.textContent).includes(text));
    if (!button) return false;
    button.click();
    return true;
  }, buttonText);
}

function assertStructure(view, history) {
  check('Vägen till valdagen section exists and is visible', view.section && !view.section.hidden && view.section.display !== 'none', view.section);
  equal('the timeline heading uses the election-day-first label', view.section?.heading, 'Vägen till valdagen');
  const order = view.sectionOrder;
  equal('the five primary sections use the exact timeline-first DOM order',
    order.slice(0, 5), [
      'election-timeseries',
      'election-alternatives',
      'election-government-builder',
      'election-headline',
      'election-seats',
    ]);
  equal('the subsection navigation follows the DOM order and labels',
    view.navigation, [
      { href: '#election-timeseries', text: 'Vägen till valdagen' },
      { href: '#election-alternatives', text: 'Regeringsalternativ' },
      { href: '#election-government-builder', text: 'Bygg din egen regering' },
      { href: '#election-parliament-outcome', text: 'Ett simulerat riksdagsutfall' },
      { href: '#election-headline', text: 'Röstandelar på valdagen' },
      { href: '#election-seats', text: 'Mandat på valdagen' },
      { href: '#election-latest-poll', text: 'Senaste mätningarna' },
      { href: '#election-changes', text: 'Förändring sedan föregående prognos' },
      { href: '#election-model', text: 'Så fungerar modellen' },
      { href: '#election-methodology', text: 'Metod och utvärdering' },
      { href: '#election-technical', text: 'Teknisk information' },
    ], view.navigation);
  const facts = view.hero?.facts || [];
  const publishedSamples = history.future_campaign_paths?.election_day?.samples ||
    history.series?.at(-1)?.samples;
  equal('hero fact labels are election-day-first', facts.map((fact) => fact.label),
    ['Underlag t.o.m.', 'Valdag', 'Dagar kvar']);
  check('hero lede explains the published election date, as-of date and draw count',
    /Valprognosen visar hur valet den\s+\d+ \S+ \d{4} kan sluta/i.test(view.hero?.lede || '') &&
    /underlag till och med\s+\d+ \S+ \d{4}/i.test(view.hero?.lede || '') &&
    numberInText(view.hero?.lede || '', publishedSamples), view.hero?.lede);
  check('historical SVG has accessible title and description',
    view.svg && view.svg.title.length > 0 && view.svg.description.length > 0 &&
    view.svg.role && view.svg.labelledby, view.svg);
  equal('the two default coalitions are represented by native controls',
    DEFAULT_COALITIONS.map((parties) => findLabel(view.coalitions, parties)?.text || null),
    DEFAULT_COALITIONS.map(labelFor));
  for (const parties of DEFAULT_COALITIONS) {
    const button = findLabel(view.coalitions, parties);
    check(`${labelFor(parties)} is a button with aria-pressed=true`, button?.tag === 'BUTTON' &&
      button.type === 'button' && button.pressed === 'true', button);
  }
  for (const parties of EXTRA_COALITIONS) {
    const button = findLabel(view.coalitions, parties);
    check(`${labelFor(parties)} has an off aria-pressed state by default`, button?.tag === 'BUTTON' &&
      button.type === 'button' && button.pressed === 'false', button);
  }
  equal('view controls expose Röstandel and Mandatandel',
    view.views.map((button) => button.text), ['Röstandel', 'Mandatandel']);
  check('view controls are native buttons with aria-pressed', view.views.every((button) =>
    button.tag === 'BUTTON' && button.type === 'button' && ['true', 'false'].includes(button.pressed)), view.views);
  equal('range controls expose Sedan 2022 and Sista 30 dagarna',
    view.ranges.map((button) => button.text), ['Sedan 2022', 'Sista 30 dagarna']);
  check('range control is an accessible native pressed-button group',
    view.rangeGroup?.role === 'group' && Boolean(view.rangeGroup?.label) && view.ranges.every((button) =>
      button.tag === 'BUTTON' && button.type === 'button' && button.controls === 'election-timeseries-svg' &&
      ['true', 'false'].includes(button.pressed)), { group: view.rangeGroup, buttons: view.ranges });
  equal('Sedan 2022 is the default range', view.ranges.map((button) => button.pressed), ['true', 'false']);
  const fullStart = fullRangeStart(history, 'vote');
  check('default full-range x-domain is unchanged through election day',
    view.svg?.range === 'full' && view.svg?.xMin === fullStart && view.svg?.xMax === history.election_date,
  { expected: [fullStart, history.election_date], svg: view.svg });
  check('default vote view uses an adaptive y-axis', view.svg?.metric === 'vote' &&
    finite(view.svg.yMin) && finite(view.svg.yMax) && view.svg.yMin > 0 && view.svg.yMax > view.svg.yMin,
  view.svg);
  check('50% is inside the displayed vote domain', view.svg?.yMin <= 50 && view.svg?.yMax >= 50, view.svg);
  check('the two default forecast series are visible', view.series.filter((series) => series.visible).length >= 2,
    view.series);
  check('the chart has both 50% and 90% forecast bands', view.band90Count >= 2 && view.band50Count >= 2,
    { band90: view.band90Count, band50: view.band50Count });
  check('median forecast lines are visible', view.medianCount >= 2, view.medianCount);
  // The aggregate Poll of Polls series is not charted at all any more: no
  // line, no vertex dots, no legend key, in either metric or range.
  equal('the aggregate Poll of Polls line is not drawn', view.popLineCount, 0);
  equal('the aggregate Poll of Polls points are not drawn', view.popPointCount, 0);
  equal('Poll of Polls has no legend key', view.popLegendCount, 0);
  // Archived prospective forecasts are published but not charted, so no
  // hollow marker is drawn and no undrawn mark stays selectable.
  equal('archived prospective forecasts are not drawn', view.archivedCount, 0);
  check('no archived date is a rendered forecast point',
    (history.series || []).filter((point) => point.provenance === 'prospective_archived')
      .every((point) => !view.forecastDates.includes(point.date)),
  view.forecastDates);
  check('individual poll observations are visible in vote mode', view.pollCount >= history.polls.length * 2,
    { rendered: view.pollCount, polls: history.polls.length });
  check('the latest forecast value is visibly marked', view.currentCount >= 2, view.currentCount);
  check('right-edge current-value labels are visible', view.endpointCount >= 2, view.endpointCount);
  check('no large floating tooltip is present', view.tooltip === null || view.tooltip.hidden === true,
    view.tooltip);
  check('the inspection layer is initially clear', view.crosshairCount === 0 && view.inspectionCount === 0,
    { crosshair: view.crosshairCount, inspection: view.inspectionCount });
  check('history date extent starts in September 2022 and reaches the latest point', (() => {
    const dates = view.dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
    const latest = history.series[history.series.length - 1]?.date;
    return dates.length > 0 && dates.some((date) => date <= '2022-09-30') &&
      (!latest || dates.some((date) => date === latest));
  })(), view.dates.slice(0, 3).concat(view.dates.slice(-3)));
  check('the former 24 May dynamics marker is absent from the plot', view.marker === null, view.marker);
  check('the page explains retrospective reconstruction and eight-party normalization',
    /rekonstru|omräkn|återskap/i.test(view.section?.text || '') &&
    /åtta riksdagspartier|normaliser|slutliga historiska poll of polls|poll of polls/i.test(view.section?.text || ''), view.section?.text);
  check('the chart copy distinguishes our simulation from Poll of Polls',
    /vår(?:a)? (?:simulerade |modell)?(?:val)?prognos|vår simulering|våra modellsimuleringar/i.test(view.section?.text || '') &&
    /Poll of Polls.*jämförelse|Opinionsunderlag via Poll of Polls/i.test(view.section?.text || ''),
  view.section?.text);
  check('the page explains actual and dynamics horizons',
    /faktisk.*tid|faktiska.*dag|horizon|rörelsedel|dynamik/i.test(view.section?.text || '') &&
    /112/.test(view.section?.text || ''), view.section?.text);
}

// Horizontal position encodes time.  An earlier revision inset the
// election-day glyph by 8-10 px to keep it clear of the plot clip, which put a
// dated mark at the wrong date -- and on the four-year scale, where the whole
// remaining campaign is about six pixels wide, left of the "I dag" boundary
// entirely.  Every one of the 599 other checks passed while that was true, so
// the ordering is asserted directly, in client pixels, at both viewports and
// in both ranges.
function assertCampaignGeometry(view, history, label) {
  const g = view.geometry;
  const epsilon = 0.75;
  check(`${label}: the geometry of both boundaries is measurable`,
    g !== null && Number.isFinite(g.originBoundary) && Number.isFinite(g.electionBoundary), g);
  if (!g) return;
  check(`${label}: the election-day glyph sits exactly on election day`,
    Number.isFinite(g.electionDay) &&
    Math.abs(g.electionDay - g.electionBoundary) <= epsilon,
  { glyph: g.electionDay, boundary: g.electionBoundary,
    delta: Number.isFinite(g.electionDay) ? g.electionDay - g.electionBoundary : null });
  check(`${label}: the future region runs forwards in time`,
    g.originBoundary <= g.electionBoundary + epsilon, g);
  if (g.dayCount > 0) {
    check(`${label}: every campaign day lies between today and election day`,
      g.originBoundary <= g.dayMin + epsilon && g.dayMax <= g.electionDay + epsilon,
    { boundary: g.originBoundary, dayMin: g.dayMin, dayMax: g.dayMax, glyph: g.electionDay });
  }
  if (Number.isFinite(g.originState)) {
    check(`${label}: the origin marker lies between today and election day`,
      g.originBoundary <= g.originState + epsilon && g.originState <= g.electionDay + epsilon,
    { boundary: g.originBoundary, origin: g.originState, glyph: g.electionDay });
  }
}

function assertCampaignPathStructure(view, history, metric = 'vote') {
  const paths = history.future_campaign_paths;
  const rendering = paths.rendering;
  const visibleKeys = DEFAULT_COALITIONS.map((parties) => coalitionKey(history, parties));
  const interior = paths.bands.slice(1);
  const representativeCount = Math.min(8, paths.paths.count);
  const representativeIndices = Array.from({ length: representativeCount }, (_, index) =>
    paths.paths.sample_indices[Math.round(index * (paths.paths.count - 1) /
      Math.max(1, representativeCount - 1))]);
  check('the campaign-path view is the default primary future region',
    view.section?.campaignState === 'true' && view.section?.futureView === 'campaign_paths' &&
    view.svg?.futureView === 'campaign_paths' && view.svg?.campaignOrigin === paths.origin_date &&
    view.svg?.campaignElection === paths.election_date && view.svg?.xMax === paths.election_date,
  { section: view.section, svg: view.svg });
  check('the published path count and length reach the DOM',
    view.section?.campaignPathCount === paths.paths.count &&
    view.section?.campaignPathDays === paths.path_days &&
    view.section?.campaignWarp === paths.path_construction.time_warp, view.section);
  check('the future region is shaded from the origin to election day',
    view.future?.region?.start === paths.origin_date &&
    view.future?.region?.end === paths.election_date &&
    view.future?.region?.width > 0 &&
    view.future?.electionBoundary?.date === paths.election_date, view.future);
  // The large in-plot caption is intentionally omitted.  The short control
  // keeps the published label as its accessible name without repeating it in
  // the plot and legend at the same time.
  equal('the redundant in-plot future caption is absent', view.campaign?.regionLabel, '');
  equal('the future-path control uses a concise visible label',
    view.section?.futurePathControl?.text, 'Opinionsbanor');
  equal('the future-path control carries the published accessible label',
    view.section?.futurePathControl?.ariaLabel, rendering.future_region.label);
  check('the campaign window uses its adaptive y-domain in the short range',
    metric !== 'vote' || view.svg?.range !== 'short' || view.svg?.yDomainMode === 'adaptive-campaign-window', view.svg);
  equal('the election-day distribution carries its published Swedish label',
    view.campaign?.electionDayLabel, rendering.election_day_distribution_label);
  equal('no poll or Poll of Polls dot enters the future region',
    view.future?.pollsAfterOrigin, 0);
  equal('the shrinking-horizon fan is not drawn in the primary view',
    [view.future?.bandCount, view.future?.medianCount, view.future?.pointCount], [0, 0, 0]);

  // The emphasized election-day distribution is present in both metrics: it
  // is the only future object that has a seat distribution at all.
  check('the election-day distribution is emphasized with box, whisker and median',
    view.campaign?.electionDayPointCount === DEFAULT_COALITIONS.length &&
    view.campaign?.electionDayMedianCount === DEFAULT_COALITIONS.length &&
    JSON.stringify(view.campaign?.electionDayIntervals) === JSON.stringify(['50', '90']) &&
    JSON.stringify(view.campaign?.electionDayDates) === JSON.stringify([paths.election_date]),
  view.campaign);
  equal('election-day marks are accessible buttons', view.campaign?.electionDayRoles, ['button']);
  equal('election-day marks remain keyboard tab stops', view.campaign?.electionDayTabindexValues, ['0']);

  if (metric === 'vote') {
    check('a restrained representative set of trajectories is drawn for every visible coalition',
      view.svg?.campaignVisiblePathCount === representativeCount &&
      view.campaign?.pathCount === representativeCount * DEFAULT_COALITIONS.length &&
      JSON.stringify(view.campaign?.pathSampleIndices) ===
        JSON.stringify(representativeIndices), view.campaign);
    check('50 % and 90 % predictive bands and a median are drawn',
      view.campaign?.bandCount === DEFAULT_COALITIONS.length * 2 &&
      view.campaign?.medianCount === DEFAULT_COALITIONS.length, view.campaign);
    check('the campaign median is visually subordinate to the fan and paths',
      view.campaign?.medianOpacities?.every((value) => Number(value) <= 0.2), view.campaign);
    check('one invisible selectable mark per campaign day, excluding the origin',
      view.campaign?.pointCount === 0 &&
      view.campaign?.pointTargetCount === interior.length * DEFAULT_COALITIONS.length &&
      view.campaign?.pointFocusableCount === 0 &&
      JSON.stringify(view.campaign?.pointTabindexValues) === JSON.stringify([null]) &&
      JSON.stringify(view.campaign?.pointDates) ===
        JSON.stringify(interior.map((band) => band.date)) &&
      view.campaign?.pathDays[0] === 1 &&
      view.campaign?.pathDays.at(-1) === paths.path_days, view.campaign);
    check('daily campaign hit geometry is hidden from the accessibility tree',
      JSON.stringify(view.campaign?.pointRoles) === JSON.stringify([null]) &&
      JSON.stringify(view.campaign?.pointAriaHiddenValues) === JSON.stringify(['true']) &&
      JSON.stringify(view.campaign?.pointAriaLabelValues) === JSON.stringify([null]),
    view.campaign);
    // Path day 0 is the latent opinion state, a different and much narrower
    // distribution than the certified forecast point on the same date.  It
    // gets its own mark, its own shape and its own published label.
    check('the origin state has its own mark for every visible coalition',
      view.campaign?.originStateCount === DEFAULT_COALITIONS.length &&
      view.campaign?.originStateMedianCount === DEFAULT_COALITIONS.length &&
      JSON.stringify(view.campaign?.originStateIntervals) === JSON.stringify(['50', '90']) &&
      JSON.stringify(view.campaign?.originStateDates) === JSON.stringify([paths.origin_date]),
    view.campaign);
    equal('the origin mark is not a circle, so it cannot read as the forecast dot',
      view.campaign?.originStateTags, ['rect']);
    equal('the origin mark is an accessible button', view.campaign?.originStateRoles, ['button']);
    equal('the origin mark remains a keyboard tab stop', view.campaign?.originStateTabindexValues, ['0']);
    equal('the origin mark carries its published label',
      view.campaign?.originStateLabels, [rendering.origin_state_label]);
    check('the fan emanates from the origin mark, not from the certified forecast dot',
      view.campaign?.originStateX > view.certifiedX,
    { origin: view.campaign?.originStateX, certified: view.certifiedX });
    const values = paths.bands.flatMap((band) => visibleKeys.flatMap((key) =>
      [band.groups[key].vote.p05, band.groups[key].vote.p95]));
    const trajectories = paths.paths.series.flatMap((track) =>
      visibleKeys.flatMap((key) => track.values[key]));
    check('the y-domain contains every visible band edge and trajectory value',
      view.svg?.yMin <= Math.min(...values, ...trajectories) &&
      view.svg?.yMax >= Math.max(...values, ...trajectories),
    { domain: [view.svg?.yMin, view.svg?.yMax],
      min: Math.min(...values, ...trajectories), max: Math.max(...values, ...trajectories) });
  } else {
    check('Mandatandel hides the future-view selector', view.section?.futureViewHidden === true,
      view.section);
    check('Mandatandel draws no opinion paths, bands, origin marker or day marks',
      view.campaign?.pathCount === 0 && view.campaign?.bandCount === 0 &&
      view.campaign?.medianCount === 0 && view.campaign?.pointCount === 0 &&
      view.campaign?.originStateCount === 0, view.campaign);
    check('Mandatandel explains why opinion paths carry no seats',
      /Mandat visas först för valdagsprognosen/i.test(view.section?.text || ''), view.section?.text);
    const seatValues = visibleKeys.flatMap((key) =>
      [100 * paths.election_day.groups[key].seats.p05 / 349,
        100 * paths.election_day.groups[key].seats.p95 / 349]);
    check('the seat y-domain contains the election-day seat distribution',
      view.svg?.yMin <= Math.min(...seatValues) && view.svg?.yMax >= Math.max(...seatValues),
    { domain: [view.svg?.yMin, view.svg?.yMax], seatValues });
  }
  check('the primary view explains why the election-day interval is wider',
    /Valdagsprognosen är bredare.*osäkerheten/i.test(view.section?.text || ''), view.section?.text);
  check('the secondary view is described as conditional, not as the prognosis',
    (view.section?.text || '').includes(history.future_projection.description_sv),
  view.section?.text);
}

function assertFutureStructure(view, history, metric = 'vote') {
  const projection = history.future_projection;
  const futureSource = metric === 'seats' && history.future_campaign_paths
    ? history.future_campaign_paths : projection;
  const rendering = futureSource.rendering;
  const visibleKeys = DEFAULT_COALITIONS.map((parties) => coalitionKey(history, parties));
  const values = metric === 'vote' ? projection.series.flatMap((point) => visibleKeys.flatMap((key) => {
    const quantiles = point.groups[key][metric];
    return [quantiles.p05, quantiles.p95];
  })) : [];
  check('valid future projection is rendered by the main chart',
    view.section?.futureState === 'true' && view.svg?.futureOrigin === futureSource.origin_date &&
    view.svg?.futureElection === futureSource.election_date && view.svg?.xMax === futureSource.election_date,
  { section: view.section, svg: view.svg });
  check('future region spans exactly latest forecast to election day',
    view.future?.region?.start === futureSource.origin_date &&
    view.future?.region?.end === futureSource.election_date &&
    view.future?.latestBoundary?.date === futureSource.origin_date &&
    view.future?.electionBoundary?.date === futureSource.election_date &&
    Math.abs(view.future.region.x - view.future.latestBoundary.x) < 0.01 &&
    Math.abs(view.future.region.x + view.future.region.width - view.future.electionBoundary.x) < 0.01,
  view.future);
  equal('future boundary labels come from rendering metadata',
    [view.future?.latestLabel, view.future?.electionLabel],
    [rendering.latest_forecast_label || rendering.origin_boundary_label, rendering.election_day_label]);
  if (metric === 'vote') {
    check(`${metric} mode renders future 50/90 bands and dashed medians`,
      view.future?.bandCount >= DEFAULT_COALITIONS.length * 2 &&
      view.future?.medianCount >= DEFAULT_COALITIONS.length &&
      view.future?.medianDashes?.every((value) => value && value !== 'none'), view.future);
    check(`${metric} y-domain contains every visible future p05/p95`,
      view.svg?.yMin <= Math.min(...values) && view.svg?.yMax >= Math.max(...values),
    { yMin: view.svg?.yMin, yMax: view.svg?.yMax, futureMin: Math.min(...values), futureMax: Math.max(...values) });
    check('future points cover the daily series through election day',
      view.future?.pointCount === projection.series.length * DEFAULT_COALITIONS.length &&
      view.future?.pointDates[0] === projection.series[0].date &&
      view.future?.pointDates.at(-1) === projection.election_date, view.future);
    equal('interactive future points use role button', view.future?.pointRoles, ['button']);
  } else {
    check('Mandatandel hides the future-view selector', view.section?.futureViewHidden === true,
      view.section);
    check('Mandatandel does not invent intermediate future seat paths',
      view.future?.bandCount === 0 && view.future?.medianCount === 0 &&
      view.future?.pointCount === 0, view.future);
    check('Mandatandel retains the election-day seat distribution',
      view.campaign?.electionDayPointCount === DEFAULT_COALITIONS.length &&
      view.campaign?.electionDayMedianCount === DEFAULT_COALITIONS.length,
    view.campaign);
  }
  equal('no future poll or Poll of Polls dots are rendered', view.future?.pollsAfterOrigin, 0);
  if (metric === 'vote') {
    check('projection legend and disclosure use backend copy',
      (view.section?.text || '').includes(rendering.legend_label) &&
      (view.section?.text || '').includes(projection.tooltip_sv), view.section?.text);
  }
}

function assertFixturePointText(text, point, group, label) {
  check(`${label}: selected detail includes its date`, text.includes(point.date) ||
    text.includes(point.date.slice(0, 4)) ||
    /\b(?:19|20)\d{2}\b/.test(text), text);
  check(`${label}: selected detail includes median and 50% interval`, numberInText(text, group.p50) &&
    numberInText(text, group.p25) && numberInText(text, group.p75), text);
  check(`${label}: selected detail includes 90% interval`, numberInText(text, group.p05) &&
    numberInText(text, group.p95), text);
  check(`${label}: selected detail includes simulation count`, numberInText(text, point.samples), text);
  check(`${label}: selected detail includes provenance`,
    /reconstructed_current_model|prospective_archived|rekonstru|omräkn|återskap|prospektiv|arkiver/i.test(text), text);
  check(`${label}: selected detail includes actual/dynamics horizons`,
    numberInText(text, point.horizon_days) && numberInText(text, point.dynamics_horizon_days), text);
}

function visibleRangeExtremes(history, metric, start, end) {
  const keys = DEFAULT_COALITIONS.map((parties) => coalitionKey(history, parties));
  const values = [];
  const addQuantiles = (point) => {
    for (const key of keys) {
      const quantiles = point?.groups?.[key]?.[metric];
      if (!quantiles) continue;
      const convert = (value) => metric === 'seats' ? 100 * value / 349 : value;
      values.push(convert(quantiles.p05), convert(quantiles.p95));
    }
  };
  for (const point of history.series || []) {
    if (inDateRange(point?.date, start, end)) addQuantiles(point);
  }
  if (metric === 'seats' && history.future_campaign_paths?.election_day &&
      inDateRange(history.future_campaign_paths.election_day.date, start, end)) {
    addQuantiles(history.future_campaign_paths.election_day);
  }
  // The secondary future fan is an opinion-only view.  In Mandatandel it is
  // intentionally not a source of seat values, so it must not widen the seat
  // domain invisibly.
  if (metric === 'vote') {
    for (const point of history.future_projection?.series || []) {
      if (inDateRange(point?.date, start, end)) addQuantiles(point);
    }
  }
  if (metric === 'vote') {
    for (const collection of [history.polls || []]) {
      for (const point of collection) {
        const date = publishedDate(point);
        if (!inDateRange(date, start, history.future_projection.origin_date)) continue;
        const denominator = PARTY_ORDER.reduce((sum, party) => sum + Number(point.parties?.[party] || 0), 0);
        for (const parties of DEFAULT_COALITIONS) {
          values.push(100 * parties.reduce((sum, party) => sum + Number(point.parties?.[party] || 0), 0) /
            denominator);
        }
      }
    }
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

function assertShortRange(view, history, fullView, metric = 'vote') {
  const start = shortRangeStart(history);
  const end = history.election_date;
  const origin = history.future_projection.origin_date;
  equal('fixture short-range dates are election minus 30 days through election day',
    [start, end], ['2026-08-14', '2026-09-13']);
  check('Sista 30 dagarna exposes the exact active x-domain',
    view.section?.range === 'short' && view.section?.rangeStart === start && view.section?.rangeEnd === end &&
    view.svg?.range === 'short' && view.svg?.xMin === start && view.svg?.xMax === end,
  { section: view.section, svg: view.svg });
  equal('short-range button state is visible and exclusive',
    view.ranges.map((button) => button.pressed), ['false', 'true']);
  check('historical forecasts before the short-range start are not rendered',
    view.forecastDates.length > 0 && view.forecastDates.every((date) => inDateRange(date, start, origin)),
  view.forecastDates);
  const expectedPollDates = [...new Set((history.polls || []).map(publishedDate)
    .filter((date) => inDateRange(date, start, origin)))].sort();
  if (metric === 'vote') {
    equal('all in-range individual poll observations remain visible', view.pollDates, expectedPollDates);
    check('individual poll observations never enter the future region',
      view.pollDates.every((date) => date <= origin), { polls: view.pollDates, origin });
  } else {
    check('Mandatandel keeps individual poll observations hidden',
      view.pollDates.length === 0, view.pollDates);
  }
  equal('the short range does not reintroduce the Poll of Polls overlay',
    [view.popLineCount, view.popPointCount], [0, 0]);
  if (metric === 'vote') {
    check('short range keeps the complete future projection shaded and dashed',
      view.future?.pointCount === history.future_projection.series.length * DEFAULT_COALITIONS.length &&
      view.future?.bandCount >= DEFAULT_COALITIONS.length * 2 &&
      view.future?.medianDashes?.every((value) => value && value !== 'none'), view.future);
  } else {
    check('short-range Mandatandel keeps the future seat area intentionally empty',
      view.future?.pointCount === 0 && view.future?.bandCount === 0 && view.future?.medianCount === 0,
    view.future);
  }
  check('Senaste prognos stays at the projection origin, not the short-range start',
    view.future?.latestBoundary?.date === origin && view.future.latestBoundary.x > view.plot?.x,
  { boundary: view.future?.latestBoundary, plot: view.plot, start });
  check('election-day boundary stays at the right edge',
    view.future?.electionBoundary?.date === end &&
    Math.abs(view.future.electionBoundary.x - (view.plot?.x + view.plot?.width)) < 0.01,
  { boundary: view.future?.electionBoundary, plot: view.plot });
  const extremes = visibleRangeExtremes(history, metric, start, end);
  check(`${metric} short-range y-domain contains visible uncertainty and observations`,
    view.svg?.yMin <= extremes.min && view.svg?.yMax >= extremes.max,
  { domain: [view.svg?.yMin, view.svg?.yMax], extremes });
  check(`${metric} y-domain is recalculated instead of retained from full range`,
    view.svg?.yMin !== fullView.svg?.yMin || view.svg?.yMax !== fullView.svg?.yMax,
  { full: [fullView.svg?.yMin, fullView.svg?.yMax], short: [view.svg?.yMin, view.svg?.yMax] });
}

async function exercise(viewport, history, siteRoot) {
  console.log(`\n${viewport.name}`);
  const { server, browser } = await open(viewport, siteRoot);
  const assertionsStarted = Date.now();
  await diagnostic(`${viewport.diagnostic} assertions START`);
  try {
    // ---- primary view: the coherent campaign-path region -----------------
    // A published campaign-path region makes the election-relative range the
    // default, because the four-year view compresses the remaining campaign
    // into a few pixels.
    let view = await readPage(browser);
    const paths = history.future_campaign_paths;
    // A published campaign region must not silently change which view the page
    // opens on.  "Sedan 2022" stays the default and the cue is how a reader
    // finds the election-relative window where the region is legible.
    equal('the published full range is still the opening range',
      [view.svg?.range, view.svg?.xMin, view.svg?.xMax],
      ['full', fullRangeStart(history, 'vote'), history.election_date]);
    equal('the range buttons open on Sedan 2022',
      view.ranges.map((button) => button.pressed), ['true', 'false']);
    assertCampaignGeometry(view, history, 'full range, vote');
    equal('full range switches to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    assertCampaignGeometry(await readPage(browser), history, 'full range, seats');
    equal('full range returns to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();
    view = await readPage(browser);
    check('the campaign-window cue is offered as a native button',
      view.section?.campaignCue?.hidden === false &&
      view.section?.campaignCue?.tag === 'BUTTON' &&
      /kampanjperioden/i.test(view.section?.campaignCue?.text || ''),
    view.section?.campaignCue);
    equal('the cue switches to the election-relative window',
      await clickButton(browser, 'Visa kampanjperioden'), true);
    await settle();
    view = await readPage(browser);
    check('the cue lands on the campaign window and then retires',
      view.svg?.range === 'short' && view.svg?.xMin === shortRangeStart(history) &&
      view.svg?.xMax === history.election_date &&
      view.section?.campaignCue?.hidden === true, { svg: view.svg, cue: view.section?.campaignCue });
    equal('the future-view control offers the primary and secondary views',
      view.ranges.length >= 2 && await browser.evaluate(() => {
        const host = document.getElementById('election-timeseries-future');
        if (!host || host.hidden) return null;
        return Array.from(host.querySelectorAll('button')).map((button) => ({
          text: button.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
          ariaLabel: button.getAttribute('aria-label'),
          pressed: button.getAttribute('aria-pressed'),
        }));
      }), [
        { text: 'Opinionsbanor', ariaLabel: paths.rendering.future_region.label, pressed: 'true' },
        { text: 'Kvarvarande osäkerhet', ariaLabel: null, pressed: 'false' },
      ]);
    assertCampaignPathStructure(view, history, 'vote');
    assertCampaignGeometry(view, history, 'campaign window, vote');

    // ---- secondary view: the shrinking-horizon fan ------------------------
    await switchFutureView(browser, 'conditional_projection', 'Kvarvarande osäkerhet');
    await settle();
    view = await readPage(browser);
    check('the secondary view replaces the campaign region rather than stacking on it',
      view.campaign?.pathCount === 0 && view.campaign?.bandCount === 0 &&
      view.campaign?.electionDayPointCount === 0 && view.future?.bandCount > 0, view);
    await switchFutureView(browser, 'campaign_paths', 'Opinionsbanor');
    await settle();
    view = await readPage(browser);
    check('switching back restores the campaign region', view.campaign?.bandCount > 0, view.campaign);

    // ---- the remaining assertions exercise the historical chart and the
    // secondary fan, so return to the full range and keep that fan active.
    equal('return to the full history range', await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    await switchFutureView(browser, 'conditional_projection', 'Kvarvarande osäkerhet');
    await settle();
    view = await readPage(browser);
    assertStructure(view, history);
    view = await readPage(browser);
    const fullVoteView = structuredClone(view);
    assertFutureStructure(view, history, 'vote');

    // Clicking an extra coalition must change both aria-pressed and the
    // visible series.
    const extra = labelFor(EXTRA_COALITIONS[0]);
    const beforeVisible = (await readPage(browser)).series.filter((series) => series.visible).length;
    const beforeFutureMedians = (await readPage(browser)).future?.medianCount;
    equal(`toggle ${extra} on`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    const extraOn = findLabel(view.coalitions, EXTRA_COALITIONS[0]);
    check(`${extra} changes aria-pressed to true`, extraOn?.pressed === 'true', extraOn);
    check(`${extra} adds a visible forecast series`, view.series.filter((series) => series.visible).length > beforeVisible,
      view.series);
    check(`${extra} adds its future projection series in the same render`,
      view.future?.medianCount === beforeFutureMedians + 1, view.future);
    equal(`toggle ${extra} off`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    check(`${extra} changes aria-pressed back to false`, findLabel(view.coalitions, EXTRA_COALITIONS[0])?.pressed === 'false', view.coalitions);
    check(`${extra} removes its historical and future series together`,
      view.series.filter((series) => series.visible).length === beforeVisible &&
      view.future?.medianCount === beforeFutureMedians, { series: view.series, future: view.future });

    // Faded individual observations are visible in vote-share mode; the
    // aggregate Poll of Polls series is not.
    equal('the Poll of Polls overlay stays absent in vote-share mode',
      view.popLineCount + view.popPointCount, 0);
    check('individual poll dots appear for both default coalitions', view.pollCount >= history.polls.length * 2,
      { rendered: view.pollCount, polls: history.polls.length });

    equal('switch to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    view = await readPage(browser);
    const fullSeatView = structuredClone(view);
    check('Mandatandel is pressed', findLabel(view.views, ['Mandatandel'])?.pressed === 'true', view.views);
    check('seat mode uses an adaptive y-axis containing the majority threshold',
      view.svg?.metric === 'seats' && finite(view.svg.yMin) && finite(view.svg.yMax) &&
      view.svg.yMin > 0 && view.svg.yMin <= (175 / 349 * 100) &&
      view.svg.yMax >= (175 / 349 * 100), view.svg);
    equal('seat-share mode has no Poll of Polls overlay',
      view.popLineCount + view.popPointCount, 0);
    equal('seat-share mode has no raw poll dots', view.pollCount, 0);
    check('seat-share mode shows the 175 mandate majority rule', /175\s*mandat/i.test(view.section?.text || '') &&
      /175\s*mandat/i.test(`${view.marker?.text || ''} ${view.section?.text || ''}`), view.section?.text);
    check('seat-share mode explains why individual measurements are omitted',
      /Mandat visas först för valdagsprognosen/i.test(view.section?.text || ''),
      view.section?.text);
    check('Mandatandel has no future-view selector', view.section?.futureViewHidden === true,
      view.section);
    assertFutureStructure(view, history, 'seats');
    const seatPoint = history.series[0];
    const seatCoordinates = await historicalPointCoordinates(browser, seatPoint.date);
    await clickAt(browser, seatCoordinates);
    const seatView = await readPage(browser);
    const seatDetail = seatView.detail?.text || '';
    check('seat detail includes the raw median seat count',
      numberInText(seatDetail, findPointFor(history, DEFAULT_COALITIONS[0], seatPoint).group.seats.p50) &&
      /mandat/i.test(seatDetail), seatDetail);
    check('seat detail omits Poll of Polls', !/Poll of Polls/i.test(seatDetail), seatDetail);

    // Repeat the range round trip while Mandatandel is active.  This guards
    // the metric-specific full-domain source list and the majority reference
    // independently of the vote-share path below.
    equal('Mandatandel full range uses its published extent',
      [view.svg?.range, view.svg?.xMin, view.svg?.xMax],
      ['full', fullRangeStart(history, 'seats'), history.election_date]);
    const seatFullBeforeRange = structuredClone(view);
    equal('Mandatandel switches to Sista 30 dagarna', await clickButton(browser, 'Sista 30 dagarna'), true);
    await settle();
    let seatShortRoundTrip = await readPage(browser);
    check('Mandatandel short round-trip has the election-relative domain',
      seatShortRoundTrip.svg?.metric === 'seats' && seatShortRoundTrip.svg?.range === 'short' &&
      seatShortRoundTrip.svg?.xMin === shortRangeStart(history) &&
      seatShortRoundTrip.svg?.xMax === history.election_date, seatShortRoundTrip.svg);
    equal('Mandatandel switches back to Sedan 2022', await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    view = await readPage(browser);
    check('Mandatandel full domain and y-domain restore after range round trip',
      view.svg?.metric === 'seats' && view.svg?.range === 'full' &&
      view.svg?.xMin === seatFullBeforeRange.svg?.xMin &&
      view.svg?.xMax === seatFullBeforeRange.svg?.xMax &&
      view.svg?.yMin === seatFullBeforeRange.svg?.yMin &&
      view.svg?.yMax === seatFullBeforeRange.svg?.yMax &&
      view.majority?.seats === '175', { before: seatFullBeforeRange.svg, after: view.svg, majority: view.majority });

    equal('switch back to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();
    view = await readPage(browser);
    check('Röstandel is pressed', findLabel(view.views, ['Röstandel'])?.pressed === 'true', view.views);
    equal('vote-share mode does not restore the Poll of Polls overlay',
      view.popLineCount + view.popPointCount, 0);
    check('vote-share mode restores individual poll dots', view.pollCount >= history.polls.length * 2,
      { rendered: view.pollCount, polls: history.polls.length });

    // Exercise the same renderer in the election-relative viewport.  All
    // assertions below observe the built page after real button interaction.
    equal('switch to Sista 30 dagarna', await clickButton(browser, 'Sista 30 dagarna'), true);
    await settle();
    view = await readPage(browser);
    assertShortRange(view, history, fullVoteView, 'vote');

    await browser.evaluate(() => document.getElementById('election-timeseries-range-full')?.focus());
    await pressKey(browser, ' ', 'Space');
    view = await readPage(browser);
    check('Space activates the focused Sedan 2022 range button',
      view.svg?.range === 'full' && view.ranges[0]?.pressed === 'true', view.ranges);
    await browser.evaluate(() => document.getElementById('election-timeseries-range-short')?.focus());
    await pressKey(browser, ' ', 'Space');
    view = await readPage(browser);
    check('Space activates the focused Sista 30 dagarna range button',
      view.svg?.range === 'short' && view.ranges[1]?.pressed === 'true', view.ranges);

    const shortFutureMedians = view.future?.medianCount;
    equal(`short range toggle ${extra} on`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    check('coalition toggles add historical and projected series in the short range',
      findLabel(view.coalitions, EXTRA_COALITIONS[0])?.pressed === 'true' &&
      view.future?.medianCount === shortFutureMedians + 1, view);
    equal(`short range toggle ${extra} off`, await clickButton(browser, extra), true);
    await settle();

    const shortStart = shortRangeStart(history);
    const shortOrigin = history.future_projection.origin_date;
    const visibleHistorical = history.series.filter((point) =>
      inDateRange(point.date, shortStart, shortOrigin));
    const pointerDates = [visibleHistorical[0]?.date,
      visibleHistorical[Math.floor(visibleHistorical.length / 2)]?.date,
      shortOrigin];
    for (const [index, date] of pointerDates.entries()) {
      const ratio = (dateTime(date) - dateTime(shortStart)) /
        Math.max(1, dateTime(shortOrigin) - dateTime(shortStart));
      await hoverAt(browser, await plotCoordinates(browser, ratio));
      const mapped = await readPage(browser);
      check(`short-range historical pointer mapping ${['left edge', 'intermediate date', 'latest date'][index]}`,
        mapped.svg?.selectedDate === date, { selected: mapped.svg?.selectedDate, expected: date, ratio });
    }

    const shortFutureDate = history.future_projection.series[Math.floor(
      history.future_projection.series.length / 2)].date;
    await clickAt(browser, await futurePointCoordinates(browser, shortFutureDate));
    let shortFutureView = await readPage(browser);
    check('short-range future click opens projected details',
      shortFutureView.svg?.selectedDate === shortFutureDate && shortFutureView.detail?.visible === true,
    shortFutureView.detail);
    equal('short-range future point receives keyboard focus',
      await focusFuturePoint(browser, history.election_date), { role: 'button', date: history.election_date });
    await pressKey(browser, 'Enter', 'Enter');
    shortFutureView = await readPage(browser);
    check('short-range Enter selects election-day projection',
      shortFutureView.svg?.selectedDate === history.election_date && shortFutureView.detail?.visible === true,
    shortFutureView.detail);
    await pressKey(browser, ' ', 'Space');
    shortFutureView = await readPage(browser);
    check('short-range Space preserves projected details',
      shortFutureView.svg?.selectedDate === history.election_date && shortFutureView.detail?.visible === true,
    shortFutureView.detail);

    equal('switch short range to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    view = await readPage(browser);
    assertShortRange(view, history, fullSeatView, 'seats');
    check('short-range Mandatandel retains the 175-seat majority line',
      view.svg?.metric === 'seats' && view.majority?.seats === '175' &&
      Math.abs(view.majority.percent - 100 * 175 / 349) < 0.0001,
    { metric: view.svg?.metric, majority: view.majority });
    equal('return short range to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();

    // Select a full-history point, then change range without a focus/blur
    // detour.  The renderer must replace the invisible detail deterministically.
    equal('temporarily restore full range for stale-selection check',
      await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    const staleTransition = await browser.evaluate(({ oldDate, shortLabel }) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const point = document.querySelector(
        `[data-forecast-point="true"][data-date="${oldDate}"]`,
      );
      point?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const svg = document.getElementById('election-timeseries-svg');
      const before = svg?.getAttribute('data-selected-date') || '';
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        candidate.textContent.replace(/[\t\n\r ]+/g, ' ').trim() === shortLabel);
      button?.click();
      return { before, after: svg?.getAttribute('data-selected-date') || '' };
    }, { oldDate: history.series[0].date, shortLabel: 'Sista 30 dagarna' });
    await settle();
    view = await readPage(browser);
    equal('stale-selection fixture starts outside the short range',
      staleTransition.before, history.series[0].date);
    check('range change replaces an out-of-range selection with a visible short-range point',
      staleTransition.after === shortOrigin &&
      inDateRange(view.svg?.selectedDate, shortStart, history.election_date) &&
      view.svg?.selectedDate !== history.series[0].date && view.detail?.visible === true &&
      !(view.detail?.text || '').includes(history.series[0].date),
    { transition: staleTransition, selected: view.svg?.selectedDate, detail: view.detail });
    check('short-range view has no horizontal overflow', view.overflow <= 0, view.overflow);

    equal('switching back restores Sedan 2022 without reloading',
      await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    view = await readPage(browser);
    check('full domain and default button state are restored',
      view.svg?.range === 'full' && view.svg?.xMin === fullVoteView.svg?.xMin &&
      view.svg?.xMax === fullVoteView.svg?.xMax &&
      view.svg?.yMin === fullVoteView.svg?.yMin && view.svg?.yMax === fullVoteView.svg?.yMax &&
      JSON.stringify(view.ranges.map((button) => button.pressed)) === JSON.stringify(['true', 'false']),
    { svg: view.svg, ranges: view.ranges });

    await hoverAt(browser, await historicalPointCoordinates(browser, history.future_projection.origin_date));
    const latestHistorical = await readPage(browser);
    check('historical pointer mapping still selects the latest historical point at its boundary',
      latestHistorical.svg?.selectedDate === history.future_projection.origin_date,
    { selected: latestHistorical.svg?.selectedDate, expected: history.future_projection.origin_date });

    const futureSeries = history.future_projection.series;
    const futureMouseDate = futureSeries[Math.floor(futureSeries.length / 2)].date;
    const futureCoordinates = await futurePointCoordinates(browser, futureMouseDate);
    await settle(100);
    await hoverAt(browser, futureCoordinates);
    let futureView = await readPage(browser);
    check('future mouse inspection selects a projected day',
      futureSeries.some((point) => point.date === futureView.svg?.selectedDate) &&
      futureView.detail?.visible === true &&
      (futureView.detail?.text || '').includes(history.future_projection.rendering.legend_label) &&
      !/Poll of Polls/i.test(futureView.detail?.text || ''), futureView.detail);
    const futureDate = history.future_projection.election_date;
    equal('future point can receive keyboard focus as a button',
      await focusFuturePoint(browser, futureDate), { role: 'button', date: futureDate });
    await pressKey(browser, 'Enter', 'Enter');
    futureView = await readPage(browser);
    check('Enter opens future projection details', futureView.svg?.selectedDate === futureDate &&
      futureView.detail?.visible === true && numberInText(futureView.detail?.text || '', 0), futureView.detail);
    await pressKey(browser, ' ', 'Space');
    futureView = await readPage(browser);
    check('Space preserves future projection details', futureView.svg?.selectedDate === futureDate &&
      futureView.detail?.visible === true, futureView.detail);

    // The first forecast point is a deterministic fixture check.
    const point = history.series[0];
    const rendered = await readRenderedPoint(browser, history, DEFAULT_COALITIONS[0], point);
    const expected = findPointFor(history, DEFAULT_COALITIONS[0], point);
    if (rendered?.source === 'data-attributes') {
      equal('first default series date matches history fixture', rendered.date, point.date);
      for (const quantile of ['p05', 'p25', 'p50', 'p75', 'p95']) {
        check(`first default series ${quantile} matches history fixture`,
          Math.abs(rendered.values[quantile] - expected.group.vote[quantile]) < 0.0001,
          { rendered: rendered.values[quantile], expected: expected.group.vote[quantile] });
      }
    } else {
      check('chart exposes a fixture-date point or detail target', false, { date: point.date, key: expected.key });
    }

    const coordinates = await historicalPointCoordinates(browser, point.date);
    await hoverAt(browser, coordinates);
    view = await readPage(browser);
    check('hovering a forecast point exposes the persistent detail panel', view.detail?.visible === true &&
      (view.detail.text || '').length > 0, view.detail);
    check('hovering a forecast point draws a crosshair', view.crosshairCount === 1,
      { crosshair: view.crosshairCount, selectedDate: view.svg?.selectedDate });
    check('hovering a forecast point highlights every visible coalition', view.inspectionCount >= 2,
      view.inspectionCount);
    check('simulation metadata uses an aligned responsive layout', (() => {
      const entries = view.detailMeta?.entries || [];
      if (view.detailMeta?.display !== 'grid' || entries.length !== 3) return false;
      if (viewport.width <= 600) {
        return new Set(entries.map((entry) => entry.top)).size === 3 &&
          new Set(entries.map((entry) => entry.valueLeft)).size === 1;
      }
      return new Set(entries.map((entry) => entry.top)).size === 1;
    })(), view.detailMeta);
    check('hover detail does not expose internal provenance enum strings',
      !/reconstructed_current_model|prospective_archived|current_production/.test(view.detail?.text || ''),
      view.detail?.text);
    const detailText = view.detail?.text || '';
    if (detailText) {
      assertFixturePointText(detailText, point, expected.group.vote, 'vote-share forecast detail');
      check('detail panel includes Poll of Polls', /Poll of Polls/i.test(detailText), detailText);
      check('detail panel labels our simulated forecast separately', /Vår simulering/i.test(detailText), detailText);
    }
    await clickAt(browser, coordinates);
    view = await readPage(browser);
    check('clicking a forecast point keeps its selection visible', view.detail?.visible === true &&
      (view.detail.text || '').length > 0, view.detail);
    check('clicking a forecast point keeps its crosshair and selected date',
      view.crosshairCount === 1 && Boolean(view.svg?.selectedDate), view.svg);
    const clickedDate = view.svg?.selectedDate;
    await hoverAt(browser, await plotCoordinates(browser, 0.76));
    const afterClickHover = await readPage(browser);
    check('hover inspection remains live after clicking the chart',
      afterClickHover.crosshairCount === 1 && Boolean(afterClickHover.svg?.selectedDate) &&
      afterClickHover.svg.selectedDate !== clickedDate,
    { clickedDate, hoveredDate: afterClickHover.svg?.selectedDate });
    await browser.evaluate((selectors) => {
      const svg = document.querySelector(selectors.svg);
      svg?.focus();
    }, SELECTORS);
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    const keyboardView = await readPage(browser);
    check('keyboard ArrowLeft moves the selected forecast date',
      keyboardView.crosshairCount === 1 && keyboardView.detail?.visible === true &&
      Boolean(keyboardView.svg?.selectedDate), keyboardView);
    await browser.evaluate(() => {
      const app = document.getElementById('election-simulator-app');
      app?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });
    await settle(100);
    const afterEscape = await readPage(browser);
    check('Escape clears the persistent point selection', !afterEscape.detail?.visible || !afterEscape.detail?.text,
      afterEscape.detail);

    // Touch interaction
    if (viewport.coarse) {
      await tapAt(browser, coordinates);
      const tapped = await readPage(browser);
      check('tapping a date persists the selected detail on touch', tapped.detail?.visible === true &&
        (tapped.detail.text || '').length > 0, tapped.detail);
      check('tapping a date pins the crosshair on touch', tapped.crosshairCount === 1 &&
        Boolean(tapped.svg?.selectedDate), tapped.svg);
    }

    // ---- back to the primary view for its own interaction contract -------
    // Run these last: the historical assertions above require a pristine
    // inspection layer, which any pointer interaction would dirty.
    await switchFutureView(browser, 'campaign_paths', paths.rendering.future_region.label);
    equal('return to the campaign window', await clickButton(browser, 'Visa kampanjperioden'), true);
    await settle();
    view = await readPage(browser);
    assertCampaignPathStructure(view, history, 'vote');

    // Daily campaign marks remain pointer/touch targets, while keyboard users
    // reach the same dates from the chart-level focus target.
    await clickAt(browser, await markCoordinates(browser, 'data-election-day-point',
      history.election_date));
    await browser.evaluate(() => document.getElementById('election-timeseries-svg')?.focus());
    const campaignDays = paths.bands.slice(1).map((band) => band.date);
    await pressKey(browser, 'ArrowLeft', 'ArrowLeft');
    let chartKeyboardView = await readPage(browser);
    check('chart-level ArrowLeft reaches a campaign day',
      chartKeyboardView.svg?.tabindex === '0' &&
      campaignDays.includes(chartKeyboardView.svg?.selectedDate),
    { selected: chartKeyboardView.svg?.selectedDate, campaignDays });
    await pressKey(browser, 'ArrowRight', 'ArrowRight');
    chartKeyboardView = await readPage(browser);
    check('chart-level ArrowRight reaches the election-day landmark',
      chartKeyboardView.svg?.selectedDate === history.election_date, chartKeyboardView.svg);

    // Pointer, keyboard and focus interaction on the two new mark kinds.
    const bandDate = paths.bands[Math.floor(paths.bands.length / 2)].date;
    await clickAt(browser, await markCoordinates(browser, 'data-campaign-point', bandDate));
    let campaignView = await readPage(browser);
    check('clicking an opinion-band mark opens its detail',
      campaignView.svg?.selectedDate === bandDate && campaignView.detail?.visible === true &&
      (campaignView.detail?.text || '').includes(paths.rendering.future_region.label) &&
      !/Poll of Polls/i.test(campaignView.detail?.text || ''), campaignView.detail);
    check('an opinion-band detail reports opinion, not seats or a horizon',
      /Underliggande opinionsläge/i.test(campaignView.detail?.text || '') &&
      !/mandat/i.test(campaignView.detail?.text || ''), campaignView.detail);
    await clickAt(browser, await markCoordinates(browser, 'data-origin-state-point',
      paths.origin_date));
    campaignView = await readPage(browser);
    const originKey = coalitionKey(history, DEFAULT_COALITIONS[0]);
    check('clicking the origin mark opens the opinion state, not the forecast',
      campaignView.svg?.selectedDate === paths.origin_date &&
      campaignView.detail?.visible === true &&
      (campaignView.detail?.text || '').includes(paths.rendering.origin_state_label) &&
      numberInText(campaignView.detail?.text || '',
        paths.bands[0].groups[originKey].vote.p50) &&
      !/Officiell aktuell valprognos/i.test(campaignView.detail?.text || ''),
    campaignView.detail);
    check('the origin detail states the quantity and separates it from the forecast',
      /Underliggande opinionsläge/i.test(campaignView.detail?.text || '') &&
      /inte valdagsprognosen/i.test(campaignView.detail?.text || ''), campaignView.detail);
    equal('the origin mark receives keyboard focus as a button',
      await focusMark(browser, 'data-origin-state-point', paths.origin_date),
      { role: 'button', date: paths.origin_date });
    await pressKey(browser, 'Enter', 'Enter');
    campaignView = await readPage(browser);
    check('Enter opens the focused origin state',
      campaignView.svg?.selectedDate === paths.origin_date &&
      campaignView.detail?.visible === true, campaignView.detail);
    equal('daily opinion-band marks are not individually keyboard focusable',
      await focusMark(browser, 'data-campaign-point', bandDate), null);
    equal('the election-day mark receives keyboard focus as a button',
      await focusMark(browser, 'data-election-day-point', history.election_date),
      { role: 'button', date: history.election_date });
    await pressKey(browser, 'Enter', 'Enter');
    campaignView = await readPage(browser);
    const electionKey = coalitionKey(history, DEFAULT_COALITIONS[0]);
    check('Enter opens the certified election-day distribution',
      campaignView.svg?.selectedDate === history.election_date &&
      campaignView.detail?.visible === true &&
      (campaignView.detail?.text || '').includes(paths.election_day.label_sv) &&
      numberInText(campaignView.detail?.text || '',
        paths.election_day.groups[electionKey].vote.p50) &&
      numberInText(campaignView.detail?.text || '', paths.election_day.samples),
    campaignView.detail);
    await pressKey(browser, ' ', 'Space');
    campaignView = await readPage(browser);
    check('Space preserves the election-day distribution detail',
      campaignView.svg?.selectedDate === history.election_date &&
      campaignView.detail?.visible === true, campaignView.detail);
    check('the primary view has no horizontal overflow', campaignView.overflow <= 0,
      campaignView.overflow);

    // The same primary view under Mandatandel: seats exist only on election day.
    equal('primary view switches to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    campaignView = await readPage(browser);
    assertCampaignPathStructure(campaignView, history, 'seats');
    assertCampaignGeometry(campaignView, history, 'campaign window, seats');
    await clickAt(browser, await markCoordinates(browser, 'data-election-day-point',
      history.election_date));
    campaignView = await readPage(browser);
    check('the election-day seat distribution is the certified seat distribution',
      numberInText(campaignView.detail?.text || '',
        paths.election_day.groups[electionKey].seats.p50) &&
      /mandat/i.test(campaignView.detail?.text || ''), campaignView.detail);
    equal('primary view returns to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();


    view = await readPage(browser);
    check('no page-level horizontal overflow', view.overflow <= 0, view.overflow);
    equal('no console errors', appErrors(browser), []);
    equal('no uncaught exceptions', browser.exceptions, []);
    await diagnostic(
      `${viewport.diagnostic} assertions DONE elapsed=${((Date.now() - assertionsStarted) / 1000).toFixed(3)}s`,
    );
  } catch (error) {
    await diagnostic(
      `${viewport.diagnostic} assertions FAIL ` +
      `elapsed=${((Date.now() - assertionsStarted) / 1000).toFixed(3)}s reason=${error.message}`,
    );
    throw error;
  } finally {
    await closeBrowser(viewport.diagnostic, browser, server);
  }
}

async function scenarioView(prepared, label, beforeRead = null) {
  const viewport = VIEWPORTS[0];
  const { server, browser } = await open({ ...viewport, diagnostic: label }, prepared.root);
  try {
    if (beforeRead) await beforeRead(browser);
    return await readPage(browser);
  } finally {
    await closeBrowser(label, browser, server);
    await prepared.cleanup();
  }
}

function historicalFingerprint(view) {
  return {
    metric: view.svg?.metric,
    yMin: view.svg?.yMin,
    yMax: view.svg?.yMax,
    xMax: view.svg?.xMax,
    series: view.series.filter((series) => series.visible).map((series) => series.key),
    medianCount: view.medianCount,
    band50Count: view.band50Count,
    band90Count: view.band90Count,
    pollCount: view.pollCount,
    currentCount: view.currentCount,
    endpointCount: view.endpointCount,
  };
}

async function exerciseMetricSpecificFullDomain(siteRoot = SITE) {
  // Give vote share one poll-only date before the first series/PoP date in a
  // throwaway copy of the fixture.  This makes the source-list distinction
  // observable in a real browser without changing the published fixture.
  const prepared = await prepareSite((history) => {
    const firstPoll = history.polls?.[0];
    const firstSeriesDate = history.series?.[0]?.date;
    const pollOnlyDate = calendarDateOffset(firstSeriesDate, -1);
    if (!firstPoll || !pollOnlyDate) return history;
    const extraPoll = structuredClone(firstPoll);
    extraPoll.poll_id = `${extraPoll.poll_id || 'domain-check'}-poll-only-date`;
    extraPoll.publication_date = pollOnlyDate;
    extraPoll.fieldwork_start = pollOnlyDate;
    extraPoll.fieldwork_end = pollOnlyDate;
    history.polls = [extraPoll, ...history.polls];
    return history;
  });
  const viewport = { ...VIEWPORTS[0], diagnostic: 'metric-domain' };
  const { server, browser } = await open(viewport, prepared.root || siteRoot);
  try {
    // A published campaign-path region defaults the chart to the campaign
    // window, so the full-history domain has to be requested explicitly.
    equal('metric-domain opens the full history range',
      await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    let view = await readPage(browser);
    const voteMin = fullRangeStart(prepared.history, 'vote');
    const seatsMin = fullRangeStart(prepared.history, 'seats');
    check('vote full range includes its individual-poll extent',
      view.svg?.metric === 'vote' && view.svg?.range === 'full' &&
      view.svg?.xMin === voteMin && view.svg?.xMax === prepared.history.election_date &&
      voteMin !== seatsMin, { svg: view.svg, voteMin, seatsMin });

    equal('metric-domain switches to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    view = await readPage(browser);
    check('Mandatandel full range uses series plus Poll of Polls extent only',
      view.svg?.metric === 'seats' && view.svg?.range === 'full' &&
      view.svg?.xMin === seatsMin && view.svg?.xMax === prepared.history.election_date &&
      view.svg?.xMin !== voteMin, { svg: view.svg, voteMin, seatsMin });
    check('metric-specific full-domain browser check has no overflow or errors',
      view.overflow <= 0 && appErrors(browser).length === 0 && browser.exceptions.length === 0,
    { overflow: view.overflow, console: appErrors(browser), exceptions: browser.exceptions });
  } finally {
    await closeBrowser(viewport.diagnostic, browser, server);
    await prepared.cleanup();
  }
}

async function exerciseFallbackScenarios() {
  const missing = await prepareSite((history) => {
    delete history.future_projection;
    return history;
  }, false);
  const missingView = await scenarioView(missing, 'missing-projection');
  check('missing future_projection leaves the historical chart active',
    missingView.section?.futureState === '' && missingView.future?.seriesCount === 0 &&
    missingView.future?.pointCount === 0, missingView);

  const missingShort = await prepareSite((history) => {
    delete history.future_projection;
    return history;
  }, false);
  const missingShortView = await scenarioView(missingShort, 'missing-projection-short', async (browser) => {
    equal('missing projection can switch to Sista 30 dagarna',
      await clickButton(browser, 'Sista 30 dagarna'), true);
    await settle();
  });
  check('missing future_projection still uses election-relative short domain',
    missingShortView.section?.futureState === '' && missingShortView.svg?.range === 'short' &&
    missingShortView.svg?.xMin === shortRangeStart(missingShort.history) &&
    missingShortView.svg?.xMax === missingShort.history.election_date &&
    missingShortView.forecastDates.every((date) => inDateRange(
      date, shortRangeStart(missingShort.history), missingShort.history.election_date)),
  missingShortView);

  const malformed = await prepareSite((history) => {
    history.future_projection.anchor.samples += 1;
    return history;
  }, false);
  const malformedView = await scenarioView(malformed, 'malformed-projection');
  check('malformed future_projection fails safely to the historical chart',
    malformedView.section?.futureState === 'invalid' && malformedView.future?.seriesCount === 0 &&
    malformedView.future?.pointCount === 0, malformedView);
  equal('missing and malformed projections have the same historical rendering',
    historicalFingerprint(malformedView), historicalFingerprint(missingView));

  // ---- campaign-path fail-safe scenarios --------------------------------
  const noPaths = await prepareSite((history) => {
    delete history.future_campaign_paths;
    return history;
  }, false);
  const noPathsView = await scenarioView(noPaths, 'missing-campaign-paths');
  check('missing future_campaign_paths falls back to the secondary fan and the full range',
    noPathsView.section?.campaignState === '' && noPathsView.campaign?.pathCount === 0 &&
    noPathsView.campaign?.electionDayPointCount === 0 &&
    noPathsView.svg?.range === 'full' && noPathsView.future?.bandCount > 0 &&
    noPathsView.svg?.xMax === ELECTION_DATE, noPathsView);

  const malformedPaths = await prepareSite((history) => {
    // The published election-day distribution no longer matches the certified
    // production point.  That is exactly the drift the consumer must refuse.
    const key = Object.keys(history.future_campaign_paths.election_day.groups)[0];
    history.future_campaign_paths.election_day.groups[key].seats.p50 += 1;
    return history;
  }, false);
  const malformedPathsView = await scenarioView(malformedPaths, 'malformed-campaign-paths');
  check('campaign paths whose election day drifts from production fail safely',
    malformedPathsView.section?.campaignState === 'invalid' &&
    malformedPathsView.campaign?.pathCount === 0 &&
    malformedPathsView.campaign?.bandCount === 0 &&
    malformedPathsView.campaign?.electionDayPointCount === 0 &&
    malformedPathsView.svg?.range === 'full', malformedPathsView);
  equal('missing and malformed campaign paths render the same history',
    historicalFingerprint(malformedPathsView), historicalFingerprint(noPathsView));

  const seatPathClaim = await prepareSite((history) => {
    history.future_campaign_paths.rendering.intermediate_seat_trajectory = true;
    return history;
  }, false);
  const seatPathClaimView = await scenarioView(seatPathClaim, 'campaign-paths-seat-claim');
  check('an implied intermediate seat trajectory is refused outright',
    seatPathClaimView.section?.campaignState === 'invalid' &&
    seatPathClaimView.campaign?.pathCount === 0, seatPathClaimView);

  const walkClaim = await prepareSite((history) => {
    history.future_campaign_paths.path_construction.daily_independent_random_walk = true;
    return history;
  }, false);
  const walkClaimView = await scenarioView(walkClaim, 'campaign-paths-random-walk');
  check('a declared daily independent random walk is refused outright',
    walkClaimView.section?.campaignState === 'invalid' &&
    walkClaimView.campaign?.pathCount === 0, walkClaimView);

  const leaked = await prepareSite((history) => {
    history.future_campaign_paths.path_construction.latest_trajectory_end =
      history.election_date;
    return history;
  }, false);
  const leakedView = await scenarioView(leaked, 'campaign-paths-leakage');
  check('a trajectory ending after the origin is refused outright',
    leakedView.section?.campaignState === 'invalid' && leakedView.campaign?.pathCount === 0,
  leakedView);

  const electionDay = await prepareSite((history) => {
    // On election day there is no remaining campaign, so the publisher drops
    // the primary object entirely.
    delete history.future_campaign_paths;
    const current = history.series.find((point) => point.provenance === 'current_production');
    current.date = history.election_date;
    current.horizon_days = 0;
    current.dynamics_horizon_days = 0;
    const projection = history.future_projection;
    projection.origin_date = history.election_date;
    projection.state_cutoff_date = history.election_date;
    projection.anchor.date = history.election_date;
    projection.series = [];
    projection.tooltip_sv = 'Framåtblickande projektion från opinionsläget 13 sep. Antar oförändrat underliggande opinionsläge; framtida mätningar är okända.';
    projection.rendering.x_axis_max = history.election_date;
    projection.rendering.future_region.start = history.election_date;
    projection.rendering.future_region.end = history.election_date;
    return history;
  }, false);
  const electionDayView = await scenarioView(electionDay, 'election-day-projection');
  check('election-day origin accepts an empty series without rendering a fan',
    electionDayView.section?.futureState === 'empty' && electionDayView.future?.seriesCount === 0 &&
    electionDayView.future?.pointCount === 0 && electionDayView.svg?.xMax === ELECTION_DATE &&
    electionDayView.section?.campaignState === '' &&
    electionDayView.campaign?.electionDayPointCount === 0, electionDayView);
}

async function main() {
  const prepared = await prepareSite();
  try {
    for (const viewport of VIEWPORTS) await exercise(viewport, prepared.history, prepared.root);
  } finally {
    await prepared.cleanup();
  }
  await exerciseFallbackScenarios();
  await exerciseMetricSpecificFullDomain();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log('FAIL');
    process.exitCode = 1;
  } else {
    console.log('PASS (forecast timeseries)');
  }
}

main().catch((error) => {
  console.error(`\nforecast timeseries smoke test blocked: ${error.message}`);
  process.exitCode = 1;
});
