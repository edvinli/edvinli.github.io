import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(HERE, '..', 'assets', 'js', 'election-simulator.js'), 'utf8');
const head = await readFile(join(HERE, '..', '_includes', 'head', 'custom.html'), 'utf8');

const checks = [
  ['no companion renderer is loaded', !head.includes('election-future-projection.js')],
  ['consumer reads future_projection separately', source.includes('payload.future_projection')],
  ['historical series is not rewritten', !source.includes('history.series =') && !source.includes('payload.series =')],
  ['future election must match history election', source.includes('election.iso !== electionDate.iso')],
  ['future anchor exactly matches current production', source.includes('currentRaw.length !== 1') &&
    source.includes('JSON.stringify(anchorGroups) !== JSON.stringify(currentGroups)')],
  ['future state cutoff must equal origin', source.includes('raw.state_cutoff_date !== origin.iso')],
  ['future measurements must remain unknown', source.includes('raw.future_measurements_known !== false')],
  ['daily dates are validated through election day', source.includes('expectedDate') &&
    source.includes('remaining_horizon_days')],
  ['election-day zero dynamics is required when future points exist',
    source.includes('normalizedSeries.length &&') && source.includes('remainingHorizonDays !== 0')],
  ['election-day origin with an empty series is accepted', source.includes('origin.time > election.time') &&
    !source.includes('election.time <= origin.time')],
  ['published rendering metadata is validated', source.includes('rendering.x_axis_max !== election.iso') &&
    source.includes('rendering.poll_observations_in_future !== false') &&
    source.includes('rendering.connect_from_history_anchor !== true')],
  ['published rendering labels are consumed', source.includes('projection.rendering.latest_forecast_label') &&
    source.includes('projection.rendering.election_day_label') &&
    source.includes('projection.rendering.legend_label')],
  ['x-axis explicitly extends to election day', source.includes('data-x-axis-max')],
  ['future region is separately marked', source.includes('data-future-region') &&
    source.includes('data-future-background')],
  ['future median is dashed', source.includes('stroke-dasharray') && source.includes('data-future-median')],
  ['future 50/90 bands are separate', source.includes('data-future-band') &&
    source.includes('future-band--50') && source.includes('future-band--90')],
  ['future points support vote and seats', source.includes('selectedMetric === "seats"') &&
    source.includes('group[selectedMetric]')],
  ['future points are accessible buttons', source.includes('role: "button"') &&
    source.includes('event.key === "Enter"')],
  ['one renderer owns historical and future scales',
    source.includes('historyValueDomain(history, selectedMetric, definitions)') &&
    source.includes('if (projection) allTimes.push(projection.election.time)')],
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
console.log(`future projection contract: ${checks.length} checks passed`);
