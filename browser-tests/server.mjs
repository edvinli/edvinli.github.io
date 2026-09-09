// Static server for the built _site, with two hooks: the election-simulator
// publication pointer and the history artifact can each be overridden per run,
// so a test can exercise a specific published generation without touching the
// repository's current.json.
//
// Both hooks exist for the same reason. A pinned generation is frozen, but the
// history artifact ships outside the publication bundle and is replaced by
// every forecast sync. A historical regression that pins one and reads the
// other is not pinned at all: it asserts against whatever polling input the
// artifact happens to describe today, and starts failing when the two drift
// apart -- which says nothing about the generation under test.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.xml': 'application/xml',
};

const POINTER_PATH = '/files/election-simulator/current.json';
// `data-publication-base` in the built page, plus the name the app requests.
const HISTORY_PATH = '/files/election-simulator/history/coalition-timeseries.json';

/** Build a valid pointer for a published generation directory. */
export async function pointerFor(siteRoot, generation) {
  const dir = join(siteRoot, 'files/election-simulator/versions', generation);
  const manifest = await readFile(join(dir, 'manifest.json'));
  return {
    schema_version: JSON.parse(manifest).schema_version,
    publication_state: 'COMPLETE',
    publication_generation: generation,
    path: `versions/${generation}`,
    manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
  };
}

/**
 * Read a preserved history artifact fixture, and refuse one that is not a
 * usable history payload. A silently-wrong override would leave the page
 * rendering its "history unavailable" branch, and every provenance assertion
 * would then pass or fail for a reason unrelated to what it names.
 */
export async function historyFixture(path) {
  const history = JSON.parse(await readFile(path, 'utf8'));
  const polls = Array.isArray(history.polls) ? history.polls : null;
  if (typeof history.poll_source_sha256 !== 'string' || !history.poll_source_sha256) {
    throw new Error(`history fixture ${path} carries no poll_source_sha256`);
  }
  if (!polls || polls.length === 0) {
    throw new Error(`history fixture ${path} carries no polls`);
  }
  const newest = polls.map((poll) => poll.publication_date).filter(Boolean).sort().at(-1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newest || '')) {
    throw new Error(`history fixture ${path} has no dated newest poll`);
  }
  return { body: JSON.stringify(history), source: history.poll_source_sha256, newest, path };
}

export async function serve(siteRoot, { port = 4000, pointer = null, history = null } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (pointer && path === POINTER_PATH) {
      const body = JSON.stringify(pointer, null, 2);
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (history && path === HISTORY_PATH) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(history.body);
    }
    let file = join(siteRoot, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    try {
      const info = await stat(file).catch(() => null);
      if (info && info.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
    }
  });
  // The built pages carry absolute http://localhost:4000 asset URLs from
  // _config.dev.yml, so the stylesheet only loads on that exact host and
  // port.  Bind the same name the markup names, rather than 127.0.0.1: on a
  // machine where localhost resolves to ::1 first, a 127.0.0.1 binding leaves
  // ::1:4000 free for any other process to answer the stylesheet request, and
  // the run then asserts layout against a stranger's CSS with nothing failing.
  // Binding the name instead turns that collision into a loud EADDRINUSE.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, 'localhost', resolve);
  });
  return { port: server.address().port, close: () => new Promise(r => server.close(r)) };
}
