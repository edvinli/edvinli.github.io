import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(HERE, '..', 'assets', 'js', 'election-future-projection.js'), 'utf8');
const head = await readFile(join(HERE, '..', '_includes', 'head', 'custom.html'), 'utf8');

const checks = [
  ['projection script is loaded', head.includes('election-future-projection.js')],
  ['consumer reads future_projection separately', source.includes('history.future_projection')],
  ['historical series is not rewritten', !source.includes('history.series =') && !source.includes('payload.series =')],
  ['future state cutoff must equal origin', source.includes('raw.state_cutoff_date !== origin.iso')],
  ['future measurements must remain unknown', source.includes('raw.future_measurements_known !== false')],
  ['daily dates are validated through election day', source.includes('expectedDate') && source.includes('remaining_horizon_days')],
  ['election-day zero dynamics is required', source.includes('remaining_horizon_days !== 0')],
  ['x-axis explicitly extends to election day', source.includes('data-x-axis-max')],
  ['future region is separately marked', source.includes('data-future-region') && source.includes('data-future-background')],
  ['latest forecast boundary is labelled', source.includes('Senaste prognos')],
  ['election day is labelled', source.includes('Valdag 13 sep')],
  ['future median is dashed', source.includes('stroke-dasharray') && source.includes('data-future-median')],
  ['future 50/90 bands are separate', source.includes('data-future-band') && source.includes('future-band--50') && source.includes('future-band--90')],
  ['future tooltip carries the conditional assumption', source.includes('framtida mätningar är okända')],
  ['future points support vote and seats', source.includes('metric === "seats"') && source.includes('group[metric]')],
  ['future points are keyboard focusable', source.includes('tabindex: "0"') && source.includes('event.key === "Enter"')],
  ['script is a no-op off the election page', source.includes('if (!app || !section) return')],
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
