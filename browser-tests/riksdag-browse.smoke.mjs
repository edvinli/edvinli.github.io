// Riksdagen röstar, second part: finding votes and linking to views.
//
// riksdag-roster.smoke.mjs owns the page's panels; this suite owns what was
// added on top of them, reading every expectation from files/riksdag/:
//
//   * the acklamation caveat beside the matrix and in the methods, and the
//     <noscript> text with its links when JavaScript is off;
//   * a matrix cell lists the votes behind it: the count of "samma linje"
//     and "olika linje" equals the summary's agree and n − agree, for both
//     counting modes and a committee; the diagonal lists nothing;
//   * the quick filters: "Jämnaste" orders by vote_flags.margin (ties
//     newest first), "Med avvikande röster" is vote_flags.against_line > 0,
//     "Blocköverskridande" is vote_flags.cross_bloc and only offered when the
//     summary has blocs; they combine with search and utskott;
//   * the against-line list sorts by name, count or share, and nothing
//     anywhere offers participation as a sort or filter;
//   * the map's axis captions state explained variance, and its help text the
//     orientation the summary records;
//   * the query string: every state change is written, a link restores it,
//     and parameters that name nothing are dropped;
//   * "Visa i kammaren" on, and only on, votes of the seating plan's session;
//   * no console errors and no horizontal overflow at 360px.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/riksdag-browse.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve } from './server.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/riksdagen-roster/';
const DATA = 'files/riksdag';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const SEATING = 'files/election-simulator/results/2026-seating.json';

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
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const readJson = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));
const appErrors = (browser) => browser.consoleErrors.filter((entry) => !/favicon|images\/manifest\.json/.test(entry.text));
const plain = (text) => String(text ?? '').replace(/\u00a0/g, ' ');
const number = (text) => Number(plain(text).replace(/ /g, '').match(/^\d+/)?.[0]);

// --- expectations from the files --------------------------------------------

const index = await readJson(SITE, DATA, 'index.json');
const plan = await readJson(SITE, SEATING);
const terms = index.terms.slice().sort((a, b) => a.label.localeCompare(b.label));
const term = terms.filter((t) => t.term_complete).at(-1);
const summary = await readJson(SITE, DATA, term.files.summary.path);
const sessionOf = (rm) => index.sessions.find((s) => s.rm === rm);
const votesOf = {};
for (const s of index.sessions) votesOf[s.rm] = await readJson(SITE, DATA, s.files.votes.path);
const flags = summary.vote_flags.columns;
const lines = summary.party_lines;
const flagOf = Object.fromEntries(lines.votes.map((v, i) => [v.id, {
  rm: v.rm, analysis: v.analysis, margin: flags.margin[i], against: flags.against_line[i], cross: flags.cross_bloc[i],
}]));
const metaOf = {};
for (const rm of Object.keys(votesOf)) votesOf[rm].votes.forEach((v, i) => { metaOf[v.id] = { ...v, rm, order: i }; });
const newestSession = term.sessions.slice().sort().at(-1);

