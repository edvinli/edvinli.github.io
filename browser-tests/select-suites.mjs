// Decide which browser suites a change needs, and emit them as a GitHub
// Actions matrix.
//
// The browser suites cost about 90 seconds in total and each one needs its own
// runner, because every suite binds port 4000 by name: _config.dev.yml gives
// the built pages absolute http://localhost:4000 asset URLs, so the stylesheet
// only loads on that exact host and port, and two suites on one runner
// collide. Sharding across jobs is therefore the only way to parallelise them,
// and running only the affected ones is the only way to keep a small change
// cheap.
//
// No dependencies, on purpose: browser-tests/ ships a hand-written CDP client
// precisely so this directory installs nothing.
//
// Usage:
//   node browser-tests/select-suites.mjs --changed <path>...
//   node browser-tests/select-suites.mjs --all
//   node browser-tests/select-suites.mjs --self-test

import { readdirSync } from 'node:fs';

// Every suite, with the reason it would need to re-run.
export const SUITES = {
  'government-builder.smoke.mjs': { seconds: 23, area: 'builder' },
  'builder-blocks.smoke.mjs': { seconds: 10, area: 'builder' },
  'alternatives.smoke.mjs': { seconds: 9, area: 'builder' },
  'histogram-copy.smoke.mjs': { seconds: 10, area: 'builder' },
  'forecast-timeseries.smoke.mjs': { seconds: 29, area: 'forecast' },
  'party-timeseries.smoke.mjs': { seconds: 24, area: 'forecast' },
  'party-timeseries.contract.mjs': { seconds: 1, area: 'forecast' },
  'equations.smoke.mjs': { seconds: 7, area: 'equations' },
  'changes-baseline.smoke.mjs': { seconds: 14, area: 'provenance' },
};

const ALL = Object.keys(SUITES);
const byArea = (area) => ALL.filter((s) => SUITES[s].area === area);

// Files the whole browser harness rests on. A change here can alter how every
// suite drives the page, so every suite re-runs.
const HARNESS = new Set([
  'browser-tests/cdp.mjs',
  'browser-tests/server.mjs',
  'browser-tests/schema13-fixture.mjs',
  'browser-tests/select-suites.mjs',
]);

// Prefix rules, most specific first. `suites: null` means "everything".
const RULES = [
  // The forecast app powers every election view.
  { prefix: 'assets/js/election-simulator.js', suites: null },
  { prefix: 'assets/js/election-latest-poll.js', suites: byArea('forecast') },
  // Reorders the election sections and rebuilds the hero's section nav, whose
  // label for the change table has to track that section's own heading.
  { prefix: 'assets/js/election-seat-opacity.js',
    suites: [...byArea('builder'), ...byArea('provenance')] },

  // Published forecast artifacts: the data every election view renders. The
  // provenance suite belongs here for a reason of its own -- it asserts
  // published instants and the resolved comparison baseline, so a sync that
  // adds a generation directory can move its expectations even when no
  // rendered number changes.
  { prefix: 'files/election-simulator/', suites: [
    ...byArea('builder'), ...byArea('forecast'), ...byArea('provenance')] },

  // Layout and markup: the suites assert computed style and box geometry, so a
  // stylesheet or include change can break any of them. This is the rule that
  // caught the original _reset.scss [hidden] regression.
  { prefix: '_sass/', suites: null },
  { prefix: '_includes/', suites: null },
  { prefix: '_layouts/', suites: null },
  { prefix: '_pages/election_simulator.md', suites: null },

  // The workflows *are* the browser harness in CI: they build the site, move
  // it between jobs, find Chrome and run the suites. A change here that breaks
  // any of that must not be able to select nothing and pass on a skipped
  // matrix, so it selects everything. This rule has to precede the general
  // '.github/' rule below, since the first matching prefix wins.
  { prefix: '.github/workflows/', suites: null },

  // Jekyll data is rendered-site input, not inert configuration:
  // _data/navigation.yml drives the masthead and _data/ui-text.yml the chrome
  // around every page, both of which the suites assert against -- including
  // the no-horizontal-overflow checks at 360px. The selector cannot prove a
  // given key is unused, so it does not try.
  { prefix: '_data/', suites: null },

  // Paths that cannot affect a browser suite. The Jekyll build still runs.
  //
  // These are narrow on purpose. The suites only ever load
  // /election-simulator/, so another page's content cannot reach them; and the
  // election page has its own rule above. Anything less clear-cut belongs in
  // the `suites: null` group instead.
  { prefix: '_pages/', suites: [] },
  { prefix: '_drafts/', suites: [] },
  { prefix: 'images/', suites: [] },
  { prefix: 'README.md', suites: [] },
  { prefix: 'CHANGELOG.md', suites: [] },
  { prefix: 'CONTRIBUTING.md', suites: [] },
  { prefix: 'LICENSE', suites: [] },
  // Non-workflow .github content (issue templates, CODEOWNERS) cannot reach
  // the built site.
  { prefix: '.github/', suites: [] },
];

/**
 * Choose the suites a set of changed paths requires.
 * Returns { suites, reason }. Unrecognised paths select everything: the
 * default has to over-run rather than under-run.
 */
