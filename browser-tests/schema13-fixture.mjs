// Builds a schema-1.3 publication for the browser tests out of the *exact*
// joint seat draws behind the published schema-1.2 generation.
//
// The repository's published forecast is immutable and stays schema 1.2, so a
// 1.3 fixture has to come from somewhere. It comes from the preserved 100 000
// draw matrix that produced that very publication -- not from a resampled run,
// not from a smoothed or synthetic distribution. The consequence is worth
// stating plainly: every summary field in the fixture is the published number,
// byte for byte, and the only thing added is `seat_histogram`. This module
// refuses to build unless the histograms it derives reproduce those published
// numbers exactly, so a fixture that drifts from the publication cannot be
// used to make the page look correct.
//
// The matrix is deliberately not in any repository (6.4 MB of raw draws). It
// lives beside the audit that preserved it:
//
//   ~/Documents/election-simulator-audit/20260828-coalition-covariance-audit/
//
// Override with SEATS_MATRIX=/path/to/seats_matrix.npy. When it is missing the
// caller is told, and the schema-1.3 cases are skipped rather than faked.
//
// Nothing here writes into the repository: the 1.3 generation is assembled in
// a temporary copy of the built site and removed when the run ends.

import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pointerFor } from './server.mjs';

export const MATRIX_PATH = process.env.SEATS_MATRIX || join(
  homedir(), 'Documents/election-simulator-audit',
  '20260828-coalition-covariance-audit/seats_matrix.npy');

// The audit's recorded digest. A different matrix is a different simulation,
// and silently deriving expectations from one would be worse than skipping.
export const MATRIX_SHA256 =
  '7d5626506bb7cad1bf54378bafd7aa51937037da5c45d22756632f681ed221cd';

const CHAMBER = 349;
const MAJORITY = 175;
const PARTIES = 8;
const MASKS = 1 << PARTIES;
// Column j of the matrix is this party's seats -- the same order as the
// publication's coalition_builder.party_order, which the loader also checks.
export const MATRIX_PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];

/** Parse a little-endian `<i8` C-order .npy. Nothing else is accepted. */
function parseNpy(buffer) {
  if (buffer.subarray(0, 6).toString('latin1') !== '\x93NUMPY') {
    throw new Error('not a .npy file');
  }
  const major = buffer[6];
  const headerLength = major === 1
    ? buffer.readUInt16LE(8)
    : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.subarray(headerStart, headerStart + headerLength).toString('latin1');
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!/'descr':\s*'<i8'/.test(header) || !/'fortran_order':\s*False/.test(header) || !shape) {
    throw new Error(`unsupported .npy header: ${header.trim()}`);
  }
  const rows = Number(shape[1]);
  const columns = Number(shape[2]);
  if (columns !== PARTIES) throw new Error(`expected ${PARTIES} columns, got ${columns}`);
  const values = new BigInt64Array(
    buffer.buffer, buffer.byteOffset + headerStart + headerLength, rows * columns);
  return { rows, columns, values };
}

/**
 * Exact one-seat-bin histograms for all 256 combinations, in one pass.
 *
 * Each row's 256 subset sums are built by adding one party to a sum already
 * computed, so the whole table costs 256 additions per draw rather than 1024.
 */
function histogramsFrom({ rows, values }) {
  const counts = [];
  for (let mask = 0; mask < MASKS; mask += 1) counts.push(new Int32Array(CHAMBER + 1));
  const sums = new Int32Array(MASKS);
  const row = new Int32Array(PARTIES);

  for (let r = 0; r < rows; r += 1) {
    let total = 0;
    for (let column = 0; column < PARTIES; column += 1) {
      const seats = Number(values[r * PARTIES + column]);
      row[column] = seats;
      total += seats;
    }
    if (total !== CHAMBER) throw new Error(`draw ${r} seats ${total}, not ${CHAMBER}`);
    for (let mask = 1; mask < MASKS; mask += 1) {
      const lowest = mask & -mask;
      sums[mask] = sums[mask ^ lowest] + row[31 - Math.clz32(lowest)];
    }
    for (let mask = 0; mask < MASKS; mask += 1) counts[mask][sums[mask]] += 1;
  }

  return counts.map((bins) => {
    let min = 0;
    while (min <= CHAMBER && bins[min] === 0) min += 1;
    let max = CHAMBER;
    while (max >= 0 && bins[max] === 0) max -= 1;
    return { min_seats: min, counts: Array.from(bins.subarray(min, max + 1)) };
  });
}

/** The published summaries use NumPy's linear percentile, truncated. */
function quantile(histogram, q, total) {
  const at = (index) => {
    let remaining = index;
    for (let offset = 0; offset < histogram.counts.length; offset += 1) {
      if (remaining < histogram.counts[offset]) return histogram.min_seats + offset;
      remaining -= histogram.counts[offset];
    }
    return null;
  };
  const position = (total - 1) * q;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = at(lowerIndex);
  const upper = at(upperIndex);
  const gamma = position - lowerIndex;
  const difference = upper - lower;
  return Math.floor(gamma < 0.5
    ? lower + difference * gamma
    : upper - difference * (1 - gamma));
}

