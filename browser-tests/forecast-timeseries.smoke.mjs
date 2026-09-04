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

// The chart ends at the latest published forecast, so both range ends do too.
function latestPlottedDate(history) {
  return (history?.series || [])
    .filter((point) => point?.provenance !== 'prospective_archived')
    .map(publishedDate)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    .sort().at(-1) || null;
}

function shortRangeStart(history) {
  return calendarDateOffset(latestPlottedDate(history), -30);
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
function fullRangeDates(history, metric) {
  const collections = [history?.series || []];
  if (metric === 'vote') collections.push(history?.polls || []);
  return collections.flatMap((items) => items.map(publishedDate))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    .sort();
}

function fullRangeStart(history, metric) {
  return fullRangeDates(history, metric)[0] || null;
}

// Not the latest observation of any kind: a poll that post-dates the most
// recent generation must not carry the axis past the end of the forecast line.
function fullRangeEnd(history) {
  return latestPlottedDate(history);
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
  // The line is drawn only through the non-archived points, so a date that
  // carries nothing but an archived prospective point is a hole in it. Inside
  // the daily part of the schedule the drawn dates must therefore step one day
  // at a time: each publication relabels the previous official point
  // `prospective_archived`, and when nothing refills the date the final
  // segment silently spans a gap that widens by a day per publication.
  const dailyFrom = typeof history?.schedule?.daily_from === 'string'
    ? history.schedule.daily_from : null;
  const curveDates = series
    .filter((point) => point?.provenance !== 'prospective_archived')
    .map((point) => point?.date)
    .filter((date) => typeof date === 'string')
    .sort();
  const dailyGaps = [];
  for (let index = 1; index < curveDates.length; index += 1) {
    const previous = curveDates[index - 1];
    const current = curveDates[index];
    if (dailyFrom === null || previous < dailyFrom) continue;
    const days = Math.round(
      (Date.parse(`${current}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`)) / 86400000);
    if (days !== 1) dailyGaps.push(`${previous} → ${current} (${days} days)`);
  }
  check('the drawn curve steps one day at a time after the dynamics cap',
    dailyFrom !== null && dailyGaps.length === 0, dailyGaps.slice(0, 5));

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
  const current = series.filter((point) => point?.provenance === 'current_production');
  check('fixture has one current production anchor', current.length === 1,
    current.map((point) => point.date));
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

// Exercise the consumer deterministically by always overlaying the contract
// fixture onto a throwaway copy of the built site.  Publication validation
// covers the real artifact separately; this smoke test owns the real-browser
// interaction contract and never modifies the checkout.
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
  // Every mark kind the chart used to draw to the right of the latest
  // certified forecast.  The chart now ends there, so all of these must be
  // absent -- listed by name so a reintroduced extrapolation fails loudly
  // rather than silently reappearing.
  forwardMarks: [
    '[data-future-region="true"]', '[data-future-background="true"]',
    '[data-future-series="true"]', '[data-future-point="true"]',
    '[data-future-band]', '[data-future-median="true"]',
    '[data-campaign-path-series="true"]', '[data-campaign-path="true"]',
    '[data-campaign-band]', '[data-campaign-median="true"]',
    '[data-campaign-point="true"]',
    '[data-origin-state-point="true"]', '[data-origin-state-interval]',
    '[data-origin-state-median="true"]',
    '[data-election-day-series="true"]', '[data-election-day-point="true"]',
    '[data-election-day-interval]', '[data-election-day-median="true"]',
    '[data-election-day-boundary="true"]', '[data-election-day-label="true"]',
    '[data-election-day-distribution-label="true"]',
    '[data-latest-forecast-boundary="true"]', '[data-latest-forecast-label="true"]',
  ].join(','),
  crosshairLabels: '[data-crosshair-label="true"]',
  // The detail panel the crosshair readout replaced. None of these may exist.
  retiredDetail: '#election-timeseries-detail, #election-timeseries-detail-body, #election-timeseries-detail-title, .election-timeseries__detail, .election-timeseries__detail-body, .election-timeseries__detail-meta, #election-timeseries-tooltip, .election-timeseries__tooltip',
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
    // The hover readout is now on the chart: a crosshair plus one median per
    // visible series, printed beside it.
    const crosshairLabels = svg ? Array.from(svg.querySelectorAll(selectors.crosshairLabels)) : [];
    // The status line survives as a visually hidden aria-live announcement, so
    // it is read for its text, never for its visibility.
    const status = section?.querySelector('#election-timeseries-status') || null;
    const readout = section?.querySelector('#election-timeseries-readout') || null;
    // Screen readers reach an inspected date through these two elements, never
    // through the crosshair labels: those live in an aria-hidden layer.
    const hiddenBox = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const geometry = element.getBoundingClientRect();
      return style.display !== 'none' && style.position === 'absolute' &&
        geometry.width <= 1.5 && geometry.height <= 1.5;
    };
    const box = (element) => element ? (() => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    })() : null;
    const title = svg?.querySelector('title');
    const description = svg?.querySelector('desc');
    const forwardMarks = svg ? Array.from(svg.querySelectorAll(selectors.forwardMarks)) : [];
    const plotClip = svg?.querySelector('#election-timeseries-plot-clip rect');
    const majority = svg?.querySelector('[data-majority="175"]');
    return {
      section: section ? {
        hidden: section.hidden,
        display: getComputedStyle(section).display,
        text: section.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
        box: box(section),
        // Ids the decluttered chart must not carry at all, in any state.
        forwardControlIds: [
          'election-timeseries-future', 'election-timeseries-future-paths',
          'election-timeseries-future-stability', 'election-timeseries-campaign-cue',
          'election-timeseries-seat-note',
        ].filter((id) => Boolean(document.getElementById(id))),
        forwardDataAttributes: Array.from(section.attributes)
          .map((attribute) => attribute.name)
          .filter((name) => /^data-(future|campaign)/.test(name)),
        heading: section.querySelector('h2')?.textContent?.trim() || '',
        intro: section.querySelector('#election-timeseries-intro')?.textContent
          ?.replace(/[\t\n\r ]+/g, ' ').trim() || '',
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
        yDomainMode: svg.getAttribute('data-y-domain-mode') || '',
        forwardDataAttributes: Array.from(svg.attributes)
          .map((attribute) => attribute.name)
          .filter((name) => /^data-(future|campaign)/.test(name)),
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
      // The chart must not draw anything to the right of the latest certified
      // forecast, so this is a census of the mark kinds it used to draw there.
      forward: svg ? {
        markCount: forwardMarks.length,
        markSelectors: [...new Set(forwardMarks.map((mark) => {
          const names = Array.from(mark.attributes).map((attribute) => attribute.name)
            .filter((name) => /^data-(future|campaign|origin-state|election-day|latest-forecast)/.test(name));
          return names.join(' ') || mark.tagName;
        }))],
        // Every drawn mark's centre, against the plot's right edge: a forecast
        // point or poll dot beyond it would mean the domain still runs past
        // the last published date.
        lastDrawnDate: [...new Set(Array.from(
          svg.querySelectorAll('[data-forecast-point="true"],[data-poll-point="true"]'),
        ).map((mark) => mark.getAttribute('data-date')).filter(Boolean))].sort().pop() || '',
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
      crosshair: {
        count: crosshairLabels.filter(visible).length,
        labels: crosshairLabels.map((label) => ({
          coalition: label.getAttribute('data-coalition'),
          date: label.getAttribute('data-date'),
          value: Number(label.getAttribute('data-value')),
          text: (label.textContent || '').replace(/\u00a0/g, ' ').trim(),
          anchor: label.getAttribute('text-anchor'),
          visible: visible(label),
          // A readout that ran outside the frame would be worse than none.
          insideFrame: (() => {
            if (!svg) return false;
            const frame = svg.getBoundingClientRect();
            const box = label.getBoundingClientRect();
            return box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5;
          })(),
        })),
      },
      // Retired with the panel: none of these nodes may come back.
      retiredDetailCount: section ? section.querySelectorAll(selectors.retiredDetail).length : 0,
      // The crosshair labels are inside an aria-hidden group, so they are not
      // an accessible surface at all -- asserted, not assumed.
      crosshairLabelsAriaHidden: (() => {
        const label = svg?.querySelector(selectors.crosshairLabels);
        return label ? Boolean(label.closest('[aria-hidden="true"]')) : null;
      })(),
      forecastPointLabels: [...new Set(forecastPoints
        .map((point) => point.getAttribute('aria-label') || ''))].slice(0, 3),
      readout: readout ? {
        date: readout.getAttribute('data-readout-date'),
        live: readout.getAttribute('aria-live'),
        role: readout.getAttribute('role'),
        visuallyHidden: hiddenBox(readout),
        text: readout.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
      } : null,
      // Visually hidden, but it must still announce what the crosshair shows.
      status: status ? (() => {
        // "Visually hidden" is a 1x1 clipped box, not display:none -- it must
        // stay in the accessibility tree. So it is measured, not asked.
        const box = status.getBoundingClientRect();
        const style = getComputedStyle(status);
        return {
          text: status.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
          visuallyHidden: style.display !== 'none' && style.position === 'absolute' &&
            box.width <= 1.5 && box.height <= 1.5,
          live: status.getAttribute('aria-live'),
        };
      })() : null,
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
  const publishedSamples = history.series?.at(-1)?.samples;
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
  const fullEnd = fullRangeEnd(history, 'vote');
  check('default full-range x-domain runs from the first to the latest published date',
    view.svg?.range === 'full' && view.svg?.xMin === fullStart && view.svg?.xMax === fullEnd,
  { expected: [fullStart, fullEnd], svg: view.svg });
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
  // A date that also carries a reconstructed point is rendered -- that mark is
  // the curve point, not the archived one, which is why this looks only at
  // dates the curve does not cover.
  const curveDatesInView = new Set((history.series || [])
    .filter((point) => point.provenance !== 'prospective_archived')
    .map((point) => point.date));
  check('an archive-only date is never a rendered forecast point',
    (history.series || [])
      .filter((point) => point.provenance === 'prospective_archived')
      .filter((point) => !curveDatesInView.has(point.date))
      .every((point) => !view.forecastDates.includes(point.date)),
  view.forecastDates);
  check('individual poll observations are visible in vote mode', view.pollCount >= history.polls.length * 2,
    { rendered: view.pollCount, polls: history.polls.length });
  check('the latest forecast value is visibly marked', view.currentCount >= 2, view.currentCount);
  check('right-edge current-value labels are visible', view.endpointCount >= 2, view.endpointCount);
  equal('the detail panel the crosshair readout replaced is gone', view.retiredDetailCount, 0);
  check('the hidden live region still announces the readout',
    view.status?.visuallyHidden === true && view.status?.live === 'polite', view.status);
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

// The chart's single claim: each point is the forecast as known on its date,
// and the last point is the forecast today. Nothing may be drawn to the right
// of it, and no control may invite reading an extrapolation towards the
// election. The published artifact still carries `future_projection` and
// `future_campaign_paths`; this asserts the page ignores them.
function assertNoForwardView(view, history, label) {
  const latest = (history.series || [])
    .filter((point) => point?.provenance !== 'prospective_archived')
    .map((point) => point.date).sort().at(-1);
  equal(`${label}: no forward-view control is in the page`,
    view.section?.forwardControlIds, []);
  equal(`${label}: the section declares no forward-view state`,
    view.section?.forwardDataAttributes, []);
  equal(`${label}: the chart declares no forward-view state`,
    view.svg?.forwardDataAttributes, []);
  equal(`${label}: nothing is drawn beyond the latest forecast`,
    [view.forward?.markCount, view.forward?.markSelectors], [0, []]);
  // Equality, not an upper bound over "forecast or poll": the chart's claim is
  // that its last point is the latest published forecast, so the axis has to
  // end exactly there even when a newer poll exists.
  equal(`${label}: the x-axis ends exactly at the latest published forecast`,
    view.svg?.xMax, view.svg?.range === 'short' ? view.svg?.xMax : latest);
  check(`${label}: the right edge is before election day`,
    view.svg?.xMax < history.election_date,
  { xMax: view.svg?.xMax, election: history.election_date });
  check(`${label}: the last drawn mark is no later than the right edge`,
    view.forward?.lastDrawnDate !== '' && view.forward?.lastDrawnDate <= view.svg?.xMax,
  { drawn: view.forward?.lastDrawnDate, xMax: view.svg?.xMax });
  check(`${label}: no copy explains a removed forward view`,
    !/opinionsban|kvarvarande osäkerhet|kampanjperioden|möjliga opinionsbanor|villkorad projektion/i
      .test(view.section?.text || ''), view.section?.text);
}

// The hover readout is one median per visible series, printed at the crosshair
// and nowhere else. It is deliberately not the old interval table: the 50/90 %
// numbers are the bands the marker sits inside.
function assertCrosshairReadout(view, history, expectedDate, label) {
  const keys = DEFAULT_COALITIONS.map((parties) => coalitionKey(history, parties));
  const labels = view.crosshair?.labels || [];
  equal(`${label}: one readout per visible series`,
    labels.map((entry) => entry.coalition).sort(), keys.slice().sort());
  check(`${label}: every readout is drawn and inside the frame`,
    labels.length > 0 && labels.every((entry) => entry.visible && entry.insideFrame), labels);
  equal(`${label}: every readout carries the inspected date`,
    [...new Set(labels.map((entry) => entry.date))], [expectedDate]);
  equal(`${label}: the readouts share one side of the crosshair`,
    [...new Set(labels.map((entry) => entry.anchor))].length, 1);
  const point = (history.series || []).find((item) => item.date === expectedDate);
  const metric = view.svg?.metric === 'seats' ? 'seats' : 'vote';
  check(`${label}: each readout prints that series' published median`,
    labels.every((entry) => {
      const published = point?.groups?.[entry.coalition]?.[metric]?.p50;
      if (!finite(published)) return false;
      const shown = metric === 'seats' ? published : published;
      return numberInText(entry.text, metric === 'seats' ? shown : shown);
    }), { labels, expectedDate, metric });
  check(`${label}: no interval, provenance or simulation count is printed`,
    labels.every((entry) =>
      !/intervall|simuleringar|horisont|rekonstru|prospektiv|poll of polls/i.test(entry.text)),
  labels);
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
  if (metric === 'vote') {
    for (const collection of [history.polls || []]) {
      for (const point of collection) {
        const date = publishedDate(point);
        if (!inDateRange(date, start, end)) continue;
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
  const end = latestPlottedDate(history);
  const origin = end;
  equal('fixture short-range dates are the 30 days up to the latest forecast',
    [start, end], ['2026-08-05', '2026-09-04']);
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
  assertNoForwardView(view, history, `short range, ${metric}`);
  const extremes = visibleRangeExtremes(history, metric, start, end);
  check(`${metric} short-range y-domain contains visible uncertainty and observations`,
    view.svg?.yMin <= extremes.min && view.svg?.yMax >= extremes.max,
  { domain: [view.svg?.yMin, view.svg?.yMax], extremes });
  if (metric === 'vote') {
    // Röstandel gets a data-driven window for the last 30 days, so the short
    // range must not simply reuse the four-year ladder.
    check('vote y-domain is recalculated instead of retained from full range',
      view.svg?.yMin !== fullView.svg?.yMin || view.svg?.yMax !== fullView.svg?.yMax,
    { full: [fullView.svg?.yMin, fullView.svg?.yMax], short: [view.svg?.yMin, view.svg?.yMax] });
    equal('the short vote range declares its adaptive window',
      view.svg?.yDomainMode, 'adaptive-short-window');
  } else {
    // Mandatandel is anchored on the 175-seat rule with a 20-point minimum
    // span in both ranges, so an identical domain here is correct, not stale.
    // What must hold is that the anchor and the visible extremes are inside it
    // and it is never wider than the four-year view.
    check('seat y-domain keeps the majority anchor and never widens in the short range',
      view.svg?.yMin <= 100 * 175 / 349 && view.svg?.yMax >= 100 * 175 / 349 &&
      view.svg?.yMin >= fullView.svg?.yMin && view.svg?.yMax <= fullView.svg?.yMax,
    { full: [fullView.svg?.yMin, fullView.svg?.yMax], short: [view.svg?.yMin, view.svg?.yMax] });
  }
}

async function exercise(viewport, history, siteRoot) {
  console.log(`\n${viewport.name}`);
  const { server, browser } = await open(viewport, siteRoot);
  const assertionsStarted = Date.now();
  await diagnostic(`${viewport.diagnostic} assertions START`);
  try {
    // ---- the chart's one claim: history up to today, and nothing after ---
    let view = await readPage(browser);
    equal('the published full range is the opening range and ends at today',
      [view.svg?.range, view.svg?.xMin, view.svg?.xMax],
      ['full', fullRangeStart(history, 'vote'), fullRangeEnd(history, 'vote')]);
    equal('the range buttons open on Sedan 2022',
      view.ranges.map((button) => button.pressed), ['true', 'false']);
    assertNoForwardView(view, history, 'full range, vote');
    // The plotted history is reconstructed with today's model, not what was
    // published on each date -- the consumer says so itself by dropping
    // prospective_archived points and labelling the rest "Rekonstruerad med
    // dagens modell". The most-read sentence on the section must not claim
    // otherwise, especially with the on-page provenance note hidden at runtime
    // by election-latest-poll.js.
    check('the intro says the history is reconstructed, not prospective',
      /rekonstruerad/i.test(view.section?.intro || '') &&
      /i efterhand/i.test(view.section?.intro || ''), view.section?.intro);
    check('the intro does not claim each point was the forecast on its date',
      !/varje punkt är prognosen som den såg ut/i.test(view.section?.intro || ''),
    view.section?.intro);
    check('the intro still names the last point as the current forecast',
      /sista punkten/i.test(view.section?.intro || '') &&
      /aktuella publicerade prognosen/i.test(view.section?.intro || ''), view.section?.intro);
    equal('full range switches to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    assertNoForwardView(await readPage(browser), history, 'full range, seats');
    equal('full range returns to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();
    view = await readPage(browser);
    view = await readPage(browser);
    assertStructure(view, history);
    const fullVoteView = structuredClone(view);

    // Clicking an extra coalition must change both aria-pressed and the
    // visible series.
    const extra = labelFor(EXTRA_COALITIONS[0]);
    const beforeVisible = (await readPage(browser)).series.filter((series) => series.visible).length;
    equal(`toggle ${extra} on`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    const extraOn = findLabel(view.coalitions, EXTRA_COALITIONS[0]);
    check(`${extra} changes aria-pressed to true`, extraOn?.pressed === 'true', extraOn);
    check(`${extra} adds a visible forecast series`, view.series.filter((series) => series.visible).length > beforeVisible,
      view.series);
    equal(`toggle ${extra} off`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    check(`${extra} changes aria-pressed back to false`, findLabel(view.coalitions, EXTRA_COALITIONS[0])?.pressed === 'false', view.coalitions);
    check(`${extra} removes its historical series`,
      view.series.filter((series) => series.visible).length === beforeVisible, view.series);

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
    check('the retired election-day seat caveat is gone with the future view',
      !/Mandat visas först för valdagsprognosen/i.test(view.section?.text || ''),
      view.section?.text);
    assertNoForwardView(view, history, 'full range, seats (after switch)');
    const seatPoint = history.series[0];
    const seatCoordinates = await historicalPointCoordinates(browser, seatPoint.date);
    await clickAt(browser, seatCoordinates);
    const seatView = await readPage(browser);
    const seatReadout = (seatView.crosshair?.labels || [])
      .find((entry) => entry.coalition === coalitionKey(history, DEFAULT_COALITIONS[0]));
    check('the seat readout prints the raw median seat count',
      Boolean(seatReadout) &&
      numberInText(seatReadout.text, findPointFor(history, DEFAULT_COALITIONS[0], seatPoint).group.seats.p50) &&
      /mandat/i.test(seatReadout.text), seatReadout);
    check('the seat readout omits Poll of Polls',
      !/Poll of Polls/i.test(seatView.crosshair?.labels?.map((e) => e.text).join(' ') || ''),
    seatView.crosshair);

    // Repeat the range round trip while Mandatandel is active.  This guards
    // the metric-specific full-domain source list and the majority reference
    // independently of the vote-share path below.
    equal('Mandatandel full range uses its published extent',
      [view.svg?.range, view.svg?.xMin, view.svg?.xMax],
      ['full', fullRangeStart(history, 'seats'), fullRangeEnd(history, 'seats')]);
    const seatFullBeforeRange = structuredClone(view);
    equal('Mandatandel switches to Sista 30 dagarna', await clickButton(browser, 'Sista 30 dagarna'), true);
    await settle();
    let seatShortRoundTrip = await readPage(browser);
    check('Mandatandel short round-trip has the last-30-days domain',
      seatShortRoundTrip.svg?.metric === 'seats' && seatShortRoundTrip.svg?.range === 'short' &&
      seatShortRoundTrip.svg?.xMin === shortRangeStart(history) &&
      seatShortRoundTrip.svg?.xMax === latestPlottedDate(history), seatShortRoundTrip.svg);
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

    const shortSeriesBefore = view.series.filter((series) => series.visible).length;
    equal(`short range toggle ${extra} on`, await clickButton(browser, extra), true);
    await settle();
    view = await readPage(browser);
    check('coalition toggles add a historical series in the short range',
      findLabel(view.coalitions, EXTRA_COALITIONS[0])?.pressed === 'true' &&
      view.series.filter((series) => series.visible).length > shortSeriesBefore, view.series);
    equal(`short range toggle ${extra} off`, await clickButton(browser, extra), true);
    await settle();

    const shortStart = shortRangeStart(history);
    const shortOrigin = latestPlottedDate(history);
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
      view.svg?.selectedDate !== history.series[0].date && view.crosshair?.count > 0 &&
      (view.crosshair?.labels || []).every((entry) => entry.date !== history.series[0].date),
    { transition: staleTransition, selected: view.svg?.selectedDate, crosshair: view.crosshair });
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

    await hoverAt(browser, await historicalPointCoordinates(browser, latestPlottedDate(history)));
    const latestHistorical = await readPage(browser);
    // Pointer coordinates are quantized to whole device pixels, and on the
    // four-year scale one pixel spans several days -- about six at 360px. Once
    // the series tail is daily, demanding an exact date would be demanding
    // sub-pixel pointer resolution the platform does not have. What the mapping
    // must do is stay in the historical region and land within its own
    // resolution of the boundary; the election-relative range is where an exact
    // day is addressable, and its own checks cover that.
    const daysPerPointerPixel = await browser.evaluate(() => {
      const svg = document.getElementById('election-timeseries-svg');
      if (!svg) return null;
      const box = svg.getBoundingClientRect();
      const min = Date.parse(`${svg.getAttribute('data-x-axis-min')}T00:00:00Z`);
      const max = Date.parse(`${svg.getAttribute('data-x-axis-max')}T00:00:00Z`);
      const plotFraction = 808 / 960;
      return ((max - min) / 86400000) / (box.width * plotFraction);
    });
    const selectedOffsetDays = latestHistorical.svg?.selectedDate
      ? (dateTime(latestPlottedDate(history)) -
        dateTime(latestHistorical.svg.selectedDate)) / 86400000
      : null;
    check('historical pointer mapping selects the latest forecast at the right edge',
      selectedOffsetDays !== null && selectedOffsetDays >= 0 &&
      selectedOffsetDays <= Math.max(1, Math.ceil(daysPerPointerPixel)),
    { selected: latestHistorical.svg?.selectedDate, expected: latestPlottedDate(history),
      offsetDays: selectedOffsetDays, daysPerPointerPixel });

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
    check('hovering a forecast point draws a crosshair', view.crosshairCount === 1,
      { crosshair: view.crosshairCount, selectedDate: view.svg?.selectedDate });
    check('hovering a forecast point highlights every visible coalition', view.inspectionCount >= 2,
      view.inspectionCount);
    assertCrosshairReadout(view, history, point.date, 'vote-share hover');
    // The right-hand current-value labels and the crosshair readout both print
    // medians. Exactly one set is on screen at a time, or a hover near the
    // right edge reads as one crowded column of unexplained numbers.
    equal('the current-value labels stand down while a date is inspected',
      view.endpointCount, 0);
    check('the hidden live region announces the inspected date and medians',
      view.status?.visuallyHidden === true &&
      (view.status?.text || '').includes(String(new Date(point.date).getUTCFullYear())) &&
      numberInText(view.status?.text || '', expected.group.vote.p50), view.status);
    check('the announcement does not expose internal provenance enum strings',
      !/reconstructed_current_model|prospective_archived|current_production/.test(view.status?.text || ''),
      view.status?.text);
    // The crosshair readout is drawn inside an aria-hidden layer, so a screen
    // reader reaches an inspected date only through the two hidden elements.
    // Without the interval readout the 50/90 % numbers would be sighted-only,
    // which is exactly the asymmetry the visible panel used to prevent.
    equal('the crosshair labels are not an accessible surface',
      view.crosshairLabelsAriaHidden, true);
    check('the hidden readout carries the full 50/90 % intervals for that date',
      view.readout?.visuallyHidden === true && view.readout?.date === point.date &&
      numberInText(view.readout?.text || '', expected.group.vote.p25) &&
      numberInText(view.readout?.text || '', expected.group.vote.p75) &&
      numberInText(view.readout?.text || '', expected.group.vote.p05) &&
      numberInText(view.readout?.text || '', expected.group.vote.p95), view.readout);
    equal('the interval readout is not announced, so arrowing stays quiet',
      view.readout?.live, 'off');
    check('the announcement itself stays a short navigation cue',
      !/intervall/i.test(view.status?.text || ''), view.status?.text);
    check('every plotted point carries its own intervals for focus and browse mode',
      (view.forecastPointLabels || []).length > 0 &&
      view.forecastPointLabels.every((text) =>
        /median/i.test(text) && /50 % intervall/i.test(text) && /90 % intervall/i.test(text)),
    view.forecastPointLabels);
    await clickAt(browser, coordinates);
    view = await readPage(browser);
    check('clicking a forecast point keeps its readout visible', view.crosshair?.count > 0,
      view.crosshair);
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
      keyboardView.crosshairCount === 1 && keyboardView.crosshair?.count > 0 &&
      Boolean(keyboardView.svg?.selectedDate), keyboardView.crosshair);
    await browser.evaluate(() => {
      const app = document.getElementById('election-simulator-app');
      app?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });
    await settle(100);
    const afterEscape = await readPage(browser);
    check('Escape clears the persistent point selection', afterEscape.crosshair?.count === 0,
      afterEscape.crosshair);
    equal('the current-value labels come back once nothing is inspected',
      afterEscape.endpointCount >= 2, true);

    // Touch interaction
    if (viewport.coarse) {
      await tapAt(browser, coordinates);
      const tapped = await readPage(browser);
      check('tapping a date persists the readout on touch', tapped.crosshair?.count > 0,
        tapped.crosshair);
      check('tapping a date pins the crosshair on touch', tapped.crosshairCount === 1 &&
        Boolean(tapped.svg?.selectedDate), tapped.svg);
    }

    view = await readPage(browser);
    assertNoForwardView(view, history, 'end of run');
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
    equal('metric-domain opens the full history range',
      await clickButton(browser, 'Sedan 2022'), true);
    await settle();
    let view = await readPage(browser);
    const voteMin = fullRangeStart(prepared.history, 'vote');
    const seatsMin = fullRangeStart(prepared.history, 'seats');
    check('vote full range includes its individual-poll extent',
      view.svg?.metric === 'vote' && view.svg?.range === 'full' &&
      view.svg?.xMin === voteMin &&
      view.svg?.xMax === fullRangeEnd(prepared.history, 'vote') &&
      voteMin !== seatsMin, { svg: view.svg, voteMin, seatsMin });

    equal('metric-domain switches to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    view = await readPage(browser);
    check('Mandatandel full range uses series plus Poll of Polls extent only',
      view.svg?.metric === 'seats' && view.svg?.range === 'full' &&
      view.svg?.xMin === seatsMin &&
      view.svg?.xMax === fullRangeEnd(prepared.history, 'seats') &&
      view.svg?.xMin !== voteMin, { svg: view.svg, voteMin, seatsMin });
    check('metric-specific full-domain browser check has no overflow or errors',
      view.overflow <= 0 && appErrors(browser).length === 0 && browser.exceptions.length === 0,
    { overflow: view.overflow, console: appErrors(browser), exceptions: browser.exceptions });
  } finally {
    await closeBrowser(viewport.diagnostic, browser, server);
    await prepared.cleanup();
  }
}

// The published artifacts still carry `future_projection` and
// `future_campaign_paths` -- removing them is a simulator change this website
// change deliberately does not make. So the contract is not "the objects are
// gone" but "the page does not read them": a publication carrying both must
// render pixel-for-pixel the same chart as one carrying neither.
async function exerciseUnusedForwardArtifacts() {
  const withArtifacts = await prepareSite((history) => history, false);
  const withView = await scenarioView(withArtifacts, 'forward-artifacts-present');
  check('a publication carrying both forward artifacts still draws none of them',
    withView.forward?.markCount === 0 &&
    withView.section?.forwardDataAttributes.length === 0 &&
    withView.svg?.forwardDataAttributes.length === 0, withView.forward);

  const withoutArtifacts = await prepareSite((history) => {
    delete history.future_projection;
    delete history.future_campaign_paths;
    return history;
  }, false);
  const withoutView = await scenarioView(withoutArtifacts, 'forward-artifacts-absent');
  equal('dropping both forward artifacts changes nothing on screen',
    historicalFingerprint(withoutView), historicalFingerprint(withView));
  equal('the chart still ends at the latest published forecast',
    withoutView.svg?.xMax, latestPlottedDate(withoutArtifacts.history));

  const shortWithout = await prepareSite((history) => {
    delete history.future_projection;
    delete history.future_campaign_paths;
    return history;
  }, false);
  const shortView = await scenarioView(shortWithout, 'forward-artifacts-absent-short',
    async (browser) => {
      equal('the short range is reachable without any forward artifact',
        await clickButton(browser, 'Sista 30 dagarna'), true);
      await settle();
    });
  const start = shortRangeStart(shortWithout.history);
  const end = latestPlottedDate(shortWithout.history);
  check('the short range is the 30 days up to the latest forecast',
    shortView.svg?.range === 'short' && shortView.svg?.xMin === start &&
    shortView.svg?.xMax === end &&
    shortView.forecastDates.every((date) => inDateRange(date, start, end)),
  shortView.svg);
}

// A poll published after the most recent forecast generation. This is the
// normal state of the artifact for the hours between a poll landing and the
// next publication, and it used to carry the x-axis past the end of the
// forecast line: the full-range domain took its maximum over forecasts *and*
// polls. The nearest guard -- the real-artifact precondition that refused a
// poll dated after the origin -- lived in the campaign-path block and was
// removed with it, so nothing caught the drift.
async function exercisePollAfterLatestForecast() {
  const prepared = await prepareSite((history) => {
    const latest = history.series
      .filter((point) => point.provenance !== 'prospective_archived')
      .map((point) => point.date).sort().at(-1);
    const late = calendarDateOffset(latest, 3);
    const poll = structuredClone(history.polls.at(-1));
    poll.poll_id = `${poll.poll_id || 'late'}-after-latest-forecast`;
    poll.publication_date = late;
    poll.fieldwork_start = late;
    poll.fieldwork_end = late;
    history.polls = [...history.polls, poll];
    return history;
  }, false);
  const latest = latestPlottedDate(prepared.history);
  const late = calendarDateOffset(latest, 3);
  const view = await scenarioView(prepared, 'poll-after-latest-forecast');
  equal('a poll newer than the forecast does not move the right edge',
    view.svg?.xMax, latest);
  check('the late poll is fixture-side, so the check is not vacuous',
    (prepared.history.polls || []).some((poll) => publishedDate(poll) === late),
  { late, latest });
  check('the late poll is not drawn',
    view.pollDates.length > 0 && view.pollDates.every((date) => date <= latest),
  { drawn: view.pollDates.at(-1), latest });
  assertNoForwardView(view, prepared.history, 'poll after latest forecast');
}

async function main() {
  const prepared = await prepareSite();
  try {
    for (const viewport of VIEWPORTS) await exercise(viewport, prepared.history, prepared.root);
  } finally {
    await prepared.cleanup();
  }
  await exerciseUnusedForwardArtifacts();
  await exercisePollAfterLatestForecast();
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
