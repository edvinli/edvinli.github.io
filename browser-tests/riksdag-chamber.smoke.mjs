// The roll-call overlay on "Som i kammaren" (/election-simulator/, Valet 2026).
//
// assets/js/riksdag-votes.js colours each numbered seat of the hall by how its
// occupant voted in one vote of the session the seating plan is for. Bench
// numbers in votes.json are the hall's seat numbers; a substitute sits in the
// bench of the member they replace, and the vote's own roster says who sat
// there. Every expectation is read from files/riksdag/ and the members and
// seating files on disk.
//
// It guards:
//   * nothing is fetched and nothing changes until the hall view is opened,
//     and nothing changes until a vote is picked;
//   * each seat's colour is the ballot of its bench, the legend is the vote's
//     counts, the Speaker's chair and the Prime Minister's place carry none;
//   * the card names the occupant from the vote's roster (substitutes too);
//   * "Röstade mot partilinjen" marks exactly the members the pipeline's
//     summary lists as against the line on that vote;
//   * clearing the vote, or going back to Partivis, restores the chamber;
//   * fail-closed: without files/riksdag/, with an invalid votes.json, with a
//     session other than the seating plan's, or without riksdag-votes.js at
//     all, the chamber behaves exactly as before;
//   * no console errors, no horizontal overflow at 360px.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/riksdag-chamber.smoke.mjs [path/to/_site]

import { launch } from './cdp.mjs';
import { serve, pointerFor } from './server.mjs';
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(process.argv[2] || './_site');
const PAGE = '/election-simulator/';
const DESKTOP = { width: 1280, height: 1000 };
const MOBILE = { width: 360, height: 800 };
const DATA = 'files/riksdag';
const SEATING = 'files/election-simulator/results/2026-seating.json';
const MEMBERS = 'files/election-simulator/results/2026-members.json';
// The election-day publication, as in election-result.smoke.mjs: a frozen
// generation whose page shows the 2026 result and its chamber.
const DECIDED_GENERATION = '20260913T054241Z-496dd879';
const CHAMBER = 349;
const COLORS = { J: 'rgb(42, 108, 176)', N: 'rgb(212, 98, 42)', A: 'rgb(44, 42, 37)', F: 'rgb(217, 212, 202)' };

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
const appErrors = (browser, allowed = []) => browser.consoleErrors.filter(
  (entry) => !/favicon|images\/manifest\.json/.test(entry.text) && !allowed.some((re) => re.test(entry.text)));

// --- expectations from the files --------------------------------------------

const plan = await readJson(SITE, SEATING);
const members = await readJson(SITE, MEMBERS);
const index = await readJson(SITE, DATA, 'index.json');
const session = index.sessions.find((s) => s.rm === plan.riksmote);
if (!session) throw new Error(`files/riksdag/index.json has no session ${plan.riksmote}`);
const votes = await readJson(SITE, DATA, session.votes.path);
const summary = await readJson(SITE, DATA, session.summary.path);
const occupant = (vote, bench) => {
  const holder = votes.seat_holders[votes.rosters[vote.roster][bench - 1]];
  return { ...votes.people[holder[0]], party: holder[1] };
};
const newestFirst = votes.votes.map((v, i) => ({ v, i }))
  .sort((a, b) => (b.v.date || '').localeCompare(a.v.date || '') || b.i - a.i).map(({ v }) => v);
// The vote with the most members against the line, per the pipeline.
const againstBy = {};
summary.members.forEach((m) => (m.against_line_vote_ids || []).forEach((id) => {
  (againstBy[id] = againstBy[id] || []).push(m.id);
}));
const againstVote = votes.votes.slice().sort((a, b) => (againstBy[b.id] || []).length - (againstBy[a.id] || []).length)[0];
// A bench whose occupant on that vote is not the one the members file lists:
// a substitute, or a change since the members file was written.
const listedAt = {};
Object.values(members.parties).flat().forEach((m) => {
  if (m.substitute) listedAt[m.substitute.seat] = m.substitute.name;
  else if (m.seat > 0) listedAt[m.seat] = m.name;
});

