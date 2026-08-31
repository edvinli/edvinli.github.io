// Real-browser smoke test for the historical "Prognos över tid" chart.
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
  { name: 'desktop (1280x1000)', width: 1280, height: 1000, coarse: false },
  { name: 'narrow-360 (360x900)', width: 360, height: 900, coarse: true },
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

const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
const compact = (value) => flat(value).replace(/\s*\+\s*/g, '+').toLowerCase();
const sameParties = (left, right) => left.length === right.length &&
  left.every((party) => right.includes(party));
const labelFor = (parties) => parties.join(' + ');
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const settle = (ms = 180) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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

// A source checkout can be built before the offline publication job has copied
// the history artifact into _site.  Keep the browser test runnable in that
// state with a throwaway static-site copy and a small, deterministic fixture.
// A real published artifact always wins; the fallback never modifies the
// repository and is called out in the run output.
async function prepareSite() {
  try {
    const history = await readHistoryFile(SITE);
    return { root: SITE, history, fallback: false, cleanup: async () => {} };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fixturePath = join(HERE, 'fixtures', 'coalition-timeseries.json');
    let fixture;
    try {
      fixture = await readFile(fixturePath, 'utf8');
    } catch {
      throw error;
    }
    const root = await mkdtemp(join(tmpdir(), 'election-timeseries-site-'));
    await cp(SITE, root, { recursive: true });
    const historyPath = join(root, HISTORY_RELATIVE);
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, fixture);
    const history = await readHistoryFile(root);
    console.log(`\nusing browser-test history fixture because the live artifact is unavailable (${error.message})`);
    return { root, history, fallback: true, cleanup: () => rm(root, { recursive: true, force: true }) };
  }
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
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    if (viewport.coarse) {
      await browser.S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await browser.goto(`http://localhost:${server.port}${PAGE}`);
    await waitForApp(browser);
    return { server, browser };
  } catch (error) {
    await browser.close();
    await server.close();
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
  details: '#election-timeseries-detail, #election-timeseries-status, #election-forecast-history-detail, [data-timeseries-detail], .election-timeseries__detail, .et-detail, .eht-detail',
};

