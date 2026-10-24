// Builds a schema-1.5 publication with a geography.json for the constituency
// map, in a temporary copy of the built site.
//
// No published generation carries geography.json yet, so this one is
// SYNTHETIC. It starts from a pinned schema-1.4 generation, relabels its
// contracts 1.5 and adds a geography.json whose numbers are invented from that
// generation's national quantiles: each constituency's quantiles are the
// national ones scaled by a fixed per-constituency factor, its "baseline" sits
// a fixed distance below the median, and the party with the largest median is
// the largest party in every draw. They are plausible-looking and internally
// consistent, which is all a layout and interaction suite needs; they are not
// model output and must never be read as such. What the map's numbers mean is
// the simulator's contract, and its own tests check it.
//
// Everything the page verifies is real, however: geography.json's bytes match
// the manifest, it names the generation's own payload hash and sample count,
// and the pointer is rebuilt over the rewritten manifest. A mutation hook lets
// a test break exactly one of those and assert the panel stays hidden.
//
// Nothing here writes into the repository; the copy is removed by cleanup().

import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pointerFor } from './server.mjs';

export const GEOGRAPHY_SOURCE_GENERATION = '20261023T091122Z-f94e075f';
const CONTRACTS = ['forecast.json', 'parties.json', 'seats.json', 'groups.json',
  'calibration.json', 'metadata.json'];
const PARTIES = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD', 'REST'];
const QUANTILES = { p05: 'vote_share_p05', p25: 'vote_share_p25', p50: 'vote_share_median',
  p75: 'vote_share_p75', p95: 'vote_share_p95' };
const BASELINE_YEAR = 2026;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function syntheticGeography(forecast, boundaries, payloadHash) {
  const constituencies = boundaries.constituencies.map((shape, index) => {
    const factors = Object.fromEntries(PARTIES.map((party, p) => [
      party, 1 + 0.45 * Math.sin(1.7 * (index + 1) + 2.3 * p)]));
    const parties = {};
    const baseline = {};
    for (const party of PARTIES) {
      const national = forecast.parties[party];
      const quantiles = {};
      for (const [field, source] of Object.entries(QUANTILES)) {
        quantiles[field] = round6(Math.min(100, national[source] * factors[party]));
      }
      parties[party] = { vote_share_quantiles: quantiles, prob_largest: 0 };
      baseline[party] = round6(Math.max(0, quantiles.p50 - 0.4 - 0.1 * (index % 5)));
    }
    const largest = PARTIES.slice(0, 8).reduce((best, party) =>
      parties[party].vote_share_quantiles.p50 > parties[best].vote_share_quantiles.p50 ? party : best);
    parties[largest].prob_largest = 1;
    return { code: shape.code, name: shape.name, baseline_actual_vote_share: baseline, parties };
  });
  return {
    schema_version: '1.5',
    party_order: PARTIES,
    sample_count: forecast.total_samples,
    baseline_year: BASELINE_YEAR,
    constituencies,
    deterministic_payload_sha256: payloadHash,
  };
}

/**
 * @param {string} site built _site
 * @param {object} [options]
 * @param {(files: {geography: object, manifest: object, contracts: object}) => void} [options.mutate]
 *   change the generated objects before they are hashed and written
 * @param {(text: string) => string} [options.tamper] change geography.json's
 *   bytes after its manifest hash was taken
 * @param {boolean} [options.withGeography=true] false keeps a 1.5 relabel
 *   without the file, as a publication that does not advertise one
 */
export async function buildGeographySite(site, { mutate = null, tamper = null, withGeography = true } = {}) {
  const generation = GEOGRAPHY_SOURCE_GENERATION;
  const root = await mkdtemp(join(tmpdir(), 'election-ui-geography-'));
  await cp(site, root, { recursive: true });
  const version = join(root, 'files/election-simulator/versions', generation);
  const contracts = {};
  for (const name of CONTRACTS) {
    contracts[name] = JSON.parse(await readFile(join(version, name), 'utf8'));
    contracts[name].schema_version = '1.5';
  }
  contracts['metadata.json'].geography_baseline_year = BASELINE_YEAR;
  const manifest = JSON.parse(await readFile(join(version, 'manifest.json'), 'utf8'));
  manifest.schema_version = '1.5';
  const boundaries = JSON.parse(await readFile(
    join(root, 'files/election-simulator/geography/constituency-boundaries.json'), 'utf8'));
  const geography = syntheticGeography(contracts['forecast.json'], boundaries,
    manifest.deterministic_payload_sha256);
  if (mutate) mutate({ geography, manifest, contracts });

  const hashes = {};
  for (const name of CONTRACTS) {
    const text = json(contracts[name]);
    await writeFile(join(version, name), text);
    hashes[name] = sha256(text);
  }
  if (withGeography) {
    const text = json(geography);
    hashes['geography.json'] = sha256(text);
    await writeFile(join(version, 'geography.json'), tamper ? tamper(text) : text);
  }
  manifest.publication_files = hashes;
  await writeFile(join(version, 'manifest.json'), json(manifest));
  const pointer = await pointerFor(root, generation);
  return {
    root,
    pointer,
    geography,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
