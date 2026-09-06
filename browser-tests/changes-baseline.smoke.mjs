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
// It also owns the hero's two freshness claims, which are two different
// clocks and used to be printed as if they were one. "Uppdaterad <instant>"
// sat directly under a fact labelled "Underlag t.o.m.", so a re-run on
// unchanged polling read as a fresh round of measurement -- and the countdown
// beside it was measured from the polling date, which on a stale-input
// generation did not reach the published election day at all.
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
// The live publication at the time of writing, and the case the freshness
// split was written for: `as_of` 2026-09-06 over a poll_data_hash it shares
// with the two publications before it, whose newest poll was published on
// 2026-09-04. Every date-based freshness test passes here and is still wrong.
const QUIET_RERUN_GENERATION = '20260906T081926Z-92521273';
// Its baseline snapshot predates the versioned publication directory, so it
// cannot be resolved to an instant. The label has to degrade to the published
// prior_as_of date instead of inventing one.
const UNRESOLVABLE_GENERATION = '20260831T170410Z-1f5e0506';
// A quiet re-run whose polling input is *not* the one the shipped history
// artifact describes: the note still has to fire, because it is answered from
// the frozen bundle alone, while the polling date cell has nothing verifiable
// to print. The two claims are independent and this pins that.
const QUIET_UNDATED_GENERATION = '20260904T082721Z-af776460';

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

// The Stockholm calendar day of a published instant. A late-evening UTC stamp
// is already the next day here, so the countdown expectation is built from the
// zone database too rather than from the ISO string's own date.
function stockholmDayIso(iso) {
  const fields = {};
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso.replace(/(\.\d{3})\d+/, '$1')))
    .forEach((part) => { if (part.type !== 'literal') fields[part.type] = part.value; });
  return `${fields.year}-${fields.month}-${fields.day}`;
}

const daysBetweenDays = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const countdownText = (days) => `${days} ${days === 1 ? 'dag' : 'dagar'}`;

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

// The publication this one immediately followed, among the generations the
// built site ships -- the same ordering the page establishes from its own
// build-time generation index, and a different question from the hash-named
// comparison baseline above.
async function precedingPublication(generation) {
  const earlier = (await shippedGenerations()).filter((name) => name < generation);
  if (!earlier.length) return null;
  const name = earlier[earlier.length - 1];
  return { generation: name, metadata: await readJson(SITE, VERSIONS, name, 'metadata.json') };
}

const freshnessNote = (preceding) =>
  `Inga nya mätningar sedan föregående prognos ` +
  `(${stockholmStamp(preceding.metadata.generated_at_utc)}). ` +
  'Omräkningen har kortare tid kvar till valdagen, men samma opinionsunderlag.';

const pollHash = (metadata) => metadata.input_hashes.poll_data_hash;

// The newest poll this forecast actually saw. The frozen bundle names its
// polling input by hash only, so the date comes from the history artifact --
// and only when that artifact carries this publication's own poll hash.
async function newestPollDay() {
  const history = await readJson(SITE, 'files/election-simulator/history',
    'coalition-timeseries.json');
  return {
    source: history.poll_source_sha256,
    newest: history.polls.map((poll) => poll.publication_date).sort().at(-1),
  };
}

const heroPollDay = (polling, metadata) =>
  polling.source === pollHash(metadata) ? swedishDay(polling.newest) : '—';

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

// The floor is stated in the caption, per section, from the same number the
// chip applies -- so a dot beside a median can be told from a median that
// genuinely did not move.
const FLOOR_LABEL = { 'i procentenheter': '0,05 procentenheter', 'i mandat': 'ett halvt mandat' };