function readPage(browser) {
  return browser.evaluate((selectors) => {
    const section = document.querySelector(selectors.section);
    const svg = section?.querySelector(selectors.svg) || document.querySelector(selectors.svg);
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
    const coalitions = buttons.filter((button) => /\b[MVLCKSDP]{1,2}\b\s*\+/i.test(buttonText(button)));
    const series = svg ? Array.from(svg.querySelectorAll(selectors.series)) : [];
    const genericSeries = svg ? Array.from(svg.querySelectorAll('[data-coalition]')).filter((element) =>
      element.tagName.toLowerCase() === 'g' || element.matches('path,polyline')) : [];
    const seriesNodes = series.length ? series : genericSeries;
    const popLines = svg ? Array.from(svg.querySelectorAll(selectors.popLine)) : [];
    const polls = svg ? Array.from(svg.querySelectorAll(selectors.polls)) : [];
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
    return {
      section: section ? {
        hidden: section.hidden,
        display: getComputedStyle(section).display,
        text: section.textContent.replace(/[\t\n\r ]+/g, ' ').trim(),
        box: box(section),
      } : null,
      sectionOrder: Array.from(document.querySelectorAll('.election-app > section')).map((element) => element.id),
      svg: svg ? {
        role: svg.getAttribute('role'),
        labelledby: svg.getAttribute('aria-labelledby'),
        title: title?.textContent?.trim() || '',
        description: description?.textContent?.trim() || '',
        metric: svg.getAttribute('data-metric') || '',
        yMin: Number(svg.getAttribute('data-y-min')),
        yMax: Number(svg.getAttribute('data-y-max')),
        selectedDate: svg.getAttribute('data-selected-date') || '',
        box: box(svg),
      } : null,
      views: views.map((button) => ({
        text: buttonText(button),
        pressed: button.getAttribute('aria-pressed'),
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
      popLineCount: popLines.filter(visible).length,
      popLegendCount: section ? section.querySelectorAll('#election-timeseries-key-pop').length : 0,
      band90Count: svg ? Array.from(svg.querySelectorAll(selectors.band90)).filter(visible).length : 0,
      band50Count: svg ? Array.from(svg.querySelectorAll(selectors.band50)).filter(visible).length : 0,
      currentCount: svg ? Array.from(svg.querySelectorAll('.election-timeseries__current, [data-current="true"]')).filter(visible).length : 0,
      pollCount: polls.filter(visible).length,
      crosshairCount: svg ? Array.from(svg.querySelectorAll(selectors.crosshair)).filter(visible).length : 0,
      inspectionCount: svg ? Array.from(svg.querySelectorAll(selectors.inspection)).filter(visible).length : 0,
      endpointCount: svg ? Array.from(svg.querySelectorAll(selectors.endpoint)).filter(visible).length : 0,
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

async function pointCoordinates(browser) {
  return browser.evaluate((selectors) => {
    const section = document.querySelector(selectors.section);
    const svg = section?.querySelector(selectors.svg) || document.querySelector(selectors.svg);
    if (!svg) return null;
    svg.scrollIntoView({ block: 'center', inline: 'nearest' });
    const point = Array.from(svg.querySelectorAll('[data-forecast-point], .et-point, .eht-point, [data-date]'))
      .find((element) => !/marker|horizon/i.test(String(element.className?.baseVal || element.className || '')) &&
        ['circle', 'rect', 'path', 'line', 'g'].includes(element.tagName.toLowerCase()));
    const target = point || svg;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, SELECTORS);
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
    const button = Array.from(document.querySelectorAll('button')).find((element) =>
      normalize(element.textContent) === text || normalize(element.textContent).includes(text));
    if (!button) return false;
    button.click();
    return true;
  }, buttonText);
}

function assertStructure(view, history) {
  check('Prognos över tid section exists and is visible', view.section && !view.section.hidden && view.section.display !== 'none', view.section);
  const order = view.sectionOrder;
  check('historical chart is physically before Röstandelar',
    order.indexOf('election-timeseries') >= 0 && order.indexOf('election-headline') >= 0 &&
    order.indexOf('election-timeseries') < order.indexOf('election-headline'), order);
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
  check('default vote view uses an adaptive y-axis', view.svg?.metric === 'vote' &&
    finite(view.svg.yMin) && finite(view.svg.yMax) && view.svg.yMin > 0 && view.svg.yMax > view.svg.yMin,
  view.svg);
  check('50% is inside the displayed vote domain', view.svg?.yMin <= 50 && view.svg?.yMax >= 50, view.svg);
  check('the two default forecast series are visible', view.series.filter((series) => series.visible).length >= 2,
    view.series);
  check('the chart has both 50% and 90% forecast bands', view.band90Count >= 2 && view.band50Count >= 2,
    { band90: view.band90Count, band50: view.band50Count });
  check('median forecast lines are visible', view.medianCount >= 2, view.medianCount);
  equal('Poll of Polls line is absent from vote mode', view.popLineCount, 0);
  equal('Poll of Polls line is absent from the legend', view.popLegendCount, 0);
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

async function exercise(viewport, history, siteRoot) {
  console.log(`\n${viewport.name}`);
  const { server, browser } = await open(viewport, siteRoot);
  try {
    let view = readPage(browser);
    assertStructure(await view, history);
    view = await readPage(browser);

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

    // Both the aggregate Poll of Polls and faded individual observations are
    // visible in vote-share mode.
    equal('Poll of Polls line remains absent in vote-share mode', view.popLineCount, 0);
    check('individual poll dots appear for both default coalitions', view.pollCount >= history.polls.length * 2,
      { rendered: view.pollCount, polls: history.polls.length });

    equal('switch to Mandatandel', await clickButton(browser, 'Mandatandel'), true);
    await settle();
    view = await readPage(browser);
    check('Mandatandel is pressed', findLabel(view.views, ['Mandatandel'])?.pressed === 'true', view.views);
    check('seat mode uses an adaptive y-axis containing the majority threshold',
      view.svg?.metric === 'seats' && finite(view.svg.yMin) && finite(view.svg.yMax) &&
      view.svg.yMin > 0 && view.svg.yMin <= (175 / 349 * 100) &&
      view.svg.yMax >= (175 / 349 * 100), view.svg);
    equal('seat-share mode has no Poll of Polls lines', view.popLineCount, 0);
    equal('seat-share mode has no raw poll dots', view.pollCount, 0);
    check('seat-share mode shows the 175 mandate majority rule', /175\s*mandat/i.test(view.section?.text || '') &&
      /175\s*mandat/i.test(`${view.marker?.text || ''} ${view.section?.text || ''}`), view.section?.text);
    check('seat-share mode explains why Poll of Polls is omitted', /poll.*visas.*röstandel|röstandelsläget/i.test(view.section?.text || ''), view.section?.text);
    const seatPoint = history.series[0];
    const seatCoordinates = await pointCoordinates(browser);
    await clickAt(browser, seatCoordinates);
    const seatView = await readPage(browser);
    const seatDetail = seatView.detail?.text || '';
    check('seat detail includes the raw median seat count',
      numberInText(seatDetail, findPointFor(history, DEFAULT_COALITIONS[0], seatPoint).group.seats.p50) &&
      /mandat/i.test(seatDetail), seatDetail);
    check('seat detail omits Poll of Polls', !/Poll of Polls/i.test(seatDetail), seatDetail);
    equal('switch back to Röstandel', await clickButton(browser, 'Röstandel'), true);
    await settle();
    view = await readPage(browser);
    check('Röstandel is pressed', findLabel(view.views, ['Röstandel'])?.pressed === 'true', view.views);
    equal('vote-share mode does not restore the Poll of Polls line', view.popLineCount, 0);
    check('vote-share mode restores individual poll dots', view.pollCount >= history.polls.length * 2,
      { rendered: view.pollCount, polls: history.polls.length });

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

    const coordinates = await pointCoordinates(browser);
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

    view = await readPage(browser);
    check('no page-level horizontal overflow', view.overflow <= 0, view.overflow);
    equal('no console errors', appErrors(browser), []);
    equal('no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function main() {
  const prepared = await prepareSite();
  try {
    for (const viewport of VIEWPORTS) await exercise(viewport, prepared.history, prepared.root);
  } finally {
    await prepared.cleanup();
  }
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