async function open(viewport, query = '') {
  const server = await serve(SITE, { port: 4000 });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}${query}`);
  const ok = await browser.waitFor(() =>
    document.querySelectorAll('#rv-matrix td.rv-matrix__cell').length > 0 && document.getElementById('rv-status').hidden, 20000);
  if (!ok) throw new Error('the page never finished loading');
  await settle(400);
  return { server, browser };
}

const listState = (browser) => browser.evaluate(() => ({
  count: document.getElementById('rv-votes-count').textContent,
  ids: Array.from(document.querySelectorAll('#rv-votes button[data-vote]')).map((b) => b.dataset.vote),
  pill: document.getElementById('rv-cell-filter').hidden ? null : document.getElementById('rv-cell-filter-text').textContent,
  session: document.getElementById('rv-browser-session').value,
  url: decodeURIComponent(location.search),
}));

async function waitList(browser) {
  await browser.waitFor(() => /voteringar?\s/.test(document.getElementById('rv-votes-count').textContent) &&
    !/Läser in/.test(document.getElementById('rv-votes-count').textContent), 20000);
  await settle(200);
}

function cellCounts(mode, committee, a, b) {
  const block = committee ? summary.agreement.by_committee[committee][mode] : summary.agreement.overall[mode];
  const i = summary.agreement.parties.indexOf(a);
  const j = summary.agreement.parties.indexOf(b);
  return { same: block.agree[i][j], diff: block.n[i][j] - block.agree[i][j] };
}

// --- 1. copy: acklamation and noscript --------------------------------------

async function copy() {
  console.log('\n[copy] desktop');
  const { server, browser } = await open(DESKTOP);
  try {
    const caveat = await browser.evaluate(() => {
      const note = document.getElementById('rv-acklamation');
      const table = document.getElementById('rv-matrix');
      return {
        shown: Boolean(note) && !note.hidden && note.getBoundingClientRect().height > 0,
        inSection: Boolean(note && note.closest('#rv-agreement')),
        beforeMatrix: Boolean(note && (note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)),
        text: note ? note.textContent : '',
        methods: document.getElementById('rv-methods').textContent,
      };
    });
    check('the acklamation caveat is shown in the agreement section, before the matrix',
      caveat.shown && caveat.inSection && caveat.beforeMatrix, caveat);
    check('it says most decisions are made without a vote, votes only on request, so agreement is understated',
      /acklamation/.test(caveat.text) && /begär/.test(caveat.text) && /underskattar/.test(caveat.text), caveat.text);
    check('the methods repeat it', /acklamation/.test(caveat.methods) && /begär/.test(caveat.methods));

    const declutter = await browser.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#riksdag-app .election-info__button'));
      const openBefore = buttons.filter((b) => b.getAttribute('aria-expanded') === 'true').length;
      buttons[0].click();
      const firstOpen = buttons[0].getAttribute('aria-expanded') === 'true' &&
        !document.getElementById(buttons[0].getAttribute('aria-controls')).hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closedAfterEsc = buttons[0].getAttribute('aria-expanded') === 'false' &&
        document.getElementById(buttons[0].getAttribute('aria-controls')).hidden;
      const details = document.getElementById('rv-methods-details');
      const methodsClosedInitially = Boolean(details) && !details.open;
      details.querySelector('summary').click();
      const methodsOpens = details.open;
      details.querySelector('summary').click();
      const govChip = Array.from(document.querySelectorAll('#rv-chips [data-chip]')).some((c) => /regering|gov_split/i.test(c.textContent + c.dataset.chip));
      return {
        infoCount: buttons.length,
        subtitles: document.querySelectorAll('#riksdag-app .rv-subtitle').length,
        openBefore,
        firstOpen,
        closedAfterEsc,
        methodsClosedInitially,
        methodsOpens,
        govChip,
      };
    });
    equal('four sections have concise subtitles and (i) popovers',
      { infoCount: declutter.infoCount, subtitles: declutter.subtitles, openBefore: declutter.openBefore },
      { infoCount: 4, subtitles: 4, openBefore: 0 });
    check('the (i) popover opens on click and closes on Escape', declutter.firstOpen && declutter.closedAfterEsc, declutter);
    check('Metod och källor is collapsed by default and opens on click', declutter.methodsClosedInitially && declutter.methodsOpens, declutter);
    check('gov_split is not shown as a UI chip', !declutter.govChip, declutter);

    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }

  console.log('\n[noscript] desktop, JavaScript off');
  const server2 = await serve(SITE, { port: 4000 });
  const browser2 = await launch(DESKTOP);
  try {
    await browser2.S('Emulation.setScriptExecutionDisabled', { value: true });
    await browser2.goto(`http://localhost:${server2.port}${PAGE}`);
    await settle(500);
    const off = await browser2.evaluate(() => {
      const box = document.querySelector('.rv-noscript');
      return {
        shown: Boolean(box) && box.getBoundingClientRect().height > 0,
        text: box ? box.textContent : '',
        links: box ? Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href')) : [],
      };
    });
    check('the noscript text is shown', off.shown, off);
    check('it says what the page shows and that it needs JavaScript', /JavaScript/.test(off.text) && /voteringar/.test(off.text), off.text);
    check('it links the data index and the pipeline docs',
      off.links.some((h) => /\/files\/riksdag\/index\.json$/.test(h)) && off.links.some((h) => /docs\/riksdag_votes\.md$/.test(h)), off.links);
  } finally {
    await browser2.close();
    await server2.close();
  }
}

