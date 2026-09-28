// The certified election result: the hero that leads with it, the panel that
// sets the forecast against it, and its marks on "Vägen till valdagen".
//
// The result is a separate lookup file (files/election-simulator/results/),
// outside the frozen publication bundle. What this suite guards is that the
// page only *prints* it and subtracts it from published quantiles: every
// expectation is read from results/2026.json and the pinned generation's
// forecast.json on disk, so a frontend that started rounding, re-deriving or
// transcribing numbers would disagree with the files rather than with a
// constant written here.
//
// It also guards the two ways the result must stay off the page: a
// publication computed before the election never meets its result, and a
// result file that does not validate whole changes nothing.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/election-result.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor, historyFixture } from './server.mjs';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const VERSIONS = 'files/election-simulator/versions';
const RESULT = 'files/election-simulator/results/2026.json';

// The election-day publication: the last forecast made for 2026, computed on
// the morning of the election. Its result is the one the page compares to.
const DECIDED_GENERATION = '20260913T054241Z-496dd879';
// A week before the election. The page must render it exactly as published.
const PRE_ELECTION_GENERATION = '20260906T081926Z-92521273';
// A synthetic forecast for the next election, built by the simulator's own
// publication pipeline (2,000 draws, as_of 2026-09-11) and kept as a test
// fixture only: no real 2030 generation exists yet. With it on screen the
// bars show today's forecast against the result, and the comparison panel
// keeps showing the final 2026 forecast.
const NEXT_GENERATION = '20261005T040000Z-1ba3b530';
const NEXT_GENERATION_DIR = new URL(`./fixtures/generation-2030/${NEXT_GENERATION}/`, import.meta.url);
const NEXT_HISTORY = new URL('./fixtures/next-cycle-2030.json', import.meta.url);

const PARTIES = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const CHAMBER = 349;
const MONTHS = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni',
  'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
const BLOCS = [
  { id: 'red_green_center', parties: ['V', 'MP', 'S', 'C'] },
  { id: 'tido', parties: ['L', 'KD', 'M', 'SD'] },
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
const near = (a, b, tolerance = 1e-3) => Math.abs(Number(a) - Number(b)) <= tolerance;

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
const swedishDay = (iso) => {
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const svg = document.getElementById('election-timeseries-svg');
    return Boolean(status) && (status.hidden || status.className.includes('error')) &&
      Boolean(svg) && svg.childElementCount > 2;
  }, 25000);
  if (!settled) throw new Error('the forecast page never finished loading');
  await settle(400);
}

