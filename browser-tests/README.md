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

## What `government-builder.smoke.mjs` covers

The publication pointer is overridden **in the test server**, so the repository's
`files/election-simulator/current.json` is never touched and no local pointer
edit can leak into a commit. The expected seat numbers are read from the pinned
fixture's `groups.json`, not hard-coded, so the test compares the page against
the published lookup rather than against a copy of it.

The panel is a direct-manipulation builder with three states per party —
*Tillgängliga partier*, *Regering*, *Opposition* — so the drags are driven as
**real input**: CDP mouse and touch events through the browser's own pointer
pipeline, not synthetic `DragEvent` objects dispatched at the handlers. A drag
that only works because the test constructed the event is not a drag.

The run is deliberately split into one long session plus a series of short ones:

### `schema12()` — one session per viewport, 1280px and 360px

- *Copy*: the Swedish intro sentence and the `Tillgängliga partier` /
  `Regering` / `Opposition` / `Återställ` /
  `90 % prognosintervall` / `Sannolikhet för minst 175 mandat` labels, and the
  government-only disclaimer.
- *Initial empty state*: all eight parties in the pool with a real box each,
  both sides empty and inviting a drop, both totals `0`, no bar segments, both
  side masks `0`, and the summary genuinely `display: none`.
- *Card anatomy*: every card carries a grip; `draggable` is `"false"`, because
  the pointer handlers own the drag and native HTML5 dragging cannot reach a
  touchscreen; each card's menu offers exactly the two states it is not in.
- *Target sizes*: every move control at least 24px on its short side (WCAG
  2.5.8 AA), and every grip a full-height strip at least 14px wide.
- *Shared scale*: both bars the same height and the same top edge; the majority
  rule dashed, spanning both columns, positioned at 175/349 of the plot to
  within 1.5px, and labelled `Majoritetsgräns: 175 mandat`.
- *Dragging*: pool → Regering, pool → Opposition, Regering → Opposition and
  back to the pool, each asserted to leave the party in exactly one zone with
  no duplicate anywhere; a drop back onto a card's own side asserted to be a
  no-op; and a **touch** drag from the grip placing a party the same way a
  mouse drag does.
- *The move menu under real pointer input*: a real click opens the menu and a
  real click on an entry performs the move. This is not the same path as a
  scripted `.click()`, which skips the `pointerdown` a real tap fires —
  `pointerdown` on the card is exactly where an earlier revision tore the menu
  down before the entry's click could land.
- *Reset*: `Återställ` returns all eight parties to the pool, clears both
  masks, hides the summary and announces itself.
- *Masks and results*: government mask 84 (`C + S + MP`) and opposition mask
  137 (`M + KD + SD`) on the two column heads and on the summary, asserted
  disjoint; the summary's `data-coalition-mask` equal to the **government**
  mask, because that is the coalition being evaluated; the published median,
  90 % interval and majority probability for that mask; the opposition's own
  median looked up on its own mask, with **no** probability printed for it.
  `C + S + MP` is used because its majority probability is genuinely nontrivial
  (10,78 %) — a panel that silently printed 0 %, 100 % or another mask's value
  would pass against a coalition that is hopeless or certain, and the test
  asserts the fixture's value is still strictly between 2 % and 98 %.
- *Each bar draws the number it prints*: each side's measured pixel stack
  equals its own coalition median on the 0–349 scale, so the drawing and the
  printed number cannot diverge; plus both bars' `aria-label`s and the live
  region.
- *Crossing the rule*: adding `V` to that government (mask 116, median 190)
  must lift the government bar **above** the dashed rule while the opposition
  bar stays below it. The test also asserts the fixture still contains such a
  case, so a data refresh that removes one fails loudly rather than quietly
  weakening the check.
- *Layout*: no sideways scroll on the document or the panel, nothing inside the
  panel reaching past the viewport, and the same again with a menu open — an
  absolutely positioned menu is the one thing that can hang off the right edge
  of a 360px column.
- No console errors and no uncaught exceptions.

### `dragCase()` — one browser per drag

