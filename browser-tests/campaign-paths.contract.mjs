// Static source contract for the coherent forward campaign-path view.
//
// The companion real-browser test (forecast-timeseries.smoke.mjs) proves the
// view renders and responds.  This file proves the *rules* the deployed
// consumer enforces are present in the source, so a future refactor cannot
// quietly drop a fail-closed check and still pass a happy-path smoke test.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(HERE, '..', 'assets', 'js', 'election-simulator.js'), 'utf8');
const page = await readFile(join(HERE, '..', '_pages', 'election_simulator.md'), 'utf8');
const styles = await readFile(join(HERE, '..', '_sass', 'custom.scss'), 'utf8');
const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'coalition-timeseries.json'), 'utf8'));

const paths = fixture.future_campaign_paths;
const projection = fixture.future_projection;
const current = (fixture.series || []).filter((point) => point?.provenance === 'current_production');
const sourcePrimarySections = [
  'election-alternatives',
  'election-government-builder',
  'election-headline',
  'election-seats',
  'election-timeseries',
];
const sourcePrimarySectionPositions = sourcePrimarySections.map((id) =>
  page.indexOf(`<section id="${id}"`));
const campaignMarkBlock = source.match(/var mark = svgNode\("circle", \{[\s\S]*?\n\s*\}\);/)?.[0] || '';
const originMarkBlock = source.match(/var originMark = svgNode\("rect", \{[\s\S]*?\n\s*\}\);/)?.[0] || '';
const electionMarkBlock = source.match(/var electionMark = svgNode\("circle", \{[\s\S]*?\n\s*\}\);/)?.[0] || '';

