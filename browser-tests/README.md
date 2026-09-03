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
node browser-tests/campaign-paths.contract.mjs      # static, no browser
node browser-tests/future-projection.contract.mjs   # static, no browser
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
  - Page section order: Regeringsalternativ → Bygg din egen regering → Prognos
    över tid → Röstandelar → Mandat, and nothing left of the removed
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

Exercises `Prognos över tid` at desktop and 360 px mobile widths: section
order, accessible coalition and metric toggles, joint quantile bands, raw-poll
points, the 112-day marker, the 175-seat reference, pointer/touch/keyboard
inspection, provenance copy, horizontal overflow, and browser errors. It uses
the built history artifact when present and otherwise installs its dedicated
fixture only in a temporary copy of `_site`.

It also owns the **coherent campaign-path** future region
(`future_campaign_paths`), the primary future view:

- the distinctly shaded future region labelled **Möjliga opinionsbanor**, its
  faint individual trajectories, its 50 % and 90 % predictive bands, and the
  emphasized election-day distribution labelled **Valdagsprognos**;
- the separate **Opinionsläge i dag** origin marker for path day 0. It is a
  different quantity from the certified forecast point on the same date — the
  latent opinion state, before ElectionNoise — so it is drawn as its own
  interval and the fan emanates from it, never from the forecast dot;
- `Sedan 2022` remains the opening range; `Visa kampanjperioden` is the
  discoverability cue that switches to the election-relative window where the
  future region is legible;
- `Mandatandel` draws **no** intermediate opinion paths, bands or origin
  marker — only the election-day seat distribution — and says why;
- pointer, click, focus, `Enter` and `Space` on all three new mark kinds, with
  the published Swedish copy in the detail panel;
- the `Kvarvarande osäkerhet` control switching to the demoted
  shrinking-horizon fan and back;
- fail-safe scenarios: a missing object, an election-day distribution that
  drifts from the certified production point, a declared intermediate seat
  trajectory, a declared daily random walk, and a trajectory ending after the
  origin all fall back to the historical chart with no campaign marks.

### 7. `campaign-paths.contract.mjs` — static campaign-path contract

Runs without a browser. It asserts that the *rules* the deployed consumer
enforces are present in `assets/js/election-simulator.js` — bitwise endpoint
parity, the leakage boundary, the rejected-alternative disclaimers, vote-only
bands, the accessible mark kinds — so a refactor cannot quietly drop a
fail-closed check and still pass a happy-path smoke test. It also validates the
committed fixture.

#### Regenerating the history fixture

`fixtures/coalition-timeseries.json` is the real published artifact with a
`future_campaign_paths` object built by the simulator repository, so the
browser test consumes authentic 100 000-draw numbers. Regenerate it from an
`edvinli/election-simulator` checkout:

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

`builder-blocks`, `histogram-copy`, `government-builder` and `alternatives` all
do this. `forecast-timeseries` uses the built history artifact when present and
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
suite; an unrecognised path selects every suite. Adding a suite means adding it
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