Every direction a card can travel, each in a fresh session asserting the whole
resulting state: pool → Regering, pool → Opposition, Regering → Opposition,
Opposition → Regering, and an assigned party back to Tillgängliga partier.
Each case checks the party exists exactly once, sits in the expected zone, that
no card is duplicated anywhere, that all eight parties are still placed exactly
once, that **both** side masks are right, and that the displayed median and
probability are the published values for the resulting government mask (or that
an empty government prints no result at all).

### `keyboardCase()` and friends — one browser per case

Accessibility is not weakened here, only isolated. See **the key budget** below
for why each case gets its own browser.

- `Tab` from the reset control reaching a card's move control, with a computed
  outline and a real `:focus-visible` match. `:focus-visible` deliberately does
  not match a programmatic `focus()` after pointer input, so the ring is only
  meaningful once a real key has moved focus.
- `Escape` closing an open menu, clearing `aria-expanded` and handing focus
  back to the control it came from. This is the panel's own `keydown` listener
  rather than a browser default action, so an in-page `KeyboardEvent` is the
  real code path and costs no key budget.
- `Enter` moving a pool party to Regering, and `Space` doing the same — the two
  keys that activate a button, each proved once against real input.
- `ArrowDown` then `Enter` moving a pool party to Opposition, i.e. the second
  entry in the menu.
- `Enter` returning an assigned party to Tillgängliga partier, and `ArrowDown`
  then `Enter` moving a governing party across to Opposition.

Every keyboard case asserts the resulting zone, that the party exists exactly
once, that no menu is left open, that both side masks are correct, and that
**focus follows the card into its new home** — a keyboard user must not be
dumped at the top of the document after every move.

### The key budget (a harness limitation, not a page defect)

Headless Chrome stops answering CDP after roughly **five**
`Input.dispatchKeyEvent` presses in a browser session. Renderer *and*
browser-level commands stop returning — `Runtime.evaluate` and
`Browser.getVersion` alike — with the browser idle at 0% CPU and the WebSocket
still open. It reproduces on a fifteen-line data-URL page containing none of
this project's code, for `Tab`, `Escape`, `ArrowDown` and `Enter` equally, so
it is a property of the harness rather than anything the builder does.

The consequences for this file, all of them test-side:

- keyboard checks are split across short-lived browsers, **two or three presses
  each**, well inside the limit;
- after real key input a case reads back only the few DOM facts it needs
  (`readState`) rather than the whole panel — a large `evaluate` is the first
  thing a nearly exhausted session swallows;
- anything that does not need a *browser default action* is driven by script
  instead, which costs nothing.

No sleeps or retries were added to paper over this, and no product behaviour
was changed to accommodate it: the panel's keyboard support, focus management
and menu semantics are exactly what a user gets.

`cdp.mjs` also drains Chrome's stdout/stderr and fails any pending command when
the connection drops. The pipes were previously opened and never read, which
deadlocks Chrome once the OS pipe buffer fills; and a dead connection used to
leave every pending promise unsettled, so a crashed browser looked like a
hanging page.

## What `equations.smoke.mjs` covers

The equations in "Så fungerar modellen" are authored as LaTeX text inside
`.election-equation` blocks and typeset by a pinned MathJax 3 build
(`mathjax@3.2.2/es5/tex-chtml.js`, loaded from jsDelivr with an SRI hash on
this page only). Three properties of that arrangement need a real browser:

- the blocks sit inside a **collapsed `<details>`**, and CHTML cannot measure a
  `display: none` subtree, so typesetting is deferred to the first `toggle`;
- a wide equation must **scroll inside its own panel** instead of widening the
  page, and must not be clipped by it;
- if MathJax never loads, the **LaTeX source has to stay on the page** rather
  than the equations disappearing.

At 1280px and 360px, after opening the section: all 11 blocks typeset as
display math with a non-zero box, no block wider than its column, nothing
clipped vertically, every equation's full width reachable by scrolling, no
page-level horizontal overflow, `MathJax.version === '3.2.2'`, and no console
errors or uncaught exceptions. A final pass blocks `*cdn.jsdelivr.net*` and
asserts all 11 blocks still show their `\[ … \]` source.
