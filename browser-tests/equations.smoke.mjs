// Real-browser smoke test for the MathJax equations in "Så fungerar modellen".
//
// The equations are authored as LaTeX text inside `.election-equation` blocks
// and typeset by a pinned MathJax 3 build. Two things about that arrangement
// can only be observed in a real browser:
//
//   - the blocks sit inside a collapsed <details>, and CHTML cannot measure a
//     display:none subtree, so typesetting is deferred to the first open;
//   - a wide equation must scroll inside its own panel instead of widening the
//     page, and must not be clipped by that panel.
//
// The last pass blocks the CDN to prove the graceful-failure path: with no
// MathJax, the LaTeX source itself has to stay on the page.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/equations.smoke.mjs [path/to/_site]
//
// Dependencies: Node >= 22 (built-in WebSocket) and a local Chrome/Chromium.
// Override the binary with CHROME_BIN. Nothing is installed.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(process.argv[2] || join(HERE, '..', '_site'));
const PAGE = '/election-simulator/';

// Same pinned publication the government-builder smoke test uses, so neither
// run depends on whatever files/election-simulator/current.json points at.
const GENERATION = '20260828T064703Z-1da59168';

const MATHJAX_VERSION = '3.2.2';
const EQUATION_COUNT = 11;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1200 },
  { name: 'narrow-360', width: 360, height: 800 },
];

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || detail === undefined ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** Ignore asset noise that comes from serving a dev build, not from the app. */
const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));

async function waitForApp(browser) {
  const settled = await browser.waitFor(() => {
    const status = document.getElementById('election-app-status');
    return Boolean(status) && (status.hidden || status.className.includes('error'));
  }, 25000);
  if (!settled) throw new Error('the forecast app never finished loading');
  await new Promise((r) => setTimeout(r, 300));
}

const openModel = (browser) => browser.evaluate(() => {
  const details = document.getElementById('election-model');
  if (!details) return false;
  details.open = true;               // fires `toggle`, which triggers typesetting
  return true;
});

