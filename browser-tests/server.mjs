// Static server for the built _site, with one hook: the election-simulator
// publication pointer can be overridden per run so a test can exercise a
// specific published generation without touching the repository's
// current.json.
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

export async function serve(siteRoot, { port = 4000, pointer = null } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (pointer && path === POINTER_PATH) {
      const body = JSON.stringify(pointer, null, 2);
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(body);
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
  // _config.dev.yml, so the stylesheet only loads on that exact port.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { port: server.address().port, close: () => new Promise(r => server.close(r)) };
}