export function selectSuites(changed) {
  if (changed.length === 0) return { suites: [], reason: 'no changed paths' };

  const chosen = new Set();
  const unmapped = [];

  for (const path of changed) {
    if (HARNESS.has(path)) {
      return { suites: ALL, reason: `${path} is shared browser harness` };
    }
    // A suite's own file selects exactly that suite.
    const own = ALL.find((s) => path === `browser-tests/${s}`);
    if (own) { chosen.add(own); continue; }
    // Anything else under browser-tests/ (README, fixtures) is treated as
    // harness-wide rather than guessed at.
    if (path.startsWith('browser-tests/')) {
      return { suites: ALL, reason: `${path} changes shared browser-tests state` };
    }

    const rule = RULES.find((r) => path.startsWith(r.prefix));
    if (!rule) { unmapped.push(path); continue; }
    if (rule.suites === null) {
      return { suites: ALL, reason: `${path} can affect every suite` };
    }
    for (const s of rule.suites) chosen.add(s);
  }

  if (unmapped.length > 0) {
    return { suites: ALL, reason: `unmapped path ${unmapped[0]}` };
  }
  // Keep a stable, longest-first order so the slowest suite starts first.
  const suites = ALL.filter((s) => chosen.has(s));
  return { suites, reason: `${suites.length} of ${ALL.length} suites affected` };
}

// --- self-test -------------------------------------------------------------
// Runs in CI before the matrix is trusted. A selector that under-selects makes
// every job pass while the coverage quietly disappears.
function selfTest() {
  let failures = 0;
  const check = (label, pass, detail) => {
    if (pass) { console.log(`  ok   ${label}`); return; }
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
  };
  const eq = (label, a, b) =>
    check(label, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

  eq('no paths selects nothing', selectSuites([]).suites, []);

  eq('a suite file selects only itself',
    selectSuites(['browser-tests/equations.smoke.mjs']).suites,
    ['equations.smoke.mjs']);

  eq('the CDP client selects everything',
    selectSuites(['browser-tests/cdp.mjs']).suites, ALL);

  eq('the serving harness selects everything',
    selectSuites(['browser-tests/server.mjs']).suites, ALL);

  eq('the forecast app selects everything',
    selectSuites(['assets/js/election-simulator.js']).suites, ALL);

  eq('a stylesheet selects everything',
    selectSuites(['_sass/_reset.scss']).suites, ALL);

  eq('an unrelated page selects nothing',
    selectSuites(['_pages/about.md']).suites, []);

  eq('an unrelated image selects nothing',
    selectSuites(['images/foo.png']).suites, []);

  eq('an unmapped path selects everything',
    selectSuites(['some/new/thing.txt']).suites, ALL);

  // The workflows are the harness in CI. A change that breaks the browser job
  // must not be able to select nothing and pass on a skipped matrix.
  eq('a browser workflow change selects everything',
    selectSuites(['.github/workflows/pr.yml']).suites, ALL);
  eq('the full workflow also selects everything',
    selectSuites(['.github/workflows/full.yml']).suites, ALL);
  eq('non-workflow .github content selects nothing',
    selectSuites(['.github/ISSUE_TEMPLATE/bug.md']).suites, []);

  // _data is rendered-site input: navigation.yml drives the masthead the
  // suites measure for overflow at 360px.
  eq('a Jekyll data change selects everything',
    selectSuites(['_data/navigation.yml']).suites, ALL);
  eq('ui-text also selects everything',
    selectSuites(['_data/ui-text.yml']).suites, ALL);

  const published = selectSuites(['files/election-simulator/groups.json']).suites;
  check('published forecast data selects the election suites, not equations',
    published.includes('government-builder.smoke.mjs')
    && published.includes('forecast-timeseries.smoke.mjs')
    && !published.includes('equations.smoke.mjs'), published);

  // A forecast sync adds a generation directory, which is what the provenance
  // suite resolves the comparison baseline against.
  check('published forecast data selects the provenance suite',
    selectSuites(['files/election-simulator/versions/x/manifest.json']).suites
      .includes('changes-baseline.smoke.mjs'));

  const forecastOnly = selectSuites(['browser-tests/forecast-timeseries.smoke.mjs']).suites;
  check('a forecast suite edit does not drag in builder suites',
    JSON.stringify(forecastOnly) === JSON.stringify(['forecast-timeseries.smoke.mjs']),
    forecastOnly);

  const mixed = selectSuites([
    'browser-tests/equations.smoke.mjs',
    'browser-tests/alternatives.smoke.mjs',
  ]).suites;
  eq('two suite edits select both', mixed,
    ['alternatives.smoke.mjs', 'equations.smoke.mjs']);

  // A suite renamed on disk but left in SUITES would be selected and then fail
  // to launch; one added on disk but missing from SUITES would never run at
  // all. Both are silent, so check the table against the directory.
  const onDisk = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.smoke.mjs') || f.endsWith('.contract.mjs'))
    .sort();
  eq('SUITES matches the suites on disk', ALL.slice().sort(), onDisk);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: selector self-test`);
  return failures === 0 ? 0 : 1;
}

// --- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.length > 0) {
  if (args[0] === '--self-test') {
    process.exit(selfTest());
  }
  const { suites, reason } =
    args[0] === '--all'
      ? { suites: ALL, reason: 'all suites requested' }
      : selectSuites(args.slice(1));

  const include = suites.map((s) => ({ suite: s, seconds: SUITES[s].seconds }));
  console.log(JSON.stringify({ include }));
  console.error(`selection: ${reason}`);
}
