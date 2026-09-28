// Two elections on one chart: the frozen 2026 history to the left of election
// day, the live history for the next election to the right of it.
//
// The live history artifact covers one election. Once it targets a later one,
// the page joins every archived cycle named in history/cycles.json -- verified
// by SHA-256 -- onto the same axis. What this suite guards:
//
// * the join is exact: every plotted point of both files is on the chart, and
//   nothing else;
// * a line for one election never joins the next one's: every series breaks
//   on election day, and the last 2026 forecast is labelled as the final one
//   rather than the current one;
// * the certified result sits on the break, and "Sedan valet 2026" opens the
//   window there;
// * it fails closed: an archive that does not verify, or a live history for the
//   same election, leaves the chart exactly the live one.
//
// No 2030 history exists yet, so the live side is a synthetic fixture
// (fixtures/next-cycle-2030.json, built by fixtures/make-next-cycle-fixture.mjs)
// whose points are copies of the final 2026 point. The suite overrides the live
// history and pins the publication, so no forecast publication can change its
// outcome: it is selected by the archive files, the app and the page, not by
// the paths a publication writes.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/forecast-cycles.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor, historyFixture } from './server.mjs';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const ARCHIVE = 'files/election-simulator/history/2026/coalition-timeseries.json';
const INDEX = 'files/election-simulator/history/cycles.json';
const FIXTURE = join(HERE, 'fixtures', 'next-cycle-2030.json');
const GENERATION = '20260913T054241Z-496dd879';
const MONTHS = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni',
  'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];

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
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
const swedishDay = (iso) => {
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};
const offset = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
// The chart's own rule: archived prospective points are not plotted, and one
// vertex per date and provenance.
const plotted = (history) => new Set(history.series
  .filter((point) => point.provenance !== 'prospective_archived')
  .map((point) => `${point.date}|${point.provenance}`)).size;

