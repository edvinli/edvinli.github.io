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
node browser-tests/government-builder.smoke.mjs path/to/_site
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

## What `government-builder.smoke.mjs` covers

The publication pointer is overridden **in the test server**, so the repository's
`files/election-simulator/current.json` is never touched and no local pointer
edit can leak into a commit. The expected seat numbers are read from the pinned
fixture's `groups.json`, not hard-coded, so the test compares the page against
the published lookup rather than against a copy of it.

- **schema 1.2** (`20260828T064703Z-1da59168`), at 1280px and 360px:
  - *Copy*: the Swedish intro sentence and the `Tillgängliga partier` /
    `Regering` / `Stödpartier` / `Tillsammans` /
    `Sannolikhet för minst 175 mandat` labels, and the "not a probability of
    forming a government" disclaimer.
  - *Initial empty state*: all eight parties in the pool with a real box each,
    both columns empty and saying so, both totals `0`, no bar segments, both
    column masks `0`, the prompt visible, and the summary and the medians note
    genuinely `display: none`.
  - *Shared scale*: both bars the same height and the same top edge; the
    majority rule dashed, spanning both columns, positioned at 175/349 of the
    plot to within 1.5px, and labelled `Majoritetsgräns: 175 mandat` — asserted
    **not** to say "50 %".
  - *Movement and membership*: a party moved pool → Regering → Stödpartier →
    pool, with focus following it each time; no party ever present in two
    zones; an empty Regering still suppressing the summary. Then `M + KD + SD`
    as government and `L` added as support **through the drag handlers**.
  - *Masks and results*: government mask 137, support mask 2, union mask 139 on
    the summary; the five published numbers (both column medians, the combined
    median, the union 90 % interval and the union probability) matching the
    fixture; the stacked bar's measured pixel height equal to the coalition
    median on the 0–349 scale, so the drawing and the printed number cannot
    diverge; the bar's `aria-label` and the live region.
  - *Keyboard*: a real `Tab` keypress landing on a builder control that matches
    `:focus-visible` and computes a non-zero outline.
  - *Layout*: no sideways scroll on the document or the panel, and no element
    inside the panel reaching past the viewport.
  - No console errors and no uncaught exceptions.
- **schema 1.1** (`20260827T205828Z-e6c6ee97`), which has no `coalition_builder`:
  the panel must keep its `hidden` attribute *and* compute to `display: none`,
  with no tiles, no bar segments and no summary text. This is the fail-closed
  assertion — the renderer declining to build the panel must leave no trace of
  it on the page.
