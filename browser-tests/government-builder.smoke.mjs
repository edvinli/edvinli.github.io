// Real-browser smoke test for the "Bygg din egen regering" coalition builder.
//
// This is the only coverage in either repository that exercises the panel in a
// real DOM with the real stylesheet applied. The Node contract tests in the
// election-simulator repository (tests.test_actual_browser_consumer and its
// neighbours) run the module against stub DOM objects: they verify the
// data/lookup contract only, and cannot observe computed style, layout or the
// `hidden` attribute actually taking effect. A regression that leaves a panel
// visible-but-empty, a bar drawn off its scale, or a 360px column overflowing
// the page passes those tests and fails this one.
//
// The panel has exactly two states per party: Regering and Opposition. The
// invariant the whole file is organised around is that they partition the
// eight parties -- government & opposition === 0 and government | opposition
// === 255 -- at every point in a session, including the initial state
// (government 0, opposition 255) and after Återställ.
//
// The party card is the whole interaction: there is no button and no grip
// inside it. It is what the pointer grabs, and it is also the control -- it
// takes focus and Enter or Space sends it to the other side. So the drags are
// driven as real input: CDP mouse and touch events through the browser's own
// pointer pipeline, not synthetic DragEvent objects dispatched at the
// handlers. A drag that only works because the test constructed the event is
// not a drag.
//
// Layout of the run:
//
//   schema12()            one long session per viewport: copy, layout, drags,
//                         reset, card anatomy, overflow, lookup;
//   dragCases()           one short session per drag direction, each asserting
//                         the whole resulting state (zone, masks, numbers);
//   keyboardCases()       one short session per keyboard case, each spending
//                         at most two real key presses -- see KEY BUDGET;
//   touchGestures()       scroll versus drag under an emulated touchscreen;
//   schema11FailsClosed() the fail-closed contract for the older publication.
//
// KEY BUDGET. Headless Chrome stops answering CDP after roughly five
// Input.dispatchKeyEvent presses in a session: renderer and browser-level
// commands alike stop returning, at 0% CPU. It reproduces on a fifteen-line
// page with none of this project's code, for Tab, Escape, ArrowDown and Enter
// equally, so it is a limitation of the test harness rather than anything the
// panel does -- see browser-tests/README.md. The keyboard cases are therefore
// split across short-lived browsers, spend one or two presses each, and read
// back only the few DOM facts they need instead of the whole panel.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/government-builder.smoke.mjs [path/to/_site]
//
// Dependencies: Node >= 22 (built-in WebSocket) and a local Chrome/Chromium.
// Override the binary with CHROME_BIN. Nothing is installed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';

// The schema-1.2 publication that carries the coalition builder, and the
// schema-1.1 publication that predates it. Both are committed under
// files/election-simulator/versions/.
const GENERATION_1_2 = '20260828T064703Z-1da59168';
const GENERATION_1_1 = '20260827T205828Z-e6c6ee97';

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
const BIT = {};
PARTY_ORDER.forEach((party, index) => { BIT[party] = 1 << index; });
// Every party, as one mask. The two sides always partition exactly this.
const FULL_MASK = (1 << PARTY_ORDER.length) - 1;               // 255
// Conventional left-to-right Riksdag seating: the order the bars stack in,
// and (reversed) the order the cards are listed in below them.
const SEATING = ['V', 'S', 'MP', 'C', 'L', 'KD', 'M', 'SD'];
const CHAMBER = 349;
const MAJORITY = 175;
// Swedish typography puts a non-breaking space before a percent sign, and the
// page emits one. Spelling it out keeps the expected strings readable.
const NBSP = '\u00a0';

// C + S + MP govern. Chosen because its majority probability is genuinely
// nontrivial (10,78 %): a panel that silently printed 0 %, 100 % or the wrong
// mask's value would pass against a coalition that is hopeless or certain.
const GOVERNMENT = ['C', 'S', 'MP'];
const GOVERNMENT_MASK = BIT.C | BIT.S | BIT.MP;      // 84
// Everyone else is the opposition, by construction rather than by choice.
const OPPOSITION_MASK = FULL_MASK ^ GOVERNMENT_MASK; // 171
// Adding V to the same government crosses the rule: median 190 of 349.
const MAJORITY_MASK = GOVERNMENT_MASK | BIT.V;       // 116

// The card is now the target, so its own box is what has to be comfortable:
// the row height the grip used to hold open with a fine pointer, and the WCAG
// 2.5.8 (AA) 44px on a touchscreen.
const MIN_CARD_HEIGHT = 32;
const TOUCH_CARD_HEIGHT = 44;
// A vertical swipe over a card must still scroll the page. Synthesized as a
// real touch gesture, so `touch-action` decides the outcome, not the test.
const SCROLL_DISTANCE = 160;

const GOVERNMENT_ZONE = 'election-government-parties';
const OPPOSITION_ZONE = 'election-opposition-parties';
const ZONE_IDS = [GOVERNMENT_ZONE, OPPOSITION_ZONE];
const ZONE_OF_ACTION = {
  government: GOVERNMENT_ZONE, opposition: OPPOSITION_ZONE,
};

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1400 },
  { name: 'narrow-360', width: 360, height: 900 },
];
// The isolated cases each pay for a browser launch, so they run at one
// viewport; the drag and fallback paths are exercised at both by schema12.
const CASE_VIEWPORT = VIEWPORTS[0];

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || detail === undefined ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tolerance) =>
  check(name, Math.abs(actual - expected) <= tolerance,
    `expected ${expected} +/- ${tolerance}, got ${actual}`);

/**
 * The two-state invariant, asserted from whatever masks a reader just took off
 * the page. Every path through the panel goes through this.
 */
function partitions(label, government, opposition) {
  const g = Number(government);
  const o = Number(opposition);
  check(`${label}: the two sides are disjoint`, Number.isInteger(g) && Number.isInteger(o) && (g & o) === 0,
    `government ${government} & opposition ${opposition} = ${g & o}`);
  check(`${label}: the two sides cover all eight parties`, (g | o) === FULL_MASK,
    `government ${government} | opposition ${opposition} = ${g | o}, want ${FULL_MASK}`);
}

/** Ignore asset noise that comes from serving a dev build, not from the app. */
const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  // Let the synchronous render pass following the load settle.
  await new Promise((r) => setTimeout(r, 300));
}

