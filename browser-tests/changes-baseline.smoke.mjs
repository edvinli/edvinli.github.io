// Publication provenance in the reader-facing copy: the hero's publication
// timestamp and the "Förändring" table's comparison baseline.
//
// Both claims used to be vague in a way no layout test could catch. The hero
// stated "Underlag t.o.m. 4 sep 2026", which is the same string for two
// forecasts published five hours apart; and the change table said "sedan
// föregående prognos" while `change_since_prior` names its baseline by
// snapshot, not by position. On the pinned generation below that wording is
// simply wrong: the baseline is the previous *evening's* publication, and a
// later one sits in between. This suite asserts the page prints the instants
// the payload actually carries.
//
// Every expectation is derived from the pinned generation's own artifacts on
// disk, so a transcription slip fails here rather than being asserted into
// existence.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/changes-baseline.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const VERSIONS = 'files/election-simulator/versions';

// The comparison baseline of this generation is 20260903T163419Z-fe0d69d8,
// while 20260904T082721Z-af776460 was published in between. It is the case
// the old wording got wrong, which is why it is the pinned one.
const TARGET_GENERATION = '20260904T110809Z-2edab481';
// Its baseline snapshot predates the versioned publication directory, so it
// cannot be resolved to an instant. The label has to degrade to the published
// prior_as_of date instead of inventing one.
const UNRESOLVABLE_GENERATION = '20260831T170410Z-1f5e0506';

// The page's own month abbreviations. Intl's sv-SE forms ("sep.", "aug.")
// are not these, so the expectation is built from the same list the page uses
// rather than from the formatter's own month name.
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

const settle = (ms = 180) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text));

// --- expectations, derived from the published artifacts --------------------

const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));

// The same wall clock the page is required to print: the published UTC instant
// converted through the zone database, never through a fixed offset.
function stockholmStamp(iso) {
  const fields = {};
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso.replace(/(\.\d{3})\d+/, '$1')))
    .forEach((part) => { if (part.type !== 'literal') fields[part.type] = part.value; });
  const hour = fields.hour === '24' ? '00' : fields.hour;
  return `${Number(fields.day)} ${MONTHS[Number(fields.month) - 1]} ${hour}:${fields.minute}`;
}

