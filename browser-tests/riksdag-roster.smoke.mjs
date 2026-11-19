// Riksdagen röstar (/riksdagen-roster/): the roll-call voting page.
//
// Every expectation is read from the files the site ships under
// files/riksdag/ -- index.json, the summaries and votes.json -- so a page
// that started rounding, re-deriving or transcribing numbers disagrees with
// the files rather than with a constant written here. It guards:
//
//   * the default period: the newest term once it has enough votes, else the
//     last complete term, with a note giving the current session's n;
//   * the agreement matrix, both counting modes, the committee filter, the
//     "-" for cells under the pipeline's minimum n, and arrow-key navigation;
//   * the map: one dot per placed member, eight parties, axis ends labelled
//     by the top-loading pattern and never as left/right, member hover and
//     keyboard, and the "no map yet" state;
//   * votes against the party line: the party table, the member search and a
//     member's against-line votes (lazy-loading votes.json);
//   * participation only inside a member's card, always with the kvittning
//     caveat, and no ranking/sorting/filtering by it anywhere;
//   * the vote browser: votes.json only once the browser is near the screen,
//     search, and party lines equal to the summary's for every vote;
//   * fail-closed: a missing index or an invalid summary shows a message and
//     no half-drawn panels; no console errors; no horizontal overflow at 360px.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/riksdag-roster.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve } from './server.mjs';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/riksdagen-roster/';
const DATA = 'files/riksdag';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const DEFAULT_SCOPE_MIN_VOTES = 100;

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail).slice(0, 600)}`}`);
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// The page prints Swedish numbers: a no-break space between thousands and
// before %. Compare in plain spaces.
const plain = (text) => String(text ?? '').replace(/\u00a0/g, ' ');
const sv = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
const appErrors = (browser, allowed = []) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text) && !allowed.some((re) => re.test(entry.text)));

// --- expectations from the files --------------------------------------------

const index = await readJson(SITE, DATA, 'index.json');
const terms = index.terms.slice().sort((a, b) => a.label.localeCompare(b.label));
const newest = terms.at(-1);
const complete = terms.filter((t) => t.term_complete);
const current = index.sessions.find((s) => s.rm === index.current_session);
const expectedTerm = newest.n_votes_analysis >= DEFAULT_SCOPE_MIN_VOTES ? newest : complete.at(-1);
const termSummary = await readJson(SITE, DATA, expectedTerm.summary.path);
const currentSummary = await readJson(SITE, DATA, current.summary.path);
const SEATING = ['V', 'S', 'MP', 'C', 'L', 'KD', 'M', 'SD'];
const latestSessionOfTerm = expectedTerm.sessions.slice().sort().at(-1);
const latestSessionEntry = index.sessions.find((s) => s.rm === latestSessionOfTerm);

async function open(viewport, root = SITE) {
  const server = await serve(root, { port: 4000 });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  return { server, browser };
}

async function waitForPage(browser) {
  const ok = await browser.waitFor(() =>
    document.querySelectorAll('#rv-matrix td.rv-matrix__cell').length > 0 &&
    document.getElementById('rv-status').hidden, 20000);
  if (!ok) throw new Error('the page never finished loading');
  await settle(300);
}

const resources = (browser) => browser.evaluate(() =>
  performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));

function readMatrix(browser) {
  return browser.evaluate(() => Array.from(document.querySelectorAll('#rv-matrix td.rv-matrix__cell')).map((td) => ({
    row: td.dataset.row, col: td.dataset.col, n: Number(td.dataset.n),
    share: td.dataset.share === undefined ? null : td.dataset.share,
    value: td.querySelector('.rv-matrix__value')?.textContent || null,
    nText: td.querySelector('.rv-matrix__n')?.textContent || null,
    label: td.getAttribute('aria-label'),
  })));
}