const changeNote = (baseline, unit) =>
  `Efter varje median visas förändringen ${unit} jämfört med ${baselineLabel(baseline)}. ` +
  `En punkt betyder ingen tydlig förändring: mindre än ${FLOOR_LABEL[unit]}.`;

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
  const freshness = document.getElementById('election-hero-poll-freshness');

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
    heroFactLabels: Array.from(document.querySelectorAll('.election-hero__fact dt'))
      .map((node) => flat(node.textContent)),
    heroFactValueTops: Array.from(document.querySelectorAll('.election-hero__fact dd'))
      .map((node) => Math.round(node.getBoundingClientRect().top)),
    heroCountdown: text('#election-hero-countdown'),
    heroText: flat(document.getElementById('election-hero').textContent),
    lede: text('#election-hero-lede'),
    heroElection: text('#election-hero-election'),
    freshnessHidden: freshness ? freshness.hidden : null,
    freshnessDisplay: freshness ? getComputedStyle(freshness).display : null,
    freshnessText: freshness ? flat(freshness.textContent) : null,
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

  const preceding = await precedingPublication(TARGET_GENERATION);
  const polling = await newestPollDay();
  check('the pinned generation has a shipped predecessor', preceding !== null, preceding);

  const { server, browser } = await open(DESKTOP, await pointerFor(SITE, TARGET_GENERATION));
  try {
    await assertServedGeneration(browser, TARGET_GENERATION);
    const page = await readProvenance(browser);

    // --- the hero's publication instant ---
    equal('the hero prints the publication instant, not just its day',
      page.stamp, stockholmStamp(metadata.generated_at_utc));
    equal('the pinned generation publishes at the documented wall clock',
      stockholmStamp(metadata.generated_at_utc), '4 sep 13:08');
    // "beräknad", not "uppdaterad": a re-run is a new calculation, and calling
    // it an update is exactly what makes it read as new polling.
    equal('the line names the calculation, not an update',
      page.updatedText.startsWith(`Prognosen beräknad ${page.stamp}`), true);
    check('no hero copy calls the recalculation an update',
      !/Uppdaterad/.test(page.updatedText + (page.freshnessText || '')),
      page.updatedText);
    equal('the timestamp line is visible', page.updatedHidden, false);
    check('the timestamp line is painted, not just unhidden',
      page.updatedDisplay !== 'none', page.updatedDisplay);
    equal('the instant is machine-readable as published',
      page.stampDatetime, metadata.generated_at_utc);
    equal('the instant is marked up as a time', page.stampTag, 'TIME');
    check('the publication instant says more than the input date',
      page.stamp !== page.heroAsOf, { stamp: page.stamp, asOf: page.heroAsOf });
    equal('the polling fact is the newest poll this forecast saw',
      page.heroAsOf, heroPollDay(polling, metadata));
    check('the polling fact is not the forecast anchor day',
      polling.newest === forecast.as_of || page.heroAsOf !== swedishDay(forecast.as_of),
      { hero: page.heroAsOf, asOf: forecast.as_of, newestPoll: polling.newest });

    // --- the three concepts, each labelled as itself ---
    equal('the hero labels the polling input, the calculation and the election day',
      [page.heroFactLabels, page.updatedText.startsWith('Prognosen beräknad')],
      [['Senaste opinionsunderlag', 'Valdag', 'Dagar kvar'], true]);
    equal('the election day is the published one',
      page.heroElection, swedishDay(metadata.election_date));
    // The polling label is the long one and wraps to a second line in its
    // column; the values share a grid row so they do not follow it down.
    check('the three hero values sit on one baseline despite a wrapping label',
      new Set(page.heroFactValueTops).size === 1, page.heroFactValueTops);
    // Counted from the day the forecast was calculated, so the reader can add
    // it to the election date and land on the right day.
    equal('the countdown runs from the calculation day to the election day',
      page.heroCountdown,
      countdownText(daysBetweenDays(
        stockholmDayIso(metadata.generated_at_utc), metadata.election_date)));

    // --- polling freshness ---
    // This publication saw polling its predecessor had not, so there is
    // nothing to say and the note must stay silent. quietRerun() below owns
    // the other half.
    check('the pinned generation saw polling its predecessor had not',
      pollHash(preceding.metadata) !== pollHash(metadata),
      { hash: pollHash(metadata), preceding: pollHash(preceding.metadata) });
    equal('no "no new polls" claim is made when a new poll arrived',
      [page.freshnessHidden, page.freshnessText], [true, '']);
    check('the freshness note is not painted either',
      page.freshnessDisplay === 'none', page.freshnessDisplay);
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
  const metadata = await readJson(SITE, VERSIONS, UNRESOLVABLE_GENERATION, 'metadata.json');
  const seatOrder =
    (await readJson(SITE, VERSIONS, UNRESOLVABLE_GENERATION, 'seats.json')).party_order;
  const baseline = await resolveBaseline(UNRESOLVABLE_GENERATION);
  check('the pinned baseline is genuinely not shipped', baseline.generation === null,
    baseline.generation);

  // This is the generation the split was written for: calculated on 31 August
  // from polling that stops on 24 August. The two clocks are a week apart, so
  // every claim that conflates them is wrong here in a way a reader can see.
  const preceding = await precedingPublication(UNRESOLVABLE_GENERATION);
  const staleDays = daysBetweenDays(metadata.as_of, stockholmDayIso(metadata.generated_at_utc));
  // Calculated a week after its anchor day -- and its polling input changed
  // even though that anchor day did not, which is the mirror image of the
  // quiet re-run and the second reason a date cannot answer this question.
  check('the pinned generation was calculated well after its anchor day',
    preceding !== null && staleDays >= 5, { asOf: metadata.as_of, staleDays });
  check('its polling input changed while its anchor day stood still',
    preceding !== null && pollHash(preceding.metadata) !== pollHash(metadata) &&
    preceding.metadata.as_of === metadata.as_of,
    { asOf: metadata.as_of, hash: pollHash(metadata) });

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

    // --- the two clocks, a week apart ---
    equal('the hero still labels the polling input as polling',
      page.heroFactLabels, ['Senaste opinionsunderlag', 'Valdag', 'Dagar kvar']);
    // This generation's polling input is not the one the shipped history
    // artifact describes, so the cell has nothing verifiable to print.
    equal('an unverifiable polling input prints nothing rather than the anchor day',
      [page.heroAsOf, page.heroAsOf === swedishDay(metadata.as_of)], ['—', false]);
    equal('the calculation line is the calculation, days later',
      page.updatedText.startsWith(
        `Prognosen beräknad ${stockholmStamp(metadata.generated_at_utc)}`), true);
    // The regression: counted from `as_of`, this cell read "20 dagar" beside a
    // 13 September election day on a forecast calculated on 31 August.
    equal('the countdown reaches the published election day',
      page.heroCountdown, countdownText(daysBetweenDays(
        stockholmDayIso(metadata.generated_at_utc), metadata.election_date)));
    check('the countdown is not the stale count measured from the polling date',
      page.heroCountdown !== countdownText(
        daysBetweenDays(metadata.as_of, metadata.election_date)),
      page.heroCountdown);
    equal('a changed polling input makes no "no new polls" claim',
      [page.freshnessHidden, page.freshnessText], [true, '']);

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

// The case a date-based freshness rule gets wrong, and the reason the rule is
// the poll hash. `as_of` advances 4 -> 5 -> 6 September across three
// publications whose `poll_data_hash` never changes, over a newest poll
// published on 4 September. So the anchor day must not reach the hero, the
// polling cell must show the poll date, and the note must fire.
async function quietRerun() {
  console.log(`\nquiet re-run (${QUIET_RERUN_GENERATION})`);
  const metadata = await readJson(SITE, VERSIONS, QUIET_RERUN_GENERATION, 'metadata.json');
  const preceding = await precedingPublication(QUIET_RERUN_GENERATION);
  const polling = await newestPollDay();

  check('the pinned generation is a re-run on unchanged polling',
    preceding !== null && pollHash(preceding.metadata) === pollHash(metadata),
    { hash: pollHash(metadata), preceding: preceding && pollHash(preceding.metadata) });
  check('its anchor day has moved past the newest poll it saw',
    polling.source === pollHash(metadata) && metadata.as_of > polling.newest,
    { asOf: metadata.as_of, newestPoll: polling.newest });

  const { server, browser } =
    await open(DESKTOP, await pointerFor(SITE, QUIET_RERUN_GENERATION));
  try {
    await assertServedGeneration(browser, QUIET_RERUN_GENERATION);
    const page = await readProvenance(browser);
    equal('the polling cell is the newest poll, not the anchor day',
      page.heroAsOf, swedishDay(polling.newest));
    check('the anchor day appears nowhere in the hero',
      !page.heroText.includes(swedishDay(metadata.as_of)),
      { asOf: swedishDay(metadata.as_of), hero: page.heroText });
    check('the lede cites the newest poll, not the anchor day',
      page.lede.includes(`opinionsunderlag till och med ${swedishDay(polling.newest)}`) &&
      !page.lede.includes(swedishDay(metadata.as_of)), page.lede);
    equal('a re-run on unchanged polling says so',
      page.freshnessText, freshnessNote(preceding));
    equal('the freshness note is visible', page.freshnessHidden, false);
    check('the freshness note is painted, not just unhidden',
      page.freshnessDisplay !== 'none', page.freshnessDisplay);
    // The only instant in the note is the predecessor's. It is free to
    // coincide with the comparison baseline -- here it does -- but it is
    // resolved from the generation index, not from change_since_prior.
    equal('the note carries exactly one instant, the predecessor\'s',
      page.freshnessText.match(/\d{1,2}:\d{2}/g),
      [stockholmStamp(preceding.metadata.generated_at_utc).split(' ').at(-1)]);
    equal('the countdown runs from the calculation day',
      page.heroCountdown, countdownText(daysBetweenDays(
        stockholmDayIso(metadata.generated_at_utc), metadata.election_date)));
    equal('the quiet re-run has no console errors', appErrors(browser), []);
    equal('the quiet re-run has no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }

  // The note is three lines of muted mono and lands directly above the lede,
  // which is where a narrow layout would push it into the page's own width.
  const narrow = await open(MOBILE, await pointerFor(SITE, QUIET_RERUN_GENERATION));
  try {
    const page = await readProvenance(narrow.browser);
    equal('the freshness note survives the narrow layout',
      [page.freshnessHidden, page.freshnessText], [false, freshnessNote(preceding)]);
    check('the freshness note is painted on mobile',
      page.freshnessDisplay !== 'none', page.freshnessDisplay);
    check('the narrow layout still has no horizontal overflow',
      page.overflow <= 0, page.overflow);
    equal('the narrow quiet re-run has no console errors', appErrors(narrow.browser), []);
  } finally {
    await narrow.browser.close();
    await narrow.server.close();
  }
}

// The two claims are answered from different places and must not be wired
// together: the note comes from the frozen bundle's own poll hash, the polling
// date from the history artifact. Here the first fires and the second cannot,
// so a implementation that gated one on the other fails exactly here.
async function quietRerunUndated() {
  console.log(`\nquiet re-run, unverifiable poll date (${QUIET_UNDATED_GENERATION})`);
  const metadata = await readJson(SITE, VERSIONS, QUIET_UNDATED_GENERATION, 'metadata.json');
  const preceding = await precedingPublication(QUIET_UNDATED_GENERATION);
  const polling = await newestPollDay();
  check('the pinned generation is a re-run on unchanged polling',
    preceding !== null && pollHash(preceding.metadata) === pollHash(metadata),
    { hash: pollHash(metadata), preceding: preceding && pollHash(preceding.metadata) });
  check('the shipped history artifact describes a different polling input',
    polling.source !== pollHash(metadata),
    { history: polling.source, publication: pollHash(metadata) });

  const { server, browser } =
    await open(DESKTOP, await pointerFor(SITE, QUIET_UNDATED_GENERATION));
  try {
    await assertServedGeneration(browser, QUIET_UNDATED_GENERATION);
    const page = await readProvenance(browser);
    equal('the note still fires, from the frozen bundle alone',
      page.freshnessText, freshnessNote(preceding));
    equal('the polling cell prints nothing it cannot verify', page.heroAsOf, '—');
    check('and the lede makes no dated claim either',
      !/till och med/.test(page.lede) && page.lede.includes('det publicerade opinionsunderlaget'),
      page.lede);
    check('no unverified date leaks in from the history artifact',
      !page.heroText.includes(swedishDay(polling.newest)),
      { newest: swedishDay(polling.newest), hero: page.heroText });
    equal('this run has no console errors', appErrors(browser), []);
    equal('this run has no uncaught exceptions', browser.exceptions, []);
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
  const head = await readFile(
    new URL('../_includes/head/custom.html', import.meta.url), 'utf8');
  check('the conversion goes through the zone database, not a fixed offset',
    source.includes('"Europe/Stockholm"') && !/\+0?2:00|utcOffset|\+ 2 \* 3600/.test(source));
  check('the baseline is verified by payload hash before it is believed',
    source.includes('manifest.deterministic_payload_sha256 !== expected'));
  check('one noise-floor rule and one chip renderer serve both row kinds',
    (source.match(/function deltaShape/g) || []).length === 1 &&
    (source.match(/function inlineDelta\b/g) || []).length === 1 &&
    source.includes('inlineDelta(voteChange[name], VOTE_CHANGE.floor, VOTE_CHANGE.digits)') &&
    source.includes('inlineDelta(seatChange[name], SEAT_CHANGE.floor, SEAT_CHANGE.digits)'));
  // The floor the caption states and the floor the chip applies are one
  // number, so the sentence cannot drift from the rule it describes.
  check('each section states the floor its own chip applies',
    /VOTE_CHANGE = \{[\s\S]{0,200}?floor: 0\.05,[\s\S]{0,200}?floorLabel: "0,05 procentenheter"/.test(source) &&
    /SEAT_CHANGE = \{[\s\S]{0,200}?floor: 0\.5,[\s\S]{0,200}?floorLabel: "ett halvt mandat"/.test(source) &&
    source.includes('kind.floorLabel'));
  check('the chips are gated on the payload having a baseline at all',
    (source.match(/change\.status === "AVAILABLE"/g) || []).length === 2 &&
    source.includes('? (change.vote_share_median_change_pp || {}) : {}') &&
    source.includes('? (change.seat_median_change || {}) : {}'));
  check('the change table left nothing behind',
    !/renderChanges|deltaCell|ec-table|ec-delta/.test(source));
  check('the hero reads the publication instant, not the input date',
    source.includes('var generatedAt = metadata.generated_at_utc ||'));
  // The captions name a baseline identified by payload hash, which is not
  // reliably the publication that came before. They may name an instant or a
  // date, never a position.
  check('the baseline label claims no ordering it cannot establish',
    /function priorLabel[\s\S]{0,400}?\n  }/.test(source) &&
    !/function priorLabel[\s\S]{0,400}?f\\u00f6reg\\u00e5ende/.test(source));
  // The one place the page may say "föregående prognos" is the freshness note,
  // where the predecessor comes from the build-time generation index and is
  // believed only when the fetched metadata matches the directory it came from.
  check('the only "previous forecast" claim is the verified predecessor',
    (source.match(/f\\u00f6reg\\u00e5ende prognos/g) || []).length === 1 &&
    source.includes('compactInstant(metadata.generated_at_utc) !== generationInstant(generation)') &&
    !page.includes('föregående prognos'));
  // The identity of the polling input, not a date: `as_of` advances on a
  // re-run that saw no new poll, so a date-based rule stays silent exactly
  // when the note is needed.
  check('the freshness note is gated on the polling input hash, not a date',
    source.includes('pollDataHash(preceding) !== hash') &&
    !/renderPollFreshness[\s\S]{0,600}?as_of/.test(source));
  // The anchor day is never a fallback for the polling cell: falling back to
  // it would restore the overclaim the cell exists to remove.
  check('the polling cell is the verified newest poll, never the anchor day',
    source.includes('pollingInput.historySource !== pollingInput.pollHash') &&
    !/function renderPollingInput[\s\S]{0,700}?asOf/.test(source));
  check('the anchor day is named as an anchor where it is still shown',
    source.includes('["Prognosens ankardatum", metadata.as_of'));
  // The DOM patcher that used to rewrite these labels after the fact, racing
  // the renderer through a MutationObserver and reaching only the vote
  // caption, is gone -- its three intents live in the renderer now.
  check('no after-the-fact copy patcher remains',
    !head.includes('election-publication-copy'));
  check('the countdown is anchored on the calculation day, not the polling date',
    source.includes('(generatedStamp && generatedStamp.day) || asOf, electionDate') &&
    !/daysBetween\(asOf, electionDate\)/.test(source));
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
await quietRerun();
await unresolvable();
await quietRerunUndated();
await mobile();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('FAIL');
  process.exit(1);
}
console.log(`PASS (${[TARGET_GENERATION, QUIET_RERUN_GENERATION,
  UNRESOLVABLE_GENERATION, QUIET_UNDATED_GENERATION].join(', ')})`);