const settle = () => new Promise((r) => setTimeout(r, 140));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Serve the built site, open the page and wait for the forecast to render. */
async function open(viewport, pointer, { coarse = false } = {}) {
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  // Touch emulation, not setEmulatedMedia: `pointer` and `hover` are not
  // overridable media features in CDP, and Blink derives them from the
  // device's touch capability instead. Turning that on is what makes
  // `(pointer: coarse)` match, which is the whole point of the case.
  if (coarse) {
    await browser.S('Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 });
  }
  await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
  await waitForApp(browser);
  return { server, browser };
}

/** Run `body` against a fresh browser, then always tear it down. */
async function session(viewport, pointer, body, options) {
  const { server, browser } = await open(viewport, pointer, options);
  try {
    await body(browser);
    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Page readers. Every one of these runs inside the real page.
// ---------------------------------------------------------------------------

const readPanel = (browser) => browser.evaluate(() => {
  // The page uses NBSP deliberately (Swedish typography puts one before %),
  // so collapse ordinary whitespace only -- /\s+/ would erase the difference.
  const flat = (value) => value.replace(/[\t\n\r ]+/g, ' ').trim();
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      hiddenAttr: el.hidden,
      display: style.display,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
    };
  };
  const byId = (id) => {
    const el = document.getElementById(id);
    return el ? box(el) : null;
  };
  const cards = (hostId) => Array.from(
    document.querySelectorAll(`#${hostId} .eg-party`)
  ).map((el) => {
    const style = getComputedStyle(el);
    return Object.assign({
      party: el.getAttribute('data-party'),
      zone: el.getAttribute('data-zone'),
      // Native HTML5 dragging must stay off: the pointer handlers own the drag.
      nativeDraggable: el.getAttribute('draggable'),
      // The card is the control: it takes focus and carries the whole name.
      role: el.getAttribute('role'),
      tabindex: el.getAttribute('tabindex'),
      label: el.getAttribute('aria-label'),
      cursor: style.cursor,
      touchAction: style.touchAction,
      // Nothing inside a card may be a control of its own any more.
      inner: el.querySelectorAll(
        'button, a, input, [role="button"], [tabindex], .eg-party__move, .eg-party__grip').length,
      text: flat(el.textContent),
    }, box(el));
  });
  const segments = (barId) => Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).map((el) => ({
    party: el.getAttribute('data-party'),
    height: Math.round(el.getBoundingClientRect().height * 100) / 100,
    label: el.textContent.trim(),
  }));
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? flat(el.textContent) : null;
  };
  const summary = document.getElementById('election-government-results');
  const metrics = {};
  Array.from(summary.querySelectorAll('div[data-metric]')).forEach((row) => {
    metrics[row.getAttribute('data-metric')] = {
      term: flat(row.querySelector('dt').textContent),
      value: flat(row.querySelector('dd').textContent),
    };
  });

  const majority = document.querySelector('.eg-chart__majority');
  const plot = document.querySelector('.eg-chart__plot');
  const majorityRect = majority.getBoundingClientRect();
  const plotRect = plot.getBoundingClientRect();

  const stackHeight = (barId) => Math.round(Array.from(
    document.querySelectorAll(`#${barId} .eg-bar__segment`)
  ).reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) * 100) / 100;

  return {
    section: byId('election-government-builder'),
    summaryBox: byId('election-government-results'),
    reset: byId('election-builder-reset'),
    resetLabel: text('election-builder-reset'),
    government: cards('election-government-parties'),
    opposition: cards('election-opposition-parties'),
    governmentBar: byId('election-government-bar'),
    oppositionBar: byId('election-opposition-bar'),
    governmentSegments: segments('election-government-bar'),
    oppositionSegments: segments('election-opposition-bar'),
    governmentBarLabel: document.getElementById('election-government-bar').getAttribute('aria-label'),
    oppositionBarLabel: document.getElementById('election-opposition-bar').getAttribute('aria-label'),
    governmentTotal: text('election-government-total'),
    oppositionTotal: text('election-opposition-total'),
    governmentStack: stackHeight('election-government-bar'),
    oppositionStack: stackHeight('election-opposition-bar'),
    governmentTitle: text('election-government-title'),
    oppositionTitle: text('election-opposition-title'),
    // Nothing in the panel may be a per-card control or a popup any more.
    leftovers: {
      moveButtons: document.querySelectorAll('#election-government-builder .eg-party__move').length,
      grips: document.querySelectorAll('#election-government-builder .eg-party__grip').length,
      popups: document.querySelectorAll(
        '#election-government-builder [aria-haspopup], #election-government-builder [role="menu"]').length,
      // The reset control is the only <button> the panel is allowed to hold.
      buttons: Array.from(document.querySelectorAll('#election-government-builder button'))
        .map((el) => el.id || el.className),
    },
    intro: flat(document.querySelector('#election-government-builder .election-panel__head p').textContent),
    disclaimer: flat(document.querySelector('.eg-builder__disclaimer').textContent),
    hints: Array.from(document.querySelectorAll('.eg-zone__hint')).map((el) => el.textContent.trim()),
    masks: {
      government: document.getElementById('election-government-column').getAttribute('data-coalition-mask'),
      opposition: document.getElementById('election-opposition-column').getAttribute('data-coalition-mask'),
      summaryGovernment: summary.getAttribute('data-government-mask'),
      summaryOpposition: summary.getAttribute('data-opposition-mask'),
      summaryCoalition: summary.getAttribute('data-coalition-mask'),
    },
    metrics,
    majority: {
      label: flat(majority.textContent),
      visible: getComputedStyle(majority).display !== 'none',
      borderStyle: getComputedStyle(majority).borderTopStyle,
      // Distance of the rule from the bottom of the plot, and the plot height
      // it has to be read against.
      fromBottom: Math.round((plotRect.bottom - majorityRect.top) * 100) / 100,
      plotHeight: Math.round(plotRect.height * 100) / 100,
      spansPlot: Math.abs(majorityRect.left - plotRect.left) < 1 &&
        Math.abs(majorityRect.right - plotRect.right) < 1,
    },
    announcement: text('election-government-announcement'),
  };
});

/**
 * The smallest read that still answers "did that move do the right thing?".
 *
 * The isolated cases use this rather than readPanel: after real key input a
 * session has little CDP budget left (see KEY BUDGET above), and a large
 * evaluate is the first thing to be swallowed.
 */
