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

# The schema-1.3 cases need the preserved joint seat matrix; see below.
SEATS_MATRIX=/path/to/seats_matrix.npy node browser-tests/government-builder.smoke.mjs
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

The panel is a direct-manipulation builder with **two** states per party —
*Regering* and *Opposition* — and the invariant the whole file is organised
around is that those two partition the eight parties: `government &
opposition === 0` and `government | opposition === 255`, asserted after every
move, at the initial state (`0` / `255`) and after *Återställ*. The page stores
only the government mask and derives the opposition as its complement, so the
sides cannot drift apart; the tests read both back off the DOM and check the
partition anyway.

The party card is the whole interaction. There is no button and no grip inside
it: the block is what a pointer grabs, and it is also the control — it takes
focus and `Enter` or `Space` sends it to the other side.

The drags are driven as **real input**: CDP mouse and touch events through the
browser's own pointer pipeline, not synthetic `DragEvent` objects dispatched at
the handlers. A drag that only works because the test constructed the event is
not a drag.

The run is deliberately split into one long session plus a series of short ones:

### `schema12()` — one session per viewport, 1280px and 360px

- *Copy*: the Swedish intro sentence and the `Regering` / `Opposition` /
  `Återställ` / `90 % prognosintervall` / `Sannolikhet för minst 175 mandat`
  labels, and the government-only disclaimer.
- *Initial state*: an empty government beside an opposition holding all eight
  parties — masks `0` and `255`, the opposition total `349` with its bar filled
  to the top of the 0–349 scale, only the government side showing a drop hint,
  and the summary genuinely `display: none`.
- *Card anatomy*: no `.eg-party__move` button and no `.eg-party__grip` survive
  anywhere; a card contains no `button`, `a`, `input`, `[role="button"]` or
  `[tabindex]` of its own; `Återställ` is the only `<button>` in the panel; and
  nothing opens a popup. `draggable` is `"false"`, because the pointer handlers
  own the drag and native HTML5 dragging cannot reach a touchscreen. Each card
  is `role="button" tabindex="0"` and carries the whole accessible name —
  `Socialdemokraterna (S), 110 mandat i median, i Opposition. Tryck Enter för
  att flytta till Regering.` — which flips to name the way back once the party
  is governing.
- *Target sizes*: `cursor: grab` on every card, and every card at least 32px
  tall with a fine pointer, so the row rhythm the grip used to hold open is
  preserved. The touchscreen sizes are a case of their own, below.
- *Shared scale*: both bars the same height and the same top edge; the majority
  rule dashed, spanning both columns, positioned at 175/349 of the plot to
  within 1.5px, and labelled `Majoritetsgräns: 175 mandat`.
- *Dragging*: Opposition → Regering and Regering → Opposition, each asserted to
  leave the party in exactly one zone, with no duplicate anywhere and the
  partition intact; a drop back onto a card's own side asserted to be a no-op;
  and a **touch** drag of the card placing a party the same way a mouse drag
  does.
- *A press that does not travel*: a real click on a card, with no pointer
  movement at all, must leave the party where it is. The block is both the
  handle and the control, so the drag threshold is the only thing separating a
  click from a move.
- *The card as a control*: an `Enter` reaching the card's own key handler moves
  the party, and the live region announces the move and then the state it left
  behind (`Kristdemokraterna (KD) flyttades till Regering. Regering …`).
- *Reset*: `Återställ` returns all eight parties to Opposition, restores
  government `0` / opposition `255`, hides the summary and announces itself.
- *Masks and results*: government mask 84 (`C + S + MP`) with opposition mask
  171 (`M + L + KD + V + SD`) as its exact complement, on the two column heads
  and on the summary; the summary's `data-coalition-mask` equal to the
  **government** mask, because that is the coalition being evaluated; the
  published median, 90 % interval and majority probability for that mask; the
  opposition's own median looked up on its own mask, with **no** probability
  printed for it. `C + S + MP` is used because its majority probability is
  genuinely nontrivial (10,78 %) — a panel that silently printed 0 %, 100 % or
  another mask's value would pass against a coalition that is hopeless or
  certain, and the test asserts the fixture's value is still strictly between
  2 % and 98 %.