// --- 2. the matrix filters the vote list -------------------------------------

async function pairs(viewport, name) {
  console.log(`\n[pairs and chips] ${name}`);
  const { server, browser } = await open(viewport);
  try {
    const before = await browser.evaluate(() => performance.getEntriesByType('resource')
      .map((e) => new URL(e.name).pathname).filter((p) => p.endsWith('/votes.json')).length);
    equal('no votes.json before anything is asked for', before, 0);

    // M and S, three-way, all committees.
    await browser.evaluate(() => document.querySelector('#rv-matrix td[data-row="M"][data-col="S"]').click());
    await waitList(browser);
    let state = await listState(browser);
    let expect = cellCounts('three_way', '', 'M', 'S');
    equal('a cell lists the votes where the pair had the same line', number(state.count), expect.same);
    equal('over the whole period', state.session, 'alla');
    check('an active-filter pill names the pair', /M och S hade samma linje/.test(state.pill || ''), state.pill);
    check('the URL carries the pair', /par=M-S/.test(state.url), state.url);
    const sample = state.ids.slice(0, 20).every((id) => {
      const i = lines.votes.findIndex((v) => v.id === id);
      const m = lines.parties.indexOf('M');
      const s = lines.parties.indexOf('S');
      return lines.votes[i].analysis && lines.votes[i].lines[m] && lines.votes[i].lines[m] === lines.votes[i].lines[s];
    });
    check('the listed votes are analysis votes where M and S agree', sample);
    await browser.evaluate(() => document.querySelector('#rv-cell-filter [data-rel="diff"]').click());
    await settle();
    state = await listState(browser);
    equal('"Olika linje" lists n − agree', number(state.count), expect.diff);
    check('the URL says olika', /linje=olika/.test(state.url), state.url);
    await browser.evaluate(() => document.getElementById('rv-cell-filter-clear').click());
    await settle();
    state = await listState(browser);
    check('clearing removes the pill and the parameter', state.pill === null && !/par=/.test(state.url), state);

    // Bara Ja/Nej in one committee, chosen by keyboard.
    const committee = Object.keys(summary.agreement.by_committee).sort()[1];
    await browser.evaluate((code) => {
      document.querySelector('#rv-mode [data-mode="ja_nej"]').click();
      const select = document.getElementById('rv-committee');
      select.value = code;
      select.dispatchEvent(new Event('change'));
    }, committee);
    await settle();
    await browser.evaluate(() => {
      const cell = document.querySelector('#rv-matrix td[data-row="C"][data-col="SD"]');
      cell.focus();
      cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitList(browser);
    state = await listState(browser);
    expect = cellCounts('ja_nej', committee, 'C', 'SD');
    equal(`Enter on C/SD in ${committee}, Ja/Nej: the summary's count`, number(state.count), expect.same);
    check('the pill names the mode and the committee',
      /bara ja\/nej/.test(state.pill) && state.pill.includes(summary.agreement.by_committee[committee].name), state.pill);
    await browser.evaluate(() => document.getElementById('rv-cell-filter-clear').click());
    const diagonal = await browser.evaluate(() => {
      document.querySelector('#rv-matrix td[data-row="KD"][data-col="KD"]').click();
      return document.getElementById('rv-cell-filter').hidden;
    });
    check('the diagonal lists nothing', diagonal);
    await browser.evaluate(() => {
      document.querySelector('#rv-mode [data-mode="three_way"]').click();
      const select = document.getElementById('rv-committee');
      select.value = '';
      select.dispatchEvent(new Event('change'));
      // The pair set the list's utskott to its own; the list keeps it
      // (visibly) after the pair is cleared, so reset it here.
      const listCommittee = document.getElementById('rv-browser-committee');
      listCommittee.value = '';
      listCommittee.dispatchEvent(new Event('change'));
      const session = document.getElementById('rv-browser-session');
      session.value = session.options[1].value;
      session.dispatchEvent(new Event('change'));
    });
    await waitList(browser);

    // Quick filters, on the newest session of the period (and full term for cross-bloc).
    const inSession = Object.keys(flagOf).filter((id) => flagOf[id].rm === newestSession);
    const chip = (key) => browser.evaluate((k) => document.querySelector(`#rv-chips [data-chip="${k}"]`).click(), key);
    await chip('dissent');
    await settle();
    state = await listState(browser);
    equal('"Med avvikande röster": votes with vote_flags.against_line > 0',
      number(state.count), inSession.filter((id) => flagOf[id].against > 0).length);
    await chip('dissent');
    const blocs = summary.blocs;
    const crossShown = await browser.evaluate(() => {
      const c = document.querySelector('#rv-chips [data-chip="cross"]');
      return { shown: !c.hidden, disabled: c.disabled, title: c.title, note: document.getElementById('rv-blocs-note').textContent };
    });
    if (blocs) {
      check('"Blocköverskridande" is offered with the blocs it uses',
        crossShown.shown && !crossShown.disabled && blocs.government_side.every((p) => crossShown.title.includes(p)) &&
        crossShown.note.includes(blocs.opposition.join(', ')), crossShown);
      // Verify the full term's cross-bloc count (16 strict cross-bloc votes for 2022-26).
      await browser.evaluate(() => {
        const s = document.getElementById('rv-browser-session');
        s.value = 'alla';
        s.dispatchEvent(new Event('change'));
      });
      await waitList(browser);
      await chip('cross');
      await settle();
      state = await listState(browser);
      const termCross = Object.keys(flagOf).filter((id) => flagOf[id].cross === 1).length;
      equal('"Blocköverskridande" over the whole term matches summary cross_bloc = 1',
        number(state.count), termCross);
      await chip('cross');
      await browser.evaluate((rm) => {
        const s = document.getElementById('rv-browser-session');
        s.value = rm;
        s.dispatchEvent(new Event('change'));
      }, newestSession);
      await waitList(browser);
      await chip('cross');
      await settle();
      state = await listState(browser);
      equal('"Blocköverskridande" in the session: votes with vote_flags.cross_bloc = 1',
        number(state.count), inSession.filter((id) => flagOf[id].cross === 1).length);
      await chip('cross');
    } else {
      check('without blocs "Blocköverskridande" is disabled', crossShown.shown && crossShown.disabled, crossShown);
    }
    await chip('close');
    await settle();
    state = await listState(browser);
    const closest = inSession.slice().sort((a, b) => flagOf[a].margin - flagOf[b].margin ||
      (metaOf[b].date || '').localeCompare(metaOf[a].date || '') || metaOf[b].order - metaOf[a].order);
    equal('"Jämnaste": smallest margin first, ties newest first', state.ids.slice(0, 15), closest.slice(0, 15));
    // Combined with search and utskott.
    const code = metaOf[closest[0]].committee || 'övrigt';
    await browser.evaluate((c) => {
      document.querySelector('#rv-chips [data-chip="dissent"]').click();
      const select = document.getElementById('rv-browser-committee');
      select.value = c;
      select.dispatchEvent(new Event('change'));
    }, code);
    await settle();
    state = await listState(browser);
    const combined = inSession.filter((id) => flagOf[id].against > 0 && (metaOf[id].committee || 'övrigt') === code);
    equal(`quick filters combine with utskott (${code})`, number(state.count), combined.length);
    check('the URL carries the filters', /filter=jamnast,avvikande/.test(state.url) || /filter=avvikande,jamnast/.test(state.url), state.url);

    const overflow = await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no horizontal overflow (${overflow}px)`, overflow <= 0, overflow);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
    equal('no exceptions', browser.exceptions.map((e) => e.text || String(e)), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 3. members, map, chamber links, contract --------------------------------

async function rest() {
  console.log('\n[members, map, links] desktop');
  const { server, browser } = await open(DESKTOP);
  try {
    const sorts = await browser.evaluate(() => ({
      options: Array.from(document.getElementById('rv-against-sort').options).map((o) => o.value),
      anyParticipation: Array.from(document.querySelectorAll('select option, button, label')).some((n) => /deltag|närvaro/i.test(n.textContent)),
    }));
    equal('sort by name, count or share', sorts.options, ['namn', 'antal', 'andel']);
    check('no control sorts or filters by participation', !sorts.anyParticipation);
    const rebels = summary.members.filter((m) => m.against_line > 0);
    const sortBy = async (value) => {
      await browser.evaluate((v) => {
        const select = document.getElementById('rv-against-sort');
        select.value = v;
        select.dispatchEvent(new Event('change'));
      }, value);
      await settle();
      return browser.evaluate(() => Array.from(document.querySelectorAll('#rv-members li[data-member]')).slice(0, 10).map((li) => li.dataset.member));
    };
    const byName = (a, b) => a.name.localeCompare(b.name, 'sv');
    equal('"antal": most votes against the line first', await sortBy('antal'),
      rebels.slice().sort((a, b) => b.against_line - a.against_line || byName(a, b)).slice(0, 10).map((m) => m.id));
    const share = (m) => m.against_line / m.against_line_comparable;
    equal('"andel": largest share of comparable votes first', await sortBy('andel'),
      rebels.slice().sort((a, b) => share(b) - share(a) || byName(a, b)).slice(0, 10).map((m) => m.id));
    check('the URL carries the sort', /sortera=andel/.test(await browser.evaluate(() => location.search)));

    const map = await browser.evaluate(() => ({
      axes: document.getElementById('rv-map-axes').textContent,
      orientation: document.getElementById('rv-map-orientation').textContent,
    }));
    const pct = (x) => `${Math.round(x * 100)} % av variationen`;
    check('axis captions: "Axel k – förklarar N % av variationen"',
      plain(map.axes).includes(`Axel 1 – förklarar ${pct(summary.map.explained_variance_ratio[0])}`) &&
      plain(map.axes).includes(`Axel 2 – förklarar ${pct(summary.map.explained_variance_ratio[1])}`), map.axes);
    const anchors = summary.map.orientation_axes.map((a) => a.anchor);
    check('the help text states the orientation the summary records',
      map.orientation.includes(`axel 1 är vänd så att ${anchors[0]}`) && map.orientation.includes(`axel 2 så att ${anchors[1]}`), map.orientation);
    check('no left/right in the orientation text', !/vänster|höger/i.test(map.orientation));
    const sessionSummary = await readJson(SITE, DATA, sessionOf(term.sessions[1]).files.summary.path);
    await browser.evaluate((key) => {
      const select = document.getElementById('rv-scope');
      select.value = key;
      select.dispatchEvent(new Event('change'));
    }, `rm:${term.sessions[1]}`);
    await browser.waitFor((rm) => document.getElementById('rv-fact-scope').textContent === rm, 10000, term.sessions[1]);
    await settle(300);
    const aligned = await browser.evaluate(() => document.getElementById('rv-map-orientation').textContent);
    if (sessionSummary.map.orientation_reference) {
      check(`${term.sessions[1]}: the session is aligned to its term`,
        aligned.includes(`mandatperioden ${term.label.replace('-', '–')}`), aligned);
    }

    // "Visa i kammaren" on the seating plan's session only.
    const chamberRm = plan.riksmote;
    await browser.evaluate((key) => {
      const select = document.getElementById('rv-scope');
      select.value = key;
      select.dispatchEvent(new Event('change'));
      document.getElementById('rv-browser').scrollIntoView();
    }, `rm:${chamberRm}`);
    await browser.waitFor(() => document.querySelectorAll('#rv-votes li').length > 0 &&
      document.querySelectorAll('#rv-votes .rv-vote__chamber').length > 0, 15000);
    const links = await browser.evaluate(() => Array.from(document.querySelectorAll('#rv-votes li')).map((li) => [
      li.querySelector('button').dataset.vote, li.querySelector('.rv-vote__chamber')?.getAttribute('href') || null]));
    const page = (id) => `/election-simulator/?riksdag_vote=${encodeURIComponent(id)}#valet-2026`;
    equal(`every ${chamberRm} vote links to the chamber`, links, links.map(([id]) => [id, page(id)]));
    await browser.evaluate(() => document.querySelector('#rv-votes button').click());
    const detailLink = await browser.evaluate(() => document.querySelector('#rv-vote-detail .rv-vote-detail__chamber')?.getAttribute('href'));
    equal('the vote detail links to the chamber too', detailLink, page(links[0][0]));
    const chamberSummary = await readJson(SITE, DATA, sessionOf(chamberRm).files.summary.path);
    const crossState = await browser.evaluate(() => {
      const c = document.querySelector('#rv-chips [data-chip="cross"]');
      c.click();
      return { hidden: c.hidden, disabled: c.disabled, pressed: c.getAttribute('aria-pressed') };
    });
    equal('the cross-bloc chip is disabled (and not pressed) when the summary has no blocs',
      crossState,
      { hidden: false, disabled: !chamberSummary.blocs, pressed: 'false' });
    await browser.evaluate((key) => {
      const select = document.getElementById('rv-scope');
      select.value = key;
      select.dispatchEvent(new Event('change'));
    }, `rm:${newestSession}`);
    await browser.waitFor((rm) => document.getElementById('rv-browser-session').value === rm &&
      document.querySelectorAll('#rv-votes li').length > 0, 15000, newestSession);
    await settle(300);
    const other = await browser.evaluate(() => {
      document.querySelector('#rv-votes button').click();
      return {
        list: document.querySelectorAll('#rv-votes .rv-vote__chamber').length,
        detail: Boolean(document.querySelector('#rv-vote-detail .rv-vote-detail__chamber')),
      };
    });
    equal(`${newestSession} votes do not link to the chamber`, other, { list: 0, detail: false });

    // The pipeline's against_line flag equals the browser's own count.
    const mismatch = await browser.evaluate(async (entries) => {
      const bad = [];
      for (const [votesPath, summaryPath] of entries) {
        const [v, s] = await Promise.all([votesPath, summaryPath].map((p) => fetch(`/files/riksdag/${p}`).then((r) => r.json())));
        const data = window.RiksdagVotes.normalizeVotes(v);
        s.party_lines.votes.forEach((entry, i) => {
          const vote = data.byId[entry.id];
          const mine = window.RiksdagVotes.againstLine(data, vote, window.RiksdagVotes.partyLines(data, vote)).length;
          if (mine !== s.vote_flags.columns.against_line[i] ||
              Math.abs(vote.counts.J - vote.counts.N) !== s.vote_flags.columns.margin[i]) bad.push([entry.id, mine, s.vote_flags.columns.against_line[i]]);
        });
      }
      return bad.slice(0, 5);
    }, index.sessions.map((s) => [s.files.votes.path, s.files.summary.path]));
    equal('vote_flags.against_line and margin equal the ballots on every vote of every session', mismatch, []);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
    equal('no exceptions', browser.exceptions.map((e) => e.text || String(e)), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 4. links restore the view -----------------------------------------------

async function links() {
  console.log('\n[deep links] desktop');
  const committee = Object.keys(summary.agreement.by_committee).sort()[2];
  const member = summary.members.filter((m) => m.against_line > 0).sort((a, b) => a.name.localeCompare(b.name, 'sv'))[3];
  const vote = Object.keys(flagOf).find((id) => flagOf[id].rm === newestSession && flagOf[id].against > 0 && metaOf[id].committee === committee) ||
    Object.keys(flagOf).find((id) => flagOf[id].rm === newestSession && flagOf[id].against > 0);
  const query = `?utskott=${encodeURIComponent(committee)}&rakna=janej&par=L-C&linje=olika&filter=avvikande&sok=&` +
    `riksmote=${encodeURIComponent(newestSession)}&votering=${vote}&ledamot=${member.id}&sortera=antal&alla_ledamoter=1`;
  const { server, browser } = await open(DESKTOP, query);
  try {
    await waitList(browser);
    await browser.waitFor(() => document.querySelectorAll('#rv-members .rv-member__votes li').length > 0, 15000);
    await settle(400);
    const view = await browser.evaluate(() => ({
      scope: document.getElementById('rv-scope').value,
      committee: document.getElementById('rv-committee').value,
      mode: document.querySelector('#rv-mode [aria-pressed="true"]').dataset.mode,
      pill: document.getElementById('rv-cell-filter').hidden ? null : document.getElementById('rv-cell-filter-text').textContent,
      chips: Array.from(document.querySelectorAll('#rv-chips [aria-pressed="true"]')).map((c) => c.dataset.chip),
      session: document.getElementById('rv-browser-session').value,
      vote: document.querySelector('#rv-vote-detail:not([hidden]) .rv-vote-detail__title')?.textContent || null,
      sort: document.getElementById('rv-against-sort').value,
      everyone: !document.getElementById('rv-against-only').checked,
      open: Array.from(document.querySelectorAll('#rv-members li[data-member]'))
        .filter((li) => li.querySelector('.rv-member__toggle').getAttribute('aria-expanded') === 'true').map((li) => li.dataset.member),
      url: decodeURIComponent(location.search),
    }));
    equal('the link restores the view', {
      scope: view.scope, committee: view.committee, mode: view.mode, chips: view.chips, session: view.session,
      sort: view.sort, everyone: view.everyone, open: view.open,
    }, {
      scope: `term:${term.label}`, committee, mode: 'ja_nej', chips: ['dissent'], session: newestSession,
      sort: 'antal', everyone: true, open: [member.id],
    });
    check('the pair comes back as "olika linje" in the linked committee and mode',
      /L och C hade olika linjer/.test(view.pill || '') && /bara ja\/nej/.test(view.pill) &&
      view.pill.includes(summary.agreement.by_committee[committee].name), view.pill);
    equal('the linked vote is open', view.vote, metaOf[vote].title);
    check('the restored URL keeps every part', ['utskott=', 'rakna=janej', 'par=L-C', 'linje=olika', 'filter=avvikande',
      `votering=${vote}`, `ledamot=${member.id}`, 'sortera=antal', 'alla_ledamoter=1'].every((p) => view.url.includes(p)), view.url);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
  } finally {
    await browser.close();
    await server.close();
  }

  console.log('\n[parameters that name nothing] desktop');
  const junk = '?period=1999-03&utskott=XYZ&rakna=nope&par=M-M&linje=x&filter=bogus,<b>&riksmote=1999%2F00' +
    '&votering=not-a-vote&ledamot=000&sortera=deltagande&parti=Q&ledamot_sok=';
  const second = await open(DESKTOP, junk);
  try {
    await settle(600);
    const view = await second.browser.evaluate(() => ({
      scope: document.getElementById('rv-scope').value,
      committee: document.getElementById('rv-committee').value,
      mode: document.querySelector('#rv-mode [aria-pressed="true"]').dataset.mode,
      pill: !document.getElementById('rv-cell-filter').hidden,
      chips: document.querySelectorAll('#rv-chips [aria-pressed="true"]').length,
      sort: document.getElementById('rv-against-sort').value,
      url: location.search,
    }));
    equal('they are ignored and dropped from the URL', view,
      { scope: `term:${term.label}`, committee: '', mode: 'three_way', pill: false, chips: 0, sort: 'namn', url: '' });
    equal('no console errors', appErrors(second.browser).map((e) => e.text), []);
    equal('no exceptions', second.browser.exceptions.map((e) => e.text || String(e)), []);
  } finally {
    await second.browser.close();
    await second.server.close();
  }
}

await copy();
await pairs(DESKTOP, 'desktop');
await pairs(MOBILE, 'mobile');
await rest();
await links();

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