const QUANTILES = [
  ['p05_seats', 0.05], ['p10_seats', 0.10], ['p25_seats', 0.25],
  ['median_seats', 0.50], ['p75_seats', 0.75], ['p90_seats', 0.90],
  ['p95_seats', 0.95],
];

/**
 * The whole point of the cross-check: a histogram derived from the preserved
 * draws must imply, exactly, the summary numbers the publication already
 * prints. If it does not, the matrix and the publication are not the same
 * simulation and the fixture is worthless.
 */
function assertMatchesPublished(histogram, entry, mask, total) {
  const weighted = histogram.counts.reduce(
    (sum, count, index) => sum + (histogram.min_seats + index) * count, 0);
  const mean = weighted / total;
  if (Math.abs(mean - entry.mean_seats) > 1e-12) {
    throw new Error(`mask ${mask}: derived mean ${mean} != published ${entry.mean_seats}`);
  }
  for (const [field, q] of QUANTILES) {
    const derived = quantile(histogram, q, total);
    if (derived !== entry[field]) {
      throw new Error(`mask ${mask}: derived ${field} ${derived} != published ${entry[field]}`);
    }
  }
  const majority = histogram.counts.reduce(
    (sum, count, index) => sum + (histogram.min_seats + index >= MAJORITY ? count : 0), 0);
  if (Math.abs((majority / total) - entry.prob_majority) > 1e-12) {
    throw new Error(
      `mask ${mask}: derived P(>=${MAJORITY}) ${majority / total} != published ${entry.prob_majority}`);
  }
}

/** Read and verify the preserved matrix, or explain why it cannot be used. */
export async function loadSeatsMatrix() {
  let buffer;
  try {
    buffer = await readFile(MATRIX_PATH);
  } catch {
    return { available: false, reason: `no seats matrix at ${MATRIX_PATH}` };
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== MATRIX_SHA256) {
    // Not a skip. A matrix that is present but wrong would quietly produce
    // expectations for a simulation nobody published.
    throw new Error(
      `seats matrix digest ${digest} does not match the audited ${MATRIX_SHA256}`);
  }
  return { available: true, matrix: parseNpy(buffer), bytes: buffer.length };
}

/**
 * Assemble a schema-1.3 publication in a throwaway copy of the built site.
 * Returns its pointer plus the exact histograms, so the tests can compare the
 * page against the same numbers the page was given.
 */
export async function buildSchema13Site(site, sourceGeneration, generation, options = {}) {
  const loaded = await loadSeatsMatrix();
  if (!loaded.available) return loaded;

  const histograms = histogramsFrom(loaded.matrix);
  const total = loaded.matrix.rows;

  const root = await mkdtemp(join(tmpdir(), 'election-ui-schema-13-'));
  const version = join(root, 'files/election-simulator/versions', generation);
  await cp(site, root, { recursive: true });
  await cp(join(site, 'files/election-simulator/versions', sourceGeneration), version,
    { recursive: true });

  const groupsPath = join(version, 'groups.json');
  const groups = JSON.parse(await readFile(groupsPath, 'utf8'));
  const order = groups.coalition_builder.party_order;
  if (order.join(',') !== MATRIX_PARTY_ORDER.join(',')) {
    throw new Error(`published party_order ${order} does not match the matrix columns`);
  }
  groups.schema_version = '1.3';
  for (const key of Object.keys(groups.coalition_builder.coalitions)) {
    const mask = Number(key);
    const entry = groups.coalition_builder.coalitions[key];
    assertMatchesPublished(histograms[mask], entry, mask, total);
    let histogram = histograms[mask];
    // A histogram that no longer implies the summary printed beside it. One
    // draw is moved to the neighbouring seat value, so the total is untouched
    // and only the distribution shifts -- the quietest way for a chart and its
    // numbers to disagree, and the one the loader has to refuse.
    if (options.corruptMask === mask && histogram.counts.length > 1) {
      const counts = histogram.counts.slice();
      counts[0] -= 1;
      counts[1] += 1;
      histogram = { min_seats: histogram.min_seats, counts };
    }
    // Appended last, because the loader checks the entry's key order.
    groups.coalition_builder.coalitions[key] = { ...entry, seat_histogram: histogram };
  }
  await writeFile(groupsPath, `${JSON.stringify(groups, null, 2)}\n`);

  for (const name of ['forecast.json', 'parties.json', 'seats.json',
    'calibration.json', 'metadata.json', 'manifest.json']) {
    const path = join(version, name);
    const contract = JSON.parse(await readFile(path, 'utf8'));
    contract.schema_version = '1.3';
    if (name === 'manifest.json') contract.publication_generation = generation;
    await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`);
  }

  return {
    available: true,
    root,
    total,
    histograms,
    pointer: await pointerFor(root, generation),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
