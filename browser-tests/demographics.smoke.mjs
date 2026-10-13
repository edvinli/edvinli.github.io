// "Demografisk analys": the SVT/Valu exit-poll dashboard, and the tabs that
// lead to it.
//
// Every number the dashboard draws comes from
// files/election-simulator/valu/2026-demografi.json (pages 20-34 of SVT/Valu's
// 2026 seminar), and every reference line from results/2026.json. So the
// suite reads both files and checks the page against them rather than
// against numbers written here:
//
//   * the tabs: #demografi and #valjarfloden open their panels, a link into
//     the forecast brings it back, and only one panel shows at a time;
//   * "Partival per grupp": one stacked bar per published group, each
//     party's segment as wide as its share of the row, and with one party
//     chosen, each bar at the party's share and the line at its result;
//   * "Utveckling 1991-2026": one line per party, a legend that hides and
//     shows them, the other mode with one line per group, and the crosshair;
//   * "Plånboksröstning": every published figure, against the 39 % line;
//   * a data file that does not validate shows an error, not a dashboard.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/demographics.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve } from './server.mjs';
import { readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DATA = 'files/election-simulator/valu/2026-demografi.json';
const RESULT = 'files/election-simulator/results/2026.json';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `\n         ${JSON.stringify(detail)}`}`);
}
const equal = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const appErrors = (browser) => browser.consoleErrors.filter(
  (e) => !/favicon|images\/manifest\.json/.test(e.text));
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));

const data = await readJson(SITE, DATA);
const result = await readJson(SITE, RESULT);
const resultShare = (party) => party === 'Övr' ? result.other_parties.vote_share_pct : result.parties[party].vote_share_pct;

async function open(viewport, hash, root = SITE) {
  const server = await serve(root, { port: 4000 });
  const browser = await launch(viewport);
  await browser.setViewport(viewport.width, viewport.height);
  await browser.goto(`http://localhost:${server.port}${PAGE}${hash}`);
  return { server, browser };
}

const panels = (browser) => browser.evaluate(() => ['election-simulator-app', 'election-flows', 'election-demographics']
  .filter((id) => !document.getElementById(id).hidden));

