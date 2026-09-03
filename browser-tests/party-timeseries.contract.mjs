// Static source contract for the per-party view of "Vägen till valdagen".
//
// The companion real-browser test (party-timeseries.smoke.mjs) proves the view
// renders and responds. This file proves the *rules* are present in the
// deployed source, so a refactor cannot quietly drop a fail-closed check or
// start deriving party uncertainty in JavaScript and still pass a happy-path
// smoke test. It also validates the committed fixture.
//
// Runs without a browser.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(HERE, '..', 'assets', 'js', 'election-simulator.js'), 'utf8');
const page = await readFile(join(HERE, '..', '_pages', 'election_simulator.md'), 'utf8');
const styles = await readFile(join(HERE, '..', '_sass', 'custom.scss'), 'utf8');
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'coalition-timeseries.json'), 'utf8'));

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const QUANTILES = ['p05', 'p25', 'p50', 'p75', 'p95'];

const view = fixture.parties_view;
const series = Array.isArray(fixture.series) ? fixture.series : [];
const current = series.filter((point) => point?.provenance === 'current_production');
const paths = fixture.future_campaign_paths;

// The control order the product requires: what the chart is about, then how it
// is measured, then over what period, then which party.
const controlOrder = [
  'election-timeseries-view',
  'election-timeseries-vote',
  'election-timeseries-range',
  'election-timeseries-parties',
].map((id) => page.indexOf(id));

function ordered(values) {
  return values.every((value, index) => typeof value === 'number' && Number.isFinite(value) &&
    (index === 0 || value >= values[index - 1]));
}

function quantilesOk(entry) {
  return Boolean(entry) && Object.keys(entry).length === QUANTILES.length &&
    ordered(QUANTILES.map((key) => entry[key]));
}