async function open(viewport, { root = SITE, pointer = null, history = null } = {}) {
  const server = await serve(root, { port: 4000, pointer, history });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

function readPage(browser) {
  return browser.evaluate(() => {
    const text = (id) => (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
    const hidden = (id) => {
      const node = document.getElementById(id);
      return !node || node.hidden || getComputedStyle(node).display === 'none';
    };
    return {
      resultHidden: hidden('election-result'),
      deltaHidden: hidden('election-result-delta'),
      dividerHidden: hidden('election-forecast-divider'),
      freshnessHidden: hidden('election-hero-poll-freshness'),
      kicker: text('election-hero-kicker'),
      countdownLabel: text('election-hero-countdown-label'),
      countdown: text('election-hero-countdown'),
      lede: text('election-hero-lede'),
      updated: text('election-hero-updated'),
      // The chamber's dots in drawing order, run-length encoded by party.
      chamber: Array.from(document.querySelectorAll('#election-result-parliament .election-seat'))
        .reduce((runs, node) => {
          const party = node.dataset.party || null;
          const last = runs[runs.length - 1];
          if (last && last.party === party) last.seats += 1;
          else runs.push({ party, seats: 1 });
          return runs;
        }, []),
      legend: Array.from(document.querySelectorAll('#election-result-legend .ep-legend__item'))
        .map((node) => [node.dataset.party, node.querySelector('.ep-legend__seats')?.textContent.trim()]),
      order: Array.from(document.querySelectorAll('.election-app > section')).map((node) => node.id),
      nav: Array.from(document.querySelectorAll('#election-hero .election-hero__links a'))
        .map((node) => node.getAttribute('href')),
      simulatedChamber: Boolean(document.getElementById('election-parliament')) ||
        /simulerat riksdagsutfall/i.test(document.getElementById('election-simulator-app').textContent),
      blocs: Array.from(document.querySelectorAll('#election-result-blocs .election-result__bloc'))
        .map((node) => ({ id: node.dataset.coalition, text: node.textContent.replace(/\s+/g, ' ').trim() })),
      opinionChange: document.getElementById('election-result-bars')?.getAttribute('data-opinion-change'),
      barsTitle: text('election-result-bars-title'),
      barsKey: text('election-result-bars-key'),
      deltaIntro: text('election-result-delta-intro'),
      bars: Array.from(document.querySelectorAll('#election-result-bars .erb-row'))
        .map((node) => ({
          change: node.dataset.change === undefined ? null : Number(node.dataset.change),
          forecastMedian: node.dataset.forecastMedian === undefined ? null : Number(node.dataset.forecastMedian),
          printedChange: node.querySelector('.erb-change')?.textContent.trim() || null,
          party: node.dataset.party,
          value: node.querySelector('.erb-value')?.textContent.trim(),
          width: parseFloat(node.querySelector('.erb-bar')?.style.width || 'NaN'),
        })),
      rows: Array.from(document.querySelectorAll('#election-result-delta-rows .erd-row'))
        .map((node) => ({
          party: node.dataset.party,
          result: Number(node.dataset.resultShare),
          delta: Number(node.dataset.deltaMedian),
          // dataset cannot name data-inside-90: a digit after the dash is not camel-cased.
          inside90: node.getAttribute('data-inside-90') === 'true',
          printed: node.querySelector('.erd-delta__value')?.textContent.trim(),
          label: node.getAttribute('aria-label') || '',
        })),
      summary: text('election-result-delta-summary'),
      summaryHidden: hidden('election-result-delta-summary'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

function readChart(browser) {
  return browser.evaluate(() => {
    const svg = document.getElementById('election-timeseries-svg');
    const line = svg.querySelector('[data-election-line]');
    return {
      metric: svg.getAttribute('data-metric'),
      view: svg.getAttribute('data-view-mode'),
      electionAttr: svg.getAttribute('data-election-result'),
      xMax: svg.getAttribute('data-x-axis-max'),
      line: line ? line.getAttribute('data-election-line') : null,
      marks: Array.from(svg.querySelectorAll('.election-timeseries__result')).map((node) => ({
        series: node.getAttribute('data-result-series'),
        value: Number(node.getAttribute('data-result-value')),
        seats: Number(node.getAttribute('data-result-seats')),
      })),
      drawnSeries: Array.from(svg.querySelectorAll('.election-timeseries__series-group'))
        .map((node) => node.getAttribute('data-coalition')),
      currentPoints: svg.querySelectorAll('.election-timeseries__current').length,
      keyHidden: document.getElementById('election-timeseries-key-result')?.hidden !== false,
      intro: (document.getElementById('election-timeseries-intro')?.textContent || '').trim(),
    };
  });
}

const click = (browser, id) => browser.evaluate((wanted) => {
  const node = document.getElementById(wanted);
  if (!node) return false;
  node.click();
  return true;
}, id);

// --- expectations from the files ------------------------------------------

const result = await readJson(SITE, RESULT);
// The live history is replaced by every sync. Until the first history for the
// next election it ends on the decided election day; after that the page
// joins the archived 2026 history to its left and the chart runs on past the
// result (forecast-cycles.smoke.mjs owns that join).
const liveHistory = await readJson(SITE, 'files/election-simulator/history/coalition-timeseries.json');
const historyIsDecided = liveHistory.election_date === result.election_date;
const liveLatest = liveHistory.series.at(-1).date;
const decidedForecast = await readJson(SITE, VERSIONS, DECIDED_GENERATION, 'forecast.json');
const parliamentaryVotes = PARTIES.reduce((sum, party) => sum + result.parties[party].votes, 0);

function expectedChartValue(members, metric, kind) {
  const seats = members.reduce((sum, party) => sum + result.parties[party].seats, 0);
  if (metric === 'seats') return { value: 100 * seats / CHAMBER, seats };
  if (kind === 'party') return { value: result.parties[members[0]].vote_share_pct, seats };
  const votes = members.reduce((sum, party) => sum + result.parties[party].votes, 0);
  return { value: 100 * votes / parliamentaryVotes, seats };
}

// --- 1. decided: the election-day publication against its result ---------

async function decided(viewport, name) {
  console.log(`\n[decided] ${name}`);
  const pointer = await pointerFor(SITE, DECIDED_GENERATION);
  const { server, browser } = await open(viewport, { pointer });
  try {
    const page = await readPage(browser);
    check('the result section is shown', !page.resultHidden);
    equal('the chart leads, then the result, then the comparison, then the forecast',
      page.order.slice(0, 4),
      ['election-timeseries', 'election-result', 'election-result-delta', 'election-blocs']);
    check('the simulated parliament is gone from the page', !page.simulatedChamber);
    equal('the kicker names the result', page.kicker, `Sverige · Riksdagen · valresultat ${result.election_date.slice(0, 4)}`);
    equal('the countdown cell names the next election', [page.countdownLabel, page.countdown],
      ['Nästa val', swedishDay(result.next_election_date)]);
    check('the lede says the election is decided',
      page.lede.startsWith(`Valet den ${swedishDay(result.election_date)} är avgjort.`), page.lede);
    check('the calculation stamp names the last forecast', page.updated.startsWith('Sista prognosen beräknad'), page.updated);
    check('the polling-freshness note is not shown', page.freshnessHidden);
    check('the divider over the forecast panels is shown', !page.dividerHidden);

    const seating = ['V', 'S', 'MP', 'C', 'L', 'KD', 'M', 'SD'];
    equal('the chamber draws every certified seat, in seating order',
      page.chamber, seating.map((party) => ({ party, seats: result.parties[party].seats })));
    equal('the chamber holds 349 seats', page.chamber.reduce((sum, run) => sum + run.seats, 0), CHAMBER);
    equal('the legend prints the certified seats',
      page.legend, seating.map((party) => [party, String(result.parties[party].seats)]));
    equal('the bloc totals are the sums of the certified seats',
      page.blocs.map((bloc) => bloc.id + ':' + /(\d+) mandat/.exec(bloc.text)?.[1]),
      BLOCS.map((bloc) => bloc.id + ':' + bloc.parties.reduce((sum, p) => sum + result.parties[p].seats, 0)));
    const ranked = PARTIES.slice().sort((a, b) => result.parties[b].vote_share_pct - result.parties[a].vote_share_pct);
    equal('the vote-share bars are ranked by vote share', page.bars.map((bar) => bar.party), ranked);
    equal('each bar prints its certified share', page.bars.map((bar) => bar.value),
      ranked.map((party) => `${result.parties[party].vote_share_pct.toFixed(1).replace('.', ',')}\u00a0%`));
    equal('no opinion change is shown while the forecast is still the 2026 one',
      [page.opinionChange, page.bars.every((bar) => bar.change === null)], ['false', true]);
    check('the key says when the change will appear',
      page.barsKey.includes('valet 2030'), page.barsKey);
    check('bar lengths are proportional to the shares',
      page.bars.every((bar) => near(bar.width / page.bars[0].width,
        result.parties[bar.party].vote_share_pct / result.parties[ranked[0]].vote_share_pct, 1e-3)),
      page.bars);

    check('the forecast-against-result panel is shown', !page.deltaHidden);
    equal('one row per parliamentary party', page.rows.map((row) => row.party), PARTIES);
    const deltas = PARTIES.map((party) => {
      const forecast = decidedForecast.parties[party];
      const actual = result.parties[party].vote_share_pct;
      return {
        party,
        delta: forecast.vote_share_median - actual,
        inside90: forecast.vote_share_p05 <= actual && forecast.vote_share_p95 >= actual,
      };
    });
    check('each delta is the published median minus the result',
      page.rows.every((row, index) => near(row.delta, deltas[index].delta)),
      page.rows.map((row, index) => [row.party, row.delta, deltas[index].delta]));
    equal('each row knows whether the result was inside the 90 % interval',
      page.rows.map((row) => row.inside90), deltas.map((d) => d.inside90));
    const inside = deltas.filter((d) => d.inside90).length;
    check('the summary counts the 90 % hits', !page.summaryHidden &&
      page.summary.includes(`90-procentiga intervall för ${inside} av ${PARTIES.length} partier`), page.summary);
    check('every row is spoken with its result and direction',
      page.rows.every((row) => /valresultat \d+,\d procent/.test(row.label) && /(högre|lägre|i nivå)/.test(row.label)));
    equal('the hero navigation follows the page',
      page.nav.slice(0, 5),
      ['#election-timeseries', '#election-latest-poll', '#election-result', '#election-result-delta', '#election-blocs']);
    check('no horizontal scroll', page.overflow <= 0, page.overflow);

    // The chart: the result sits on the last day of the 2026 series, never
    // beyond it, and each mark is on the chart's own scale for its series.
    let chart = await readChart(browser);
    equal('the election line is at election day', chart.line, result.election_date);
    if (historyIsDecided) {
      check('nothing is drawn past election day', chart.xMax <= result.election_date, chart.xMax);
      check('the intro says the last point is the last forecast', /romberna visar valresultatet/.test(chart.intro), chart.intro);
    } else {
      equal('the axis runs on to the latest forecast for the next election', chart.xMax, liveLatest);
      check('the intro points to the result', /Romberna på valdagen visar valresultatet/.test(chart.intro), chart.intro);
    }
    check('the result key is shown', !chart.keyHidden);
    equal('one result mark per drawn series', chart.marks.map((m) => m.series), chart.drawnSeries);
    check('the result marks are not forecast endpoints', chart.currentPoints === chart.drawnSeries.length,
      { current: chart.currentPoints, series: chart.drawnSeries.length });
    // The chart opens on Partier: the party marks are the certified shares.
    equal('the chart opens on the party view', chart.view, 'parties');
    check('party marks are the certified shares',
      chart.marks.length === PARTIES.length && chart.marks.every((mark) =>
        near(mark.value, result.parties[mark.series].vote_share_pct, 1e-3)), chart.marks);

    await click(browser, 'election-timeseries-view-coalitions');
    await settle();
    chart = await readChart(browser);
    equal('Koalitioner shows the two default blocs', chart.drawnSeries, BLOCS.map((bloc) => bloc.id));
    const coalition = (id) => BLOCS.find((bloc) => bloc.id === id).parties;
    check('coalition vote marks are renormalized over the eight parties',
      chart.marks.length === BLOCS.length &&
      chart.marks.every((mark) => near(mark.value, expectedChartValue(coalition(mark.series), 'vote').value, 1e-3)),
      chart.marks);

    await click(browser, 'election-timeseries-seats');
    await settle();
    chart = await readChart(browser);
    check('coalition seat marks are a share of the chamber',
      chart.marks.length > 0 && chart.marks.every((mark) => {
        const expected = expectedChartValue(coalition(mark.series), 'seats');
        return near(mark.value, expected.value, 1e-3) && mark.seats === expected.seats;
      }), chart.marks);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 2. a publication from before the election ----------------------------

async function preElection() {
  console.log('\n[pre-election publication] desktop');
  const pointer = await pointerFor(SITE, PRE_ELECTION_GENERATION);
  const { server, browser } = await open(DESKTOP, { pointer });
  try {
    const page = await readPage(browser);
    check('the result is not shown', page.resultHidden);
    check('the comparison is not shown', page.deltaHidden);
    check('the divider is not shown', page.dividerHidden);
    equal('the countdown cell is the countdown', page.countdownLabel, 'Dagar kvar');
    check('the lede is the forecast lede', page.lede.startsWith('Valprognosen visar'), page.lede);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 3. a forecast for the next election on screen ------------------------

async function nextElection(viewport, name) {
  console.log(`\n[2030 forecast on screen] ${name}`);
  const root = await mkdtemp(join(tmpdir(), 'election-result-2030-'));
  try {
    await cp(SITE, root, { recursive: true });
    await cp(NEXT_GENERATION_DIR, join(root, VERSIONS, NEXT_GENERATION), { recursive: true });
    const next = JSON.parse(await readFile(new URL('forecast.json', NEXT_GENERATION_DIR), 'utf8'));
    const pointer = await pointerFor(root, NEXT_GENERATION);
    const { server, browser } = await open(viewport, { root, pointer, history: await historyFixture(NEXT_HISTORY) });
    try {
      const page = await readPage(browser);
      equal('the fixture forecasts the next election', next.election_date, result.next_election_date);
      equal('the kicker names both', page.kicker,
        `Sverige · Riksdagen · valresultat ${result.election_date.slice(0, 4)} · valprognos ${result.next_election_date.slice(0, 4)}`);
      equal('the bars carry the opinion change', [page.opinionChange, page.barsTitle],
        ['true', 'Röstandel och opinionsförändring']);
      check('each change is today\'s published median minus the certified result',
        page.bars.length === PARTIES.length && page.bars.every((bar) =>
          near(bar.forecastMedian, next.parties[bar.party].vote_share_median) &&
          near(bar.change, next.parties[bar.party].vote_share_median - result.parties[bar.party].vote_share_pct)),
        page.bars);
      check('each change is printed with its direction',
        page.bars.every((bar) => /^[▲▼•]\s?\d+,\d$/.test(bar.printedChange)), page.bars.map((bar) => bar.printedChange));
      check('the bars still show the result', page.bars.every((bar) =>
        bar.value === `${result.parties[bar.party].vote_share_pct.toFixed(1).replace('.', ',')}\u00a0%`));

      // The comparison is the final forecast for 2026, not today's.
      check('the comparison panel is shown', !page.deltaHidden);
      check('it names the final forecast\'s date', page.deltaIntro.includes('(13 sep 2026)'), page.deltaIntro);
      check('its deltas are the final 2026 forecast minus the result',
        page.rows.length === PARTIES.length && page.rows.every((row, index) => {
          const party = PARTIES[index];
          return near(row.delta, decidedForecast.parties[party].vote_share_median - result.parties[party].vote_share_pct);
        }), page.rows.map((row) => [row.party, row.delta]));
      check('the divider is not shown: the panels below are the 2030 forecast', page.dividerHidden);
      check('no horizontal scroll', page.overflow <= 0, page.overflow);
      equal('no console errors', appErrors(browser).map((e) => e.text), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- 4. a result file that does not validate ------------------------------

async function invalidResult() {
  console.log('\n[invalid result file] desktop');
  const root = await mkdtemp(join(tmpdir(), 'election-result-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    const broken = structuredClone(result);
    broken.parties.M.seats -= 1;
    await writeFile(join(root, RESULT), `${JSON.stringify(broken)}\n`);
    const pointer = await pointerFor(SITE, DECIDED_GENERATION);
    const { server, browser } = await open(DESKTOP, { root, pointer });
    try {
      const page = await readPage(browser);
      const chart = await readChart(browser);
      check('the result is not shown', page.resultHidden);
      check('the comparison is not shown', page.deltaHidden);
      equal('no result marks on the chart', chart.marks.length, 0);
      check('the result key stays hidden', chart.keyHidden);
      equal('no console errors', appErrors(browser).map((e) => e.text), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await decided(DESKTOP, 'desktop');
await decided(MOBILE, 'mobile');
await preElection();
await nextElection(DESKTOP, 'desktop');
await nextElection(MOBILE, 'mobile');
await invalidResult();

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
