// The parliamentary headline above the chart, and the chart's opening range.
//
// A visitor arriving in the final week used to meet four years of time series
// before any statement of where the forecast stands. The page now answers the
// question first -- can either bloc govern alone? -- in a panel directly under
// the hero, and the chart opens on the last 30 days instead of since 2022.
//
// What this suite is really guarding is that the panel is a *rendering*. Every
// number it prints exists in `groups.json` already, computed jointly over the
// same draws as everything else; nothing here counts, combines or derives.
// Each expectation below is therefore read out of the pinned generation's own
// artifacts on disk, so a frontend that started computing its own probability
// would disagree with the file rather than with a transcribed constant.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/bloc-summary.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const VERSIONS = 'files/election-simulator/versions';
const HISTORY = 'files/election-simulator/history/coalition-timeseries.json';

// The live publication: an ordinary pair of probabilities that round to whole
// percent, and an election seven days from the latest published forecast, so
// it is also the generation the 30-day default is written for.
const LIVE_GENERATION = '20260906T081926Z-92521273';

// Both extremes in one publication: 0.99714 and 0.00286. Printed as bounds,
// because a headline "100 %" or "0 %" would claim a certainty the simulation
// does not carry.
const EXTREME_GENERATION = '20260827T205828Z-e6c6ee97';

// The boundary case, and the reason the bound test has to read the exact
// published value rather than the rounded one: 0.98945 rounds *up* to 99 % and
// must not become ">99 %", while 0.01055 rounds *down* to 1 % and must not
// become "<1 %".
const BOUNDARY_GENERATION = '20260903T110151Z-68041c74';

const NBSP = ' ';
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));

const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));

// --- expectations, derived from the published artifacts --------------------

// The page's rule, restated here rather than imported, because the point is to
// pin the behaviour rather than to re-run the implementation: whole percent,
// and a bound instead of a rounded 0 or 100 for anything strictly inside.
function headlineProbability(value) {
  if (value <= 0) return `0${NBSP}%`;
  if (value >= 1) return `100${NBSP}%`;
  const pct = value * 100;
  if (pct < 1) return `<1${NBSP}%`;
  if (pct > 99) return `>99${NBSP}%`;
  return `${Math.round(pct)}${NBSP}%`;
}

const swedishDay = (iso) => {
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
};

// The two blocs the chart draws by default, in the order the page lists them.
const BLOCS = [
  { id: 'red_green_center', label: 'V + MP + S + C', parties: ['V', 'MP', 'S', 'C'] },
  { id: 'tido', label: 'L + KD + M + SD', parties: ['L', 'KD', 'M', 'SD'] },
];

async function publishedBlocs(generation) {
  const groups = (await readJson(SITE, VERSIONS, generation, 'groups.json')).groups;
  return BLOCS.map((bloc) => {
    const published = groups[bloc.id];
    return {
      ...bloc,
      probability: published.prob_majority,
      median: published.median_seats,
      low: published.p05_seats,
      high: published.p95_seats,
    };
  });
}

const expectedTile = (bloc) => ({
  bloc: bloc.id,
  name: bloc.label,
  probability: headlineProbability(bloc.probability),
  median: `${bloc.median} mandat`,
  interval: `${bloc.low}–${bloc.high} mandat`,
  exact: String(bloc.probability),
});

// --- the page --------------------------------------------------------------

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    const svg = document.getElementById('election-timeseries-svg');
    return Boolean(status) && (status.hidden || status.className.includes('error')) &&
      Boolean(svg) && svg.childElementCount > 2;
  }, 25000);
  if (!settled) throw new Error('the forecast page never finished loading');
  await settle(350);
}