/** Measure every equation block: page overflow, clipping and typeset state. */
const readEquations = (browser) => browser.evaluate(() => {
  const doc = document.documentElement;
  const blocks = Array.from(document.querySelectorAll('.election-equation'));
  return {
    pageScrollWidth: doc.scrollWidth,
    viewportWidth: window.innerWidth,
    mathJaxVersion: window.MathJax && window.MathJax.version,
    blocks: blocks.map((el, index) => {
      const panel = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      const container = el.querySelector('mjx-container');
      // mjx-container is a block and fills the panel; mjx-math is the
      // inline-block that actually carries the equation's intrinsic width.
      const inner = container && container.querySelector('mjx-math');
      const math = inner && inner.getBoundingClientRect();
      return {
        index,
        // A block still holding `\[` has not been typeset (or MathJax is gone).
        sourceVisible: /\\\[/.test(el.textContent),
        typeset: Boolean(container),
        display: container ? container.getAttribute('display') : null,
        panelWidth: Math.round(panel.width),
        parentWidth: Math.round(parent.width),
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        // Wider than the panel is fine — it scrolls; taller is a clip.
        verticalOverflow: el.scrollHeight - el.clientHeight,
        mathWidth: math ? Math.round(math.width) : 0,
        mathHeight: math ? Math.round(math.height) : 0,
        // Distance the typeset math pokes out of the panel's padding box.
        clippedTop: math ? Math.round(panel.top - math.top) : 0,
        clippedBottom: math ? Math.round(math.bottom - panel.bottom) : 0,
        visible: getComputedStyle(el).display !== 'none' && panel.height > 0,
      };
    }),
  };
});

async function runViewport(server, viewport) {
  console.log(`\n${viewport.name} (${viewport.width}px)`);
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    await browser.setViewport(viewport.width, viewport.height);
    await browser.goto(`http://localhost:${server.port}${PAGE}`);
    await waitForApp(browser);

    check('"Så fungerar modellen" opens', await openModel(browser));

    const typesetDone = await browser.waitFor((expected) => {
      const done = document.querySelectorAll('.election-equation mjx-container').length;
      return done === expected;
    }, 20000, EQUATION_COUNT);
    check(`all ${EQUATION_COUNT} equations typeset after opening the section`, typesetDone);

    const state = await readEquations(browser);
    eq('MathJax version', state.mathJaxVersion, MATHJAX_VERSION);
    eq('equation blocks found', state.blocks.length, EQUATION_COUNT);

    for (const b of state.blocks) {
      const at = `equation ${b.index + 1}`;
      check(`${at}: LaTeX source replaced by typeset math`,
        b.typeset && !b.sourceVisible,
        `typeset=${b.typeset} sourceVisible=${b.sourceVisible}`);
      eq(`${at}: rendered as display math`, b.display, 'true');
      check(`${at}: has a non-zero box`, b.mathWidth > 0 && b.mathHeight > 0,
        `${b.mathWidth}x${b.mathHeight}`);
      check(`${at}: panel stays inside its column`, b.panelWidth <= b.parentWidth + 1,
        `panel ${b.panelWidth} > parent ${b.parentWidth}`);
      check(`${at}: not clipped vertically`,
        b.verticalOverflow <= 1 && b.clippedTop <= 1 && b.clippedBottom <= 1,
        `overflowY=${b.verticalOverflow} top=${b.clippedTop} bottom=${b.clippedBottom}`);
      // Anything wider than the panel has to be reachable by scrolling it,
      // never cut off at the panel edge.
      check(`${at}: full width is reachable`, b.scrollWidth >= b.mathWidth - 1,
        `math ${b.mathWidth} > scrollWidth ${b.scrollWidth}`);
    }

    check('no page-level horizontal overflow',
      state.pageScrollWidth <= state.viewportWidth + 1,
      `scrollWidth ${state.pageScrollWidth} > innerWidth ${state.viewportWidth}`);

    const errors = appErrors(browser);
    eq('no console errors', errors.map((e) => e.text), []);
    eq('no uncaught exceptions', browser.exceptions.map((e) => e.text), []);
  } finally {
    await browser.close();
  }
}

/** With the CDN blocked the LaTeX must stay on the page, not disappear. */
async function runOffline(server) {
  console.log('\ngraceful failure (MathJax CDN blocked)');
  const browser = await launch({ width: 1280, height: 1200 });
  try {
    await browser.S('Network.setBlockedURLs', { urls: ['*cdn.jsdelivr.net*'] });
    await browser.goto(`http://localhost:${server.port}${PAGE}`);
    await waitForApp(browser);
    await openModel(browser);
    await new Promise((r) => setTimeout(r, 1500));

    const state = await readEquations(browser);
    check('MathJax did not load', state.mathJaxVersion === undefined,
      `version=${state.mathJaxVersion}`);
    eq('every block still shows its LaTeX source',
      state.blocks.filter((b) => b.sourceVisible && b.visible).length, EQUATION_COUNT);
    check('no page-level horizontal overflow',
      state.pageScrollWidth <= state.viewportWidth + 1,
      `scrollWidth ${state.pageScrollWidth} > innerWidth ${state.viewportWidth}`);

    // The blocked script is the point of this pass; everything else must be quiet.
    const errors = appErrors(browser).filter((e) => !/jsdelivr|MathJax/i.test(e.text));
    eq('no console errors beyond the blocked script', errors.map((e) => e.text), []);
    eq('no uncaught exceptions', browser.exceptions.map((e) => e.text), []);
  } finally {
    await browser.close();
  }
}

const pointer = await pointerFor(SITE, GENERATION);
const server = await serve(SITE, { port: 4000, pointer });
try {
  for (const viewport of VIEWPORTS) await runViewport(server, viewport);
  await runOffline(server);
} finally {
  await server.close();
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