async function open(viewport, root = SITE) {
  const pointer = await pointerFor(root, DECIDED_GENERATION);
  const server = await serve(root, { port: 4000, pointer });
  const browser = await launch(viewport);
  await browser.goto(`http://localhost:${server.port}${PAGE}`);
  await browser.evaluate(() => document.getElementById('election-tab-outcome')?.click());
  await browser.evaluate(() => document.getElementById('election-tab-result')?.click());
  const bound = await browser.waitFor(() =>
    document.getElementById('election-result-parliament')?.getAttribute('data-members') === 'true', 25000);
  if (!bound) throw new Error('the result chamber never bound its members');
  await settle(300);
  return { server, browser };
}

const riksdagRequests = (browser) => browser.evaluate(() =>
  performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.includes('/files/riksdag/')));

function chamberState(browser) {
  return browser.evaluate(() => {
    const host = document.getElementById('election-result-parliament');
    return Array.from(host.querySelectorAll('.election-seat')).map((dot) => [
      dot.style.left, dot.style.top, dot.style.backgroundColor, dot.className, dot.getAttribute('data-vote')]);
  });
}

function setView(browser, view) {
  return browser.evaluate((v) => document.querySelector(`#election-result-view [data-view="${v}"]`).click(), view);
}

function pickVote(browser, id) {
  return browser.evaluate((value) => {
    const pick = document.getElementById('election-votes-pick');
    pick.value = value;
    pick.dispatchEvent(new Event('change'));
  }, id);
}

function readHall(browser) {
  return browser.evaluate(() => {
    const host = document.getElementById('election-result-parliament');
    const dots = Array.from(host.querySelectorAll('.election-seat')).filter((d) => !d.classList.contains('is-offstage'));
    return {
      seats: dots.map((d) => ({ seat: d.hallSeat, vote: d.getAttribute('data-vote'), color: d.style.backgroundColor,
        against: d.classList.contains('rv-against'), dim: d.classList.contains('rv-dim') })),
      legend: Array.from(document.querySelectorAll('#election-votes-legend .ep-legend__item'))
        .map((li) => [li.dataset.vote, li.querySelector('.ep-legend__seats').textContent]),
      legendShown: !document.getElementById('election-votes-legend').hidden,
      partyLegendShown: !document.getElementById('election-result-legend').hidden,
      summary: document.getElementById('election-votes-summary').textContent,
      overlay: host.getAttribute('data-vote-overlay'),
    };
  });
}

// --- 1. the overlay ---------------------------------------------------------

