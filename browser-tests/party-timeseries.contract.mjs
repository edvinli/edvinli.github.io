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
const smoke = await readFile(join(HERE, 'party-timeseries.smoke.mjs'), 'utf8');
// The real-artifact reader must be written without any knowledge of the
// fixtures directory. Sliced out so the fixture-mode helper above it cannot
// satisfy the check by accident.
const realArtifactReader = smoke.slice(
  smoke.indexOf('async function readSiteHistory'),
  smoke.indexOf('function orderedNumbers'),
);

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const QUANTILES = ['p05', 'p25', 'p50', 'p75', 'p95'];

const view = fixture.parties_view;
const series = Array.isArray(fixture.series) ? fixture.series : [];
const current = series.filter((point) => point?.provenance === 'current_production');

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
    source.includes('view.intermediate_seat_trajectory !== false')],
  ['party mode needs a certified point that carries party summaries',
    source.includes('certifiedPoints.length > 0')],
  // The publisher preserves reused history points byte for byte, so an
  // incremental publication produces a certified point with party data and
  // reconstructed points without it. Non-empty coverage is not enough.
  ['party mode needs the whole plotted history, not merely one point',
    source.includes('pointsWithParties.length === points.length') &&
    !source.includes('pointsWithParties.length > 0')],
  ['the refusal names its own reason in the DOM',
    source.includes('"incomplete-history"') && source.includes('"invalid"') &&
    source.includes('"absent"')],

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
  // max(0.25 pp, 15% of the visible span) -- not a strict 15% bound: the
  // 0.25 pp floor is what keeps the reach usable when a party's visible span
  // is itself under two points.
  ['the threshold nudge is bounded at max(0.25 pp, 15% of span)',
    source.includes('var reach = Math.max(0.25, dataSpan * 0.15);')],
  ['the 175-seat majority rule is coalition-only',
    source.includes('selectedMetric === "seats" && viewMode !== "parties"')],
  ['the tick ladder is shared and derived from the domain',
    source.includes('function historyTickStep') &&
    source.includes('var yStep = yDomain.step;')],

  // ---- the chart ends at the latest certified forecast -------------------
  // The page no longer extrapolates from today to election day, so no future
  // artifact may be read back into the chart and no forward view control may
  // reappear in the markup.
  ['no forward-looking artifact is read',
    !source.includes('payload.future_projection') &&
    !source.includes('payload.future_campaign_paths')],
  ['no forward view controls remain in the markup',
    !page.includes('election-timeseries-future') &&
    !page.includes('election-timeseries-campaign-cue')],
  ['the time domain ends at the latest published point',
    source.includes('var fullMaxTime = Math.max.apply(Math, fullTimes);') &&
    !/futureElection/.test(source)],

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
  ['the party denominator note appears only in party mode, and only for votes',
    source.includes('partyNote.hidden = !(parties && selectedMetric === "vote")')],
  ['the direct-navigation action exists and routes into the timeline',
    source.includes('data-party-timeline') && source.includes('Visa utveckling') &&
    source.includes('showPartyTimeline')],
  ['direct navigation scrolls, switches mode, selects and moves focus',
    /showPartyTimeline = function \(party\) \{[\s\S]*?selectTimeseriesParty\(party[\s\S]*?setViewMode\("parties"[\s\S]*?scrollIntoView[\s\S]*?\.focus\(/.test(source)],
  // The action comes from a vote-share section, so it must land on Röstandel
  // rather than on whatever metric the timeline was left on.
  ['direct navigation forces the vote view and leaves the range alone',
    /showPartyTimeline = function \(party\) \{[\s\S]*?selectedMetric = "vote";[\s\S]*?setViewMode\("parties"/.test(source) &&
    !/showPartyTimeline = function \(party\) \{[\s\S]*?selectedRange =/.test(source)],
  ['the action stays hidden until the artifact publishes the party family',
    source.includes('enablePartyTimelineLinks') && source.includes('partyTimelineIsAvailable')],

  // ---- accessibility ------------------------------------------------------
  // Party mode is a toggle set, exactly like coalition mode: one selection
  // map, one filter, and the shared value domain derives the y-axis from
  // whatever is on. A second selection model would be how the two families
  // start drifting apart.
  ['parties are a toggle set, not a single selection',
    source.includes('function activePartyDefinitions') &&
    source.includes('return partyDefinitions.filter(function (definition) {') &&
    !source.includes('selectedPartyId')],
  ['the y-axis is derived from the selected set',
    source.includes('if (viewMode === "parties") return activePartyDefinitions();') &&
    source.includes('historyValueDomain(history, selectedMetric, definitions, activeDomain)')],
  ['the direct-navigation action isolates the party it came from',
    /function selectTimeseriesParty[\s\S]*?selectedParties\[definition\.id\] = definition\.id === match\[0\]\.id;/
      .test(source)],
  // The hover readout is on the chart, at the crosshair, and the panel it
  // replaced must not come back.
  ['hovering prints one median per visible series at the crosshair',
    source.includes('data-crosshair-label') &&
    source.includes('election-timeseries__crosshair-label') &&
    !source.includes('function forecastDetail') &&
    !page.includes('election-timeseries-detail-body')],
  ['the readout stays announced for screen readers',
    /id="election-timeseries-status"[^>]*class="visually-hidden"/.test(page) &&
    source.includes('liveStatus.textContent = point')],
  ['only one set of medians is on screen at a time',
    source.includes('endpointLayer.setAttribute("display", point ? "none" : "inline")')],
  ['the party pills carry their abbreviation, so colour is not the sole encoding',
    source.includes('escapeHtml(definition.shortLabel)')],
  ['party pills inherit the app focus ring',
    styles.includes(':focus-visible') && styles.includes('.election-timeseries__party-button')],
  ['the disabled state of the party switch is visible, not only semantic',
    styles.includes('.election-timeseries__view-button[disabled]')],
  ['the suite is registered with the CI selector',
    (await readFile(join(HERE, 'select-suites.mjs'), 'utf8'))
      .includes("'party-timeseries.contract.mjs':")],

  // ---- the two smoke modes ------------------------------------------------
  // Fixture mode overwrites the site's history, which is what makes the
  // mutation matrix deterministic -- and is why a release gate must not use
  // it: `party-timeseries.smoke.mjs _site` would look reassuring while
  // validating the committed fixture instead of the new production artifact.
  ['the smoke suite has a real-artifact mode reachable from the command line',
    smoke.includes("ARGV.includes('--real-artifact')") &&
    smoke.includes("ARGV.includes('--no-fixture')") &&
    smoke.includes('if (REAL_ARTIFACT)')],
  ['the real-artifact reader knows nothing about the fixtures directory',
    realArtifactReader.length > 0 && !/fixtures/.test(realArtifactReader)],
  ['real-artifact mode neither copies nor overwrites the site',
    (() => {
      const body = smoke.slice(smoke.indexOf('async function runRealArtifactAt'),
        smoke.indexOf('// Scenarios'));
      return body.length > 0 && !/prepareSite\(|writeFile\(|cp\(/.test(body);
    })()],
  ['fixture mode still overwrites history, so the mutation matrix stays deterministic',
    /async function prepareSite[\s\S]*?writeFile\(historyPath/.test(smoke)],
  // The flat parties.json at the publication root is a frozen legacy forecast
  // -- a different generation entirely. Falling back to it would compare a
  // fresh history against the wrong numbers.
  ['the certified rows come from the pointer, with no flat-file fallback',
    smoke.includes('POINTER_RELATIVE') &&
    smoke.includes("/^versions\\/[A-Za-z0-9_-]+$/") &&
    !smoke.includes("join(root, PUBLICATION_DIR, 'parties.json')")],
  ['real-artifact mode verifies the published endpoint quantiles',
    smoke.includes('VOTE_FIELDS') && smoke.includes('SEAT_FIELDS') &&
    smoke.includes('published forecast says')],
  ['real-artifact mode refuses to drive the browser on an unfit artifact',
    smoke.includes('skipping the browser phase')],
  ['real-artifact mode reuses the one happy path rather than a second copy',
    /runRealArtifactAt[\s\S]*?await runViewport\(viewport, \{ root: root/.test(smoke)],
  ['the mode is self-tested on every default run',
    smoke.includes('await selfTestRealArtifactMode();') &&
    smoke.includes('real-artifact mode rejects ')],

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
  ['fixture party keys never leak into the coalition groups',
    series.every((point) => PARTY_ORDER.every((party) => !(party in (point.groups || {}))))],
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
