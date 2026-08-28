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
node browser-tests/histogram-copy.smoke.mjs
node browser-tests/equations.smoke.mjs
```

Requirements: Node >= 22 (for the built-in `WebSocket`) and a local
Chrome/Chromium. Set `CHROME_BIN` to point at a different binary. **No packages
are installed** — `cdp.mjs` is a ~150-line CDP client over Node built-ins, which
is why there is no Puppeteer/Playwright dependency here.

The harness must serve on port **4000**: `_config.dev.yml` sets
`url: http://localhost:4000`, so the built pages carry absolute asset URLs and
the stylesheet only loads on that port. A run that serves on another port still
renders the markup but with no CSS, which silently invalidates every layout
assertion.

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

### 2. `builder-blocks.smoke.mjs` — mandate block interaction

Dedicated smoke test for the colored mandate-block interaction:

- Mouse drag in both directions (Opposition → Regering and Regering → Opposition).
- Touch drag (horizontal movement claims the gesture).
- Native vertical scrolling passthrough (`touch-action: pan-y`).
- Zero-seat marker dragging (`L`).
- Smooth compositor tracking without layout interpolation lag.
- Same-side drop no-op.

### 3. `histogram-copy.smoke.mjs` — histogram discoverability and copy

Dedicated smoke test for reader-facing histogram copy and discoverability:

- Summary line discoverability link (`Visa mandatfördelningen ↓`) targeting `#election-government-histogram`.
- Smooth scroll navigation to histogram on link click.
- Single dynamic denominator explanation.
- Majority probability and exact draw count matching published simulation results.
- Interactive hover on exact seat bins (e.g. 175-seat bin).

### 4. `equations.smoke.mjs` — KaTeX / MathJax typesetting

Verifies the mathematical documentation layout:

- LaTeX rendering inside collapsed `<details>`.
- Equation container scrolling without page-level horizontal overflow.
- Source fallback preservation if the CDN fails.