const readState = (browser, party) => browser.evaluate((name) => {
  const copies = document.querySelectorAll(`.eg-party[data-party="${name}"]`);
  const card = copies[0] || null;
  const active = document.activeElement;
  const activeCard = active && active.closest ? active.closest('.eg-party') : null;
  const activeZone = active && active.closest ? active.closest('.eg-zone') : null;
  const dd = (metric) => {
    const el = document.querySelector(`#election-government-results div[data-metric="${metric}"] dd`);
    return el ? el.textContent.replace(/[\t\n\r ]+/g, ' ').trim() : null;
  };
  return {
    zone: card ? card.getAttribute('data-zone') : null,
    copies: copies.length,
    government: document.getElementById('election-government-column').getAttribute('data-coalition-mask'),
    opposition: document.getElementById('election-opposition-column').getAttribute('data-coalition-mask'),
    activeParty: activeCard ? activeCard.getAttribute('data-party') : null,
    activeZone: activeZone ? activeZone.id : null,
    activeIsCard: Boolean(active) && active.classList.contains('eg-party'),
    activeLabel: active ? active.getAttribute('aria-label') : null,
    medianText: dd('government'),
    probabilityText: dd('probability'),
  };
}, party);

/** Every layout fact needed to prove the page does not overflow sideways. */
const readOverflow = (browser) => browser.evaluate(() => {
  const root = document.documentElement;
  const panel = document.getElementById('election-government-builder');
  let worst = null;
  Array.from(panel.querySelectorAll('*')).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (!worst || rect.right > worst.right) {
      worst = { right: Math.round(rect.right * 100) / 100, cls: el.className || el.tagName };
    }
  });
  return {
    documentScrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    panelScrollWidth: panel.scrollWidth,
    panelClientWidth: panel.clientWidth,
    worst,
  };
});

/** Where each party currently lives, straight from the DOM. */
const membership = (browser) => browser.evaluate((zoneIds) => {
  const found = {};
  const duplicates = [];
  zoneIds.forEach((zone) => {
    Array.from(document.querySelectorAll(`#${zone} .eg-party`)).forEach((el) => {
      const party = el.getAttribute('data-party');
      if (found[party]) duplicates.push(party);
      found[party] = zone;
    });
  });
  return { found, duplicates };
}, ZONE_IDS);

// ---------------------------------------------------------------------------
// Real input. These drive Chrome's own pointer and key pipelines.
// ---------------------------------------------------------------------------

/** Centre of a card -- the whole block is the handle -- and a drop point. */
const dragPoints = (browser, party, zoneId) => browser.evaluate((arg) => {
  const [name, target] = arg;
  const card = document.querySelector(`#election-government-builder .eg-party[data-party="${name}"]`);
  const zone = document.getElementById(target);
  if (!card || !zone) return null;
  const from = card.getBoundingClientRect();
  const box = zone.getBoundingClientRect();
  return {
    fromX: from.left + from.width / 2,
    fromY: from.top + from.height / 2,
    // Near the top of the zone, which is inside it whether or not it already
    // holds cards.
    toX: box.left + box.width / 2,
    toY: box.top + Math.min(box.height - 8, 26),
  };
}, [party, zoneId]);

/** Scroll the panel into view so drag coordinates stay inside the viewport. */
async function focusPanel(browser) {
  await browser.evaluate(() => {
    document.getElementById('election-government-builder')
      .scrollIntoView({ block: 'center' });
  });
  await settle();
}

async function mouseDrag(browser, party, zoneId) {
  await focusPanel(browser);
  const p = await dragPoints(browser, party, zoneId);
  if (!p) return false;
  const send = (type, x, y) => browser.S('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await send('mousePressed', p.fromX, p.fromY);
  for (let step = 1; step <= 8; step += 1) {
    await send('mouseMoved',
      p.fromX + (p.toX - p.fromX) * step / 8,
      p.fromY + (p.toY - p.fromY) * step / 8);
  }
  await send('mouseReleased', p.toX, p.toY);
  await settle();
  return true;
}

const touchSend = (browser, type, x, y) => browser.S('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
});

/**
 * A finger dragging a card across. The path goes sideways first, because that
 * is what tells the page apart from a scroll: the two sides sit next to each
 * other, so the card travels horizontally and the panel claims only that
 * direction. A straight diagonal would be an ambiguous gesture in real use.
 */
async function touchDrag(browser, party, zoneId) {
  await focusPanel(browser);
  const p = await dragPoints(browser, party, zoneId);
  if (!p) return false;
  await touchSend(browser, 'touchStart', p.fromX, p.fromY);
  for (let step = 1; step <= 6; step += 1) {
    await touchSend(browser, 'touchMove', p.fromX + (p.toX - p.fromX) * step / 6, p.fromY);
  }
  for (let step = 1; step <= 4; step += 1) {
    await touchSend(browser, 'touchMove', p.toX, p.fromY + (p.toY - p.fromY) * step / 4);
  }
  await touchSend(browser, 'touchEnd', p.toX, p.toY);
  await settle();
  return true;
}

/**
 * The other touch path: press and hold, then move in any direction. `checkHeld`
 * runs while the finger is still down and nothing has moved, which is the only
 * moment the hold can be observed on its own.
 */
async function touchHoldDrag(browser, party, zoneId, checkHeld) {
  await focusPanel(browser);
  const p = await dragPoints(browser, party, zoneId);
  if (!p) return false;
  await touchSend(browser, 'touchStart', p.fromX, p.fromY);
  // Comfortably past the panel's 320 ms hold, and still without moving.
  await new Promise((r) => setTimeout(r, 450));
  if (checkHeld) await checkHeld();
  for (let step = 1; step <= 6; step += 1) {
    await touchSend(browser, 'touchMove',
      p.fromX + (p.toX - p.fromX) * step / 6,
      p.fromY + (p.toY - p.fromY) * step / 6);
  }
  await touchSend(browser, 'touchEnd', p.toX, p.toY);
  await settle();
  return true;
}

/**
 * A vertical swipe that starts on a card, synthesized as a real touch gesture
 * so the browser -- not the test -- decides whether `touch-action` lets it
 * scroll. Returns how far the page actually moved.
 */
async function touchSwipeDown(browser, party) {
  await focusPanel(browser);
  const at = await browser.evaluate((name) => {
    const card = document.querySelector(
      `#election-government-builder .eg-party[data-party="${name}"]`);
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      scrollY: window.scrollY,
    };
  }, party);
  if (!at) return null;
  await browser.S('Input.synthesizeScrollGesture', {
    x: at.x, y: at.y, xDistance: 0, yDistance: -SCROLL_DISTANCE,
    gestureSourceType: 'touch', speed: 800,
  });
  await new Promise((r) => setTimeout(r, 400));
  const after = await browser.evaluate(() => window.scrollY);
  return { before: at.scrollY, after, moved: after - at.scrollY };
}

