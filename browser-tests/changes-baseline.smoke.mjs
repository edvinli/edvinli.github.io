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
// It also owns the change chip, which is where those changes are now read:
// beside the vote medians and beside the seat medians, instead of in a
// separate table three screens away. One renderer, one noise floor, one
// resolved baseline named once per section.
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

// The page's own delta formatting, so the Övr. row is checked against the
// published number rather than against a copied string.
function deltaValue(change) {
  const rounded = change.toFixed(2).replace('.', ',');
  return `${change > 0 ? '+' : ''}${rounded} procentenheter`;
}
// Percentage points resolve to 0,05; a seat median moves in whole seats, so
// its floor is half a seat.
const VOTE = { floor: 0.05, digits: 1, unit: 'procentenheter' };
const SEAT = { floor: 0.5, digits: 0, unit: 'mandat' };

const deltaDirection = (change, kind = VOTE) =>
  Math.abs(change) < kind.floor ? 'flat' : (change > 0 ? 'up' : 'down');

// The chip: digits matching the level it sits beside, and no number at all
// below the noise floor, where a rounded "+0,0" or "0" would look like a
// measurement the publication does not claim.
const inlineDeltaValue = (change, kind = VOTE) => deltaDirection(change, kind) === 'flat'
  ? '' : `${change > 0 ? '+' : ''}${change.toFixed(kind.digits).replace('.', ',')}`;

const inlineDeltaSpoken = (change, kind = VOTE) => deltaDirection(change, kind) === 'flat'
  ? 'ingen tydlig förändring sedan jämförelseprognosen'
  : `${change > 0 ? 'upp' : 'ner'} ` +
    `${Math.abs(change).toFixed(kind.digits).replace('.', ',')} ${kind.unit} ` +
    'sedan jämförelseprognosen';

const changeNote = (baseline, unit) =>
  `Efter varje median visas förändringen ${unit} jämfört med ${baselineLabel(baseline)}. ` +
  'En punkt betyder ingen tydlig förändring.';

// The seat medians are taken separately, so neither the levels nor the changes
// add up -- which is why this sentence has to sit with the seat column.
const SEATS_NON_ADDITIVITY =
  'Medianerna beräknas var för sig och behöver därför inte summera till 349, ' +
  'och förändringarna inte till 0. Varje simulerat valresultat innehåller ändå exakt 349 mandat.';