function swedishDay(iso) {
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const shippedGenerations = async () =>
  (await readdir(join(SITE, VERSIONS), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

// Resolve the baseline the way the payload identifies it: by deterministic
// payload hash, over the generations the built site actually ships.
async function resolveBaseline(generation) {
  const forecast = await readJson(SITE, VERSIONS, generation, 'forecast.json');
  const change = forecast.change_since_prior;
  for (const candidate of (await shippedGenerations()).reverse()) {
    const manifest = await readJson(SITE, VERSIONS, candidate, 'manifest.json');
    if (manifest.deterministic_payload_sha256 === change.prior_deterministic_payload_sha256) {
      return { change, generation: candidate, generatedAt: manifest.generated_at_utc };
    }
  }
  return { change, generation: null, generatedAt: null };
}

const baselineLabel = (baseline) => baseline.generatedAt
  ? `prognosen ${stockholmStamp(baseline.generatedAt)}`
  : `prognosen ${swedishDay(baseline.change.prior_as_of)}`;

const statusLine = (baseline) => `Jämfört med ${baselineLabel(baseline)}. ` +
  'Skillnaden är mellan medianerna; små skillnader behöver inte betyda en verklig förändring.';

// The page's own delta formatting, so the Övr. row is checked against the
// published number rather than against a copied string.
function deltaValue(change) {
  const rounded = change.toFixed(2).replace('.', ',');
  return `${change > 0 ? '+' : ''}${rounded} procentenheter`;
}
const deltaDirection = (change) =>
  Math.abs(change) < 0.05 ? 'flat' : (change > 0 ? 'up' : 'down');

// --- the page --------------------------------------------------------------

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  await settle(300);
}

async function open(viewport, pointer) {
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

const readProvenance = (browser) => browser.evaluate(() => {
  const flat = (value) => String(value || '').replace(/[\t\n\r ]+/g, ' ').trim();
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? flat(node.textContent) : null;
  };
  const updated = document.getElementById('election-hero-updated');
  const stampNode = document.getElementById('election-hero-updated-time');
  const ageNode = document.getElementById('election-hero-updated-age');
  const note = document.getElementById('election-changes-note');
  const table = document.querySelector('#election-changes-content .ec-table');
  const swatches = Array.from(document.querySelectorAll('#election-changes-content .ev-swatch'));
  return {
    heroAsOf: text('#election-hero-asof'),
    updatedHidden: updated ? updated.hidden : null,
    updatedDisplay: updated ? getComputedStyle(updated).display : null,
    updatedText: text('#election-hero-updated'),
    stamp: stampNode ? flat(stampNode.textContent) : null,
    stampTag: stampNode ? stampNode.tagName : null,
    stampDatetime: stampNode ? stampNode.getAttribute('datetime') : null,
    age: ageNode ? flat(ageNode.textContent) : null,

    changesHeading: text('#election-changes h2'),
    heroNav: Array.from(document.querySelectorAll('.election-hero__links a'))
      .map((link) => `${link.getAttribute('href')} ${link.textContent.trim()}`),
    changesStatus: text('#election-changes-status'),
    caption: text('#election-changes-content caption'),
    captionClass: table && table.querySelector('caption')
      ? table.querySelector('caption').className : null,
    headers: Array.from(document.querySelectorAll('#election-changes-content thead th'))
      .map((cell) => flat(cell.textContent)),
    scopes: Array.from(document.querySelectorAll('#election-changes-content thead th'))
      .map((cell) => cell.getAttribute('scope')),
    rows: Array.from(document.querySelectorAll('#election-changes-content tbody tr'))
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const readCell = (cell) => {
          if (!cell) return null;
          const delta = cell.querySelector('.ec-delta');
          return {
            deltaText: delta ? flat(delta.textContent) : null,
            value: flat((cell.querySelector('.ec-delta__value') || {}).textContent),
            direction: delta
              ? (delta.className.match(/ec-delta--([a-z]+)/) || [])[1] || null
              : null,
            hiddenText: flat((cell.querySelector('.visually-hidden') || {}).textContent),
            glyphHidden: cell.querySelector('.ec-delta__glyph')
              ? cell.querySelector('.ec-delta__glyph').getAttribute('aria-hidden') : null,
          };
        };
        return {
          party: flat(row.querySelector('th').textContent),
          rowScope: row.querySelector('th').getAttribute('scope'),
          vote: readCell(cells[0]),
          seats: readCell(cells[1]),
        };
      }),
    noteHidden: note ? note.hidden : null,
    noteText: note ? flat(note.textContent) : null,
    swatchesHidden: swatches.map((node) => node.getAttribute('aria-hidden')),

    liveRegions: Array.from(document.querySelectorAll('[aria-live]'))
      .map((node) => `${node.id || node.tagName}:${node.getAttribute('aria-live')}` +
        `:${node.getAttribute('role')}`).sort(),
    generationIndex: (() => {
      const node = document.getElementById('election-publication-generations');
      if (!node) return null;
      try { return JSON.parse(node.textContent); } catch { return 'unparseable'; }
    })(),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

// The expectations are only meaningful if the page really was served the
// pinned generation, so read the pointer back through the same server.
async function assertServedGeneration(browser, generation) {
  const served = await browser.evaluate(async () => {
    const res = await fetch('/files/election-simulator/current.json', { cache: 'no-store' });
    return (await res.json()).publication_generation;
  });
  equal('the page was served the pinned generation', served, generation);
}

async function target() {
  console.log(`\ndesktop provenance (${TARGET_GENERATION})`);
  const metadata = await readJson(SITE, VERSIONS, TARGET_GENERATION, 'metadata.json');
  const forecast = await readJson(SITE, VERSIONS, TARGET_GENERATION, 'forecast.json');
  const baseline = await resolveBaseline(TARGET_GENERATION);
  const generations = await shippedGenerations();

  // What makes this generation the right one to pin: its baseline is not the
  // publication that came out just before it. If a future re-pin loses that
  // property, the suite stops testing the thing it was written for.
  const intervening = generations.filter(
    (name) => name > baseline.generation && name < TARGET_GENERATION);
  check('the pinned baseline is not the immediately preceding publication',
    baseline.generation !== null && intervening.length > 0,
    { baseline: baseline.generation, intervening });

  const { server, browser } = await open(DESKTOP, await pointerFor(SITE, TARGET_GENERATION));
  try {
    await assertServedGeneration(browser, TARGET_GENERATION);
    const page = await readProvenance(browser);

    // --- the hero's publication instant ---
    equal('the hero prints the publication instant, not just its day',
      page.stamp, stockholmStamp(metadata.generated_at_utc));
    equal('the pinned generation publishes at the documented wall clock',
      stockholmStamp(metadata.generated_at_utc), '4 sep 13:08');
    equal('the line reads as one phrase',
      page.updatedText.startsWith(`Uppdaterad ${page.stamp}`), true);
    equal('the timestamp line is visible', page.updatedHidden, false);
    check('the timestamp line is painted, not just unhidden',
      page.updatedDisplay !== 'none', page.updatedDisplay);
    equal('the instant is machine-readable as published',
      page.stampDatetime, metadata.generated_at_utc);
    equal('the instant is marked up as a time', page.stampTag, 'TIME');
    check('the publication instant says more than the input date',
      page.stamp !== page.heroAsOf, { stamp: page.stamp, asOf: page.heroAsOf });
    equal('the input date is still its own hero fact',
      page.heroAsOf, swedishDay(forecast.as_of));
    check('any relative age is an addition to the absolute instant',
      page.age === null ||
      /^· (nyss|för \d+ (minut|minuter|timme|timmar|dagar) sedan)$/.test(page.age),
      page.age);

    // --- the comparison baseline ---
    equal('the baseline is named by its own publication instant',
      page.changesStatus, statusLine(baseline));
    equal('the documented baseline instant is the previous evening',
      baselineLabel(baseline), 'prognosen 3 sep 18:34');
    check('no copy claims the baseline is the previous forecast',
      !page.changesStatus.includes('föregående') &&
      !page.changesHeading.includes('föregående') &&
      !page.caption.includes('föregående'), page);
    equal('the heading no longer asserts an ordering',
      page.changesHeading, 'Förändring sedan jämförelseprognosen');
    // The hero's section nav is rebuilt by election-seat-opacity.js from its
    // own label table, so it can drift away from the heading it points at.
    check('the section nav names the change table by its heading',
      page.heroNav.includes(`#election-changes ${page.changesHeading}`), page.heroNav);
    check('no section nav label asserts the previous forecast',
      page.heroNav.every((entry) => !entry.includes('föregående')), page.heroNav);
    equal('the accessible caption names the same baseline', page.caption,
      `Förändring i median röstandel och medianmandat sedan ${baselineLabel(baseline)}`);
    equal('the caption stays visually hidden', page.captionClass, 'visually-hidden');
    for (const name of intervening) {
      const manifest = await readJson(SITE, VERSIONS, name, 'manifest.json');
      const stamp = stockholmStamp(manifest.generated_at_utc);
      check(`the baseline is not the intervening publication (${stamp})`,
        !page.changesStatus.includes(stamp) && !page.caption.includes(stamp),
        { stamp, status: page.changesStatus });
    }
    equal('the page enumerates the generations it ships',
      page.generationIndex, generations);

    // --- the table ---
    equal('the seat column is named for what it holds',
      page.headers, ['Parti', 'Röstandel', 'Medianmandat']);
    equal('every column header is a column scope', page.scopes,
      ['col', 'col', 'col']);
    equal('every published party has a row', page.rows.length,
      Object.keys(forecast.change_since_prior.vote_share_median_change_pp).length);
    equal('Övr. is the last row', page.rows[page.rows.length - 1].party, 'Övr.');

    const rest = page.rows[page.rows.length - 1];
    const restChange = forecast.change_since_prior.vote_share_median_change_pp.REST;
    equal('Övr. shows its published vote-share change',
      rest.vote.value, deltaValue(restChange));
    equal('Övr. carries the published direction',
      rest.vote.direction, deltaDirection(restChange));
    equal('Övr. has no seat delta to format', rest.seats.value, '');
    equal('Övr. reads as an em dash rather than a zero',
      rest.seats.deltaText, '— (kan inte få mandat)');
    equal('the dash uses the no-value styling', rest.seats.direction, 'none');
    check('no seat cell shows Övr. as unchanged',
      !/(^|[^\d])0([^,\d]|$)/.test(rest.seats.deltaText), rest.seats.deltaText);
    equal('the dash is explained to a screen reader',
      rest.seats.hiddenText, '(kan inte få mandat)');
    check('Övr. publishes no seat median to change',
      forecast.change_since_prior.seat_median_change.REST === undefined,
      forecast.change_since_prior.seat_median_change);
    equal('parties keep their row scope',
      page.rows.map((row) => row.rowScope),
      page.rows.map(() => 'row'));
    equal('the colour swatches stay decorative', page.swatchesHidden,
      page.rows.map(() => 'true'));
    check('a seated party still reports a seat change',
      page.rows.some((row) => row.party === 'S' && row.seats.value === '-2'),
      page.rows.map((row) => [row.party, row.seats.value]));

    // --- the non-additivity note ---
    equal('the note is shown with the seat column', page.noteHidden, false);
    equal('the note states why the seat column does not sum to zero',
      page.noteText,
      'Mandatförändringarna avser partiernas separata medianer och behöver därför inte ' +
      'summera till 0. Varje simulerat valresultat innehåller exakt 349 mandat.');
    const seatSum = Object.values(forecast.change_since_prior.seat_median_change)
      .reduce((total, value) => total + value, 0);
    check('the note is a live claim about this publication', seatSum !== 0, seatSum);

    // --- preserved behaviour ---
    check('the load status is still a polite status region',
      page.liveRegions.includes('election-app-status:polite:status'), page.liveRegions);
    check('the cross-view selection note is still a polite status region',
      page.liveRegions.includes('election-selection-note:polite:status'), page.liveRegions);
    check('the new timestamp line introduced no competing live region',
      page.liveRegions.filter((entry) => entry.startsWith('election-hero')).length === 0,
      page.liveRegions);
    equal('desktop has no horizontal overflow', page.overflow, 0);
    equal('desktop has no console errors', appErrors(browser), []);
    equal('desktop has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function unresolvable() {
  console.log(`\nunresolvable baseline (${UNRESOLVABLE_GENERATION})`);
  const forecast = await readJson(SITE, VERSIONS, UNRESOLVABLE_GENERATION, 'forecast.json');
  const baseline = await resolveBaseline(UNRESOLVABLE_GENERATION);
  check('the pinned baseline is genuinely not shipped', baseline.generation === null,
    baseline.generation);

  const { server, browser } =
    await open(DESKTOP, await pointerFor(SITE, UNRESOLVABLE_GENERATION));
  try {
    await assertServedGeneration(browser, UNRESOLVABLE_GENERATION);
    const page = await readProvenance(browser);
    equal('the label degrades to the published baseline date',
      page.changesStatus, statusLine(baseline));
    equal('the documented fallback is the published prior_as_of',
      baselineLabel(baseline), 'prognosen 23 aug 2026');
    check('an unresolvable baseline invents no time',
      !/\d{1,2}:\d{2}/.test(page.changesStatus), page.changesStatus);
    check('an unresolvable baseline still avoids the ordering claim',
      !page.changesStatus.includes('föregående'), page.changesStatus);

    // The table is never the casualty of a label that could not be resolved.
    equal('the seat column is still named Medianmandat',
      page.headers, ['Parti', 'Röstandel', 'Medianmandat']);
    equal('Övr. is still the last row',
      page.rows[page.rows.length - 1].party, 'Övr.');
    const rest = page.rows[page.rows.length - 1];
    const restChange = forecast.change_since_prior.vote_share_median_change_pp.REST;
    equal('a sub-threshold Övr. change is still printed',
      rest.vote.value, deltaValue(restChange));
    equal('a sub-threshold Övr. change reads as flat',
      rest.vote.direction, deltaDirection(restChange));
    equal('Övr. still has no seat change', rest.seats.direction, 'none');
    equal('Övr. still reads as an em dash',
      rest.seats.deltaText, '— (kan inte få mandat)');
    equal('the note is still shown', page.noteHidden, false);
    equal('this generation also publishes its own instant',
      page.stamp,
      stockholmStamp((await readJson(SITE, VERSIONS, UNRESOLVABLE_GENERATION,
        'metadata.json')).generated_at_utc));
    equal('the fallback run has no console errors', appErrors(browser), []);
    equal('the fallback run has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function mobile() {
  console.log(`\nmobile provenance (${TARGET_GENERATION})`);
  const baseline = await resolveBaseline(TARGET_GENERATION);
  const { server, browser } = await open(MOBILE, await pointerFor(SITE, TARGET_GENERATION));
  try {
    const page = await readProvenance(browser);
    equal('the timestamp line survives the narrow layout', page.updatedHidden, false);
    check('the timestamp line is painted on mobile',
      page.updatedDisplay !== 'none', page.updatedDisplay);
    equal('the baseline is named on mobile too', page.changesStatus, statusLine(baseline));
    equal('the seat column keeps its name on mobile',
      page.headers, ['Parti', 'Röstandel', 'Medianmandat']);
    equal('Övr. is present on mobile',
      page.rows[page.rows.length - 1].party, 'Övr.');
    equal('the note is present on mobile', page.noteHidden, false);
    check('the mobile page has no horizontal overflow', page.overflow <= 0, page.overflow);
    // The table is the one wide block in this section; it must scroll inside
    // its own box rather than pushing the page sideways.
    const scroller = await browser.evaluate(() => {
      const box = document.querySelector('.election-changes-table');
      return box ? getComputedStyle(box).overflowX : null;
    });
    equal('the change table scrolls inside its own box', scroller, 'auto');
    equal('mobile has no console errors', appErrors(browser), []);
    equal('mobile has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// Two things the browser cannot show, because they are about how the value was
// obtained rather than what it reads.
async function sourceGuard() {
  console.log('\nsource guards');
  const source = await readFile(
    new URL('../assets/js/election-simulator.js', import.meta.url), 'utf8');
  const page = await readFile(
    new URL('../_pages/election_simulator.md', import.meta.url), 'utf8');
  check('the conversion goes through the zone database, not a fixed offset',
    source.includes('"Europe/Stockholm"') && !/\+0?2:00|utcOffset|\+ 2 \* 3600/.test(source));
  check('the baseline is verified by payload hash before it is believed',
    source.includes('manifest.deterministic_payload_sha256 !== expected'));
  check('the hero reads the publication instant, not the input date',
    source.includes('var generatedAt = metadata.generated_at_utc ||'));
  check('no reader-facing copy asserts the previous forecast',
    !page.includes('föregående prognos') && !source.includes('f\\u00f6reg\\u00e5ende prognos'));
  check('the generation list is enumerated at build time, not written by hand',
    page.includes('site.static_files') && !/2026\d{4}T\d{6}Z/.test(page));
  // "Medianmandat" is the word the party cards and the coalition summary
  // already use for a separately taken median, so the change table now agrees
  // with them instead of calling the same quantity "Mandat".
  check('the bare Mandat column header is gone',
    !source.includes('<th scope=\\"col\\">Mandat</th>') &&
    source.includes('<th scope=\\"col\\">Medianmandat</th>'));
}

await sourceGuard();
await target();
await unresolvable();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('FAIL');
  process.exit(1);
}
console.log(`PASS (${TARGET_GENERATION}, ${UNRESOLVABLE_GENERATION})`);