/** Click an element with real mouse input, by selector, at its centre. */
async function mouseClick(browser, selector) {
  const at = await browser.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  if (!at) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.S('Input.dispatchMouseEvent', {
      type, x: at.x, y: at.y, button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  await settle();
  return true;
}

/**
 * Press and release one key through the browser's real key pipeline.
 * Spend these sparingly: see KEY BUDGET at the top of this file.
 */
async function key(browser, name, code, keyCode, text) {
  const send = (params) => browser.S('Input.dispatchKeyEvent', Object.assign({
    key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  }, params));
  await send({ type: 'rawKeyDown' });
  // Enter and Space are activated by the character event, not the raw key down.
  if (text) await send({ type: 'char', text, unmodifiedText: text });
  await send({ type: 'keyUp' });
  await new Promise((r) => setTimeout(r, 250));
}

const pressEnter = (browser) => key(browser, 'Enter', 'Enter', 13, '\r');
const pressSpace = (browser) => key(browser, ' ', 'Space', 32, ' ');
const pressTab = (browser) => key(browser, 'Tab', 'Tab', 9);

/**
 * Move a party by dispatching the key the card listens for. This is the
 * panel's own code path -- the same handler a real Enter reaches -- and it
 * costs no key budget, so setup is free.
 */
const moveViaKey = (browser, party) => browser.evaluate((name) => {
  const card = document.querySelector(
    `#election-government-builder .eg-party[data-party="${name}"]`);
  if (!card) return false;
  card.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}, party);

/** Put `parties` into `zone`, moving only the ones not already there. */
async function place(browser, zone, parties) {
  for (const party of parties) {
    const here = await browser.evaluate((arg) => {
      const [name, target] = arg;
      const card = document.querySelector(
        `#election-government-builder .eg-party[data-party="${name}"]`);
      return card ? card.getAttribute('data-zone') === target : false;
    }, [party, zone]);
    if (!here) await moveViaKey(browser, party);
  }
  await settle();
}

/** Put keyboard focus on one card, in script. */
const focusCard = (browser, party) => browser.evaluate((name) => {
  const card = document.querySelector(
    `#election-government-builder .eg-party[data-party="${name}"]`);
  if (!card) return false;
  card.focus();
  return document.activeElement === card;
}, party);

// ---------------------------------------------------------------------------
// schema 1.2: the two-state builder, end to end
// ---------------------------------------------------------------------------

async function schema12(viewport, pointer, expected) {
  console.log(`\n[schema 1.2 @ ${viewport.name} ${viewport.width}x${viewport.height}]`);
  await session(viewport, pointer, async (browser) => {
    // --- Swedish copy ----------------------------------------------------
    const initial = await readPanel(browser);
    check('panel is visible', initial.section.visible, JSON.stringify(initial.section));
    eq('intro copy', initial.intro,
      'Alla partier börjar i Opposition. Dra dem mellan Regering och Opposition och se hur många mandat sidorna brukar få i simuleringarna.');
    eq('government side label', initial.governmentTitle, 'Regering');
    eq('opposition side label', initial.oppositionTitle, 'Opposition');
    eq('reset control', initial.resetLabel, 'Återställ');
    eq('disclaimer is government-only', initial.disclaimer,
      'Det här visar sannolikheten att de valda regeringspartierna tillsammans får minst 175 mandat – inte sannolikheten att de faktiskt bildar regering.');

    // --- The initial state is a partition, not an empty pool -------------
    eq('government starts empty', initial.government.length, 0);
    eq('every party starts in Opposition',
      initial.opposition.map((c) => c.party), SEATING.slice().reverse());
    eq('the initial masks are 0 and 255',
      [initial.masks.government, initial.masks.opposition], ['0', String(FULL_MASK)]);
    partitions('initial state', initial.masks.government, initial.masks.opposition);
    eq('only the empty government invites a drop', initial.hints,
      ['Dra partier hit för att bygga en regering.']);
    eq('the opposition already carries the whole chamber',
      [initial.governmentTotal, initial.oppositionTotal], ['0', String(CHAMBER)]);
    eq('only the opposition bar is drawn',
      [initial.governmentSegments.length, initial.oppositionSegments.length],
      [0, PARTY_ORDER.length]);
    check('summary is hidden until a government exists',
      !initial.summaryBox.visible && initial.summaryBox.display === 'none',
      JSON.stringify(initial.summaryBox));
    eq('screen-reader status invites a government',
      initial.announcement, 'Dra partier hit för att bygga en regering.');

    // --- Card anatomy: a clean block that is itself the control ----------
    check('every card has a real box',
      initial.opposition.every((c) => c.visible && c.width > 0 && c.height > 0),
      JSON.stringify(initial.opposition.filter((c) => !(c.visible && c.width > 0))));
    eq('no per-card move button is left', initial.leftovers.moveButtons, 0);
    eq('no dedicated drag grip is left', initial.leftovers.grips, 0);
    eq('no popup survives anywhere in the panel', initial.leftovers.popups, 0);
    eq('the reset control is the panel\'s only button',
      initial.leftovers.buttons, ['election-builder-reset']);
    eq('a card holds no control of its own',
      initial.opposition.map((c) => c.inner), PARTY_ORDER.map(() => 0));
    eq('native HTML5 dragging is off',
      initial.opposition.map((c) => c.nativeDraggable),
      PARTY_ORDER.map(() => 'false'));
    eq('every card is itself focusable and operable',
      initial.opposition.map((c) => `${c.role}/${c.tabindex}`),
      PARTY_ORDER.map(() => 'button/0'));
    eq('the card names its party, its median, its side and the key',
      initial.opposition.find((c) => c.party === 'S').label,
      'Socialdemokraterna (S), 110 mandat i median, i Opposition. Tryck Enter för att flytta till Regering.');
    check('a card reads as abbreviation and median seats',
      /^S110mandat/.test(initial.opposition.find((c) => c.party === 'S').text.replace(/\s/g, '')),
      initial.opposition.find((c) => c.party === 'S').text);
    eq('the cursor says the block can be grabbed',
      initial.opposition.map((c) => c.cursor), PARTY_ORDER.map(() => 'grab'));
    check(`every card is at least ${MIN_CARD_HEIGHT}px tall`,
      initial.opposition.every((c) => c.height >= MIN_CARD_HEIGHT),
      JSON.stringify(initial.opposition.map((c) => [c.party, c.height])));

    // --- Shared scale and the majority rule ------------------------------
    near('both bars are the same height',
      initial.governmentBar.height, initial.oppositionBar.height, 0.5);
    near('both bars start at the same y', initial.governmentBar.top, initial.oppositionBar.top, 0.5);
    check('majority rule is drawn', initial.majority.visible && initial.majority.borderStyle === 'dashed',
      JSON.stringify(initial.majority));
    eq('majority rule is labelled in seats, not per cent',
      initial.majority.label, 'Majoritetsgräns: 175 mandat');
    check('majority rule spans both columns', initial.majority.spansPlot, JSON.stringify(initial.majority));
    near('majority rule sits at 175 of 349',
      initial.majority.fromBottom,
      initial.majority.plotHeight * (MAJORITY / CHAMBER), 1.5);
    near('an all-opposition chamber fills its bar to 349',
      initial.oppositionStack, initial.majority.plotHeight, 1.5);

    // --- Dragging: the primary interaction, in both directions -----------
    check('drag C from Opposition into Regering',
      await mouseDrag(browser, 'C', GOVERNMENT_ZONE));
    let where = await membership(browser);
    let state = await readState(browser, 'C');
    eq('C is now only in Regering', where.found.C, GOVERNMENT_ZONE);
    eq('nothing is in two zones at once', where.duplicates, []);
    eq('the masks moved the one bit', [state.government, state.opposition],
      [String(BIT.C), String(FULL_MASK ^ BIT.C)]);
    partitions('after Opposition -> Regering', state.government, state.opposition);
    // A move rebuilds both columns, so the dragged card is a new element. If
    // focus is not put back on it the next Tab starts from the top of the page.
    check('focus follows a dragged card into its new side',
      state.activeIsCard && state.activeParty === 'C' &&
      state.activeZone === GOVERNMENT_ZONE, JSON.stringify(state));

    check('drag C back from Regering into Opposition',
      await mouseDrag(browser, 'C', OPPOSITION_ZONE));
    where = await membership(browser);
    state = await readState(browser, 'C');
    eq('C is back in Opposition', where.found.C, OPPOSITION_ZONE);
    eq('a cross-side move leaves no copy behind', where.duplicates, []);
    eq('the masks are back to the initial partition',
      [state.government, state.opposition], ['0', String(FULL_MASK)]);
    partitions('after Regering -> Opposition', state.government, state.opposition);

    // Dropping a card back where it already is must be a no-op.
    await mouseDrag(browser, 'M', OPPOSITION_ZONE);
    const after = await membership(browser);
    eq('dropping a card back on its own side changes nothing',
      [after.found.M, after.duplicates], [OPPOSITION_ZONE, []]);

    check('touch-drag S into Regering by the card itself',
      await touchDrag(browser, 'S', GOVERNMENT_ZONE));
    where = await membership(browser);
    state = await readState(browser, 'S');
    eq('a touch drag places the party like a mouse drag', where.found.S, GOVERNMENT_ZONE);
    eq('a touch drag creates no duplicate', where.duplicates, []);
    partitions('after a touch drag', state.government, state.opposition);

    // --- A press that does not travel is not a drag ----------------------
    // The block is both the handle and the control, so a plain click on it
    // has to leave the party exactly where it is.
    check('click KD without moving the pointer',
      await mouseClick(browser, `#${OPPOSITION_ZONE} .eg-party[data-party="KD"]`));
    state = await readState(browser, 'KD');
    eq('a click that never travels moves nothing', state.zone, 'opposition');
    eq('and leaves one card', state.copies, 1);

    // --- The card as a control, through its own key handler --------------
    check('sending Enter to the card moves the party',
      await moveViaKey(browser, 'KD'));
    await settle();
    state = await readState(browser, 'KD');
    eq('the party moved to its one destination', state.zone, 'government');
    eq('a keyboard move leaves one card', state.copies, 1);
    partitions('after a keyboard move', state.government, state.opposition);
    check('the move itself is announced, then the resulting state',
      /^Kristdemokraterna \(KD\) flyttades till Regering\. Regering /
        .test((await readPanel(browser)).announcement),
      (await readPanel(browser)).announcement);

    // --- Reset -----------------------------------------------------------
    await browser.evaluate(() => document.getElementById('election-builder-reset').click());
    await settle();
    where = await membership(browser);
    eq('reset returns every party to Opposition',
      PARTY_ORDER.map((p) => where.found[p]), PARTY_ORDER.map(() => OPPOSITION_ZONE));
    let panel = await readPanel(browser);
    eq('reset restores government 0 / opposition 255',
      [panel.masks.government, panel.masks.opposition], ['0', String(FULL_MASK)]);
    partitions('after reset', panel.masks.government, panel.masks.opposition);
    check('reset hides the summary again', !panel.summaryBox.visible, JSON.stringify(panel.summaryBox));
    check('reset is announced', /Opposition/.test(panel.announcement), panel.announcement);

    // --- Masks and the published lookup ----------------------------------
    await place(browser, 'government', GOVERNMENT);
    where = await membership(browser);
    eq('final membership',
      Object.keys(where.found).sort().map((p) => [p, where.found[p]]),
      Object.entries({
        C: GOVERNMENT_ZONE, KD: OPPOSITION_ZONE, L: OPPOSITION_ZONE, M: OPPOSITION_ZONE,
        MP: GOVERNMENT_ZONE, S: GOVERNMENT_ZONE, SD: OPPOSITION_ZONE, V: OPPOSITION_ZONE,
      }).sort());
    eq('no party is in two zones', where.duplicates, []);

    panel = await readPanel(browser);
    eq('government mask', panel.masks.government, String(GOVERNMENT_MASK));
    eq('the opposition mask is the exact complement',
      panel.masks.opposition, String(OPPOSITION_MASK));
    partitions('the worked case', panel.masks.government, panel.masks.opposition);
    eq('the evaluated coalition is the government',
      panel.masks.summaryCoalition, String(GOVERNMENT_MASK));
    eq('summary carries both side masks',
      [panel.masks.summaryGovernment, panel.masks.summaryOpposition],
      [String(GOVERNMENT_MASK), String(OPPOSITION_MASK)]);

    check('summary is revealed', panel.summaryBox.visible, JSON.stringify(panel.summaryBox));
    eq('government median', panel.metrics.government,
      { term: 'Regering', value: `${expected.government.median} mandat` });
    eq('opposition median comes from the opposition mask', panel.metrics.opposition,
      { term: 'Opposition', value: `${expected.opposition.median} mandat` });
    eq('90 % interval', panel.metrics.interval,
      { term: `90${NBSP}% prognosintervall`, value: `${expected.government.p05}–${expected.government.p95} mandat` });
    eq('probability of at least 175 seats', panel.metrics.probability,
      { term: `Sannolikhet för minst ${MAJORITY} mandat`, value: expected.government.probability });
    check('the probability under test is not a trivial 0 or 100 %',
      expected.government.prob > 0.02 && expected.government.prob < 0.98,
      String(expected.government.prob));
    eq('no probability is printed for the opposition',
      Object.keys(panel.metrics).sort(),
      ['government', 'interval', 'opposition', 'probability']);
    eq('column totals match the lookup',
      [panel.governmentTotal, panel.oppositionTotal],
      [String(expected.government.median), String(expected.opposition.median)]);

    // --- Each bar draws the number it prints -----------------------------
    // The track is column-reverse, so DOM order runs bottom to top.
    eq('government bar stacks its own parties',
      panel.governmentSegments.map((s) => s.party), expected.stack(GOVERNMENT_MASK));
    eq('opposition bar stacks its own parties',
      panel.oppositionSegments.map((s) => s.party), expected.stack(OPPOSITION_MASK));
    eq('cards are listed in the bar\'s own top-to-bottom order',
      panel.government.map((c) => c.party), expected.stack(GOVERNMENT_MASK).slice().reverse());
    eq('a governing card now names the way back',
      panel.government.find((c) => c.party === 'C').label,
      'Centerpartiet (C), 25 mandat i median, i Regering. Tryck Enter för att flytta till Opposition.');
    near('the government stack is its median on the 0-349 scale',
      panel.governmentStack,
      panel.majority.plotHeight * (expected.government.median / CHAMBER), 1.5);
    near('the opposition stack is its median on the 0-349 scale',
      panel.oppositionStack,
      panel.majority.plotHeight * (expected.opposition.median / CHAMBER), 1.5);
    // In a true partition the complement of a losing government is usually a
    // winning opposition, and the panel has to draw that honestly.
    check('this government stays below the rule while its complement clears it',
      panel.governmentStack < panel.majority.fromBottom &&
      panel.oppositionStack > panel.majority.fromBottom,
      `government ${panel.governmentStack}px, opposition ${panel.oppositionStack}px, rule ${panel.majority.fromBottom}px`);
    eq('the government bar describes itself for screen readers',
      panel.governmentBarLabel, expected.barLabel('Regering', GOVERNMENT_MASK));
    eq('the opposition bar describes itself too',
      panel.oppositionBarLabel, expected.barLabel('Opposition', OPPOSITION_MASK));
    check('the live region announces both sides and the probability',
      panel.announcement.includes(`Regering C + S + MP, ${expected.government.median} mandat`) &&
      panel.announcement.includes(expected.government.probability) &&
      panel.announcement.includes('Opposition M + L + KD + V + SD'),
      panel.announcement);

    // --- A government that does cross the rule ---------------------------
    check('drag V into Regering', await mouseDrag(browser, 'V', GOVERNMENT_ZONE));
    const crossing = await readPanel(browser);
    eq('the enlarged government mask', crossing.masks.government, String(MAJORITY_MASK));
    eq('the opposition shrinks to match',
      crossing.masks.opposition, String(FULL_MASK ^ MAJORITY_MASK));
    partitions('the crossing case', crossing.masks.government, crossing.masks.opposition);
    eq('the enlarged government median',
      crossing.metrics.government.value, `${expected.majority.median} mandat`);
    eq('its probability is the published one',
      crossing.metrics.probability.value, expected.majority.probability);
    check('the fixture still holds a crossing case',
      expected.government.median < MAJORITY && expected.majority.median >= MAJORITY,
      `${expected.government.median} then ${expected.majority.median}`);
    check('the government bar now rises above the majority rule',
      crossing.governmentStack > crossing.majority.fromBottom,
      `stack ${crossing.governmentStack}px vs rule ${crossing.majority.fromBottom}px`);
    check('and its complement drops below it',
      crossing.oppositionStack < crossing.majority.fromBottom,
      `stack ${crossing.oppositionStack}px vs rule ${crossing.majority.fromBottom}px`);
    near('the crossing stack is still drawn on the same 0-349 scale',
      crossing.governmentStack,
      crossing.majority.plotHeight * (expected.majority.median / CHAMBER), 1.5);

    // --- Layout ----------------------------------------------------------
    const overflow = await readOverflow(browser);
    eq('the document does not scroll sideways',
      overflow.documentScrollWidth <= overflow.clientWidth, true);
    check('the panel does not scroll sideways',
      overflow.panelScrollWidth <= overflow.panelClientWidth,
      JSON.stringify(overflow));
    check('nothing in the panel reaches past the viewport',
      overflow.worst.right <= overflow.clientWidth + 0.5, JSON.stringify(overflow.worst));

    // The all-in-one-column extreme: eight cards on one side is the tallest
    // and widest the zone ever gets.
    await place(browser, 'government', PARTY_ORDER);
    const loaded = await readOverflow(browser);
    check('an all-government chamber still does not overflow',
      loaded.documentScrollWidth <= loaded.clientWidth &&
      loaded.worst.right <= loaded.clientWidth + 0.5, JSON.stringify(loaded));
    const full = await readPanel(browser);
    eq('an all-government chamber is mask 255 against an empty opposition',
      [full.masks.government, full.masks.opposition], [String(FULL_MASK), '0']);
    partitions('all-government', full.masks.government, full.masks.opposition);
    eq('the emptied opposition invites a drop', full.hints,
      ['Dra partier hit för att lägga dem i opposition.']);
  });
}

// ---------------------------------------------------------------------------
// One drag per browser, each asserting the whole resulting state
// ---------------------------------------------------------------------------

async function dragCase(pointer, expected, spec) {
  console.log(`\n[drag: ${spec.name}]`);
  await session(CASE_VIEWPORT, pointer, async (browser) => {
    if (spec.setup && spec.setup.length) await place(browser, 'government', spec.setup);
    check(`drag ${spec.party} into ${spec.to}`,
      await mouseDrag(browser, spec.party, ZONE_OF_ACTION[spec.to]));

    const state = await readState(browser, spec.party);
    const where = await membership(browser);
    eq(`${spec.party} sits in exactly one zone`, state.copies, 1);
    eq(`${spec.party} is in ${spec.to}`, state.zone, spec.to);
    eq('no card is duplicated anywhere', where.duplicates, []);
    eq('every party is still placed exactly once',
      Object.keys(where.found).length, PARTY_ORDER.length);
    eq('the government mask is correct', state.government, String(spec.government));
    eq('the opposition mask is its complement',
      state.opposition, String(FULL_MASK ^ spec.government));
    partitions(spec.name, state.government, state.opposition);

    if (spec.government === 0) {
      eq('an empty government prints no result', state.probabilityText, null);
    } else {
      const entry = expected.of(spec.government);
      eq('the median shown is the published one for that mask',
        state.medianText, `${entry.median} mandat`);
      eq('the probability shown is the published one for that mask',
        state.probabilityText, entry.probability);
    }
  });
}

// ---------------------------------------------------------------------------
// One keyboard case per browser, one or two real presses each
// ---------------------------------------------------------------------------

/**
 * The card is the control, so one Enter or Space on the focused card is the
 * whole move. Each step of `spec.steps` is a real key press followed by the
 * state it must leave behind; two presses is well inside the key budget.
 */
async function keyboardCase(pointer, spec) {
  console.log(`\n[keyboard: ${spec.name}]`);
  await session(CASE_VIEWPORT, pointer, async (browser) => {
    if (spec.setup && spec.setup.length) await place(browser, 'government', spec.setup);
    await focusPanel(browser);
    check(`focus reaches the ${spec.party} card itself`,
      await focusCard(browser, spec.party));

    for (const step of spec.steps) {
      await step.press(browser);
      const state = await readState(browser, spec.party);
      eq(`${step.name}: ${spec.party} is in ${step.to}`, state.zone, step.to);
      eq(`${step.name}: ${spec.party} exists exactly once`, state.copies, 1);
      eq(`${step.name}: the government mask is correct`,
        state.government, String(step.government));
      eq(`${step.name}: the opposition mask is its complement`,
        state.opposition, String(FULL_MASK ^ step.government));
      partitions(step.name, state.government, state.opposition);
      // Focus restoration: a keyboard user must not be dumped at the top of
      // the document after every move, and the card is rebuilt by the move.
      check(`${step.name}: focus follows the card into its new side`,
        state.activeIsCard && state.activeParty === spec.party &&
        state.activeZone === ZONE_OF_ACTION[step.to], JSON.stringify(state));
      check(`${step.name}: the focused card names the side it is now on`,
        typeof state.activeLabel === 'string' &&
        state.activeLabel.includes(`i ${step.to === 'government' ? 'Regering' : 'Opposition'}.`),
        String(state.activeLabel));
    }
  });
}

/** Tab reaching a control, and the focus ring that has to come with it. */
async function keyboardFocusRing(pointer) {
  console.log('\n[keyboard: Tab reaches a control with a visible ring]');
  await session(CASE_VIEWPORT, pointer, async (browser) => {
    await focusPanel(browser);
    // :focus-visible deliberately does not match a programmatic focus() after
    // pointer input, so the ring is only meaningful once a real Tab has moved
    // focus. One press, then one small read.
    await browser.evaluate(() => document.getElementById('election-builder-reset').focus());
    await pressTab(browser);
    const ring = await browser.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return {
        isCard: active.classList.contains('eg-party'),
        party: active.getAttribute('data-party'),
        matchesFocusVisible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    check('Tab from the reset control reaches a party card',
      ring.isCard && Boolean(ring.party), JSON.stringify(ring));
    check('keyboard focus is visibly outlined',
      ring.matchesFocusVisible && ring.outlineStyle !== 'none' &&
      parseFloat(ring.outlineWidth) > 0, JSON.stringify(ring));
  });
}

// ---------------------------------------------------------------------------
// Touch: scrolling and dragging on the same block
// ---------------------------------------------------------------------------

/**
 * The card is the drag handle, and it fills most of the column, so the page
 * would be unscrollable if the block simply claimed every touch. It claims
 * one direction instead: `touch-action: pan-y` leaves vertical panning to the
 * browser, and the panel starts a drag only on a sideways move -- which is
 * the direction a card actually travels between the two columns -- or on a
 * deliberate press-and-hold.
 *
 * All three are exercised as real gestures: the scroll is synthesized so the
 * browser, not the test, decides whether `touch-action` lets it through.
 */
async function touchGestures(pointer) {
  console.log('\n[touch: scrolling and dragging the same block]');
  await session(VIEWPORTS[1], pointer, async (browser) => {
    const panel = await readPanel(browser);
    eq('a card hands vertical panning back to the browser',
      panel.opposition.map((c) => c.touchAction), PARTY_ORDER.map(() => 'pan-y'));
    check(`every card is at least ${TOUCH_CARD_HEIGHT}px tall under a finger`,
      panel.opposition.every((c) => c.height >= TOUCH_CARD_HEIGHT),
      JSON.stringify(panel.opposition.map((c) => [c.party, c.height])));

    // 1. A vertical swipe that starts on a card scrolls the page.
    const scrolled = await touchSwipeDown(browser, 'C');
    check('a vertical swipe over a card scrolls the page',
      Boolean(scrolled) && scrolled.moved > SCROLL_DISTANCE / 2, JSON.stringify(scrolled));
    let state = await readState(browser, 'C');
    eq('and does not move the party', state.zone, 'opposition');
    partitions('after a scroll', state.government, state.opposition);

    // 2. A sideways drag moves it.
    check('a sideways touch drag moves the card',
      await touchDrag(browser, 'C', GOVERNMENT_ZONE));
    state = await readState(browser, 'C');
    eq('C reached Regering', state.zone, 'government');
    eq('and exists exactly once', state.copies, 1);
    partitions('after a sideways drag', state.government, state.opposition);

    // 3. Press and hold, then move in any direction.
    let held = null;
    check('a press-and-hold drag moves the card back',
      await touchHoldDrag(browser, 'C', OPPOSITION_ZONE, async () => {
        held = await browser.evaluate(() => ({
          ghosts: document.querySelectorAll('.eg-party--ghost').length,
          droppable: document.querySelectorAll('.eg-zone.is-droppable').length,
          lifted: document.querySelectorAll('.eg-party.is-dragging').length,
        }));
      }));
    check('the hold alone lifts the card, before the finger has moved',
      held && held.ghosts === 1 && held.lifted === 1 && held.droppable === 1,
      JSON.stringify(held));
    state = await readState(browser, 'C');
    eq('C is back in Opposition', state.zone, 'opposition');
    partitions('after a held drag', state.government, state.opposition);

    const overflow = await readOverflow(browser);
    check('the touchscreen layout does not overflow',
      overflow.documentScrollWidth <= overflow.clientWidth &&
      overflow.panelScrollWidth <= overflow.panelClientWidth,
      JSON.stringify(overflow));
  }, { coarse: true });
}

// ---------------------------------------------------------------------------
// schema 1.1: the fail-closed contract
// ---------------------------------------------------------------------------

async function schema11FailsClosed(pointer) {
  console.log('\n[schema 1.1 fails closed @ desktop]');
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: 1280, height: 1200 });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);
    // A publication without a coalition_builder must leave no trace of the
    // panel: this is the empty-shell regression that the `hidden` attribute
    // is responsible for preventing.
    const panel = await browser.evaluate(() => {
      const section = document.getElementById('election-government-builder');
      const style = getComputedStyle(section);
      return {
        hiddenAttr: section.hidden,
        display: style.display,
        height: section.getBoundingClientRect().height,
        cards: document.querySelectorAll('#election-government-builder .eg-party').length,
        segments: document.querySelectorAll('#election-government-builder .eg-bar__segment').length,
        controls: document.querySelectorAll(
          '#election-government-builder .eg-party__move, #election-government-builder .eg-party__grip').length,
        focusables: document.querySelectorAll(
          '#election-government-builder .eg-party[tabindex]').length,
        masks: [
          document.getElementById('election-government-column').getAttribute('data-coalition-mask'),
          document.getElementById('election-opposition-column').getAttribute('data-coalition-mask'),
        ],
        summary: document.getElementById('election-government-results').textContent.trim(),
      };
    });
    check('panel keeps the hidden attribute', panel.hiddenAttr === true, JSON.stringify(panel));
    check('panel is not rendered at all',
      panel.display === 'none' && panel.height === 0, JSON.stringify(panel));
    eq('no party cards leak', panel.cards, 0);
    eq('no bar segments leak', panel.segments, 0);
    eq('no per-card controls leak', panel.controls, 0);
    eq('nothing focusable leaks into the tab order', panel.focusables, 0);
    // Not even the opposition side is populated: an unusable publication must
    // not look like a chamber with everybody in opposition.
    eq('the markup masks are left untouched', panel.masks, ['0', '0']);
    eq('no summary text leaks', panel.summary, '');
    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------

/** Expected numbers come from the published fixture, never from the page. */
async function expectations() {
  const groups = JSON.parse(await readFile(
    join(SITE, 'files/election-simulator/versions', GENERATION_1_2, 'groups.json'), 'utf8'));
  const table = groups.coalition_builder.coalitions;
  // Mirrors the page's own rule: an exact 0 or 1 prints one decimal, while a
  // strictly interior probability is never rounded to a flat 0 % or 100 %.
  const swedish = (probability) => {
    if (probability === 0) return `0,0${NBSP}%`;
    if (probability === 1) return `100,0${NBSP}%`;
    const pct = probability * 100;
    if (pct < 0.005) return `<0,01${NBSP}%`;
    if (pct > 99.995) return `>99,99${NBSP}%`;
    const digits = pct < 1 || pct > 99 ? 2 : 1;
    return `${pct.toFixed(digits).replace('.', ',')}${NBSP}%`;
  };
  const of = (mask) => ({
    median: table[String(mask)].median_seats,
    p05: table[String(mask)].p05_seats,
    p95: table[String(mask)].p95_seats,
    prob: table[String(mask)].prob_majority,
    probability: swedish(table[String(mask)].prob_majority),
  });
  // A bar stacks its members in seating order, bottom first.
  const stack = (mask) => SEATING.filter((party) => (mask & BIT[party]) !== 0);
  // ...and describes itself top-down, each party at its own published median.
  const barLabel = (side, mask) => `${side}: ${stack(mask).slice().reverse()
    .map((party) => `${party} ${of(BIT[party]).median}`).join(', ')}` +
    `. Median tillsammans ${of(mask).median} av ${CHAMBER} mandat.`;
  return {
    of,
    stack,
    barLabel,
    government: of(GOVERNMENT_MASK),
    opposition: of(OPPOSITION_MASK),
    majority: of(MAJORITY_MASK),
  };
}

const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer11 = await pointerFor(SITE, GENERATION_1_1);
if (pointer12.schema_version !== '1.2') throw new Error('fixture is not schema 1.2');
if (pointer11.schema_version !== '1.1') throw new Error('fixture is not schema 1.1');

const expected = await expectations();

for (const viewport of VIEWPORTS) {
  await schema12(viewport, pointer12, expected);
}

// Both directions a card can travel, one browser each. There is no third.
const DRAG_CASES = [
  {
    name: 'Opposition -> Regering completes C+S+MP',
    setup: ['C', 'S'],
    party: 'MP', to: 'government',
    government: GOVERNMENT_MASK,
  },
  {
    name: 'Regering -> Opposition breaks it up again',
    setup: ['C', 'S', 'MP'],
    party: 'C', to: 'opposition',
    government: GOVERNMENT_MASK & ~BIT.C,
  },
  {
    name: 'Regering -> Opposition empties the government',
    setup: ['C'],
    party: 'C', to: 'opposition',
    government: 0,
  },
];
for (const spec of DRAG_CASES) await dragCase(pointer12, expected, spec);

await keyboardFocusRing(pointer12);

// The card is the control, so one press is the whole move. Enter takes it
// across and Space brings it back, both against real key input, in the two
// starting states a card can be in.
const KEYBOARD_CASES = [
  {
    name: 'Enter across and Space back, starting in Opposition',
    setup: [], party: 'C',
    steps: [
      { name: 'Enter', press: pressEnter, to: 'government', government: BIT.C },
      { name: 'Space', press: pressSpace, to: 'opposition', government: 0 },
    ],
  },
  {
    name: 'Enter across and Space back, starting in Regering',
    setup: ['C', 'S'], party: 'C',
    steps: [
      { name: 'Enter', press: pressEnter, to: 'opposition', government: BIT.S },
      { name: 'Space', press: pressSpace, to: 'government', government: BIT.C | BIT.S },
    ],
  },
];
for (const spec of KEYBOARD_CASES) await keyboardCase(pointer12, spec);

await touchGestures(pointer12);
await schema11FailsClosed(pointer11);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