// A chip must never make its row taller than a row with no number to show.
// Stated as "the tallest unmoved row is no taller than the shortest moved
// one", which is exactly the regression -- a chip that wraps inside the narrow
// median column -- while tolerating a row that is tall for an unrelated
// reason, such as Övr.'s wrapping "gäller inte" threshold label.
function chipCostsNoHeight(rows) {
  const heights = (direction) => rows
    .filter((row) => (direction === 'flat') === (row.chipDirection === 'flat'))
    .map((row) => row.rowHeight);
  const flat = heights('flat');
  const moved = heights('moved');
  if (flat.length === 0 || moved.length === 0) return null;
  return Math.max(...flat) <= Math.min(...moved);
}

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

  // One reader for both row kinds: the chip is the same rendering in both, and
  // the assertions differ only in the published field it comes from.
  const readRows = (rowSelector, abbrSelector, medianSelector) =>
    Array.from(document.querySelectorAll(rowSelector)).map((row) => {
      const median = row.querySelector(medianSelector);
      const chip = row.querySelector('.ed-delta');
      const value = chip ? chip.querySelector('.ed-delta__value') : null;
      const medianBox = median.getBoundingClientRect();
      const chipBox = chip ? chip.getBoundingClientRect() : null;
      return {
        party: flat(row.querySelector(abbrSelector).textContent),
        hasChip: Boolean(chip),
        chipValue: value ? flat(value.textContent) : '',
        chipGlyph: chip ? flat(chip.querySelector('.ed-delta__glyph').textContent) : null,
        chipDirection: chip
          ? (chip.className.match(/ed-delta--([a-z]+)/) || [])[1] || null : null,
        chipHidden: chip ? chip.getAttribute('aria-hidden') : null,
        chipDisplay: chip ? getComputedStyle(chip).display : null,
        // Stacked when the chip starts below the median's box, beside it when
        // the two share a line.
        stacked: chipBox ? chipBox.top >= medianBox.bottom - 1 : null,
        label: row.getAttribute('aria-label'),
        rowHeight: Math.round(row.getBoundingClientRect().height),
      };
    });

  const voteNote = document.getElementById('election-vote-change-note');
  const seatNote = document.getElementById('election-seat-change-note');
  return {
    heroAsOf: text('#election-hero-asof'),
    updatedHidden: updated ? updated.hidden : null,
    updatedDisplay: updated ? getComputedStyle(updated).display : null,
    updatedText: text('#election-hero-updated'),
    stamp: stampNode ? flat(stampNode.textContent) : null,
    stampTag: stampNode ? stampNode.tagName : null,
    stampDatetime: stampNode ? stampNode.getAttribute('datetime') : null,
    age: ageNode ? flat(ageNode.textContent) : null,

    heroNav: Array.from(document.querySelectorAll('.election-hero__links a'))
      .map((link) => `${link.getAttribute('href')} ${link.textContent.trim()}`),
    // The separate change table is gone: its numbers are in the rows now.
    changesSection: Boolean(document.getElementById('election-changes')),
    changeTables: document.querySelectorAll('.ec-table').length,

    voteNoteHidden: voteNote ? voteNote.hidden : null,
    voteNoteText: voteNote ? flat(voteNote.textContent) : null,
    voteRows: readRows('#election-party-cards .ev-head', '.ev-abbr', '.ev-median__value'),

    seatsIntro: text('#election-seats-intro'),
    seatNoteHidden: seatNote ? seatNote.hidden : null,
    seatNoteText: seatNote ? flat(seatNote.textContent) : null,
    seatRows: readRows('#election-seat-bars .es-row', '.es-abbr', '.es-median__value'),

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
      page.voteNoteText, changeNote(baseline, 'i procentenheter'));
    equal('the documented baseline instant is the previous evening',
      baselineLabel(baseline), 'prognosen 3 sep 18:34');
    check('no copy claims the baseline is the previous forecast',
      !page.voteNoteText.includes('föregående') &&
      !page.seatNoteText.includes('föregående') &&
      page.heroNav.every((entry) => !entry.includes('föregående')), page);
    for (const name of intervening) {
      const manifest = await readJson(SITE, VERSIONS, name, 'manifest.json');
      const stamp = stockholmStamp(manifest.generated_at_utc);
      check(`the baseline is not the intervening publication (${stamp})`,
        !page.voteNoteText.includes(stamp) && !page.seatNoteText.includes(stamp),
        { stamp, note: page.voteNoteText });
    }
    equal('the page enumerates the generations it ships',
      page.generationIndex, generations);

    // --- the change table is gone, and nothing it carried was dropped ---
    equal('the separate change section is gone', page.changesSection, false);
    equal('no change table is rendered anywhere', page.changeTables, 0);
    check('the section nav no longer points at it',
      page.heroNav.every((entry) => !entry.startsWith('#election-changes')), page.heroNav);
    equal('the vote rows and the seat rows cite one baseline',
      [page.voteNoteText, page.seatNoteText],
      [changeNote(baseline, 'i procentenheter'), changeNote(baseline, 'i mandat')]);
    equal('both captions are shown',
      [page.voteNoteHidden, page.seatNoteHidden], [false, false]);
    // The table's own note moved into the sentence the seats section already
    // had about medians not summing to 349.
    check('non-additivity is stated with the seat column',
      page.seatsIntro.endsWith(SEATS_NON_ADDITIVITY), page.seatsIntro);
    const seatSum = Object.values(forecast.change_since_prior.seat_median_change)
      .reduce((total, value) => total + value, 0);
    check('that is a live claim about this publication', seatSum !== 0, seatSum);

    // --- the chip, in both row kinds ---
    for (const [kindName, kind, rows, published, order] of [
      ['vote', VOTE, page.voteRows,
        forecast.change_since_prior.vote_share_median_change_pp,
        Object.keys(forecast.change_since_prior.vote_share_median_change_pp)],
      ['seat', SEAT, page.seatRows,
        forecast.change_since_prior.seat_median_change,
        (await readJson(SITE, VERSIONS, TARGET_GENERATION, 'seats.json')).party_order],
    ]) {
      const label = (name) => (name === 'REST' ? 'Övr.' : name);
      equal(`every ${kindName} row is a published party`,
        rows.map((row) => row.party), order.map(label));
      equal(`every ${kindName} row carries a chip`,
        rows.map((row) => row.hasChip), order.map(() => true));
      equal(`each ${kindName} chip prints the published change`,
        rows.map((row) => [row.party, row.chipValue]),
        order.map((name) => [label(name), inlineDeltaValue(published[name], kind)]));
      equal(`each ${kindName} chip carries the matching direction`,
        rows.map((row) => row.chipDirection),
        order.map((name) => deltaDirection(published[name], kind)));
      // Why not a parenthesised number: at this precision the unmoved rows
      // round to a signed zero, which would read as a measurement rather than
      // as "below what this publication can resolve".
      const flatRows = rows.filter((row) => row.chipDirection === 'flat');
      check(`a sub-threshold ${kindName} change is a glyph, never a signed zero`,
        flatRows.length > 0 &&
        flatRows.every((row) => row.chipValue === '' && row.chipGlyph === '·'),
        flatRows.map((row) => [row.party, row.chipValue, row.chipGlyph]));
      check(`the ${kindName} rows that moved print a signed number`,
        rows.filter((row) => row.chipDirection !== 'flat')
          .every((row) => new RegExp(`^[+-]\\d+${kind.digits ? ',\\d' : ''}$`).test(row.chipValue)),
        rows.map((row) => [row.party, row.chipValue]));

      // Each row carries its own aria-label, so nothing inside it is
      // announced. The chip is decorative and the change is spoken there,
      // with the unit written out.
      equal(`the ${kindName} chip is decorative`,
        rows.map((row) => row.chipHidden), rows.map(() => 'true'));
      check(`every ${kindName} row speaks its change with the unit in full`,
        rows.every((row, index) =>
          row.label.includes(inlineDeltaSpoken(published[order[index]], kind))),
        rows.map((row) => row.label));
      check(`no ${kindName} chip prints the unit it cannot fit`,
        rows.every((row) => !row.chipValue.includes(kind.unit)));

      // .ev-head, .es-row, .ev-axis and .es-axis are sized from one
      // --ev-cols, so the chip shares the median cell rather than widening it.
      check(`the ${kindName} chip stacks under the median on wide screens`,
        rows.every((row) => row.stacked === true && row.chipDisplay === 'flex'),
        rows.map((row) => [row.party, row.stacked, row.chipDisplay]));
      check(`the ${kindName} chip costs its row no height`,
        chipCostsNoHeight(rows) === true,
        rows.map((row) => [row.party, row.chipDirection, row.rowHeight]));
    }

    // Övr. is aggregate vote mass for parties modelled as ineligible. It has a
    // published vote change and no seat median at all -- and because the seat
    // contract's own party_order omits it, there is no seat row to explain.
    check('Övr. shows its vote change', page.voteRows.some((row) =>
      row.party === 'Övr.' && row.chipValue ===
      inlineDeltaValue(forecast.change_since_prior.vote_share_median_change_pp.REST)),
      page.voteRows.map((row) => [row.party, row.chipValue]));
    check('Övr. has no seat row to claim a seat change in',
      page.seatRows.every((row) => row.party !== 'Övr.') &&
      forecast.change_since_prior.seat_median_change.REST === undefined,
      page.seatRows.map((row) => row.party));

    // --- preserved behaviour ---
    check('the load status is still a polite status region',
      page.liveRegions.includes('election-app-status:polite:status'), page.liveRegions);
    check('the cross-view selection note is still a polite status region',
      page.liveRegions.includes('election-selection-note:polite:status'), page.liveRegions);
    check('the timestamp line and the captions introduced no live regions',
      page.liveRegions.filter((entry) =>
        /^election-(hero|vote-change|seat-change)/.test(entry)).length === 0,
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
  const seatOrder =
    (await readJson(SITE, VERSIONS, UNRESOLVABLE_GENERATION, 'seats.json')).party_order;
  const baseline = await resolveBaseline(UNRESOLVABLE_GENERATION);
  check('the pinned baseline is genuinely not shipped', baseline.generation === null,
    baseline.generation);

  const { server, browser } =
    await open(DESKTOP, await pointerFor(SITE, UNRESOLVABLE_GENERATION));
  try {
    await assertServedGeneration(browser, UNRESOLVABLE_GENERATION);
    const page = await readProvenance(browser);
    equal('both captions degrade to the published baseline date',
      [page.voteNoteText, page.seatNoteText],
      [changeNote(baseline, 'i procentenheter'), changeNote(baseline, 'i mandat')]);
    equal('the documented fallback is the published prior_as_of',
      baselineLabel(baseline), 'prognosen 23 aug 2026');
    check('an unresolvable baseline invents no time',
      !/\d{1,2}:\d{2}/.test(page.voteNoteText + page.seatNoteText),
      [page.voteNoteText, page.seatNoteText]);
    check('an unresolvable baseline still avoids the ordering claim',
      !page.voteNoteText.includes('föregående') &&
      !page.seatNoteText.includes('föregående'), page.voteNoteText);

    // The chips are never the casualty of a label that could not be resolved:
    // they come straight from the payload.
    equal('the vote chips use this generation\'s own published changes',
      page.voteRows.map((row) => row.chipValue),
      Object.keys(forecast.change_since_prior.vote_share_median_change_pp)
        .map((name) => inlineDeltaValue(
          forecast.change_since_prior.vote_share_median_change_pp[name])));
    equal('the seat chips use this generation\'s own published changes',
      page.seatRows.map((row) => row.chipValue),
      seatOrder.map((name) => inlineDeltaValue(
        forecast.change_since_prior.seat_median_change[name], SEAT)));
    // This generation moved two seat medians, so the fallback run also proves
    // a signed seat chip renders, not only the flat glyph.
    check('a moved seat median still prints a signed number',
      page.seatRows.filter((row) => row.chipDirection !== 'flat').length > 0,
      page.seatRows.map((row) => [row.party, row.chipValue]));
    check('non-additivity is still stated with the seat column',
      page.seatsIntro.endsWith(SEATS_NON_ADDITIVITY), page.seatsIntro);
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
  const forecast = await readJson(SITE, VERSIONS, TARGET_GENERATION, 'forecast.json');
  const seatOrder = (await readJson(SITE, VERSIONS, TARGET_GENERATION, 'seats.json')).party_order;
  const { server, browser } = await open(MOBILE, await pointerFor(SITE, TARGET_GENERATION));
  try {
    const page = await readProvenance(browser);
    equal('the timestamp line survives the narrow layout', page.updatedHidden, false);
    check('the timestamp line is painted on mobile',
      page.updatedDisplay !== 'none', page.updatedDisplay);
    equal('both captions name the baseline on mobile too',
      [page.voteNoteText, page.seatNoteText],
      [changeNote(baseline, 'i procentenheter'), changeNote(baseline, 'i mandat')]);

    // The narrow layout gives the median a flexible column, so the chip fits
    // on its line -- which is where it belongs when vertical space, not
    // horizontal, is the scarce thing.
    for (const [kindName, rows] of [['vote', page.voteRows], ['seat', page.seatRows]]) {
      check(`the ${kindName} chip sits beside the median on narrow screens`,
        rows.every((row) => row.stacked === false && row.chipDisplay === 'inline-flex'),
        rows.map((row) => [row.party, row.stacked, row.chipDisplay]));
      check(`the ${kindName} chip still costs its row no height`,
        chipCostsNoHeight(rows) === true,
        rows.map((row) => [row.party, row.chipDirection, row.rowHeight]));
    }
    equal('the mobile chips print the same published changes',
      [page.voteRows.map((row) => row.chipValue), page.seatRows.map((row) => row.chipValue)],
      [Object.keys(forecast.change_since_prior.vote_share_median_change_pp)
        .map((name) => inlineDeltaValue(
          forecast.change_since_prior.vote_share_median_change_pp[name])),
      seatOrder.map((name) => inlineDeltaValue(
        forecast.change_since_prior.seat_median_change[name], SEAT))]);
    check('the mobile page has no horizontal overflow', page.overflow <= 0, page.overflow);
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
  const seatOpacity = await readFile(
    new URL('../assets/js/election-seat-opacity.js', import.meta.url), 'utf8');
  check('the conversion goes through the zone database, not a fixed offset',
    source.includes('"Europe/Stockholm"') && !/\+0?2:00|utcOffset|\+ 2 \* 3600/.test(source));
  check('the baseline is verified by payload hash before it is believed',
    source.includes('manifest.deterministic_payload_sha256 !== expected'));
  check('one noise-floor rule and one chip renderer serve both row kinds',
    (source.match(/function deltaShape/g) || []).length === 1 &&
    (source.match(/function inlineDelta\b/g) || []).length === 1 &&
    source.includes('inlineDelta(voteChange[name], 0.05, 1)') &&
    source.includes('inlineDelta(seatChange[name], 0.5, 0)'));
  check('the chips are gated on the payload having a baseline at all',
    (source.match(/change\.status === "AVAILABLE"/g) || []).length === 2 &&
    source.includes('? (change.vote_share_median_change_pp || {}) : {}') &&
    source.includes('? (change.seat_median_change || {}) : {}'));
  check('the change table left nothing behind',
    !/renderChanges|deltaCell|ec-table|ec-delta/.test(source));
  check('the hero reads the publication instant, not the input date',
    source.includes('var generatedAt = metadata.generated_at_utc ||'));
  check('no reader-facing copy asserts the previous forecast',
    !page.includes('föregående prognos') && !source.includes('f\\u00f6reg\\u00e5ende prognos'));
  check('the generation list is enumerated at build time, not written by hand',
    page.includes('site.static_files') && !/2026\d{4}T\d{6}Z/.test(page));
  check('the seats intro is addressed by id, not by query order',
    source.includes('getElementById("election-seats-intro")') ||
    seatOpacity.includes('getElementById("election-seats-intro")'));
  check('the change section is gone from the markup and the nav',
    !page.includes('election-changes') && !seatOpacity.includes('election-changes'));
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