const checks = [
  // ---- the party family is read, never derived ---------------------------
  ['the consumer reads the published party family',
    source.includes('payload.parties_view') && source.includes('historyPartyDefinitions')],
  ['party uncertainty is never reconstructed from coalition data',
    source.includes('parity.reconstructed_from_coalitions !== false')],
  ['the nine-category party denominator is required',
    source.includes('PARTY_VOTE_DENOMINATOR') &&
    source.includes('all_nine_model_categories_including_rest') &&
    source.includes('view.vote_share_denominator !== PARTY_VOTE_DENOMINATOR')],
  ['REST is never offered as a followable party',
    source.includes('view.rest_is_a_party !== false')],
  ['the published party order is pinned to the eight parliamentary parties',
    source.includes('view.party_order.length !== HISTORY_PARTIES.length')],
  ['a declared intermediate seat trajectory disables the party family',
    source.includes('view.intermediate_seat_trajectory !== false') &&
    source.includes('rendering.party_intermediate_seat_trajectory !== false')],
  ['party election-day values must equal the certified production point',
    source.includes('JSON.stringify(electionParties) !== JSON.stringify(certifiedParties)')],
  ['the party family is all-or-nothing, so a partial publication is refused',
    source.includes('mergeCampaignPartyFamily') &&
    source.includes('campaignPaths.partyFamily === true')],
  ['party mode needs a certified point that carries party summaries',
    source.includes('certifiedPoints.length > 0')],
  ['party opinion bands are vote-only',
    source.includes('campaignBandParties') &&
    source.includes('!Object.prototype.hasOwnProperty.call(entry, "vote")') &&
    source.includes('rendering.party_units')],

  // ---- one renderer, not two --------------------------------------------
  ['there is no second chart renderer',
    (source.match(/function renderForecastHistory\(/g) || []).length === 1 &&
    !/function renderPartyHistory\(/.test(source) &&
    !/function renderPartyChart\(/.test(source)],
  ['both families share one definition namespace',
    source.includes('definition.kind === "party"') &&
    source.includes('var allDefinitions = partyDefinitions ? definitions.concat(partyDefinitions) : definitions;')],
  ['both families share one time domain and one value domain',
    source.includes('activeDomain = activeTimeDomain()') &&
    source.includes('historyValueDomain(history, selectedMetric, definitions, activeDomain)')],
  ['no companion party renderer is loaded',
    !(await readFile(join(HERE, '..', '_includes', 'head', 'custom.html'), 'utf8'))
      .includes('election-party-timeseries.js')],

  // ---- observation denominators ------------------------------------------
  ['a party poll value is the published number, not a renormalization',
    source.includes('function definitionObservation') &&
    /if \(definition\.kind === "party"\) \{\s*var value = parties\[definition\.id\];/.test(source)],
  ['coalitions keep their eight-party denominator',
    source.includes('return 100 * total / denominator;')],

  // ---- the adaptive domain and the threshold -----------------------------
  ['the party domain is its own rule, without the coalition 50 % anchor',
    source.includes('function historyPartyValueDomain') &&
    source.includes('domain.viewMode === "parties"')],
  ['party mode declares its adaptive domain in the DOM',
    source.includes('adaptive-party-window')],
  ['the threshold is drawn only when the visible domain contains it',
    source.includes('thresholdVisible') &&
    source.includes('yDomain.thresholdVisible') &&
    source.includes('thresholdPct >= domain.min && thresholdPct <= domain.max')],
  ['the threshold nudge is bounded, so the scale is not distorted to reach it',
    source.includes('var reach = Math.max(0.25, dataSpan * 0.15);')],
  ['the tick ladder is shared and derived from the domain',
    source.includes('function historyTickStep') &&
    source.includes('var yStep = yDomain.step;')],

  // ---- the future interpretation in party mode ---------------------------
  ['the secondary uncertainty fan is hidden in party mode',
    source.includes('viewMode === "parties"') &&
    source.includes('selectedMetric === "seats" || viewMode === "parties"')],
  ['entering party mode returns the future region to the campaign paths',
    source.includes('if (viewMode === "parties" && campaignPaths) futureView = "paths";')],

  // ---- markup, order and direct navigation -------------------------------
  ['the view switch is in the page markup with both labels',
    page.includes('id="election-timeseries-view"') &&
    />Koalitioner</.test(page) && />Partier</.test(page)],
  ['Koalitioner is the pressed default in the markup',
    /id="election-timeseries-view-coalitions"[^>]*aria-pressed="true"/.test(page) &&
    /id="election-timeseries-view-parties"[^>]*aria-pressed="false"/.test(page)],
  ['the view switch is the first control dimension',
    controlOrder.every((position, index) => position >= 0 &&
      (index === 0 || position > controlOrder[index - 1]))],
  ['the party selector is a labelled group that starts hidden',
    /id="election-timeseries-parties"[^>]*aria-label="Välj parti"/.test(page) &&
    /id="election-timeseries-parties"[^>]*hidden/.test(page)],
  ['the party denominator note exists and starts hidden',
    page.includes('id="election-timeseries-party-note"') &&
    /valmanskåren/.test(page)],
  ['the coalition note now says it is about coalitions',
    /Koalitionernas röstandelar beräknas över de åtta riksdagspartierna/.test(page)],
  ['the party denominator note is the only one that appears, and only in party mode',
    source.includes('partyNote.hidden = !parties')],
  ['the direct-navigation action exists and routes into the timeline',
    source.includes('data-party-timeline') && source.includes('Visa utveckling') &&
    source.includes('showPartyTimeline')],
  ['direct navigation scrolls, switches mode, selects and moves focus',
    /showPartyTimeline = function \(party\) \{[\s\S]*?selectTimeseriesParty\(party[\s\S]*?setViewMode\("parties"[\s\S]*?scrollIntoView[\s\S]*?\.focus\(/.test(source)],
  ['the action stays hidden until the artifact publishes the party family',
    source.includes('enablePartyTimelineLinks') && source.includes('partyTimelineIsAvailable')],

  // ---- accessibility ------------------------------------------------------
  ['exactly one party is active at a time',
    source.includes('function activePartyDefinition') &&
    source.includes('return definition ? [definition] : [];')],
  ['selecting a party can never clear the selection',
    !/selectedPartyId = selectedPartyId === /.test(source)],
  ['the party pills carry their abbreviation, so colour is not the sole encoding',
    source.includes('escapeHtml(definition.shortLabel)')],
  ['party pills inherit the app focus ring',
    styles.includes(':focus-visible') && styles.includes('.election-timeseries__party-button')],
  ['the disabled state of the party switch is visible, not only semantic',
    styles.includes('.election-timeseries__view-button[disabled]')],
  ['the suite is registered with the CI selector',
    (await readFile(join(HERE, 'select-suites.mjs'), 'utf8'))
      .includes("'party-timeseries.contract.mjs':")],

  // ---- the fixture the smoke test consumes -------------------------------
  ['fixture declares the party family',
    view?.schema_version === '1.0' && view?.role === 'party_time_series' &&
    view?.vote_share_denominator === 'all_nine_model_categories_including_rest' &&
    view?.vote_share_definition === 'national_vote_share' &&
    view?.seat_definition === 'statutory_mandate_allocation' &&
    view?.rest_is_a_party === false && view?.intermediate_seat_trajectory === false &&
    view?.national_threshold_pct === 4 &&
    view?.election_day_parity?.reconstructed_from_coalitions === false],
  ['fixture names all eight parties in order, and no ninth',
    JSON.stringify(view?.party_order) === JSON.stringify(PARTY_ORDER) &&
    JSON.stringify(Object.keys(view?.party_names_sv || {})) === JSON.stringify(PARTY_ORDER)],
  ['fixture series points carry full party vote and seat quantiles',
    series.filter((point) => point.parties).length > 0 &&
    series.filter((point) => point.parties).every((point) =>
      JSON.stringify(Object.keys(point.parties)) === JSON.stringify(PARTY_ORDER) &&
      PARTY_ORDER.every((party) =>
        quantilesOk(point.parties[party]?.vote) && quantilesOk(point.parties[party]?.seats) &&
        QUANTILES.every((key) => Number.isInteger(point.parties[party].seats[key]))))],
  ['fixture certified point carries party summaries',
    current.length === 1 && Boolean(current[0].parties)],
  ['fixture party shares are the electorate share, not renormalized',
    // The eight parliamentary medians must fall short of 100: the remainder is
    // the REST mass. A renormalized set would sit at or above it.
    current.length === 1 &&
    PARTY_ORDER.reduce((sum, party) => sum + current[0].parties[party].vote.p50, 0) < 100],
  ['fixture election-day parties equal the certified point exactly',
    current.length === 1 &&
    JSON.stringify(paths?.election_day?.parties) === JSON.stringify(current[0].parties)],
  ['fixture party keys never leak into the coalition groups',
    series.every((point) => PARTY_ORDER.every((party) => !(party in (point.groups || {})))) &&
    (paths?.bands || []).every((band) =>
      PARTY_ORDER.every((party) => !(party in (band.groups || {})))) &&
    PARTY_ORDER.every((party) => !(party in (paths?.election_day?.groups || {})))],
  ['fixture party bands are daily, vote-only and monotone',
    Array.isArray(paths?.bands) && paths.bands.length === paths.path_days + 1 &&
    paths.bands.every((band, index) => band.path_day === index &&
      JSON.stringify(Object.keys(band.parties || {})) === JSON.stringify(PARTY_ORDER) &&
      PARTY_ORDER.every((party) => {
        const entry = band.parties[party];
        return Object.keys(entry).length === 1 && quantilesOk(entry.vote);
      }))],
  ['fixture party trajectories match the coalition trajectories draw for draw',
    (paths?.paths?.series || []).length > 0 &&
    paths.paths.series.every((track) =>
      JSON.stringify(Object.keys(track.party_values || {})) === JSON.stringify(PARTY_ORDER) &&
      PARTY_ORDER.every((party) => track.party_values[party].length === paths.path_days + 1))],
  ['fixture publishes no intermediate party mandate trajectory',
    paths?.rendering?.party_units?.length === 1 && paths.rendering.party_units[0] === 'vote' &&
    paths.rendering.party_intermediate_seat_trajectory === false &&
    JSON.stringify(paths.rendering.party_election_day_units) === JSON.stringify(['vote', 'seats'])],
  ['fixture declares the party denominator in the construction',
    paths?.path_construction?.party_vote_share_denominator ===
      'all_nine_model_categories_including_rest'],
  ['fixture publishes the national threshold for the party view',
    paths?.rendering?.national_threshold_pct === 4 &&
    typeof paths?.rendering?.national_threshold_label_sv === 'string' &&
    paths.rendering.national_threshold_label_sv.length > 0],
  ['fixture contains a party near the threshold and a large party',
    current.length === 1 &&
    PARTY_ORDER.some((party) => current[0].parties[party].vote.p50 < 6) &&
    PARTY_ORDER.some((party) => current[0].parties[party].vote.p50 > 15)],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`ok   ${label}`);
  else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

if (failed) process.exit(1);
console.log(`party time-series contract: ${checks.length} checks passed`);