function expectedMatrix(summary, mode, committee) {
  const block = committee ? summary.agreement.by_committee[committee][mode] : summary.agreement.overall[mode];
  const parties = summary.agreement.parties;
  const min = summary.agreement.min_cell_n;
  const order = SEATING.filter((p) => parties.includes(p));
  const cells = [];
  for (const row of order) {
    for (const col of order) {
      const i = parties.indexOf(row);
      const j = parties.indexOf(col);
      const n = block.n[i][j];
      const share = block.share[i][j];
      if (row === col) cells.push({ row, col, n, kind: 'self' });
      else if (typeof share !== 'number' || n < min) cells.push({ row, col, n, kind: 'few' });
      else cells.push({ row, col, n, kind: 'share', share, value: String(Math.round(share * 100)) });
    }
  }
  return cells;
}

function compareMatrix(label, actual, expected) {
  const bad = [];
  if (actual.length !== expected.length) bad.push({ length: actual.length, expected: expected.length });
  expected.forEach((cell, k) => {
    const got = actual[k] || {};
    if (got.row !== cell.row || got.col !== cell.col || got.n !== cell.n) bad.push({ k, got, cell });
    else if (cell.kind === 'share' && (Number(got.share) !== cell.share || got.value !== cell.value)) bad.push({ k, got, cell });
    else if (cell.kind === 'few' && (got.value !== '–' || got.nText !== `n=${cell.n}`)) bad.push({ k, got, cell });
  });
  check(label, bad.length === 0, bad.slice(0, 3));
}

// --- 1. the default page -----------------------------------------------------