const checks = [
  // ---- consumer reads the additive object separately --------------------
  ['consumer reads future_campaign_paths separately',
    source.includes('payload.future_campaign_paths')],
  ['historical series is never rewritten',
    !source.includes('history.series =') && !source.includes('payload.series =')],
  ['no companion renderer is loaded',
    !(await readFile(join(HERE, '..', '_includes', 'head', 'custom.html'), 'utf8'))
      .includes('election-campaign-paths.js')],

  // ---- model identity and the rejected alternatives ---------------------
  ['model type and id are pinned', source.includes('CAMPAIGN_PATH_TYPE') &&
    source.includes('coherent_campaign_paths_v1')],
  ['the primary role is required', source.includes('CAMPAIGN_PATH_PRIMARY_ROLE')],
  ['the published quantity must be underlying opinion',
    source.includes('underlying_opinion_share')],
  ['joint nine-category CLR construction is required',
    source.includes('construction.space !== "clr"') && source.includes('construction.categories !== 9')],
  ['one sign per whole trajectory is required',
    source.includes('single_sign_per_whole_trajectory')],
  ['all-history leakage-safe resampling is required',
    source.includes('all_history_leakage_safe') && source.includes('trajectory_end_le_origin')],
  ['synthesized future polls are rejected',
    source.includes('construction.synthesized_future_polls !== false')],
  ['a daily independent random walk is rejected',
    source.includes('construction.daily_independent_random_walk !== false')],
  ['directional momentum is rejected',
    source.includes('construction.directional_momentum !== false')],
  ['a trajectory ending after the origin is rejected',
    source.includes('latestEnd.time > origin.time')],
  ['the minimum transition pool is enforced',
    source.includes('construction.eligible_trajectories < 30')],
  ['an identity time warp must match the path length',
    source.includes('construction.endpoint_horizon_days !== pathDays')],

  // ---- endpoint parity ---------------------------------------------------
  ['the bitwise endpoint parity guarantee is required',
    source.includes('bitwise_identical_to_production_election_day_draws')],
  ['a verified parity check must report zero difference',
    source.includes('parity.max_abs_vote_share_difference_pp !== 0')],
  ['the parity reference has to be named and recognised',
    source.includes('generate_national_vote_shares') &&
    source.includes('certified_production_result') &&
    source.includes('.indexOf(parity.reference) === -1')],
  ['election-day summaries must equal the certified production point',
    source.includes('JSON.stringify(electionGroups) !== JSON.stringify(certifiedGroups)')],
  ['the election-day distribution must carry ElectionNoise, geography and mandates',
    source.includes('electionDayRaw.includes_election_noise !== true') &&
    source.includes('electionDayRaw.includes_geography_and_mandates !== true')],

  // ---- band and path structure ------------------------------------------
  ['bands cover the origin and every campaign day',
    source.includes('bands.length !== pathDays + 1')],
  ['bands are vote-only, so a seat quantile is rejected',
    source.includes('!Object.prototype.hasOwnProperty.call(group, "vote")')],
  ['individual trajectories are length-checked against the path',
    source.includes('line.length !== pathDays + 1')],
  ['trajectory indices must be sorted and inside the draw matrix',
    source.includes('indices[track] > indices[track - 1]') &&
    source.includes('item.sample_index >= raw.samples')],

  // ---- rendering ---------------------------------------------------------
  ['the future region is separately marked and distinctly shaded',
    source.includes('data-future-region') && source.includes('data-future-background') &&
    source.includes('region.background !== "light_distinct"')],
  ['the future region carries its published label accessibly, without a redundant plot caption',
    source.includes('futureViewPaths.setAttribute("aria-label", campaignPaths.rendering.future_region.label)') &&
    source.includes('campaignPaths.rendering.future_region.label') &&
    !source.includes('data-future-region-label')],
  ['the primary page sections use the election-day-first source order',
    sourcePrimarySectionPositions.every((position, index) => position >= 0 &&
      (index === 0 || position > sourcePrimarySectionPositions[index - 1]))],
  ['the timeline and primary future control use the final labels',
    page.includes('<h2>Vägen till valdagen</h2>') &&
    page.includes('aria-label="Möjliga opinionsbanor"') &&
    />Opinionsbanor<\/button>/.test(page)],

  // ---- the origin quantity ----------------------------------------------
  // Path day 0 is the latent opinion state. The certified forecast point on
  // the same date is a wider, different distribution, so the fan must not be
  // drawn out of it.
  ['day zero must be published as state-only',
    source.includes('CAMPAIGN_PATH_ORIGIN_QUANTITY') &&
    source.includes('opinion_state_only') &&
    source.includes('construction.origin_day_quantity !== CAMPAIGN_PATH_ORIGIN_QUANTITY')],
  ['the fan continues the current opinion state, not the Poll of Polls series',
    source.includes('CAMPAIGN_PATH_CONTINUES_FROM') &&
    source.includes('current_opinion_state') &&
    !source.includes('poll_of_polls_opinion_series')],
  ['the origin state label and disclosure are required',
    source.includes('rendering.origin_state_label') &&
    source.includes('rendering.origin_state_tooltip_sv')],
  ['the origin state is drawn as its own interval and median',
    source.includes('data-origin-state-interval": "90"') &&
    source.includes('data-origin-state-interval": "50"') &&
    source.includes('data-origin-state-median')],
  ['the origin mark is a rect, so it cannot read as the round forecast dot',
    /svgNode\("rect", \{[^}]*data-origin-state-point/s.test(source)],
  ['the origin mark is an accessible button with its own detail',
    source.includes('data-origin-state-point') && source.includes('originStateDetail') &&
    source.includes('isOriginState')],
  ['the fan is offset from the forecast dot rather than sharing its position',
    source.includes('originShift') && source.includes('campaignX')],
  ['faint individual paths are drawn',
    source.includes('data-campaign-path": "true"') || source.includes('"data-campaign-path": "true"')],
  ['50 % and 90 % predictive bands are drawn separately',
    source.includes('campaign-band--50') && source.includes('campaign-band--90')],
  ['the election-day distribution is emphasized with box, whisker and median',
    source.includes('data-election-day-interval": "90"') &&
    source.includes('data-election-day-interval": "50"') &&
    source.includes('data-election-day-median')],
  ['the election-day distribution carries its own label',
    source.includes('data-election-day-distribution-label')],
  ['no intermediate seat trajectory is drawn',
    source.includes('rendering.intermediate_seat_trajectory !== false') &&
    source.includes('selectedMetric === "vote" && visibleBandPoints.length')],
  ['future poll and Poll of Polls observations are forbidden',
    source.includes('rendering.poll_observations_in_future !== false') &&
    source.includes('rendering.poll_of_polls_observations_in_future !== false') &&
    source.includes('point.time <= futureOrigin.time')],
  ['the x-axis explicitly extends to election day',
    source.includes('data-x-axis-max') && source.includes('rendering.x_axis_max !== election.iso')],
  ['one renderer owns historical and future scales',
    source.includes('activeDomain = activeTimeDomain()') &&
    source.includes('historyValueDomain(history, selectedMetric, definitions, activeDomain)') &&
    source.includes('activeDomain.minTime + (activeDomain.maxTime - activeDomain.minTime) * ratio')],

  // ---- interaction and accessibility ------------------------------------
  ['band and election-day marks are accessible buttons',
    source.includes('data-campaign-point') && source.includes('data-election-day-point') &&
    source.includes('event.key === "Enter"')],
  ['daily campaign marks are pointer targets but not tab stops',
    campaignMarkBlock.includes('role: "button"') && !campaignMarkBlock.includes('tabindex:')],
  ['chart-level arrow navigation remains the keyboard route to campaign days',
    source.includes('event.target !== svg && event.target !== hit') &&
    source.includes('event.key === "ArrowLeft" || event.key === "ArrowRight"')],
  ['origin and election-day marks remain keyboard-accessible',
    originMarkBlock.includes('tabindex: "0"') && electionMarkBlock.includes('tabindex: "0"')],
  ['focus is visible on all three new mark kinds',
    styles.includes('.election-timeseries__campaign-point:focus-visible') &&
    styles.includes('.election-timeseries__origin-state-point:focus-visible') &&
    styles.includes('.election-timeseries__election-day-point:focus-visible')],
  ['decorative trajectories are not pointer targets',
    styles.includes('.election-timeseries__campaign-path') && styles.includes('pointer-events: none')],

  // ---- the secondary view -----------------------------------------------
  // ---- the opening range is not changed silently -------------------------
  ['a published campaign region does not change the default range',
    source.includes('var selectedRange = "full";') &&
    !source.includes('history.campaignPaths ? "short" : "full"')],
  ['the campaign window has a discoverability cue instead',
    page.includes('election-timeseries-campaign-cue') &&
    page.includes('Visa kampanjperioden') &&
    source.includes('setCampaignCue') &&
    source.includes('campaignCue.hidden = !(campaignPaths && selectedRange !== "short")')],

  ['the shrinking-horizon fan is only reachable as a secondary view',
    source.includes('CAMPAIGN_PATH_SECONDARY_ROLE') &&
    source.includes('secondaryProjectionDescription') &&
    source.includes('function projectionActive()')],
  ['the future-view control exists in the page markup',
    page.includes('election-timeseries-future-paths') &&
    page.includes('election-timeseries-future-stability')],
  ['the future-view control is a labelled button group',
    page.includes('id="election-timeseries-future"') && page.includes('aria-pressed')],
  ['the new suite is registered with the CI selector',
    (await readFile(join(HERE, 'select-suites.mjs'), 'utf8'))
      .includes("'campaign-paths.contract.mjs':")],
  ['the control is hidden unless both views are published',
    source.includes('futureViewHost.hidden = !available || selectedMetric === "seats"')],
  ['mandate mode retains the election-day distribution without seat paths',
    source.includes('selectedMetric === "seats"') &&
    source.includes('campaignPaths.electionDay') &&
    source.includes('selectedMetric === "vote" && visibleBandPoints.length')],

  // ---- the fixture the smoke test consumes ------------------------------
  ['fixture publishes the primary campaign-path object',
    paths?.projection_type === 'coherent_campaign_paths' &&
    paths?.model_id === 'coherent_campaign_paths_v1' && paths?.role === 'primary_future_view'],
  ['fixture publishes day zero as state-only and names it',
    paths?.path_construction?.origin_day_quantity === 'opinion_state_only' &&
    paths?.rendering?.continues_from === 'current_opinion_state' &&
    typeof paths?.rendering?.origin_state_label === 'string' &&
    paths.rendering.origin_state_label.length > 0 &&
    /inte valdagsprognosen/.test(paths?.rendering?.origin_state_tooltip_sv || '')],
  ['fixture day zero is narrower than the certified election-day forecast',
    (() => {
      const key = Object.keys(paths?.bands?.[0]?.groups || {})[0];
      const state = paths.bands[0].groups[key].vote;
      const forecast = paths.election_day.groups[key].vote;
      return (state.p95 - state.p05) < (forecast.p95 - forecast.p05);
    })()],
  ['fixture disclosure matches its published day map',
    paths?.path_construction?.time_warp === 'identity'
      ? /av samma längd/.test(paths.tooltip_sv)
      : /tidsutsträckt/.test(paths.tooltip_sv)],
  ['fixture endpoint parity is verified, exactly zero and attributed',
    paths?.endpoint_parity?.verified === true &&
    paths.endpoint_parity.max_abs_vote_share_difference_pp === 0 &&
    ['generate_national_vote_shares', 'certified_production_result']
      .includes(paths.endpoint_parity.reference)],
  ['fixture election-day groups equal the certified production point',
    current.length === 1 &&
    JSON.stringify(paths?.election_day?.groups) === JSON.stringify(current[0].groups) &&
    paths.election_day.samples === current[0].samples],
  ['fixture bands are daily, vote-only and monotone', Array.isArray(paths?.bands) &&
    paths.bands.length === paths.path_days + 1 &&
    paths.bands.every((band, index) => band.path_day === index &&
      Object.values(band.groups).every((group) => {
        const keys = Object.keys(group);
        if (keys.length !== 1 || keys[0] !== 'vote') return false;
        const values = ['p05', 'p25', 'p50', 'p75', 'p95'].map((key) => group.vote[key]);
        return values.every((value, position) => typeof value === 'number' &&
          (position === 0 || value >= values[position - 1]));
      }))],
  ['fixture trajectories are limited, sorted and complete',
    paths?.paths?.count === paths?.paths?.series?.length && paths.paths.count > 0 &&
    paths.paths.count <= 64 &&
    paths.paths.sample_indices.every((value, index) =>
      index === 0 || value > paths.paths.sample_indices[index - 1]) &&
    paths.paths.series.every((track) => Object.values(track.values)
      .every((line) => line.length === paths.path_days + 1))],
  ['fixture forbids future observations in the future region',
    paths?.rendering?.poll_observations_in_future === false &&
    paths.rendering.poll_of_polls_observations_in_future === false &&
    paths.rendering.intermediate_seat_trajectory === false &&
    paths.rendering.median_may_be_flat === true],
  ['fixture has no poll or Poll of Polls observation after the origin',
    (fixture.polls || []).every((poll) => poll.publication_date <= paths.origin_date) &&
    (fixture.poll_of_polls || []).every((item) => item.date <= paths.origin_date)],
  ['fixture demotes the shrinking-horizon fan',
    projection?.role === 'secondary_analytical_view' && projection.primary === false &&
    typeof projection.description_sv === 'string' && projection.description_sv.includes('står stilla')],
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
console.log(`campaign path contract: ${checks.length} checks passed`);