- *Each bar draws the number it prints*: each side's measured pixel stack
  equals its own coalition median on the 0–349 scale, so the drawing and the
  printed number cannot diverge; plus both bars' `aria-label`s (built from the
  fixture's single-party medians, not copied into the test) and the live
  region. In a true partition the complement of a losing government is usually
  a winning opposition, and the test asserts the panel draws exactly that: 162
  below the rule against 187 above it.
- *Crossing the rule*: adding `V` to that government (mask 116, median 190)
  must lift the government bar **above** the dashed rule while its complement
  (mask 139, median 159) drops below it. The test also asserts the fixture
  still contains such a case, so a data refresh that removes one fails loudly
  rather than quietly weakening the check.
- *Layout*: no sideways scroll on the document or the panel and nothing inside
  it reaching past the viewport — checked again with all eight parties driven
  into one column, which is the widest and tallest a zone ever gets.
- No console errors and no uncaught exceptions.

### `dragCase()` — one browser per drag

Both directions a card can travel — there is no third — each in a fresh session
asserting the whole resulting state: Opposition → Regering completing
`C + S + MP`, Regering → Opposition breaking it up, and Regering → Opposition
emptying the government altogether. Each case checks the party exists exactly
once, sits in the expected zone, that no card is duplicated anywhere, that all
eight parties are still placed exactly once, that the government mask is right
and the opposition mask is its complement, and that the displayed median and
probability are the published values for the resulting government mask (or that
an empty government prints no result at all).

### `keyboardCase()` and friends — one browser per case

Accessibility is not weakened here, only isolated. See **the key budget** below
for why each case gets its own browser.

- `Tab` from the reset control reaching a **party card**, with a computed
  outline and a real `:focus-visible` match. `:focus-visible` deliberately does
  not match a programmatic `focus()` after pointer input, so the ring is only
  meaningful once a real key has moved focus.
- `Enter` across and `Space` back, against real input, from each of the two
  states a card can start in. One press is the whole move, so a case spends two
  keys and no more.

Every step asserts the resulting zone, that the party exists exactly once, that
the partition holds, that **focus follows the card into its new side** — a
keyboard user must not be dumped at the top of the document after every move,
and the move rebuilds both columns, so the card being focused is a new element
— and that the newly focused card's accessible name names the side it is now
on.

### `touchGestures()` — scrolling and dragging the same block

`Emulation.setEmulatedMedia` cannot override `pointer` or `hover`: they are not
overridable media features, and Blink derives them from the device's touch
capability. `Emulation.setTouchEmulationEnabled` is what makes
`(pointer: coarse)` match, so that is what this case uses.

The card is the drag handle and it fills most of the column, so the page would
be unscrollable if the block simply claimed every touch. It claims one
direction instead: `touch-action: pan-y` leaves vertical panning to the
browser, and the panel starts a drag only on a sideways move — the direction a
card actually travels between the two columns — or on a deliberate
press-and-hold. All three are exercised as real gestures:

- a **vertical swipe** starting on a card, synthesized with
  `Input.synthesizeScrollGesture` so the browser rather than the test decides
  whether `touch-action` lets it through, must scroll the page and leave the
  party where it is;
- a **sideways drag** must move it;
- a **press-and-hold** must lift the card — ghost, dimmed original and the
  destination highlighted — while the finger is still down and has not moved,
  and then drop it wherever it goes.

The case also asserts every card is at least 44px tall under a finger
(WCAG 2.5.8 AA), that `touch-action` really is `pan-y`, the partition after
each gesture, and that none of it widens the layout.

### `schema13()` — the exact seat histogram

Schema 1.3 adds one `seat_histogram` per combination: `min_seats` plus a count
for every seat value from there up. The panel draws it as one bar per seat —
there is no binning choice, no kernel and no smoothing — and it draws it for
the **government mask alone**. The opposition is never unioned into the figure
or into its probability.

