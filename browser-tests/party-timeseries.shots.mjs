// Screenshot capture for "Vägen till valdagen", used for review evidence.
//
// Not a suite: the CI selector only picks up *.smoke.mjs and *.contract.mjs,
// and this writes into the gitignored _shots/ directory. It exists so the
// before/after images in a pull request can be regenerated exactly rather than
// hand-cropped.
//
// Usage:
//   jekyll build --config _config.yml,_config.dev.yml
//   node browser-tests/party-timeseries.shots.mjs --label after [path/to/_site]
//   node browser-tests/party-timeseries.shots.mjs --label before --no-fixture <site>
//
// --no-fixture serves the site exactly as built, which is what the "before"
// state is: a publication with no party family.

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './cdp.mjs';
import { serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const labelIndex = argv.indexOf('--label');
const LABEL = labelIndex === -1 ? 'after' : argv[labelIndex + 1];
const USE_FIXTURE = !argv.includes('--no-fixture');
const positional = argv.filter((value, index) =>
  !value.startsWith('--') && index !== labelIndex + 1);
const SITE = resolve(positional[0] || join(HERE, '..', '_site'));
const OUT = join(HERE, '..', '_shots');
const PAGE = '/election-simulator/';
const HISTORY_RELATIVE = join('files', 'election-simulator', 'history', 'coalition-timeseries.json');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1100, coarse: false },
  { name: 'mobile', width: 360, height: 900, coarse: true },
];

const settle = (ms = 400) => new Promise((done) => setTimeout(done, ms));

async function prepareSite() {
  if (!USE_FIXTURE) return { root: SITE, cleanup: async () => {} };
  const fixture = JSON.parse(
    await readFile(join(HERE, 'fixtures', 'coalition-timeseries.json'), 'utf8'),
  );
  const root = await mkdtemp(join(tmpdir(), 'party-shots-site-'));
  await cp(SITE, root, { recursive: true });
  const historyPath = join(root, HISTORY_RELATIVE);
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(fixture)}\n`);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function capture(browser, name) {
  const clip = await browser.evaluate(() => {
    const section = document.getElementById('election-timeseries');
    if (!section) return null;
    const box = section.getBoundingClientRect();
    return {
      x: Math.max(0, box.left + window.scrollX - 8),
      y: Math.max(0, box.top + window.scrollY - 8),
      width: Math.min(box.width + 16, document.documentElement.scrollWidth),
      height: box.height + 16,
      scale: 1,
    };
  });
  const { data } = await browser.S('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    ...(clip ? { clip } : {}),
  });
  const file = join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log(`  wrote ${file}`);
}

function clickId(browser, id) {
  return browser.evaluate((wanted) => {
    const node = document.getElementById(wanted);
    if (!node) return false;
    node.click();
    return true;
  }, id);
}

function clickParty(browser, party) {
  return browser.evaluate((wanted) => {
    const node = document.querySelector(`#election-timeseries-parties button[data-party="${wanted}"]`);
    if (!node) return false;
    node.click();
    return true;
  }, party);
}

async function run(viewport, root) {
  const server = await serve(root, { port: 4000 });
  const browser = await launch({ width: viewport.width, height: viewport.height });
  try {
    if (viewport.coarse) {
      await browser.S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await browser.goto(`http://localhost:${server.port}${PAGE}`, { timeout: 30000 });
    await browser.waitFor(() => {
      const svg = document.getElementById('election-timeseries-svg');
      return Boolean(svg) && svg.childElementCount > 2;
    }, 25000);
    await settle(700);

    const prefix = `party-timeseries-${LABEL}-${viewport.name}`;
    await capture(browser, `${prefix}-coalitions-vote`);
    await clickId(browser, 'election-timeseries-seats');
    await settle();
    await capture(browser, `${prefix}-coalitions-seats`);
    await clickId(browser, 'election-timeseries-vote');
    await settle();

    const hasParties = await clickId(browser, 'election-timeseries-view-parties');
    const ready = hasParties && await browser.evaluate(() =>
      document.getElementById('election-timeseries')?.getAttribute('data-view-mode') === 'parties');
    if (!ready) {
      console.log(`  (no party family published; coalition shots only for ${viewport.name})`);
      return;
    }
    await settle();

    // One large party and one threshold-near party, in both metrics and both
    // ranges, because those are the four cases the domain rules differ on.
    for (const [role, party] of [['large', 'S'], ['threshold', 'L']]) {
      await clickParty(browser, party);
      await settle();
      await capture(browser, `${prefix}-${role}-${party}-vote-full`);
      await clickId(browser, 'election-timeseries-range-short');
      await settle();
      await capture(browser, `${prefix}-${role}-${party}-vote-short`);
      await clickId(browser, 'election-timeseries-range-full');
      await clickId(browser, 'election-timeseries-seats');
      await settle();
      await capture(browser, `${prefix}-${role}-${party}-seats`);
      await clickId(browser, 'election-timeseries-vote');
      await settle();
    }
  } finally {
    await Promise.allSettled([browser.close(), server.close()]);
  }
}

const site = await prepareSite();
await mkdir(OUT, { recursive: true });
try {
  for (const viewport of VIEWPORTS) {
    console.log(`\n${LABEL} · ${viewport.name}`);
    await run(viewport, site.root);
  }
} finally {
  await site.cleanup();
}
console.log('\ndone');
