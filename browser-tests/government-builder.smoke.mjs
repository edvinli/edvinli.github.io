// Real-browser smoke test for the "Bygg din egen regering" panel.
//
// This is the only coverage in either repository that exercises the panel in a
// real DOM with the real stylesheet applied. The Node contract tests in the
// election-simulator repository (tests.test_actual_browser_consumer and its
// neighbours) run the module against stub DOM objects: they verify the
// data/lookup contract only, and cannot observe computed style, layout or the
// `hidden` attribute actually taking effect. A regression that leaves a panel
// visible-but-empty passes those tests and fails this one.
//
// Usage:
//   bundle exec jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/government-builder.smoke.mjs [path/to/_site]
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

// The schema-1.2 publication that introduced the coalition builder, and the
// schema-1.1 publication that predates it. Both are committed under
// files/election-simulator/versions/.
const GENERATION_1_2 = '20260828T064703Z-1da59168';
const GENERATION_1_1 = '20260827T205828Z-e6c6ee97';

const PARTY_ORDER = ['M', 'L', 'C', 'KD', 'S', 'V', 'MP', 'SD'];
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
  // Let the synchronous render pass following the load settle.
  await new Promise((r) => setTimeout(r, 300));
}

const readPanel = (browser) => browser.evaluate(() => {
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      hiddenAttr: el.hidden,
      display: style.display,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  };
  const byId = (id) => {
    const el = document.getElementById(id);
    return el ? box(el) : null;
  };
  const chips = (hostId) => Array.from(
    document.querySelectorAll(`#${hostId} .eg-builder__chip`)
  ).map((el) => Object.assign({ label: el.textContent.trim(), disabled: el.disabled }, box(el)));

  return {
    section: byId('election-government-builder'),
    empty: byId('election-government-empty'),
    results: byId('election-government-results'),
    aloneCard: byId('election-government-alone-result'),
    supportCard: byId('election-government-support-result'),
    government: chips('election-government-parties'),
    support: chips('election-support-parties'),
    governmentHost: byId('election-government-parties'),
    supportHost: byId('election-support-parties'),
  };
});

const clickChip = (browser, hostId, party) => browser.evaluate((arg) => {
  const el = document.querySelector(
    `#${arg[0]} .eg-builder__chip[data-party="${arg[1]}"]`);
  if (!el || el.disabled) return false;
  el.click();
  return true;
}, [hostId, party]);

const readCard = (browser, id) => browser.evaluate((cardId) => {
  const el = document.getElementById(cardId);
  const style = getComputedStyle(el);
  return {
    hiddenAttr: el.hidden,
    visible: style.display !== 'none' && el.getBoundingClientRect().height > 0,
    mask: el.getAttribute('data-coalition-mask'),
    text: el.textContent.replace(/\s+/g, ' ').trim(),
  };
}, id);

async function schema12(viewport, pointer) {
  console.log(`\n[schema 1.2 @ ${viewport.name} ${viewport.width}x${viewport.height}]`);
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);
    const panel = await readPanel(browser);

    check('panel is visible', panel.section.visible, JSON.stringify(panel.section));
    eq('government chip count', panel.government.length, 8);
    eq('support chip count', panel.support.length, 8);
    eq('government chip labels', panel.government.map((c) => c.label), PARTY_ORDER);
    eq('support chip labels', panel.support.map((c) => c.label), PARTY_ORDER);
    check('every chip has a non-zero box',
      panel.government.concat(panel.support).every((c) => c.visible && c.width > 0 && c.height > 0),
      JSON.stringify(panel.government.concat(panel.support).filter((c) => !(c.visible && c.width > 0 && c.height > 0))));
    check('chip hosts lay out as flex',
      panel.governmentHost.display === 'flex' && panel.supportHost.display === 'flex',
      `${panel.governmentHost.display} / ${panel.supportHost.display}`);
    check('initial empty state is visible', panel.empty.visible, JSON.stringify(panel.empty));
    check('result container is hidden initially',
      !panel.results.visible && panel.results.display === 'none', JSON.stringify(panel.results));
    check('result cards are hidden initially',
      !panel.aloneCard.visible && !panel.supportCard.visible,
      JSON.stringify([panel.aloneCard, panel.supportCard]));

    // Government selection: M + KD + SD -> bitmask 1 | 8 | 128 = 137.
    for (const party of ['M', 'KD', 'SD']) {
      check(`click government ${party}`, await clickChip(browser, 'election-government-parties', party));
    }
    const alone = await readCard(browser, 'election-government-alone-result');
    check('government result card appears', alone.visible, JSON.stringify(alone));
    eq('government coalition mask', alone.mask, '137');
    check('government result names the coalition', alone.text.includes('M + KD + SD'), alone.text);
    check('empty state is gone once a government is chosen',
      !(await readPanel(browser)).empty.visible);
    check('government parties are locked out of the support row',
      (await readPanel(browser)).support.filter((c) => c.disabled).map((c) => c.label).join(',') === 'M,KD,SD');

    // Support selection: + L -> union bitmask 137 | 2 = 139.
    check('click support L', await clickChip(browser, 'election-support-parties', 'L'));
    const union = await readCard(browser, 'election-government-support-result');
    check('support result card appears', union.visible, JSON.stringify(union));
    eq('union coalition mask', union.mask, '139');
    check('union result names the combined coalition', union.text.includes('M + L + KD + SD'), union.text);

    eq('no uncaught exceptions', browser.exceptions, []);
    eq('no console errors', appErrors(browser), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function schema11FailsClosed(pointer) {
  console.log('\n[schema 1.1 fails closed @ desktop]');
  const server = await serve(SITE, { port: 4000, pointer });
  const browser = await launch({ width: 1280, height: 1200 });
  try {
    await browser.goto(`http://127.0.0.1:${server.port}${PAGE}`);
    await waitForApp(browser);
    const panel = await readPanel(browser);
    // A publication without a coalition_builder must leave no trace of the
    // panel: this is the empty-shell regression that the `hidden` attribute
    // is responsible for preventing.
    check('panel keeps the hidden attribute', panel.section.hiddenAttr === true);
    check('panel is not rendered at all',
      !panel.section.visible && panel.section.display === 'none', JSON.stringify(panel.section));
    eq('no chips leak', panel.government.length + panel.support.length, 0);
    eq('no uncaught exceptions', browser.exceptions, []);
  } finally {
    await browser.close();
    await server.close();
  }
}

const pointer12 = await pointerFor(SITE, GENERATION_1_2);
const pointer11 = await pointerFor(SITE, GENERATION_1_1);
if (pointer12.schema_version !== '1.2') throw new Error('fixture is not schema 1.2');
if (pointer11.schema_version !== '1.1') throw new Error('fixture is not schema 1.1');

for (const viewport of VIEWPORTS) await schema12(viewport, pointer12);
await schema11FailsClosed(pointer11);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