async function open(viewport, { root = SITE, pointer = null } = {}) {
  const server = await serve(root, { port: 4000, pointer });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

const readPage = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? flat(node.textContent) : null;
  };
  const section = document.getElementById('election-blocs');
  const app = document.getElementById('election-simulator-app');
  const hero = document.getElementById('election-hero');
  const order = Array.from(app.children).map((child) => child.id).filter(Boolean);

  return {
    sectionExists: Boolean(section),
    sectionHidden: section ? section.hidden : null,
    sectionDisplay: section ? getComputedStyle(section).display : null,
    // Where it sits relative to the hero and the chart is the whole point.
    sectionOrder: order,
    heroBottom: hero ? Math.round(hero.getBoundingClientRect().bottom) : null,
    sectionTop: section ? Math.round(section.getBoundingClientRect().top) : null,
    heading: text('#election-blocs-title'),
    intro: text('#election-blocs-intro'),
    disclaimer: text('#election-blocs-disclaimer'),
    tiles: Array.from(document.querySelectorAll('.eb-bloc')).map((tile) => ({
      bloc: tile.getAttribute('data-bloc'),
      name: flat(tile.querySelector('.eb-bloc__text').textContent),
      probability: flat(tile.querySelector('[data-bloc-probability]').textContent),
      median: flat(tile.querySelector('[data-bloc-median]').textContent),
      interval: flat(tile.querySelector('[data-bloc-interval]').textContent),
      exact: tile.getAttribute('data-prob-majority'),
      exactMedian: tile.getAttribute('data-median-seats'),
      exactLow: tile.getAttribute('data-p05-seats'),
      exactHigh: tile.getAttribute('data-p95-seats'),
      label: tile.getAttribute('aria-label'),
      role: tile.getAttribute('role'),
      swatches: tile.querySelectorAll('.eb-bloc__swatches .ev-swatch').length,
      top: Math.round(tile.getBoundingClientRect().top),
      bottom: Math.round(tile.getBoundingClientRect().bottom),
      width: Math.round(tile.getBoundingClientRect().width),
      // The headline has to stay the biggest thing in the tile at any width.
      valueSize: parseFloat(getComputedStyle(tile.querySelector('.eb-bloc__value')).fontSize),
      wordSize: parseFloat(getComputedStyle(tile.querySelector('.eb-bloc__word')).fontSize),
    })),
    navFirst: (() => {
      const link = document.querySelector('.election-hero__links a');
      return link ? `${link.getAttribute('href')} ${flat(link.textContent)}` : null;
    })(),

    // --- the chart ---
    rangePressed: ['full', 'short'].map((range) => {
      const button = document.getElementById(`election-timeseries-range-${range}`);
      return `${range}:${button ? button.getAttribute('aria-pressed') : 'missing'}`;
    }),
    rangeLabels: ['full', 'short'].map((range) => {
      const button = document.getElementById(`election-timeseries-range-${range}`);
      return button ? flat(button.textContent) : null;
    }),
    axisDomain: (() => {
      const host = document.getElementById('election-timeseries-svg');
      return host ? [host.getAttribute('data-x-axis-min'),
        host.getAttribute('data-x-axis-max')] : null;
    })(),
    axisTicks: Array.from(document.querySelectorAll(
      '#election-timeseries-svg .election-timeseries__axis-label[data-date]'))
      .map((tick) => `${tick.getAttribute('data-date')} ${flat(tick.textContent)}`),
    keys: Array.from(document.querySelectorAll('.election-timeseries__key-item'))
      .map((item) => flat(item.textContent)),
    currentPoints: Array.from(document.querySelectorAll(
      '#election-timeseries-svg [data-forecast-point="true"][data-current="true"]'))
      .map((point) => ({
        coalition: point.getAttribute('data-coalition'),
        date: point.getAttribute('data-date'),
        r: Number(point.getAttribute('r')),
        strokeWidth: parseFloat(getComputedStyle(point).strokeWidth),
      })),
    interiorRadius: (() => {
      const point = document.querySelector(
        '#election-timeseries-svg [data-forecast-point="true"][data-current="false"]');
      return point ? Number(point.getAttribute('r')) : null;
    })(),
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

// --- scenarios -------------------------------------------------------------

async function live() {
  console.log(`\nthe headline panel (${LIVE_GENERATION})`);
  const blocs = await publishedBlocs(LIVE_GENERATION);
  const groups = await readJson(SITE, VERSIONS, LIVE_GENERATION, 'groups.json');
  const history = await readJson(SITE, HISTORY);
  const latestPoint = history.series[history.series.length - 1].date;

  // The pin is only meaningful while it really is the final week.
  const daysLeft = Math.round(
    (Date.parse(`${history.election_date}T00:00:00Z`) - Date.parse(`${latestPoint}T00:00:00Z`))
    / 86400000);
  check('the pinned artifact is inside the final week', daysLeft >= 0 && daysLeft <= 7,
    { latestPoint, election: history.election_date, daysLeft });
  check('both blocs round to an ordinary whole percent here',
    blocs.every((bloc) => {
      const pct = bloc.probability * 100;
      return pct >= 1 && pct <= 99;
    }), blocs.map((bloc) => bloc.probability));

  const { server, browser } = await open(DESKTOP, { pointer: await pointerFor(SITE, LIVE_GENERATION) });
  try {
    await assertServedGeneration(browser, LIVE_GENERATION);
    const page = await readPage(browser);

    // --- placement ---
    equal('the panel is visible', [page.sectionExists, page.sectionHidden], [true, false]);
    check('the panel is painted, not just unhidden',
      page.sectionDisplay !== 'none', page.sectionDisplay);
    equal('the panel comes before the historical chart',
      page.sectionOrder.filter((id) => id === 'election-blocs' || id === 'election-timeseries'),
      ['election-blocs', 'election-timeseries']);
    check('the panel sits below the hero, not inside it',
      page.sectionTop >= page.heroBottom, { hero: page.heroBottom, panel: page.sectionTop });
    equal('the section nav points at it first',
      page.navFirst, '#election-blocs Chansen till egen majoritet');

    // --- the numbers, all four of them, per bloc ---
    equal('every published bloc has a tile, in the chart\'s own order',
      page.tiles.map((tile) => tile.bloc), blocs.map((bloc) => bloc.id));
    equal('each tile prints the published headline, median and interval',
      page.tiles.map((tile) => ({
        bloc: tile.bloc, name: tile.name, probability: tile.probability,
        median: tile.median, interval: tile.interval, exact: tile.exact,
      })), blocs.map(expectedTile));
    check('the headline is a whole percent, with no decimal',
      page.tiles.every((tile) => /^\d+ %$/.test(tile.probability)),
      page.tiles.map((tile) => tile.probability));

    // The rounded figure is a presentation choice; the payload is the record.
    // A tile that carried only the rounded value would make the exact
    // frequency unrecoverable from the page.
    equal('the exact published frequency is kept on the tile',
      page.tiles.map((tile) => tile.exact),
      blocs.map((bloc) => String(bloc.probability)));
    check('and the exact value is not what is printed',
      page.tiles.every((tile) => tile.probability !== tile.exact),
      page.tiles.map((tile) => [tile.probability, tile.exact]));
    equal('the seat figures are kept exactly too',
      page.tiles.map((tile) => [tile.exactMedian, tile.exactLow, tile.exactHigh]),
      blocs.map((bloc) => [String(bloc.median), String(bloc.low), String(bloc.high)]));

    // --- seats, not seat share ---
    check('the headline talks in seats, never in a share of the chamber',
      page.tiles.every((tile) =>
        /mandat$/.test(tile.median) && /mandat$/.test(tile.interval) &&
        !/%/.test(tile.median) && !/%/.test(tile.interval)),
      page.tiles.map((tile) => [tile.median, tile.interval]));

    // --- the majority claim, stated as a majority claim ---
    check('the panel says the threshold it means',
      page.intro.includes('175') && page.intro.includes('349'), page.intro);
    check('and says this is not a probability of forming a government',
      /minst 175 mandat/.test(page.disclaimer) &&
      /inte sannolikheten att de bildar regering/.test(page.disclaimer),
      page.disclaimer);
    check('no copy claims a bloc will govern',
      !/bildar regering\./.test(page.intro) &&
      !page.tiles.some((tile) => /regering/.test(tile.label)),
      { intro: page.intro, labels: page.tiles.map((tile) => tile.label) });

    // --- what a screen reader gets ---
    check('each tile is a list item with one spoken sentence',
      page.tiles.every((tile) => tile.role === 'listitem' && tile.label &&
        tile.label.includes('sannolikhet för minst 175 mandat')),
      page.tiles.map((tile) => [tile.role, tile.label]));
    check('the spoken figure is the same rounded one the tile prints',
      page.tiles.every((tile) => tile.label.includes(tile.probability)),
      page.tiles.map((tile) => [tile.probability, tile.label]));
    equal('each tile carries one swatch per member party',
      page.tiles.map((tile) => tile.swatches), blocs.map((bloc) => bloc.parties.length));

    // --- nothing was recomputed ---
    check('the panel prints what groups.json already published',
      blocs.every((bloc) =>
        groups.groups[bloc.id].prob_majority === bloc.probability &&
        groups.groups[bloc.id].median_seats === bloc.median), blocs);

    // --- the chart's opening range ---
    equal('the final week opens on the 30-day range',
      page.rangePressed, ['full:false', 'short:true']);
    equal('and the full history is still offered',
      page.rangeLabels, ['Sedan 2022', 'Sista 30 dagarna']);
    check('the range buttons still both exist and are switchable',
      await switchesBackToFullHistory(browser));

    // --- the endpoint ---
    equal('the chart still ends at the latest published forecast',
      page.axisDomain ? page.axisDomain[1] : null, latestPoint);
    check('nothing is drawn at or past election day',
      page.axisDomain === null || page.axisDomain[1] < history.election_date,
      { domain: page.axisDomain, election: history.election_date });
    check('no axis tick reaches election day',
      page.axisTicks.every((tick) => tick.split(' ')[0] <= latestPoint), page.axisTicks);
    check('the key names the endpoint', page.keys.includes('Senaste prognos'), page.keys);
    check('every drawn series ends on a marked current point',
      page.currentPoints.length === 2 &&
      page.currentPoints.every((point) => point.date === latestPoint),
      page.currentPoints);
    check('the endpoint is drawn heavier than the points behind it',
      page.currentPoints.every((point) =>
        point.r > page.interiorRadius && point.strokeWidth >= 2),
      { current: page.currentPoints, interior: page.interiorRadius });

    equal('desktop has no horizontal overflow', page.overflow, 0);
    equal('desktop has no console errors', appErrors(browser), []);
    equal('desktop has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// "Keeping the full-history option available" is a claim about a control, so
// it is tested by using the control.
async function switchesBackToFullHistory(browser) {
  await browser.evaluate(() => {
    document.getElementById('election-timeseries-range-full').click();
  });
  await settle(300);
  const after = await browser.evaluate(() => ({
    pressed: ['full', 'short'].map((range) =>
      `${range}:${document.getElementById(`election-timeseries-range-${range}`)
        .getAttribute('aria-pressed')}`),
    start: document.getElementById('election-timeseries-svg')
      .getAttribute('data-x-axis-min'),
  }));
  const restored = JSON.stringify(after.pressed) === JSON.stringify(['full:true', 'short:false']) &&
    typeof after.start === 'string' && after.start.startsWith('2022');
  // Put the page back the way it opened, so later reads see the default.
  await browser.evaluate(() => {
    document.getElementById('election-timeseries-range-short').click();
  });
  await settle(300);
  return restored;
}

// Rounding must never manufacture certainty. Both bounds appear in this one
// publication, so the run covers each of them against a real payload.
async function extremes() {
  console.log(`\nextreme probabilities (${EXTREME_GENERATION})`);
  const blocs = await publishedBlocs(EXTREME_GENERATION);
  check('the pinned generation really is at the extremes',
    blocs.some((bloc) => bloc.probability > 0.99 && bloc.probability < 1) &&
    blocs.some((bloc) => bloc.probability < 0.01 && bloc.probability > 0),
    blocs.map((bloc) => bloc.probability));

  const { server, browser } =
    await open(DESKTOP, { pointer: await pointerFor(SITE, EXTREME_GENERATION) });
  try {
    await assertServedGeneration(browser, EXTREME_GENERATION);
    const page = await readPage(browser);
    equal('the near-certain bloc is printed as a bound, not as 100 %',
      page.tiles.map((tile) => tile.probability), blocs.map((bloc) => headlineProbability(bloc.probability)));
    equal('the documented extremes are the two bounds',
      blocs.map((bloc) => headlineProbability(bloc.probability)),
      [`>99${NBSP}%`, `<1${NBSP}%`]);
    check('no tile claims certainty in either direction',
      page.tiles.every((tile) =>
        tile.probability !== `100${NBSP}%` && tile.probability !== `0${NBSP}%`),
      page.tiles.map((tile) => tile.probability));
    check('the exact frequencies are still on the page',
      page.tiles.every((tile, index) => tile.exact === String(blocs[index].probability)),
      page.tiles.map((tile) => tile.exact));
    check('the spoken sentence uses the bound too',
      page.tiles.every((tile) => tile.label.includes(tile.probability)),
      page.tiles.map((tile) => tile.label));
    equal('the extreme run has no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// The bound is decided by the published value, not by the rounded one. Here
// 98.945 % rounds up to 99 and 1.055 % rounds down to 1, and both must print
// as ordinary whole percentages -- a rule written against the rounded figure
// would turn them into ">99 %" and "<1 %".
async function boundary() {
  console.log(`\nrounding at the bound (${BOUNDARY_GENERATION})`);
  const blocs = await publishedBlocs(BOUNDARY_GENERATION);
  check('the pinned generation straddles the bound after rounding',
    blocs.some((bloc) => bloc.probability * 100 < 99 && Math.round(bloc.probability * 100) === 99) &&
    blocs.some((bloc) => bloc.probability * 100 > 1 && Math.round(bloc.probability * 100) === 1),
    blocs.map((bloc) => bloc.probability));

  const { server, browser } =
    await open(DESKTOP, { pointer: await pointerFor(SITE, BOUNDARY_GENERATION) });
  try {
    await assertServedGeneration(browser, BOUNDARY_GENERATION);
    const page = await readPage(browser);
    equal('a value inside the bound prints as a whole percent',
      page.tiles.map((tile) => tile.probability), [`99${NBSP}%`, `1${NBSP}%`]);
    check('rounding up to 99 does not become a bound',
      !page.tiles.some((tile) => tile.probability.startsWith('>')),
      page.tiles.map((tile) => tile.probability));
    check('rounding down to 1 does not become a bound',
      !page.tiles.some((tile) => tile.probability.startsWith('<')),
      page.tiles.map((tile) => tile.probability));
    equal('the boundary run has no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// Outside the final week the chart opens where it always did. The site's own
// history artifact is served with one field changed -- the election date --
// because that is exactly the input the rule reads, and changing anything else
// would test a different artifact.
async function midCampaign() {
  console.log('\noutside the final week (election date moved out)');
  const root = await mkdtemp(join(tmpdir(), 'bloc-summary-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    const history = await readJson(SITE, HISTORY);
    const latestPoint = history.series[history.series.length - 1].date;
    history.election_date = '2026-10-13';
    await writeFile(join(root, HISTORY), `${JSON.stringify(history)}\n`);
    check('the moved election date is well outside the final week',
      Math.round((Date.parse('2026-10-13T00:00:00Z') -
        Date.parse(`${latestPoint}T00:00:00Z`)) / 86400000) > 7, latestPoint);

    const { server, browser } = await open(DESKTOP, { root });
    try {
      const page = await readPage(browser);
      equal('the chart opens on the full history again',
        page.rangePressed, ['full:true', 'short:false']);
      check('and it really is showing the full history',
        page.axisDomain && page.axisDomain[0].startsWith('2022'), page.axisDomain);
      // The panel is a property of the publication, not of the calendar.
      equal('the headline panel is unaffected by the range default',
        [page.sectionHidden, page.tiles.length], [false, 2]);
      equal('the mid-campaign run has no console errors', appErrors(browser), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mobile() {
  console.log(`\nmobile structure (${LIVE_GENERATION})`);
  const blocs = await publishedBlocs(LIVE_GENERATION);
  const { server, browser } =
    await open(MOBILE, { pointer: await pointerFor(SITE, LIVE_GENERATION) });
  try {
    const page = await readPage(browser);
    equal('both tiles survive the narrow layout', page.tiles.length, blocs.length);
    // Side by side at phone width the headline would have to shrink to fit,
    // and the headline is the reason the panel is above the chart at all.
    check('the tiles stack rather than share a row',
      page.tiles[1].top >= page.tiles[0].bottom - 1,
      page.tiles.map((tile) => [tile.top, tile.bottom]));
    check('each tile uses the full column width',
      page.tiles.every((tile) => tile.width === page.tiles[0].width && tile.width > 250),
      page.tiles.map((tile) => tile.width));
    check('the headline stays the largest thing in its tile',
      page.tiles.every((tile) => tile.valueSize >= 24 && tile.valueSize > tile.wordSize * 2),
      page.tiles.map((tile) => [tile.valueSize, tile.wordSize]));
    equal('the numbers are the same ones the wide layout printed',
      page.tiles.map((tile) => [tile.probability, tile.median, tile.interval]),
      blocs.map((bloc) => [headlineProbability(bloc.probability),
        `${bloc.median} mandat`, `${bloc.low}–${bloc.high} mandat`]));
    check('the majority wording survives too',
      /inte sannolikheten att de bildar regering/.test(page.disclaimer), page.disclaimer);
    equal('the final-week default holds on mobile',
      page.rangePressed, ['full:false', 'short:true']);
    check('the mobile page has no horizontal overflow', page.overflow <= 0, page.overflow);
    equal('mobile has no console errors', appErrors(browser), []);
    equal('mobile has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// Two properties the browser cannot show, because they are about how a number
// was obtained rather than what it reads.
async function sourceGuard() {
  console.log('\nsource guards');
  const source = await readFile(
    new URL('../assets/js/election-simulator.js', import.meta.url), 'utf8');
  const page = await readFile(
    new URL('../_pages/election_simulator.md', import.meta.url), 'utf8');

  // The panel reads the published joint summaries and does nothing else with
  // them. Counting draws, summing party medians or combining histograms here
  // would be a second, independent estimate of a number the publication
  // already carries.
  const renderer = source.slice(
    source.indexOf('function renderBlocSummary'),
    source.indexOf('// 2. Historical coalition forecast') === -1
      ? source.indexOf('Historical coalition forecast')
      : source.indexOf('// 2. Historical coalition forecast'));
  check('the panel renders the published summaries and derives nothing',
    renderer.length > 0 &&
    !/seat_histogram|total_samples|reduce\(|counts/.test(renderer), renderer.length);
  check('its numbers come from groups.json, by published field name',
    source.includes('num(published.prob_majority)') &&
    source.includes('num(published.median_seats)') &&
    source.includes('num(published.p05_seats)') &&
    source.includes('num(published.p95_seats)'));
  // A bloc whose membership the publication redefined must not inherit the
  // chart's wording for the old one.
  check('the bloc pairing is verified by party set before it is trusted',
    source.includes('sameParties(published.parties, definition.parties)'));
  check('the 175 the panel states is checked against the publication',
    source.includes('threshold !== null && threshold !== MAJORITY'));

  // The rounding rule, and the reason it cannot manufacture certainty.
  check('the headline rounds to whole percent with bounds at the extremes',
    /function headlineProbability[\s\S]{0,600}?Math\.round\(pct\)/.test(source) &&
    source.includes('if (pct < 1) return "<1"') &&
    source.includes('if (pct > 99) return ">99"'));
  check('the bounds are decided before rounding, on the published value',
    /if \(pct < 1\) return[\s\S]{0,120}?if \(pct > 99\) return[\s\S]{0,120}?Math\.round/.test(source));
  check('the two-decimal formatters elsewhere are untouched',
    source.includes('function probability(') && source.includes('function histogramProbability('));

  // The opening range is a property of the publication, not of the reader.
  check('the final-week default reads published dates, never the clock',
    source.includes('daysBetween(latestPointIso, history.electionDate)') &&
    !/selectedRange = "short"[\s\S]{0,200}?Date\.now/.test(source));
  check('the window itself is unchanged: still 30 days back from the last point',
    source.includes('historyDateOffset(latestPointIso, -30)') &&
    source.includes('var shortRangeEnd = historyDate(latestPointIso)'));
  check('both range controls are still in the markup',
    page.includes('election-timeseries-range-full') &&
    page.includes('election-timeseries-range-short'));
  check('the endpoint is named in the key rather than drawn into the future',
    page.includes('election-timeseries-key-current') && page.includes('Senaste prognos'));
}

await sourceGuard();
await live();
await extremes();
await boundary();
await midCampaign();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('FAIL');
  process.exit(1);
}
console.log(`PASS (${[LIVE_GENERATION, EXTREME_GENERATION, BOUNDARY_GENERATION].join(', ')})`);
