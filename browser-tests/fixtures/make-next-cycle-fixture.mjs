// Build the synthetic 2030-cycle history used by forecast-cycles.smoke.mjs.
//
// Not a suite. The first real 2030 history does not exist yet, so the
// multi-election chart is tested against a stand-in with the same shape: a
// schema-1.1 history for election day 2030-09-08 whose points are copies of
// the final 2026 point, re-dated to the weeks after the 2026 election. Every
// value is therefore a valid published quantile set, and nothing here claims to
// be a forecast. The polls are copies of the last real 2026 polls, re-dated and
// labelled "Syntetisk", so no dot can be mistaken for a real measurement.
//
// Deterministic: the same frozen 2026 history always produces the same bytes.
//
// Usage (from the repository root):
//   node browser-tests/fixtures/make-next-cycle-fixture.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', 'files', 'election-simulator', 'history', '2026',
  'coalition-timeseries.json');
const TARGET = join(HERE, 'next-cycle-2030.json');

const ELECTION_DATE = '2030-09-08';
const DATES = ['2026-09-20', '2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18'];
const POLL_DATES = ['2026-09-24', '2026-10-01', '2026-10-09', '2026-10-15'];
const DYNAMICS_CAP = 112;

const days = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const source = JSON.parse(await readFile(SOURCE, 'utf8'));
const final = source.series[source.series.length - 1];

const series = DATES.map((date, index) => ({
  date,
  samples: final.samples,
  horizon_days: days(date, ELECTION_DATE),
  dynamics_horizon_days: Math.min(DYNAMICS_CAP, days(date, ELECTION_DATE)),
  provenance: index === DATES.length - 1 ? 'current_production' : 'reconstructed_current_model',
  groups: final.groups,
  parties: final.parties,
}));

const lastPolls = source.polls.slice(-POLL_DATES.length);
const polls = POLL_DATES.map((date, index) => ({
  ...lastPolls[index],
  poll_id: `synthetic-2030-${index + 1}`,
  company: 'Syntetisk',
  house: 'Syntetisk',
  publication_date: date,
  fieldwork_start: date,
  fieldwork_end: date,
}));

const pollOfPolls = POLL_DATES.map((date) => ({
  date,
  parties: source.poll_of_polls[source.poll_of_polls.length - 1].parties,
}));

const fixture = {
  schema_version: source.schema_version,
  election_date: ELECTION_DATE,
  model_commit: source.model_commit,
  poll_source_sha256: createHash('sha256').update(JSON.stringify(polls)).digest('hex'),
  party_order: source.party_order,
  coalitions: source.coalitions,
  series,
  poll_of_polls: pollOfPolls,
  polls,
  parties_view: source.parties_view,
  poll_date_range: { start_date: POLL_DATES[0], end_date: POLL_DATES[POLL_DATES.length - 1] },
  provenance_note: 'Synthetic browser-test fixture for the 2030 cycle; not a forecast.',
};

await writeFile(TARGET, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${TARGET}`);