**Where the fixture comes from.** The repository's published forecast is
immutable and stays schema 1.2, so a 1.3 publication has to be assembled at run
time. It is assembled from the *preserved joint draws behind that very 1.2
generation* — the 100 000-row seat matrix kept beside the covariance audit,
pinned by SHA-256 in `schema13-fixture.mjs`. Nothing is resampled, smoothed or
invented. Every summary field in the fixture is the published number, and the
only field added is the histogram; the builder refuses to run unless each
derived histogram reproduces that entry's published mean, all seven quantiles
and `prob_majority` exactly. The 1.3 generation is written into a temporary
copy of the built site and deleted afterwards — never under
`files/election-simulator/versions`, and `current.json` is never touched.

The matrix is not in any repository. Point `SEATS_MATRIX` at it to run these
cases; without it they are skipped loudly rather than run against invented
numbers. A matrix that is *present but has the wrong digest* is an error, not a
skip — deriving expectations from a different simulation would be worse than
running nothing.

At 1280px and 360px the case asserts:

- the two-state builder is unchanged under 1.3 — masks still `0`/`255`, no move
  button, no grip, every card still `role="button" tabindex="0"`;
- an empty government draws no histogram at all;
- a whole-card drag brings the figure up on the dragged party's own mask;
- for `C + S + MP`: the exact support, one bin per seat value, and **every bin's
  count equal to the published count**; the bins at or above 175 summing to the
  same number of draws the summary's `10,78 %` is computed from; the heading
  counting the validated draws rather than a number typed into the markup; the
  context naming the government and only the government; one colour chip per
  governing party; every bin focusable and named; the SVG kept as a named group
  so its bins survive in the accessibility tree;
- the 175 rule drawn at 175, labelled in seats, and left **neutral** — it is a
  property of the Riksdag, not of the coalition, so it never takes the accent;
- a real mouse hover over the busiest bin publishing that bin's exact count;
- the figure redrawing on every government change — a drag, an `Enter` and a
  `Space` — and the previous mask's hover detail not surviving the redraw;
- `Återställ` clearing the figure away cleanly;
- the accent cases `112` (S+V+MP) → S, `84` (C+S+MP) → S and `139` (M+L+KD+SD)
  → SD, each checked against a second implementation of the rule (largest
  one-party median, ties to the earlier party in `party_order`) and against the
  whole derived palette, not just the accent;
- no sideways overflow, no console errors, no uncaught exceptions.

### `schema13FailsClosed()` — a histogram that disagrees with its summary

The same fixture with one draw moved to the neighbouring seat value in one
mask: the total is untouched and only the distribution shifts, which is the
quietest way for a chart and the numbers beside it to disagree. The whole
builder must stay hidden, exactly as a 1.1 publication does. Without this case
an inert validator would look identical to a working one.

### `schema11FailsClosed()` — the older publication

A publication without a `coalition_builder` must leave no trace of the panel:
the `hidden` attribute still set, `display: none`, zero height, no cards, no
bar segments, no per-card controls, nothing focusable in the tab order, no
summary text — and the column heads still
carrying the markup's `0` / `0`, so an unusable publication cannot look like a
chamber with everybody in opposition. This is the empty-shell regression the
whole file was written for.

### The key budget (a harness limitation, not a page defect)

Headless Chrome stops answering CDP after roughly **five**
`Input.dispatchKeyEvent` presses in a browser session. Renderer *and*
browser-level commands stop returning — `Runtime.evaluate` and
`Browser.getVersion` alike — with the browser idle at 0% CPU and the WebSocket
still open. It reproduces on a fifteen-line data-URL page containing none of
this project's code, for `Tab`, `Escape`, `ArrowDown` and `Enter` equally, so
it is a property of the harness rather than anything the builder does.

The consequences for this file, all of them test-side:

- keyboard checks are split across short-lived browsers, **one or two presses
  each**, well inside the limit;
- after real key input a case reads back only the few DOM facts it needs
  (`readState`) rather than the whole panel — a large `evaluate` is the first
  thing a nearly exhausted session swallows;
- anything that does not need a *browser default action* is driven by script
  instead, which costs nothing.

No sleeps or retries were added to paper over this, and no product behaviour
was changed to accommodate it: the panel's keyboard support and focus
management are exactly what a user gets.

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
