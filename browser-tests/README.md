# Real-browser tests

These tests drive the **built** site in headless Chrome over the Chrome DevTools
Protocol. They exist because nothing else covers layout.

## Why they exist

The election forecast's Node contract tests in the
[election-simulator](https://github.com/edvinli/election-simulator) repository —
`tests.test_actual_browser_consumer` and its neighbours — run
`assets/js/election-simulator.js` against **stub DOM objects**. That harness
verifies the publication/lookup contract: which files are fetched, how a
coalition bitmask resolves, what strings are formatted. It is genuinely useful
and should be kept.

What it **cannot** see:

- computed style, box size or layout;
- whether the stylesheet actually honours the `hidden` attribute;
- whether an element the code believes is hidden is in fact painted.

A passing `test_actual_browser_consumer` is therefore *not* evidence that the
visual UI works. The regression these tests were written for
(`_sass/_reset.scss` shadowing the user-agent `[hidden] { display: none }`, so
`section.hidden = true` stopped hiding anything and the government builder
leaked an empty shell) passes every stub-DOM test and is invisible without a
real browser.

## Running

```sh
jekyll build --config _config.yml,_config.dev.yml
node browser-tests/government-builder.smoke.mjs            # defaults to ./_site
node browser-tests/builder-blocks.smoke.mjs
node browser-tests/alternatives.smoke.mjs
node browser-tests/forecast-timeseries.smoke.mjs
node browser-tests/histogram-copy.smoke.mjs
node browser-tests/equations.smoke.mjs
node browser-tests/party-timeseries.smoke.mjs              # fixture mode
node browser-tests/party-timeseries.smoke.mjs _site --real-artifact
node browser-tests/party-timeseries.contract.mjs    # static, no browser
node browser-tests/changes-baseline.smoke.mjs
```

Requirements: Node >= 22 (for the built-in `WebSocket`) and a local
Chrome/Chromium. Set `CHROME_BIN` to point at a different binary. **No packages
are installed** — `cdp.mjs` is a ~150-line CDP client over Node built-ins, which
is why there is no Puppeteer/Playwright dependency here.

The harness must serve on port **4000**: `_config.dev.yml` sets
`url: http://localhost:4000`, so the built pages carry absolute asset URLs and
the stylesheet only loads on that host and port. A run that serves on another
port still renders the markup but with no CSS, which silently invalidates every
layout assertion.

The same trap has a subtler form. `server.mjs` binds the name `localhost`, not
`127.0.0.1`, and the tests navigate to `localhost` too. On a machine where
`localhost` resolves to `::1` first, a `127.0.0.1` binding leaves `::1:4000`
free — and any other process squatting there (a stray `python -m http.server`
from a second worktree, say) answers the stylesheet request instead. The page
under test then renders with a *stranger's* CSS and every layout assertion
still passes, because the two stylesheets mostly agree. Binding the name turns
that collision into a loud `EADDRINUSE` before a single check runs.

## Test suite overview

### 1. `government-builder.smoke.mjs` — cross-schema integration

Tests the coalition builder across all published schema generations:

- **Schema 1.2 compatibility**:
  - Initial state: empty government bar (`0`), opposition holding all eight
    parties (`349` total seats, mask `255`), summary hidden (`display: none`).
  - Colored `.eg-bar__segment` mandate blocks are draggable controls; the two bars
    are drop targets.
  - `L` (0 median seats) is drawn as a zero-height draggable baseline marker.
  - 349-seat scale and dashed 175 majority rule (`Majoritetsgräns: 175 mandat`)
    positioned at 175/349 of the plot height.
  - Dragging parties (e.g. `C + S + MP`, mask 84) evaluates the published
    coalition numbers (median, 90% interval, majority probability) from
    `groups.json`.
  - Adding `V` (mask 116, median 190) lifts the government bar above the 175 line.
  - Under schema 1.2 (no `seat_histogram`), histogram remains cleanly hidden.
  - Two-state partition invariant: `government & opposition === 0` and
    `government | opposition === 255` after every move and after reset.
  - `Återställ` returns all parties to opposition and hides the summary.
  - Asserted at desktop (1280px) and mobile (360px) viewports with no horizontal
    overflow and zero console errors.

- **Schema 1.3 histogram integration**:
  - Selecting a government renders the discoverability link (`Visa mandatfördelningen ↓`)
    and the exact seat histogram (`#election-government-histogram`).
  - Histogram displays 1-seat bins matching the published simulation distribution.
  - Reset cleanly clears the histogram and hides the summary.

- **Schema 1.1 fail-closed contract**:
  - Earlier publications without `coalition_builder` keep the section hidden
    (`hidden === true`, `display: none`).

- **Preset governments and summary statistics**:
  - Six preset buttons — `S + V + MP`, `S + C + MP`, `S + C + MP + V`,
    `S + KD + C + MP`, `SD + L + M + KD`, `S + M + C` — as native `<button>`
    controls, each with one party swatch per member.
  - Clicking a preset sets the government to exactly that mask (derived from
    `party_order`, never hard-coded) and leaves the complement in opposition.
  - Exactly one preset carries `is-active` / `aria-pressed="true"` at a time;
    dragging a party out of it clears the state, dragging back restores it, and
    `Återställ` clears it along with the government.
  - Manual dragging still works after a preset has been used.
  - The `Mandatfördelning` view prints the four published summaries for the
    same entry it drew: `median_seats`, `p25–p75`, `p10–p90`, `p05–p95`.
  - Page section order: Vägen till valdagen → Regeringsalternativ →
    Bygg din egen regering → Röstandelar på valdagen → Mandat på valdagen, and
    nothing left of the removed
    Majoritetsscenarier.

### 2. `builder-blocks.smoke.mjs` — mandate block interaction

Dedicated smoke test for the colored mandate-block interaction:

- Mouse drag in both directions (Opposition → Regering and Regering → Opposition).
- Touch drag (horizontal movement claims the gesture).
- Native vertical scrolling passthrough (`touch-action: pan-y`).
- Zero-seat marker dragging (`L`).
- Smooth compositor tracking without layout interpolation lag.
- Same-side drop no-op.

### 3. `alternatives.smoke.mjs` — the Regeringsalternativ comparison

Covers the section that replaced the old Majoritetsscenarier pill selector:

- Exactly six rows, one per named coalition, masks derived from `party_order`.
- **One shared x-axis**: every track has the same box, and the 175 rule lands
  on the same pixel in every row. Each band edge is checked against where its
  published quantile falls on that one domain.
- The domain covers all six published 90 % intervals, is padded on both sides,
  snaps to five-seat marks, and always contains 175.
- Thin/light 90 % band, thicker/darker 50 % band, median marker; both inks
  neutral and identical across rows.
- **No stacked party segments** inside a bar — a coalition's quantiles are
  joint, not a sum of party medians.
- Every printed number is the `coalition_builder` lookup for that mask.
- Renders under schema 1.2 (summaries suffice) and fails closed under 1.1.
- Desktop (1280px) and mobile (360px), no overflow, zero console errors.

### 4. `histogram-copy.smoke.mjs` — histogram discoverability and copy

Dedicated smoke test for reader-facing histogram copy and discoverability:

- Summary line discoverability link (`Visa mandatfördelningen ↓`) targeting `#election-government-histogram`.
- Smooth scroll navigation to histogram on link click.
- Single dynamic denominator explanation.
- Majority probability and exact draw count matching published simulation results.
- Interactive hover on exact seat bins (e.g. 175-seat bin).

### 5. `equations.smoke.mjs` — KaTeX / MathJax typesetting

Verifies the mathematical documentation layout:

- LaTeX rendering inside collapsed `<details>`.
- Equation container scrolling without page-level horizontal overflow.
- Source fallback preservation if the CDN fails.

### 6. `forecast-timeseries.smoke.mjs` — historical forecast chart

Exercises `Vägen till valdagen` at desktop and 360 px mobile widths: section
order, accessible coalition and metric toggles, joint quantile bands, raw-poll
points, the 112-day marker, the 175-seat reference, pointer/touch/keyboard
inspection, provenance copy, horizontal overflow, and browser errors. It uses
the built history artifact when present and otherwise installs its dedicated
fixture only in a temporary copy of `_site`.

It also owns the chart's single claim — **each point is the forecast as it was
known on its date, and the last point is the forecast today**:

- `assertNoForwardView` is run in both metrics and both ranges. It requires
  that no forward-view control is in the page, that neither the section nor the
  SVG carries a `data-future-*` / `data-campaign-*` attribute, that none of the
  mark kinds the chart used to draw past today is present, that the x-axis ends
  on a published date strictly before election day, and that no copy explains a
  removed forward view;
- `Sedan 2022` is the opening range and `Sista 30 dagarna` is the 30 days up
  to the latest published forecast — not the 30 days before election day, which
  would leave a third of the plot empty;
- Röstandel gets a data-driven window in the short range
  (`data-y-domain-mode="adaptive-short-window"`); Mandatandel stays anchored on
  the 175-seat rule in both ranges;
- `exerciseUnusedForwardArtifacts` is the load-bearing one. The publication
  still carries `future_projection` and `future_campaign_paths` — dropping them
  is a simulator change the website change deliberately did not make — so the
  contract is not "the objects are gone" but "the page does not read them": a
  publication carrying both must render an identical
  `historicalFingerprint` to one carrying neither.

### 7. `party-timeseries.smoke.mjs` — the per-party view

Owns the `Koalitioner | Partier` switch and everything behind it, at desktop
and 360 px mobile widths:

- coalition mode is the default and is asserted **unchanged** — same series,
  same y-domain, same poll cloud — before and after a round trip through party
  mode. The switch is only worth having if the default experience did not move;
- one party at a time, every pill tab-reachable, exactly one `aria-pressed`,
  and the deterministic default being the largest party in the certified
  forecast;
- party poll dots equal to the **published** party number, not a
  renormalization — the check that catches the ~2 % denominator error that
  would otherwise move every party away from the 4 % line;
- the last drawn party point being the certified `current_production` forecast,
  value for value;
- the adaptive party y-domain: tighter in `Sista 30 dagarna` than in
  `Sedan 2022`, readable tick counts, and every drawn forecast point and poll
  dot inside the visible domain;
- the 4 %-spärr drawn for a threshold-near party and **absent** for a large
  one, with the scale not stretched to reach it;
- `Mandatandel` drawing the historical party mandate series and nothing beyond
  the latest forecast;
- party selection surviving a metric change and a range change;
- `Visa utveckling →` routing: scroll, switch to `Partier`, select that party,
  and land focus on the chart's own party pill;
- pointer, touch and chart-level arrow-key inspection naming the selected
  party;
- no horizontal overflow and zero console errors in both modes.

### Fixture mode vs real-artifact mode — read this before wiring a gate

`party-timeseries.smoke.mjs` has two modes, and confusing them produces a
green run that proves nothing.

**Fixture mode (default)** overlays `fixtures/coalition-timeseries.json` onto a
throwaway copy of the built site. That overwrite is deliberate: it is what
makes the mutation and fail-closed matrix deterministic, since every scenario
is a controlled edit of a known artifact. It must stay exactly as it is.

The consequence is that in fixture mode the suite **ignores the history the
site you pass it actually ships**. So

```sh
node browser-tests/party-timeseries.smoke.mjs _site     # validates the FIXTURE
```

looks like it validates a freshly generated production history and does not.

**Real-artifact mode** is the one that does:

```sh
node browser-tests/party-timeseries.smoke.mjs _site --real-artifact
```

It copies nothing and overwrites nothing. It reads the history the site ships,
and refuses to drive the browser at all unless that artifact passes every
precondition for exposing the party view: `parties_view` present and valid;
**every plotted non-archived history point** carrying all eight parties with
integral seats; exactly one certified `current_production` point; no
intermediate party mandate trajectory declared; and every published party
endpoint quantile equal to the publication's own `parties.json`.

That last check resolves `parties.json` **through `current.json`, with no
fallback**. The flat `files/election-simulator/parties.json` at the publication
root is a frozen pre-versioning artifact from a different forecast — it still
reports M at 18.621 where the pointer-resolved generation reports 18.087 — so
falling back to it would compare a fresh history against the wrong numbers.
A missing or malformed pointer is an error.

It also compares the history's `publication_generation` against the pointer's,
so a history generated from a different run than the live publication fails
with `the artifact and the publication are out of step` rather than passing on
numbers that happen to be close.

Two consequences worth stating:

- **The publication gate must use the real-artifact form.** The fixture-mode
  command would gate every future publication against a committed fixture.
- **Real-artifact mode fails today, correctly.** The currently published
  history carries no party family, so it reports `parties_view is absent: … A
  full history regeneration (without --resume) is what creates it.` and exits
  non-zero. That is the signal that the backfill has not happened yet.

The mode is self-tested on every default run: `selfTestRealArtifactMode()`
breaks each precondition in turn and requires the matching finding, proves the
reader returns the site's history rather than the fixture, proves a missing
pointer is an error rather than a flat-file fallback, and then drives the real
browser happy path from a site whose genuine history is a complete artifact.

### The fallback and fail-closed matrix

Fixture mode owns this. A publication with **no**
party family renders exactly the old page with the switch absent and the
`Visa utveckling` action hidden. A publication whose party family is declared
but broken — a renormalized denominator, uncertainty declared as reconstructed
from coalitions, or the plotted history not carrying the family end to end —
refuses party mode outright and leaves the coalition view untouched. It also
owns `runUnreadForwardArtifact`: a malformed or absent `future_campaign_paths`
is inert, since the chart no longer reads it, so party mode stays available and
no mark appears.

### 8. `party-timeseries.contract.mjs` — static per-party contract

Runs without a browser. Asserts that the fail-closed rules are present in
`assets/js/election-simulator.js` (the nine-category denominator, the refusal
to reconstruct party uncertainty from coalition data, the all-or-nothing party
family, the bounded threshold nudge), that there is exactly **one** chart
renderer and one definition namespace rather than a second pipeline, that the
page markup puts the view switch first in the control order, that no
forward-looking artifact is read and no forward view control remains in the
markup, and that the committed fixture publishes a well-formed party family
whose party ids never leak into the coalition `groups`.

#### Regenerating the history fixture

`fixtures/coalition-timeseries.json` is the real published artifact with a
`future_campaign_paths` object built by the simulator repository, so the
browser test consumes authentic 100 000-draw numbers.

The chart no longer draws that object — the timeline ends at the latest
certified forecast — and the fixture keeps it on purpose. It is what lets
`exerciseUnusedForwardArtifacts` and `runUnreadForwardArtifact` prove the
published-but-unread contract: a publication carrying both forward artifacts
must render exactly what one carrying neither renders. Drop it from the fixture
and those checks pass vacuously.

Regenerate it from an `edvinli/election-simulator` checkout:

```python
# run from the election-simulator repository root
import json
from pathlib import Path
from scripts.forecast_history.campaign_paths_contract import (
    build_future_campaign_paths, mark_secondary_projection,
)
from scripts.forecast_history.contract import deterministic_history_sha256

FIX = Path("../edvinli.github.io/browser-tests/fixtures/coalition-timeseries.json")
history = json.loads(FIX.read_text())
anchor = next(p for p in history["series"] if p["provenance"] == "current_production")
history["future_campaign_paths"] = build_future_campaign_paths(
    origin_date=anchor["date"], election_date=history["election_date"],
    anchor_point=anchor, seed=12345, data_dir=Path("data/processed"),
    coalitions={k: tuple(v) for k, v in history["coalitions"].items()},
)
history["future_projection"] = mark_secondary_projection(history["future_projection"])
history["deterministic_content_sha256"] = deterministic_history_sha256(history)
FIX.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n")
```

The builder refuses to produce an object whose election-day endpoint is not
bitwise identical to the canonical production draws, so a fixture that exists
is a fixture that passed the scientific gate.

#### The party family in the fixture

The same fixture carries the additive party family (`parties_view`,
`series[].parties`, and — inside the unread forward object —
`bands[].parties`, `paths.series[].party_values`, `election_day.parties`).
Only `parties_view` and `series[].parties` reach the chart. Backfilling party data into the historical points is
a full `scripts.forecast_history.generate` run — the resume cache keeps old
points byte-for-byte, party block or not — so regenerating it means:

```bash
# from the election-simulator repository root, about 15 minutes on 9 workers
uv run python -m scripts.forecast_history.generate --output /tmp/history.json --workers 9
```

then rolling one certified 100 000-draw production result into it with
`scripts.forecast_history.future_projection.update_history_with_production_result`,
exactly as the publication automation does. The party quantiles at the
certified point are asserted against that run's own `parties.json` values by
`scripts.forecast_history.party_contract.assert_election_day_party_parity`, so
a fixture that exists is one whose party election-day values are the published
forecast.

### 9. `changes-baseline.smoke.mjs` — publication provenance in the copy

Owns the two provenance claims the page makes in prose, both of which were
previously vague in a way no layout assertion could catch:

- **The hero's publication instant.** `Underlag t.o.m.` is a date, and two
  forecasts published five hours apart share it. The hero now also prints
  `generated_at_utc` converted to `Europe/Stockholm` — `Uppdaterad 4 sep
  13:08` — inside a `<time datetime>` carrying the published instant verbatim.
  The suite checks the rendered wall clock against the pinned generation's own
  `metadata.json`, that the conversion goes through the zone database rather
  than a fixed `+02:00`, and that any relative age is an addition to the
  absolute timestamp rather than a replacement for it.
- **The comparison baseline.** `change_since_prior` names its baseline by
  snapshot id and deterministic payload hash, never by position, so
  *föregående prognos* was a claim the payload does not make. On the pinned
  generation it is a false one: the baseline is `20260903T163419Z-fe0d69d8`
  and `20260904T082721Z-af776460` was published in between. The page resolves
  the named snapshot against the generations the build ships, verifies the
  payload hash, and prints that snapshot's own `generated_at_utc` —
  `Jämfört med prognosen 3 sep 18:34`. The suite asserts the resolved label,
  and separately asserts that the intervening publication's instant appears
  nowhere in the copy.

It also covers the table itself: the `Övr.` row (published
`vote_share_median_change_pp.REST`, with an em dash and a screen-reader
explanation instead of a `0` seat change REST cannot have), the
`Medianmandat` column name, and the non-additivity note — asserted against a
publication whose own `seat_median_change` really does not sum to zero.

**The inline chip in `Röstandelar på valdagen`.** The same published change
appears a second time, beside the level it describes, and the suite pins the
three decisions that keep the two consistent:

- **One decimal, and no number below the noise floor.** Three of this
  publication's nine changes round to a signed zero at one decimal, so a
  parenthesised `(+0,0)` would read as a measurement rather than as "smaller
  than this publication can resolve". Below `0,05` pp the chip is the `·`
  glyph alone. `deltaShape` is the single source of the floor, the glyph
  vocabulary and the accessible wording for both the chip and the table, and
  the suite asserts there is exactly one of it.
- **The chip is decorative; the change is spoken in the row's `aria-label`.**
  `.ev-head` is one button carrying its own full `aria-label`, so nothing
  inside it is announced — a `visually-hidden` unit in the chip would be
  silently dropped. The label speaks `ner 0,7 procentenheter sedan
  jämförelseprognosen`; the chip prints no unit, because the row has no width
  for `procentenheter`, the page does not abbreviate it, and a bare `-0,7`
  under `27,7 %` would read as percent rather than percentage points.
- **Two arrangements, one for each layout.** `.ev-head`, `.es-row`, `.ev-axis`
  and `.es-axis` are all sized from one `--ev-cols`, so widening the median
  column — or adding one — would move the seat rows and pull the axis ticks
  off the chart track. Wide screens therefore stack the chip inside the
  existing 4.6rem cell (`display: flex`, below the median's box); below 46em
  the median gets a flexible column and the chip sits beside it
  (`inline-flex`), which is where it belongs when vertical space is the scarce
  thing. The suite asserts both, and asserts that every row has the *same*
  height whether it moved or not — the regression it was written for is a
  chip that flows onto the median's line and wraps inside the narrow column,
  making rows with a number taller than rows without one.

The caption above the rows names the unit and the baseline once, resolved from
the same snapshot lookup the table uses, so nine chips cannot each imply a
different "since when" and the two sections cannot disagree about what they
compare against. The suite asserts they cite the same label.

The seat rows deliberately get **no** inline chip. That is where the interval
parentheses live (`Medianmandat 102 (95–109)`) and where non-additivity bites:
the seat medians are taken separately and do not sum to zero, which needs the
one place under a single column where that note can sit.

Two generations are pinned, because the fallback is half the contract:

- `20260904T110809Z-2edab481`, whose baseline resolves to an instant;
- `20260831T170410Z-1f5e0506`, whose baseline snapshot predates the versioned
  publication directory and cannot be resolved at all. There the label must
  degrade to the published `prior_as_of` date and invent no time, while the
  table renders unchanged.

Every expectation is derived from the pinned generations' artifacts on disk
rather than typed out, so a re-pin fails loudly instead of asserting a
transcription into existence. Two of them are additionally pinned to the
literal strings above, which is what makes a wrong-field regression — reading
`as_of` where `generated_at_utc` was meant — fail rather than pass on a
plausible-looking date.

**Where the generation list comes from.** A static site has no directory
listing to ask, so `_pages/election_simulator.md` enumerates the shipped
`files/election-simulator/versions/` directories from `site.static_files` at
build time into a `<script type="application/json">` block. It is
build-generated, never hand-written: the suite checks that no generation id
appears literally in the page source, and that the block matches the
directories the built site actually ships.

## Determinism: pin the generation you assert against

A suite that asserts published numbers — a median, a majority probability, an
exact histogram count — must pin the publication generation it reads, or the
next forecast sync moves the numbers underneath it.

`serve()` takes a `pointer`, and `pointerFor(siteRoot, generation)` builds a
valid one for any directory under `files/election-simulator/versions/`. Those
directories are immutable, so a pinned suite is deterministic without
regenerating anything:

```js
import { serve, pointerFor } from './server.mjs';

const TARGET_GENERATION = '20260831T170410Z-1f5e0506';
const TARGET_POINTER = await pointerFor(SITE, TARGET_GENERATION);
const server = await serve(SITE, { port: 4000, pointer: TARGET_POINTER });
```

`builder-blocks`, `histogram-copy`, `government-builder`, `alternatives` and
`changes-baseline` all do this. `forecast-timeseries` uses the built history artifact when present and
its own committed fixture otherwise.

**Also assert that the pointer took effect.** `histogram-copy` previously
declared `TARGET_GENERATION`, printed it as provenance on success, and never
passed a pointer to `serve()` — so it silently tested the live forecast against
stale numbers and failed on every sync. Both pinned suites now read
`current.json` back through the serving harness and check the served generation
matches, which turns that mistake into a named failure.

Re-pinning is a deliberate act: bump `TARGET_GENERATION` and update the
expectations from that generation's `groups.json` in the same change.

## Continuous integration

`.github/workflows/pr.yml` builds the site once and runs the browser suites a
change can affect; `.github/workflows/full.yml` runs all of them on pushes to
`master`.

Each suite gets its own runner. That is required, not preferred: `server.mjs`
binds port 4000 by name because `_config.dev.yml` gives the built pages
absolute `http://localhost:4000` asset URLs, so two suites cannot share a
runner. Wall-clock is therefore the slowest single suite (~30 s) rather than
the ~90 s serial total.

`browser-tests/select-suites.mjs` decides what is affected and carries its own
checks:

```sh
node browser-tests/select-suites.mjs --self-test
node browser-tests/select-suites.mjs --changed assets/js/election-simulator.js
```

The rules fail toward running more. A change to a single suite file selects
that suite; a change to `cdp.mjs`, `server.mjs`, `_sass/**`, `_includes/**`,
`_data/**`, `.github/workflows/**` or `election-simulator.js` selects every
suite; a change under `files/election-simulator/` selects every suite that
reads published artifacts, `changes-baseline` included — a sync that only adds
a generation directory moves that suite's baseline resolution even when no
rendered number changes; an unrecognised path selects every suite. Adding a suite means adding it
to `SUITES` — the self-test compares that table against the directory, so a
suite present on disk but missing from the table fails rather than quietly
never running.

Two of those entries are there for reasons worth stating, because both were
initially classified as affecting nothing:

- **`.github/workflows/**`** — in CI the workflows *are* the harness. They build
  the site, move it between jobs, locate Chrome and run the suites. A change
  that broke any of that would otherwise select nothing, the browser matrix
  would be skipped, and `Website PR required checks` would accept the skip and
  pass.
- **`_data/**`** — Jekyll data is rendered-site input, not inert configuration.
  `navigation.yml` drives the masthead and `ui-text.yml` the chrome around every
  page, both of which appear on the election page and both of which the suites
  measure — including the no-horizontal-overflow checks at 360 px. The selector
  cannot prove a given key is unused, so it does not try.