async function main(viewport, name) {
  console.log(`\n[overlay] ${name}`);
  const { server, browser } = await open(viewport);
  try {
    const panel = () => browser.evaluate(() => !document.getElementById('election-result-votes').hidden);
    check('hidden in the party view', !(await panel()));
    equal('nothing is fetched before the hall view is opened', await riksdagRequests(browser), []);
    const partyView = await chamberState(browser);

    await setView(browser, 'seating');
    const shown = await browser.waitFor(() =>
      !document.getElementById('election-result-votes').hidden &&
      document.getElementById('election-votes-pick').options.length > 1, 15000);
    check('the vote picker appears in Som i kammaren', shown);
    equal('only the index and the session\'s votes are fetched', (await riksdagRequests(browser)).sort(),
      [`/${DATA}/${session.votes.path}`, `/${DATA}/index.json`].sort());
    const options = await browser.evaluate(() => ({
      values: Array.from(document.getElementById('election-votes-pick').options).map((o) => o.value),
      groups: Array.from(document.querySelectorAll('#election-votes-pick optgroup')).map((g) => g.label),
      against: document.getElementById('election-votes-against').disabled,
      link: document.getElementById('election-votes-link').getAttribute('href'),
    }));
    equal('the picker lists the latest votes, newest first, after "Ingen"', options.values,
      [''].concat(newestFirst.slice(0, 60).map((v) => v.id)));
    check('"Röstade mot partilinjen" waits for a vote', options.against);
    check('the overlay links to the voting page', /\/riksdagen-roster\/$/.test(options.link), options.link);
    const hallBefore = await chamberState(browser);
    check('until a vote is picked no seat carries a vote', hallBefore.every((d) => d[4] === null));

    // Pick the newest vote.
    const vote = newestFirst[0];
    await pickVote(browser, vote.id);
    await settle();
    const hall = await readHall(browser);
    const numbered = hall.seats.filter((s) => s.seat >= 1 && s.seat <= CHAMBER).sort((a, b) => a.seat - b.seat);
    equal('every numbered seat is in the hall once', numbered.map((s) => s.seat), Array.from({ length: CHAMBER }, (_, i) => i + 1));
    const wrong = numbered.filter((s) => s.vote !== vote.ballots[s.seat - 1] || s.color !== COLORS[s.vote]);
    equal('each seat shows the ballot of its bench', wrong.slice(0, 3), []);
    equal('the Speaker\'s chair and the Prime Minister\'s place carry no vote',
      hall.seats.filter((s) => s.seat === 0 || s.seat === CHAMBER + 1).map((s) => s.vote), hall.seats.filter((s) => s.seat === 0 || s.seat === CHAMBER + 1).map(() => '-'));
    equal('the legend is the vote\'s counts', hall.legend,
      [['J', String(vote.counts[0])], ['N', String(vote.counts[1])], ['A', String(vote.counts[2])], ['F', String(vote.counts[3])]]);
    check('the vote legend replaces the party legend', hall.legendShown && !hall.partyLegendShown, hall);
    equal('the chamber names the vote it shows', hall.overlay, vote.id);

    // The card names who sat there on that vote.
    const benches = [1, 175, 349];
    const different = Array.from({ length: CHAMBER }, (_, i) => i + 1).find((b) => listedAt[b] && listedAt[b] !== occupant(vote, b).name);
    if (different) benches.push(different);
    const cards = await browser.evaluate((wanted) => {
      const host = document.getElementById('election-result-parliament');
      const dots = Array.from(host.querySelectorAll('.election-seat')).filter((d) => !d.classList.contains('is-offstage'));
      return wanted.map((bench) => {
        const dot = dots.find((d) => d.hallSeat === bench);
        dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const tip = document.getElementById('election-result-member-tip');
        const text = tip.innerText;
        host.dispatchEvent(new MouseEvent('mouseleave'));
        return { bench, name: tip.querySelector('.ep-tip__name')?.textContent.trim(), text };
      });
    }, benches);
    const label = { J: 'Röstade ja', N: 'Röstade nej', A: 'Röstade avstår', F: 'Frånvarande' };
    cards.forEach((card) => {
      const who = occupant(vote, card.bench);
      check(`seat ${card.bench}: the card names ${who.name} and the ballot`,
        card.name === who.name && card.text.includes(label[vote.ballots[card.bench - 1]]), card);
    });
    if (different) {
      const card = cards.find((c) => c.bench === different);
      check(`seat ${different}: the card says who the members file lists`, card.text.includes(`I ledamotslistan: ${listedAt[different]}`), card.text);
    }
    const announced = await browser.evaluate(() => {
      const host = document.getElementById('election-result-parliament');
      host.focus();
      // Home is the Speaker's chair (no vote); the next place is seat 1.
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const text = document.getElementById('election-result-member-status').textContent;
      host.blur();
      return text;
    });
    check('the keyboard announces the occupant and the ballot',
      announced.startsWith(`${occupant(vote, 1).name},`) && /Röstade|Frånvarande/.test(announced) && /Plats 1 i kammaren/.test(announced), announced);

    // Against the party line, on the vote the pipeline lists most for.
    const expected = (againstBy[againstVote.id] || []);
    await pickVote(browser, againstVote.id);
    await browser.evaluate(() => document.getElementById('election-votes-against').click());
    await settle();
    const marked = await readHall(browser);
    const markedIds = marked.seats.filter((s) => s.against).map((s) => occupant(againstVote, s.seat).id).sort();
    equal(`"Röstade mot partilinjen" marks the ${expected.length} the pipeline lists`, markedIds, expected.slice().sort());
    check('everyone else is faded', marked.seats.filter((s) => !s.against).every((s) => s.dim));
    check('the pressed state is exposed', await browser.evaluate(() =>
      document.getElementById('election-votes-against').getAttribute('aria-pressed') === 'true'));
    if (expected.length) {
      const bench = marked.seats.find((s) => s.against).seat;
      const text = await browser.evaluate((b) => {
        const host = document.getElementById('election-result-parliament');
        const dot = Array.from(host.querySelectorAll('.election-seat')).find((d) => d.hallSeat === b && !d.classList.contains('is-offstage'));
        dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const t = document.getElementById('election-result-member-tip').innerText;
        host.dispatchEvent(new MouseEvent('mouseleave'));
        return t;
      }, bench);
      check('an against-line card carries the feltryckning note', /Mot partilinjen/.test(text) && /feltryckning/.test(text), text);
    }

    // Clearing restores the chamber exactly.
    await browser.evaluate(() => document.getElementById('election-votes-against').click());
    await pickVote(browser, '');
    await settle();
    equal('"Ingen" restores the hall exactly', await chamberState(browser), hallBefore);
    check('the party legend is back', await browser.evaluate(() => !document.getElementById('election-result-legend').hidden));

    // A vote left on, then back to Partivis.
    await pickVote(browser, vote.id);
    await settle();
    await setView(browser, 'party');
    await settle(800);
    check('Partivis hides the picker', !(await panel()));
    equal('Partivis restores the party view exactly', await chamberState(browser), partyView);

    await setView(browser, 'seating');
    await settle(800);
    const overflow = await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no horizontal overflow with the overlay open (${overflow}px)`, overflow <= 0, overflow);
    equal('no console errors', appErrors(browser).map((e) => e.text), []);
    equal('no exceptions', browser.exceptions.map((e) => e.text || String(e)), []);
  } finally {
    await browser.close();
    await server.close();
  }
}

// --- 2. fail-closed ----------------------------------------------------------

async function failClosed(label, mutate, allowed) {
  console.log(`\n[${label}] desktop`);
  const root = await mkdtemp(join(tmpdir(), 'riksdag-chamber-site-'));
  try {
    await cp(SITE, root, { recursive: true });
    await mutate(root);
    const { server, browser } = await open(DESKTOP, root);
    try {
      const partyView = await chamberState(browser);
      await setView(browser, 'seating');
      await settle(1500);
      const state = await browser.evaluate(() => ({
        panel: !document.getElementById('election-result-votes').hidden,
        pressed: document.querySelector('#election-result-view [data-view="seating"]').getAttribute('aria-pressed'),
        votes: Array.from(document.querySelectorAll('#election-result-parliament .election-seat')).filter((d) => d.getAttribute('data-vote')).length,
        legend: !document.getElementById('election-result-legend').hidden,
      }));
      equal('the hall view works and no vote overlay appears', state, { panel: false, pressed: 'true', votes: 0, legend: true });
      const card = await browser.evaluate(() => {
        const host = document.getElementById('election-result-parliament');
        const dot = Array.from(host.querySelectorAll('.election-seat')).find((d) => d.hallSeat === 1 && !d.classList.contains('is-offstage'));
        dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const t = document.getElementById('election-result-member-tip').innerText;
        host.dispatchEvent(new MouseEvent('mouseleave'));
        return { name: dot.member.name, text: t };
      });
      check('the card is the members-file card', card.text.startsWith(card.name) && !/Röstade|Partilinjen/.test(card.text), card);
      await setView(browser, 'party');
      await settle(800);
      equal('Partivis is as before', await chamberState(browser), partyView);
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
await failClosed('files/riksdag absent', (root) => rm(join(root, DATA), { recursive: true, force: true }),
  [/files\/riksdag\/index\.json/]);
await failClosed('votes.json does not validate', async (root) => {
  const path = join(root, DATA, session.votes.path);
  const broken = JSON.parse(await readFile(path, 'utf8'));
  broken.votes[0].ballots = broken.votes[0].ballots.slice(1);
  await writeFile(path, JSON.stringify(broken));
}, []);
await failClosed('no session for the seating plan', async (root) => {
  const path = join(root, DATA, 'index.json');
  const other = JSON.parse(await readFile(path, 'utf8'));
  other.sessions = other.sessions.filter((s) => s.rm !== plan.riksmote);
  await writeFile(path, JSON.stringify(other));
}, []);
await failClosed('riksdag-votes.js absent', (root) => rm(join(root, 'assets/js/riksdag-votes.js')),
  [/assets\/js\/riksdag-votes\.js/]);

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'} ${checks} checks`);
process.exit(failures ? 1 : 0);