async function dashboard(viewport, name) {
  console.log(`\n[dashboard] ${name}`);
  const { server, browser } = await open(viewport, '#demografi');
  try {
    const ready = await browser.waitFor(() => document.querySelector('#edm-view .edm-stack-row'), 20000);
    check('the dashboard renders', Boolean(ready));
    equal('#demografi opens only the dashboard', await panels(browser), ['election-demographics']);
    equal('its tab is selected', await browser.evaluate(() =>
      document.getElementById('election-tab-demographics').getAttribute('aria-selected')), 'true');

    // --- Partival per grupp, all parties: every table, every group.
    const tables = await browser.evaluate(async (count) => {
      const out = [];
      const pick = (id, value) => { const s = document.getElementById(id); s.value = String(value); s.dispatchEvent(new Event('change', { bubbles: true })); };
      for (let t = 0; t < count; t += 1) {
        pick('edm-table-select', t);
        out.push(Array.from(document.querySelectorAll('.edm-stack-row')).map((row) => {
          const stack = row.querySelector('.edm-stack');
          const total = stack.getBoundingClientRect().width;
          return {
            label: row.querySelector('.edm-label').firstChild.textContent,
            segments: Array.from(stack.querySelectorAll('.edm-seg')).map((seg) => ({
              tip: seg.getAttribute('data-tip'), width: parseFloat(seg.style.width),
            })),
            spoken: stack.getAttribute('aria-label'),
            total,
          };
        }));
      }
      pick('edm-table-select', 0);
      return out;
    }, data.cross_sections.length);
    equal('every published table is offered', tables.length, data.cross_sections.length);
    const mismatches = [];
    data.cross_sections.forEach((table, t) => {
      const groups = table.sections.flatMap((section) => section.groups);
      if (tables[t].length !== groups.length) mismatches.push({ table: table.id, rows: tables[t].length, expected: groups.length });
      groups.forEach((group, g) => {
        const row = tables[t][g];
        if (!row || row.label !== group.label) { mismatches.push({ table: table.id, group: group.label, got: row && row.label }); return; }
        const total = group.shares.reduce((sum, v) => sum + v, 0);
        const drawn = data.parties.map((party, i) => ({ party, value: group.shares[i] })).filter((p) => p.value > 0);
        if (row.segments.length !== drawn.length) mismatches.push({ table: table.id, group: group.label, segments: row.segments.length });
        drawn.forEach((p, i) => {
          const seg = row.segments[i];
          if (!seg || !near(seg.width, p.value / total * 100, 0.01) || !seg.tip.includes(` ${p.value} %`)) {
            mismatches.push({ table: table.id, group: group.label, party: p.party, seg });
          }
        });
        if (!data.parties.every((party, i) => row.spoken.includes(`${party} ${group.shares[i]} procent`))) {
          mismatches.push({ table: table.id, group: group.label, spoken: row.spoken });
        }
      });
    });
    equal('every segment is its party\'s share of the row, and is spoken', mismatches, []);

    // --- One party: its share per group against its election result.
    const focus = await browser.evaluate(() => {
      const pick = (id, value) => { const s = document.getElementById(id); s.value = String(value); s.dispatchEvent(new Event('change', { bubbles: true })); };
      pick('edm-table-select', 2);
      pick('edm-focus-select', 'SD');
      const rows = Array.from(document.querySelectorAll('.edm-bars .edm-bar-row:not(.edm-bar-row--key)'));
      const out = {
        values: rows.map((row) => row.querySelector('.edm-value').textContent),
        widths: rows.map((row) => parseFloat(row.querySelector('.edm-bar').style.width)),
        refs: rows.map((row) => parseFloat(row.querySelector('.edm-ref').style.left)),
        key: document.querySelector('.edm-ref-label').textContent,
      };
      document.getElementById('edm-focus-clear').click();
      out.cleared = document.querySelectorAll('.edm-stack-row').length > 0;
      return out;
    });
    const sd = data.parties.indexOf('SD');
    const sdValues = data.cross_sections[2].sections.flatMap((s) => s.groups.map((g) => g.shares[sd]));
    equal('one party: a bar per group at its share', focus.values, sdValues.map((v) => `${v} %`));
    const scale = focus.widths.length ? sdValues[0] / focus.widths[0] * 100 : 0;
    check('one party: bars share one scale', focus.widths.every((w, i) => near(w, sdValues[i] / scale * 100, 0.01)), focus.widths);
    check('one party: the line is at the election result',
      focus.refs.every((left) => near(left, resultShare('SD') / scale * 100, 0.01)) &&
      focus.key === `Valresultat ${resultShare('SD').toFixed(1).replace('.', ',')} %`, { refs: focus.refs, key: focus.key });
    check('"Visa alla partier" returns to the stacked bars', focus.cleared);

    // --- Utveckling: a line per party, a legend that hides them, the other mode.
    const trends = await browser.evaluate(async () => {
      document.querySelector('[data-analysis="trends"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const lines = () => document.querySelectorAll('.edm-line__svg .edm-series').length;
      const out = { parties: lines() };
      const svg = document.querySelector('.edm-line__svg');
      const box = svg.getBoundingClientRect();
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: box.left + 40, clientY: box.top + 40, bubbles: true }));
      out.tip = document.querySelector('.edm-tip').innerText.split('\n')[0];
      out.tipShown = !document.querySelector('.edm-tip').hidden;
      document.querySelector('.edm-legend__toggle[data-series="SD"]').click();
      out.afterHide = lines();
      out.pressed = document.querySelector('.edm-legend__toggle[data-series="SD"]').getAttribute('aria-pressed');
      document.querySelector('#edm-trend-mode [data-value="group"]').click();
      out.groups = lines();
      return out;
    });
    equal('a line per party', trends.parties, data.parties.length);
    equal('the crosshair names the nearest election', [trends.tipShown, trends.tip], [true, String(data.trends.years[0])]);
    equal('the legend hides a line', [trends.afterHide, trends.pressed], [data.parties.length - 1, 'false']);
    equal('one party across groups: a line per group', trends.groups, data.trends.groups.length);

    // --- Plånboksröstning.
    const wallet = await browser.evaluate(() => {
      document.querySelector('[data-analysis="wallet"]').click();
      return {
        values: Array.from(document.querySelectorAll('.edm-bar-row:not(.edm-bar-row--key) .edm-value')).map((n) => n.textContent),
        key: Array.from(document.querySelectorAll('.edm-ref-label')).map((n) => n.textContent),
      };
    });
    const w = data.wallet_voting;
    equal('every pocketbook figure is drawn',
      wallet.values, Object.values(w.parties).concat(w.sections.flatMap((s) => s.groups.map((g) => g[1]))).map((v) => `${v} %`));
    check('against the overall figure', wallet.key.length === 2 && wallet.key.every((k) => k === `Samtliga ${w.overall} %`), wallet.key);

    equal('no horizontal scroll', await browser.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
    equal('no uncaught exceptions', browser.exceptions.map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function tabs() {
  console.log('\n[tabs] desktop');
  const { server, browser } = await open(DESKTOP, '');
  try {
    await settle(400);
    equal('the forecast is the default view', await panels(browser), ['election-simulator-app']);
    await browser.evaluate(() => document.getElementById('election-tab-flows').click());
    equal('the flows tab opens the flows', await panels(browser), ['election-flows']);
    equal('and names itself in the address', await browser.evaluate(() => location.hash), '#valjarfloden');
    await browser.evaluate(() => document.getElementById('election-tab-demographics').click());
    equal('the dashboard tab opens the dashboard', await panels(browser), ['election-demographics']);
    await browser.evaluate(() => { location.hash = '#election-model'; });
    await settle(200);
    equal('a link into the forecast brings it back', await panels(browser), ['election-simulator-app']);
    await browser.evaluate(() => {
      const tab = document.getElementById('election-tab-forecast');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    equal('End moves to the last tab', await panels(browser), ['election-demographics']);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function invalidData() {
  console.log('\n[invalid data file] desktop');
  const root = await mkdtemp(join(tmpdir(), 'demographics-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    const broken = structuredClone(data);
    broken.cross_sections[0].sections[0].groups[0].shares.pop();
    await writeFile(join(root, DATA), `${JSON.stringify(broken)}\n`);
    const { server, browser } = await open(DESKTOP, '#demografi', root);
    try {
      await browser.waitFor(() => /kunde inte/.test(document.getElementById('edm-view').textContent), 15000);
      const state = await browser.evaluate(() => ({
        error: document.getElementById('edm-status')?.className.includes('error'),
        bars: document.querySelectorAll('.edm-stack-row, .edm-bar-row, .edm-line__svg').length,
      }));
      equal('the dashboard reports the error and draws nothing', state, { error: true, bars: 0 });
      equal('no uncaught exceptions', browser.exceptions.map((e) => e.text), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await dashboard(DESKTOP, 'desktop');
await dashboard(MOBILE, 'mobile');
await tabs();
await invalidData();

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
