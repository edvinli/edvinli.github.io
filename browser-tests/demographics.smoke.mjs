// "Demografisk analys": the SVT/Valu exit-poll dashboard, and the tabs that
// lead to it.
//
// Every number the dashboard draws comes from
// files/election-simulator/valu/2026-demografi.json (pages 20-34 of SVT/Valu's
// 2026 seminar), and every reference line from results/2026.json. So the
// suite reads both files and checks the page against them rather than
// against numbers written here:
//
//   * the tabs: the page's two parts, the forecast and the 2026 election, and
//     the 2026 part's views; #valet-2026, #demografi and #valjarfloden open
//     their views, a link into either part brings it back, and only one view
//     shows at a time;
//   * "Partival per grupp": one stacked bar per published group, each
//     party's segment as wide as its share of the row, and with one party
//     chosen, each bar at the party's share and the line at its result;
//   * "Kvinnor mot män": for every age band of page 21, women's and men's
//     share per party and per bloc on one scale, the gap in the middle, and
//     the analysis left out when the file does not pair women with men;
//   * "Utveckling 1991-2026": one line per party, a legend that hides and
//     shows them, the other mode with one line per group, and the crosshair;
//   * "Plånboksröstning": every published figure, against the 39 % line;
//   * the copy of the presentation is the file the data was read from, and
//     each analysis links to its page in it;
//   * a data file that does not validate shows an error, not a dashboard.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/demographics.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve } from './server.mjs';
import { readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
// The copy kept in the repository is the file the numbers were read from.
const pdfBytes = await readFile(join(SITE, DATA.replace(/[^/]+$/, data.source.local_copy)));
const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
const resultShare = (party) => party === 'Övr' ? result.other_parties.vote_share_pct : result.parties[party].vote_share_pct;

async function open(viewport, hash, root = SITE) {
  const server = await serve(root, { port: 4000 });
  const browser = await launch(viewport);
  await browser.setViewport(viewport.width, viewport.height);
  await browser.goto(`http://localhost:${server.port}${PAGE}${hash}`);
  return { server, browser };
}

// The views a reader can see: shown themselves, and in a part that is shown.
const panels = (browser) => browser.evaluate(() =>
  ['election-simulator-app', 'election-outcome-result', 'election-flows', 'election-demographics']
    .filter((id) => !document.getElementById(id).closest('[hidden]')));
const selectedTabs = (browser) => browser.evaluate(() =>
  Array.from(document.querySelectorAll('[role=tab][aria-selected=true]')).map((tab) => tab.id));

async function dashboard(viewport, name) {
  console.log(`\n[dashboard] ${name}`);
  const { server, browser } = await open(viewport, '#demografi');
  try {
    const ready = await browser.waitFor(() => document.querySelector('#edm-view .edm-stack-row'), 20000);
    check('the dashboard renders', Boolean(ready));
    equal('#demografi opens only the dashboard', await panels(browser), ['election-demographics']);
    equal('its tab is selected', await browser.evaluate(() =>
      document.getElementById('election-tab-demographics').getAttribute('aria-selected')), 'true');

    // --- The presentation: served, and linked page by page.
    const pdfPath = `/${DATA.replace(/[^/]+$/, data.source.local_copy)}`;
    const links = await browser.evaluate(async (path) => {
      const response = await fetch(path);
      const head = new Uint8Array(await response.arrayBuffer()).slice(0, 5);
      return {
        status: response.status,
        magic: String.fromCharCode(...head),
        source: Array.from(document.querySelectorAll('#edm-source a')).map((a) => a.getAttribute('href')),
        page: document.querySelector('#edm-view .election-panel__head a')?.getAttribute('href'),
      };
    }, pdfPath);
    equal('the presentation is served as a PDF', [links.status, links.magic], [200, '%PDF-']);
    check('the source note links the copy and SVT\'s original',
      links.source[0]?.endsWith(pdfPath) && links.source[1] === data.source.url, links.source);
    check('the analysis links its page in the copy', links.page?.endsWith(`${pdfPath}#page=${data.cross_sections[0].page}`), links.page);

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

    // --- Kvinnor mot män: every age band, bloc and party, on one scale.
    const pairing = data.cross_sections.find((t) => t.id === 'kon-och-alder');
    const BLOCS = [['V', 'S', 'MP'], ['M', 'SD']];
    const gender = await browser.evaluate(async () => {
      document.querySelector('[data-analysis="gender"]').click();
      // Each choice redraws the panel, so the buttons are looked up afresh.
      const count = document.querySelectorAll('#edm-age-band button').length;
      const out = [];
      for (let i = 0; i < count; i += 1) {
        document.querySelectorAll('#edm-age-band button')[i].click();
        const button = document.querySelectorAll('#edm-age-band button')[i];
        out.push({
          band: button.textContent,
          pressed: button.getAttribute('aria-pressed'),
          title: document.querySelector('.edm-title').textContent,
          lede: document.querySelector('#edm-view .election-panel__head p').textContent,
          rows: Array.from(document.querySelectorAll('.edm-fly__row')).map((row) => ({
            label: row.querySelector('.edm-fly__mid b').textContent,
            gap: row.querySelector('.edm-fly__mid small').textContent,
            spoken: row.getAttribute('aria-label'),
            sides: ['women', 'men'].map((side) => {
              const track = row.querySelector(`.edm-fly__track--${side}`);
              return {
                value: track.querySelector('.edm-fly__value').textContent,
                larger: track.querySelector('.edm-fly__value').classList.contains('is-larger'),
                // --share is the bar's part of the common scale.
                bars: Array.from(track.querySelectorAll('.edm-fly__bar')).map((bar) => Number(bar.style.getPropertyValue('--share'))),
              };
            }),
          })),
        });
      }
      return out;
    });
    const bandCount = pairing.sections[0].groups.length;
    equal('an age band per pair on page 21', gender.map((g) => g.band),
      pairing.sections[0].groups.map((g) => g.label.replace(/^Kvinnor\s+/, '')));
    const genderErrors = [];
    const pct = (v) => `${v}\u00a0%`;
    gender.forEach((view, b) => {
      const women = pairing.sections[0].groups[b].shares;
      const men = pairing.sections[1].groups[b].shares;
      const share = (shares, party) => shares[data.parties.indexOf(party)];
      const expected = BLOCS.map((list) => ({ label: list.join(' + '), list }))
        .concat(data.parties.map((party) => ({ label: party, list: [party] })))
        .map((row) => ({
          label: row.label,
          women: row.list.map((p) => share(women, p)),
          men: row.list.map((p) => share(men, p)),
        }));
      if (view.pressed !== 'true' || view.title !== `Kvinnor och män ${view.band}`) genderErrors.push({ band: view.band, pressed: view.pressed, title: view.title });
      if (view.rows.length !== expected.length) { genderErrors.push({ band: view.band, rows: view.rows.length }); return; }
      // One scale for every bar: value / fraction is the same everywhere.
      const scales = [];
      expected.forEach((row, r) => {
        const drawn = view.rows[r];
        const w = row.women.reduce((a, c) => a + c, 0);
        const m = row.men.reduce((a, c) => a + c, 0);
        const gap = w === m ? 'lika' : w > m ? `← ${w - m}\u00a0p.e.` : `${m - w}\u00a0p.e. →`;
        const [ws, ms] = drawn.sides;
        // Women's bars are drawn outermost first, so the list reads back to front.
        const womenBars = ws.bars.slice().reverse();
        if (drawn.label !== row.label || ws.value !== pct(w) || ms.value !== pct(m) || drawn.gap !== gap ||
            ws.larger !== (w > m) || ms.larger !== (m > w) ||
            womenBars.length !== row.women.length || ms.bars.length !== row.men.length ||
            !drawn.spoken.includes(`kvinnor ${w} procent, män ${m} procent`)) {
          genderErrors.push({ band: view.band, row: row.label, drawn });
          return;
        }
        row.women.forEach((v, i) => { if (v) scales.push(v / womenBars[i]); });
        row.men.forEach((v, i) => { if (v) scales.push(v / ms.bars[i]); });
      });
      if (!scales.every((sc) => near(sc, scales[0], scales[0] * 0.002))) genderErrors.push({ band: view.band, scales });
      const blocW = BLOCS.map((list) => list.reduce((a, p) => a + share(women, p), 0));
      const blocM = BLOCS.map((list) => list.reduce((a, p) => a + share(men, p), 0));
      if (!view.lede.startsWith(`${pct(blocW[0])} av kvinnorna röstade på V, S eller MP, mot ${pct(blocM[0])} av männen. M eller SD fick ${pct(blocM[1])} av männens röster och ${pct(blocW[1])} av kvinnornas.`)) {
        genderErrors.push({ band: view.band, lede: view.lede });
      }
    });
    equal('each band: every party and bloc, women left and men right, on one scale', genderErrors, []);
    check('page 21 as published: 18–30 women 53 % and men 34 % for V+S+MP, 32 % and 49 % for M+SD',
      gender[0] && gender[0].lede.startsWith(`${pct(53)} av kvinnorna röstade på V, S eller MP, mot ${pct(34)} av männen. M eller SD fick ${pct(49)} av männens röster och ${pct(32)} av kvinnornas.`),
      gender[0] && gender[0].lede);
    check('all bands offered', gender.length === bandCount && bandCount > 0, gender.length);

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
    equal('two parts: the forecast and the 2026 election',
      await browser.evaluate(() => Array.from(document.querySelectorAll('#election-tabs [role=tab]'))
        .map((tab) => tab.querySelector('.election-modes__name').textContent)), ['Prognos 2030', 'Valet 2026']);
    await browser.evaluate(() => document.getElementById('election-tab-outcome').click());
    equal('the 2026 part opens on its result', await panels(browser), ['election-outcome-result']);
    equal('and names itself in the address', await browser.evaluate(() => location.hash), '#valet-2026');
    await browser.evaluate(() => document.getElementById('election-tab-flows').click());
    equal('the flows tab opens the flows', await panels(browser), ['election-flows']);
    equal('and names itself in the address', await browser.evaluate(() => location.hash), '#valjarfloden');
    equal('the part and the view are both selected', await selectedTabs(browser),
      ['election-tab-outcome', 'election-tab-flows']);
    await browser.evaluate(() => document.getElementById('election-tab-demographics').click());
    equal('the dashboard tab opens the dashboard', await panels(browser), ['election-demographics']);
    await browser.evaluate(() => document.getElementById('election-tab-forecast').click());
    equal('the forecast tab leaves the 2026 part', await panels(browser), ['election-simulator-app']);
    equal('and clears the address', await browser.evaluate(() => location.hash), '');
    await browser.evaluate(() => document.getElementById('election-tab-outcome').click());
    equal('the 2026 part comes back on the view last open', await panels(browser), ['election-demographics']);
    equal('and its address is that view', await browser.evaluate(() => location.hash), '#demografi');
    await browser.evaluate(() => { location.hash = '#election-model'; });
    await settle(200);
    equal('a link into the forecast brings it back', await panels(browser), ['election-simulator-app']);
    await browser.evaluate(() => { location.hash = '#election-result'; });
    await settle(200);
    equal('a link into the result opens the 2026 part on it', await panels(browser), ['election-outcome-result']);
    await browser.evaluate(() => {
      const tab = document.getElementById('election-tab-result');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    equal('End moves to the last view of the part', await panels(browser), ['election-demographics']);
    await browser.evaluate(() => {
      const tab = document.getElementById('election-tab-outcome');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    equal('Home on the parts moves to the forecast', await panels(browser), ['election-simulator-app']);
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
    const unpaired = structuredClone(data);
    unpaired.cross_sections.find((t) => t.id === 'kon-och-alder').sections.reverse();
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

    console.log('\n[women and men not paired] desktop');
    await writeFile(join(root, DATA), `${JSON.stringify(unpaired)}\n`);
    const second = await open(DESKTOP, '#demografi', root);
    try {
      await second.browser.waitFor(() => document.querySelector('#edm-view .edm-stack-row'), 15000);
      const state = await second.browser.evaluate(() => {
        const button = document.querySelector('.edm-nav [data-analysis="gender"]');
        button.click();
        return {
          hidden: button.hidden && getComputedStyle(button).display === 'none',
          stillGroups: document.querySelectorAll('.edm-stack-row').length > 0,
          butterflies: document.querySelectorAll('.edm-fly__row').length,
        };
      });
      equal('the gender analysis is left out; the rest still draws', state, { hidden: true, stillGroups: true, butterflies: 0 });
      equal('no uncaught exceptions', second.browser.exceptions.map((e) => e.text), []);
    } finally {
      await second.browser.close();
      await second.server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log('\n[source]');
equal('the copy of the presentation has the recorded SHA-256', pdfHash, data.source.raw_sha256);
await dashboard(DESKTOP, 'desktop');
await dashboard(MOBILE, 'mobile');
await tabs();
await invalidData();

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