async function open(viewport, { root = SITE, history = null } = {}) {
  const pointer = await pointerFor(SITE, GENERATION);
  const server = await serve(root, { port: 4000, pointer, history });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  const ready = await browser.waitFor(() => {
    const svg = document.getElementById('election-timeseries-svg');
    const status = document.getElementById('election-app-status');
    return Boolean(svg) && svg.childElementCount > 2 && Boolean(status) &&
      (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!ready) throw new Error('the forecast page never finished loading');
  await settle(400);
  return { server, browser };
}

function readChart(browser) {
  return browser.evaluate(() => {
    const section = document.getElementById('election-timeseries');
    const svg = document.getElementById('election-timeseries-svg');
    const cycle = document.getElementById('election-timeseries-range-cycle');
    return {
      cycles: section.getAttribute('data-history-cycles'),
      pointCount: Number(section.getAttribute('data-history-point-count')),
      xMin: svg.getAttribute('data-x-axis-min'),
      xMax: svg.getAttribute('data-x-axis-max'),
      range: svg.getAttribute('data-range'),
      cycleButton: cycle ? { hidden: cycle.hidden, text: cycle.textContent.trim(),
        pressed: cycle.getAttribute('aria-pressed') } : null,
      groups: Array.from(svg.querySelectorAll('.election-timeseries__series-group')).map((group) => ({
        id: group.getAttribute('data-coalition'),
        segments: Number(group.getAttribute('data-curve-segments')),
        medianSubpaths: (group.querySelector('.election-timeseries__median')?.getAttribute('d')
          .match(/M/g) || []).length,
        current: Array.from(group.querySelectorAll('.election-timeseries__current'))
          .map((node) => node.getAttribute('data-date')),
        finals: Array.from(group.querySelectorAll('[data-provenance="final_production"]'))
          .map((node) => node.getAttribute('data-date')),
        between: Array.from(group.querySelectorAll('[data-forecast-point="true"]'))
          .map((node) => node.getAttribute('data-date'))
          .filter((date) => date > '2026-09-13' && date < '2026-09-20').length,
      })),
      resultLine: svg.querySelector('[data-election-line]')?.getAttribute('data-election-line') || null,
      marks: svg.querySelectorAll('.election-timeseries__result').length,
      syntheticPolls: svg.querySelectorAll('[data-poll-point="true"][data-date="2026-10-15"]').length,
      intro: (document.getElementById('election-timeseries-intro')?.textContent || '').trim(),
      dynamics: (document.getElementById('election-timeseries-dynamics-note')?.textContent || '').trim(),
      view: svg.getAttribute('data-view-mode'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const click = (browser, id) => browser.evaluate((wanted) => {
  const node = document.getElementById(wanted);
  if (!node || node.hidden) return false;
  node.click();
  return true;
}, id);

const archive = await readJson(SITE, ARCHIVE);
const live = JSON.parse(await readFile(FIXTURE, 'utf8'));
const liveLatest = live.series.at(-1).date;

// --- 1. the joined chart ----------------------------------------------------

async function joined(viewport, name) {
  console.log(`\n[two elections] ${name}`);
  const { server, browser } = await open(viewport, { history: await historyFixture(FIXTURE) });
  try {
    let chart = await readChart(browser);
    equal('both elections are on the axis', chart.cycles, `${archive.election_date} ${live.election_date}`);
    equal('every plotted point of both files, and nothing else',
      chart.pointCount, plotted(archive) + plotted(live));
    equal('the chart opens on the whole history', chart.range, 'full');
    equal('the axis ends at the latest live forecast', chart.xMax, liveLatest);
    check('the axis starts with the 2026 history', chart.xMin <= archive.series[0].date, chart.xMin);
    check('every series breaks on election day',
      chart.groups.length > 0 && chart.groups.every((g) => g.segments >= 2 && g.medianSubpaths >= 2), chart.groups);
    check('no forecast is drawn between election day and the first live point',
      chart.groups.every((g) => g.between === 0), chart.groups);
    check('only the live forecast is the current one',
      chart.groups.every((g) => JSON.stringify(g.current) === JSON.stringify([liveLatest])), chart.groups);
    check('the last 2026 forecast is labelled as the final one',
      chart.groups.every((g) => g.finals.includes(archive.election_date)), chart.groups);
    equal('the result sits on the break', chart.resultLine, archive.election_date);
    equal('one result mark per drawn series', chart.marks, chart.groups.length);
    check('the live polls are drawn', chart.syntheticPolls > 0, chart.syntheticPolls);
    check('the intro names both elections',
      chart.intro.startsWith(`Till vänster prognoserna inför valet den ${swedishDay(archive.election_date)}`) &&
      chart.intro.includes(`inför valet ${live.election_date.slice(0, 4)}`), chart.intro);
    check('the dynamics note dates the 112-day cap for the live election',
      chart.dynamics.includes(`före ${swedishDay(offset(live.election_date, -112))}`), chart.dynamics);
    equal('the since-the-election range is offered',
      chart.cycleButton, { hidden: false, text: `Sedan valet ${archive.election_date.slice(0, 4)}`, pressed: 'false' });
    check('no horizontal scroll', chart.overflow <= 0, chart.overflow);

    await click(browser, 'election-timeseries-range-cycle');
    await settle();
    chart = await readChart(browser);
    equal('"Sedan valet" opens on election day', [chart.xMin, chart.xMax], [archive.election_date, liveLatest]);
    equal('and says it is pressed', chart.cycleButton.pressed, 'true');
    equal('the result is still on screen', chart.marks, chart.groups.length);

    await click(browser, 'election-timeseries-range-full');
    if (await click(browser, 'election-timeseries-view-parties')) {
      await settle();
      chart = await readChart(browser);
      equal('the party view spans both elections', chart.view, 'parties');
      check('party series break on election day too',
        chart.groups.length > 0 && chart.groups.every((g) => g.segments >= 2), chart.groups);
    } else {
      check('the party view is offered across both elections', false);
    }
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 2. fails closed ---------------------------------------------------------

async function sameElection() {
  console.log('\n[live history for the archived election] desktop');
  // The state deployed until the first publication for the next election: the
  // live history is the 2026 one, and the archive must not be joined to itself.
  // Served explicitly rather than read from the deployed file, which stops
  // being the 2026 history on that first publication.
  const { server, browser } = await open(DESKTOP, { history: await historyFixture(join(SITE, ARCHIVE)) });
  try {
    const chart = await readChart(browser);
    equal('no archive is joined', chart.cycles, null);
    equal('the chart is exactly the live history', chart.pointCount, plotted(archive));
    equal('the since-the-election range is not offered', chart.cycleButton, null);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function tamperedArchive() {
  console.log('\n[archive that does not verify] desktop');
  const root = await mkdtemp(join(tmpdir(), 'forecast-cycles-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    const bytes = await readFile(join(root, ARCHIVE), 'utf8');
    await writeFile(join(root, ARCHIVE), bytes.replace('"schema_version":"1.1"', '"schema_version": "1.1"'));
    const { server, browser } = await open(DESKTOP, { root, history: await historyFixture(FIXTURE) });
    try {
      const chart = await readChart(browser);
      equal('the archive is left out', chart.cycles, null);
      equal('the chart is exactly the live history', chart.pointCount, plotted(live));
      equal('the since-the-election range is not offered', chart.cycleButton, null);
      equal('no console errors', appErrors(browser).map((e) => e.text), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The index itself, against the file it names: a stale hash would silently
// drop 2026 from the chart the day the first 2030 history is published.
const index = await readJson(SITE, INDEX);
const { createHash } = await import('node:crypto');
console.log('\n[archive index]');
equal('the index names the frozen 2026 history',
  index.cycles.map((cycle) => [cycle.election_date, cycle.path]),
  [[archive.election_date, 'history/2026/coalition-timeseries.json']]);
equal('its hash is the served file\'s',
  index.cycles[0].sha256, createHash('sha256').update(await readFile(join(SITE, ARCHIVE))).digest('hex'));

await joined(DESKTOP, 'desktop');
await joined(MOBILE, 'mobile');
await sameElection();
await tamperedArchive();

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