async function main(viewport, name) {
  console.log(`\n[page] ${name}`);
  const { server, browser } = await open(viewport);
  try {
    await waitForPage(browser);
    const head = await browser.evaluate(() => ({
      scope: document.getElementById('rv-scope').value,
      options: Array.from(document.getElementById('rv-scope').options).map((o) => o.value),
      note: document.getElementById('rv-scope-note').hidden ? null : document.getElementById('rv-scope-note').textContent,
      votes: document.getElementById('rv-fact-votes').textContent.replace(/\s/g, ''),
      panels: Array.from(document.querySelectorAll('.rv-panel')).map((p) => [p.id, !p.hidden]),
      text: document.body.innerText,
      nav: Array.from(document.querySelectorAll('.masthead__menu-item a')).map((a) => a.textContent.trim()),
    }));
    equal('opens on the expected period', head.scope, `term:${expectedTerm.label}`);
    const first = (await resources(browser)).filter((p) => p.includes('/files/riksdag/'));
    equal('the first load is the index and one summary; votes.json waits',
      first.sort(), [`/${DATA}/${expectedTerm.summary.path}`, `/${DATA}/index.json`].sort());
    check('every session and term is offered',
      [...index.terms.map((t) => `term:${t.label}`), ...index.sessions.map((s) => `rm:${s.rm}`)].every((k) => head.options.includes(k)),
      head.options);
    if (expectedTerm !== newest) {
      check('the note says why, with the current session\'s n',
        head.note && head.note.includes(current.rm) && head.note.includes(String(current.n_votes_analysis)), head.note);
    }
    equal('the hero counts the analysis votes', head.votes, String(termSummary.counts.votes_analysis));
    check('all five panels are shown', head.panels.every(([, shown]) => shown), head.panels);
    check('participation appears nowhere on the page until a member is opened', !/deltagande/i.test(head.text));
    check('the page is in the navigation next to Riksdagsval',
      head.nav.indexOf('Riksdagen röstar') === head.nav.indexOf('Riksdagsval') + 1, head.nav);

    // Agreement: the default count, the other count, a committee.
    compareMatrix('three-way matrix equals the summary', await readMatrix(browser), expectedMatrix(termSummary, 'three_way'));
    await browser.evaluate(() => document.querySelector('#rv-mode [data-mode="ja_nej"]').click());
    await settle();
    compareMatrix('Ja/Nej matrix equals the summary', await readMatrix(browser), expectedMatrix(termSummary, 'ja_nej'));
    equal('the count toggle is a pressed button', await browser.evaluate(() =>
      Array.from(document.querySelectorAll('#rv-mode button')).map((b) => b.getAttribute('aria-pressed'))), ['false', 'true']);
    const committee = Object.keys(termSummary.agreement.by_committee).sort()[0];
    await browser.evaluate((code) => {
      const select = document.getElementById('rv-committee');
      select.value = code;
      select.dispatchEvent(new Event('change'));
    }, committee);
    await settle();
    compareMatrix(`committee ${committee} (Ja/Nej) equals the summary`, await readMatrix(browser),
      expectedMatrix(termSummary, 'ja_nej', committee));
    const committeeLabel = await browser.evaluate(() => document.getElementById('rv-committee').selectedOptions[0].textContent);
    check('the committee is named in full', committeeLabel.startsWith(termSummary.agreement.by_committee[committee].name), committeeLabel);
    await browser.evaluate(() => {
      const select = document.getElementById('rv-committee');
      select.value = '';
      select.dispatchEvent(new Event('change'));
      document.querySelector('#rv-mode [data-mode="three_way"]').click();
    });
    await settle();

    // Keyboard: one tab stop, arrows move, the detail line follows.
    const keys = await browser.evaluate(() => {
      const tabbable = document.querySelectorAll('#rv-matrix td[tabindex="0"]').length;
      const first = document.querySelector('#rv-matrix td[tabindex="0"]');
      first.focus();
      const a = document.getElementById('rv-matrix-detail').textContent;
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const b = document.getElementById('rv-matrix-detail').textContent;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const active = document.activeElement;
      return { tabbable, a, b, at: [active.dataset.row, active.dataset.col], label: active.getAttribute('aria-label') };
    });
    equal('the matrix is one tab stop', keys.tabbable, 1);
    check('arrow keys move through the cells', keys.a !== keys.b && keys.at[0] === SEATING[1] && keys.at[1] === SEATING[2], keys);
    check('each cell has a full sentence for assistive tech', /hade samma linje i \d+\s%/.test(keys.label), keys.label);

    // The map.
    const placed = termSummary.members.filter((m) => typeof m.map.x === 'number');
    const map = await browser.evaluate(() => ({
      dots: document.querySelectorAll('#rv-map .rv-map__mp').length,
      parties: Array.from(document.querySelectorAll('#rv-map .rv-map__party')).map((g) => g.dataset.party).sort(),
      ends: Array.from(document.querySelectorAll('#rv-map .rv-map__end')).map((t) => [t.dataset.end, t.textContent]),
      axes: document.getElementById('rv-map-axes').innerText,
      label: document.getElementById('rv-map').getAttribute('aria-label'),
      unavailable: !document.getElementById('rv-map-unavailable').hidden,
      frame: !document.getElementById('rv-map-frame').hidden,
    }));
    equal('one dot per placed member', map.dots, placed.length);
    equal('eight party marks', map.parties, termSummary.map.parties.slice().sort());
    const top1 = termSummary.map.top_loading_patterns.axis_1[0];
    const top2 = termSummary.map.top_loading_patterns.axis_2[0];
    const end = (pattern, positive) => {
      const ja = `${pattern.parties_ja.join(', ')} ja`;
      const nej = `${pattern.parties_nej.join(', ')} nej`;
      return (pattern.loading >= 0) === positive ? ja : nej;
    };
    equal('axis ends are labelled by the top-loading pattern', map.ends, [
      ['x+', `${end(top1, true)} →`], ['x-', `← ${end(top1, false)}`],
      ['y+', `↑ ${end(top2, true)}`], ['y-', `↓ ${end(top2, false)}`]]);
    const pct = (x) => `${Math.round(x * 100)} % av variationen`;
    check('axes state explained variance', plain(map.axes).includes(pct(termSummary.map.explained_variance_ratio[0])) &&
      plain(map.axes).includes(pct(termSummary.map.explained_variance_ratio[1])), map.axes);
    check('no axis says left or right', !/vänster|höger/i.test(map.axes + map.ends.join(' ')), map.axes);
    check('the map has a text alternative naming every party', termSummary.map.parties.every((p) => map.label.includes(p)), map.label);
    check('the map is shown', map.frame && !map.unavailable);

    // Hover a member who sits apart, so no other dot is nearer.
    const dist = (a, b) => Math.hypot(a.map.x - b.map.x, a.map.y - b.map.y);
    const loner = placed.map((m, i) => ({ i, m, d: Math.min(...placed.filter((o) => o !== m).map((o) => dist(m, o))) }))
      .sort((a, b) => b.d - a.d)[0];
    const hover = await browser.evaluate((i) => {
      const dot = document.querySelectorAll('#rv-map .rv-map__mp')[i];
      const box = dot.getBoundingClientRect();
      dot.scrollIntoView({ block: 'center' });
      const b2 = dot.getBoundingClientRect();
      document.getElementById('rv-map').dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: b2.left + b2.width / 2, clientY: b2.top + b2.height / 2, pointerType: 'mouse' }));
      const tip = document.getElementById('rv-map-tip');
      return { shown: !tip.hidden, text: tip.innerText, w: box.width };
    }, loner.i);
    check('hovering a member shows their card', hover.shown && hover.text.startsWith(loner.m.name), hover);
    check('the card names party, valkrets and votes cast',
      plain(hover.text).includes(loner.m.valkrets || '') &&
      plain(hover.text).includes(`Avlagda röster: ${sv(loner.m.cast)} av ${sv(loner.m.seated)}`), hover.text);
    check('participation in the card carries the kvittning caveat',
      /deltagande/.test(hover.text) && /kvittning/.test(hover.text), hover.text);
    const keyboard = await browser.evaluate(() => {
      const svg = document.getElementById('rv-map');
      svg.focus();
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      const a = document.getElementById('rv-map-status').textContent;
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const b = document.getElementById('rv-map-status').textContent;
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { a, b, focusable: svg.tabIndex === 0, hidden: document.getElementById('rv-map-tip').hidden };
    });
    check('the map is keyboard reachable and announces members',
      keyboard.focusable && keyboard.a && keyboard.b && keyboard.a !== keyboard.b && /kvittning/.test(keyboard.b), keyboard);
    check('Escape closes the card', keyboard.hidden);

    // Against the party line.
    const against = await browser.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('#rv-against-parties tbody tr')).map((tr) => [
        tr.dataset.party, ...Array.from(tr.querySelectorAll('td')).slice(0, 2).map((td) => td.textContent.replace(/\s/g, ''))]),
      count: document.getElementById('rv-members-count').textContent.replace(/\s/g, ''),
      sortControls: document.querySelectorAll('#rv-against [aria-sort], #rv-against [data-sort]').length,
    }));
    const pal = termSummary.party_against_line;
    equal('party table equals the summary', against.rows,
      SEATING.filter((p) => pal[p]).map((p) => [p, String(pal[p].against), String(pal[p].comparable)]));
    const rebels = termSummary.members.filter((m) => m.against_line > 0);
    equal('the member list starts with everyone who voted against the line', against.count, `${rebels.length}ledamöter`);
    equal('no sort controls', against.sortControls, 0);
    const target = rebels.filter((m) => m.against_line_vote_ids.length >= 2)
      .sort((a, b) => a.against_line - b.against_line)[0] || rebels[0];
    const before = (await resources(browser)).filter((p) => p.endsWith('/votes.json'));
    await browser.evaluate((name) => {
      const input = document.getElementById('rv-against-search');
      input.value = name;
      input.dispatchEvent(new Event('input'));
      document.querySelector('#rv-members .rv-member__toggle').click();
    }, target.name);
    const opened = await browser.waitFor(() => document.querySelectorAll('#rv-members .rv-member__votes li').length > 0, 15000);
    const detail = await browser.evaluate(() => ({
      items: document.querySelectorAll('#rv-members li.rv-member').length,
      votes: Array.from(document.querySelectorAll('#rv-members .rv-member__votes li')).map((li) => li.innerText),
      text: document.querySelector('#rv-members .rv-member__detail').innerText,
      expanded: document.querySelector('#rv-members .rv-member__toggle').getAttribute('aria-expanded'),
    }));
    check('searching finds the member', detail.items >= 1, detail);
    check('opening a member lists every against-line vote', opened && detail.votes.length === target.against_line_vote_ids.length, detail);
    check('each listed vote is dated and named', detail.votes.every((t) => /\d{4}/.test(t) && /röstade (ja|nej|avstår)/.test(t)), detail.votes);
    check('the member card has participation with the kvittning caveat', /deltagande/.test(detail.text) && /kvittning/.test(detail.text), detail.text);
    check('the feltryckning note is beside the votes', /feltryckning/.test(detail.text), detail.text);
    equal('the toggle reports its state', detail.expanded, 'true');
    const loadedForMember = (await resources(browser)).filter((p) => p.endsWith('/votes.json') && !before.includes(p));
    const neededSessions = [...new Set(target.against_line_vote_ids.map((id) => termSummary.party_lines.votes.find((v) => v.id === id).rm))];
    equal('only the sessions holding those votes were fetched', loadedForMember.map((p) => p.split('/').at(-2)).sort(),
      neededSessions.map((rm) => rm.replace('/', '-')).sort());

    // The vote browser: votes.json only near the screen, then search and lines.
    await browser.evaluate(() => {
      const input = document.getElementById('rv-against-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      document.getElementById('rv-browser').scrollIntoView({ block: 'start' });
    });
    const listed = await browser.waitFor(() => document.querySelectorAll('#rv-votes li').length > 0, 15000);
    check('the vote browser lists votes once in view', listed);
    const loaded = await resources(browser);
    check('the browser loaded the newest session of the period',
      loaded.some((p) => p.endsWith(`/${latestSessionEntry.votes.path}`)), loaded.filter((p) => p.includes('riksdag')));
    const votes = await readJson(SITE, DATA, latestSessionEntry.votes.path);
    const sessionSummary = await readJson(SITE, DATA, latestSessionEntry.summary.path);
    const pick = votes.votes.find((v) => v.committee && v.counts[2] > 0) || votes.votes[0];
    await browser.evaluate((q) => {
      const input = document.getElementById('rv-browser-search');
      input.value = q;
      input.dispatchEvent(new Event('input'));
    }, `${pick.beteckning} ${pick.date}`);
    await settle();
    const found = await browser.evaluate(() => Array.from(document.querySelectorAll('#rv-votes button')).map((b) => [b.dataset.vote, b.innerText]));
    check('search by beteckning and date finds the vote', found.some(([id]) => id === pick.id), found.slice(0, 5));
    await browser.evaluate((id) => document.querySelector(`#rv-votes button[data-vote="${id}"]`).click(), pick.id);
    await settle();
    const shownVote = await browser.evaluate(() => ({
      lines: Array.from(document.querySelectorAll('#rv-vote-detail tbody tr')).map((tr) => [tr.dataset.party, tr.querySelector('.rv-line')?.dataset.line || null]),
      text: document.getElementById('rv-vote-detail').innerText,
      pressed: document.querySelector('#rv-votes button[aria-pressed="true"]')?.dataset.vote,
    }));
    const official = sessionSummary.party_lines.votes.find((v) => v.id === pick.id);
    const officialLines = Object.fromEntries(sessionSummary.party_lines.parties.map((p, i) => [p, official.lines[i]]));
    equal('the vote\'s party lines equal the pipeline\'s',
      shownVote.lines.filter(([p]) => p !== '-'), SEATING.filter((p) => p in officialLines).map((p) => [p, officialLines[p]]));
    check('the result is printed from the counts',
      shownVote.text.includes(`Ja ${pick.counts[0]}, nej ${pick.counts[1]}, avstår ${pick.counts[2]}, frånvarande ${pick.counts[3]}`), shownVote.text);
    equal('the selected vote is marked', shownVote.pressed, pick.id);

    // The browser's party-line rule equals the pipeline's on every vote of
    // two sessions: the current one and the newest of the period.
    for (const entry of [current, latestSessionEntry]) {
      const mismatch = await browser.evaluate(async (paths) => {
        const [v, s] = await Promise.all(paths.map((p) => fetch(`/files/riksdag/${p}`).then((r) => r.json())));
        const data = window.RiksdagVotes.normalizeVotes(v);
        const bad = [];
        s.party_lines.votes.forEach((entry) => {
          const vote = data.byId[entry.id];
          const lines = window.RiksdagVotes.partyLines(data, vote).lines;
          s.party_lines.parties.forEach((party, i) => {
            const mine = party in lines ? lines[party] : null;
            if (mine !== entry.lines[i]) bad.push([entry.id, party, mine, entry.lines[i]]);
          });
        });
        return { bad: bad.slice(0, 5), n: s.party_lines.votes.length, data: Boolean(data) };
      }, [entry.votes.path, entry.summary.path]);
      check(`party lines for all ${mismatch.n} votes of ${entry.rm} equal the pipeline's`, mismatch.data && mismatch.bad.length === 0, mismatch.bad);
    }

    // Sources.
    const sources = await browser.evaluate(() => ({
      items: document.querySelectorAll('#rv-sources li').length,
      // textContent: the source list sits in a closed <details>.
      text: document.getElementById('rv-methods').textContent,
      docs: document.getElementById('rv-docs').href,
    }));
    equal('every source file is listed', sources.items, termSummary.provenance.sources.length);
    check('sources carry retrieval time and sha256', termSummary.provenance.sources.every((s) => sources.text.includes(s.sha256)));
    check('the snapshot names its source commit', sources.text.includes(index.snapshot.source_commit.slice(0, 12)), null);
    check('the methods link the pipeline docs', /docs\/riksdag_votes\.md$/.test(sources.docs), sources.docs);

    // The current session: no map yet, every cell under the minimum.
    await browser.evaluate((key) => {
      document.getElementById('rv-scope').scrollIntoView();
      const select = document.getElementById('rv-scope');
      select.value = key;
      select.dispatchEvent(new Event('change'));
    }, `rm:${current.rm}`);
    await browser.waitFor((n) => document.getElementById('rv-fact-votes').textContent.replace(/\s/g, '') === n, 10000,
      String(currentSummary.counts.votes_analysis));
    await settle(300);
    compareMatrix(`${current.rm}: cells under the minimum show – and n`, await readMatrix(browser), expectedMatrix(currentSummary, 'three_way'));
    const noMap = await browser.evaluate(() => ({
      note: document.getElementById('rv-map-unavailable').hidden ? null : document.getElementById('rv-map-unavailable').textContent,
      frame: document.getElementById('rv-map-frame').hidden,
    }));
    if (currentSummary.map.available) {
      check(`${current.rm} has a map`, !noMap.frame && !noMap.note, noMap);
    } else {
      check(`${current.rm}: the page says there is no map yet`, noMap.frame && noMap.note && noMap.note.includes('Kartan finns inte'), noMap);
    }

    const overflow = await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no horizontal overflow (${overflow}px)`, overflow <= 0, overflow);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
    equal('no exceptions', browser.exceptions.map((e) => e.text || String(e)), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 2. fail-closed ---------------------------------------------------------

async function broken(label, mutate, expectation, allowed) {
  console.log(`\n[${label}] desktop`);
  const root = await mkdtemp(join(tmpdir(), 'riksdag-roster-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    await mutate(root);
    const { server, browser } = await open(DESKTOP, root);
    try {
      await browser.waitFor(() => document.getElementById('rv-status').className.includes('error'), 15000);
      await settle(300);
      const state = await browser.evaluate(() => ({
        status: document.getElementById('rv-status').textContent,
        error: document.getElementById('rv-status').className.includes('election-status--error'),
        panels: Array.from(document.querySelectorAll('.rv-panel')).filter((p) => !p.hidden).map((p) => p.id),
        cells: document.querySelectorAll('#rv-matrix td').length,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      check('an error message is shown', state.error && state.status.length > 0, state);
      equal('no panel is drawn', { panels: state.panels, cells: state.cells }, expectation);
      check('no horizontal overflow', state.overflow <= 0, state.overflow);
      equal('no console errors beyond the expected one', appErrors(browser, allowed).map((e) => e.text), []);
      equal('no exceptions', browser.exceptions.map((e) => e.text || String(e)), []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main(DESKTOP, 'desktop');
await main(MOBILE, 'mobile');
await broken('index.json missing', (root) => rm(join(root, DATA, 'index.json')), { panels: [], cells: 0 },
  [/files\/riksdag\/index\.json/]);
await broken('summary does not validate', async (root) => {
  const path = join(root, DATA, expectedTerm.summary.path);
  const summary = JSON.parse(await readFile(path, 'utf8'));
  summary.role = 'something_else';
  await writeFile(path, JSON.stringify(summary));
}, { panels: [], cells: 0 }, []);

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
