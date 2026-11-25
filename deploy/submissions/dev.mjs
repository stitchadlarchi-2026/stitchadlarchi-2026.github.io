/**
 * Try the whole site, form included, on your own computer:
 *
 *   node deploy/submissions/dev.mjs
 *
 * then open http://localhost:8000/#links. It serves the page the way nginx
 * does and runs the submissions service beside it, saving into
 * `.dev-submissions/` in this folder (gitignored). The download is at
 * http://localhost:8000/_s/export with the password `dev`.
 *
 * The page and form show without anything else. Sending a submission needs an
 * R2 bucket: set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and
 * R2_SECRET_ACCESS_KEY in your shell first (a test bucket whose CORS allows
 * http://localhost:8000). Without them, Submit says uploads are not set up.
 *
 * Nothing here is part of the live site: the Dockerfile strips `deploy/` out
 * of the image, and the server never runs this file.
 */

import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const PORT = Number(process.env.PORT ?? 8000);

const child = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR: join(root, '.dev-submissions', 'data'), FILES_DIR: join(root, '.dev-submissions', 'files'), SUBMISSIONS_KEY: 'dev', TURNSTILE_SECRET: '', FORM_PORT: '18081', ADMIN_PORT: '19091' },
});

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const routes = {
  '/_s/start': [18081, '/start'], '/_s/complete': [18081, '/complete'],
  '/_s/export': [19091, '/export'], '/_s/export/posters': [19091, '/export/posters'],
  '/_s/export/booklets': [19091, '/export/booklets'], '/_s/status': [19091, '/status'],
};

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const route = routes[path];
  if (route) {
    const up = request({ host: '127.0.0.1', port: route[0], path: route[1], method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"Submissions are offline right now."}'));
    req.pipe(up);
    return;
  }
  let file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root) || /[\\/](deploy|\.git|\.dev-submissions)([\\/]|$)/.test(file.slice(root.length))) {
    res.writeHead(404).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (extname(file).toLowerCase() === '.html') {
    // The live Turnstile key only works on stitchexhibition.com. Locally, use
    // Cloudflare's test key, which always passes; the server skips its own
    // check here because dev runs it with no TURNSTILE_SECRET.
    const html = await readFile(file, 'utf8');
    res.end(html.replace(/data-sitekey="[^"]*"/g, 'data-sitekey="1x00000000000000000000AA"'));
    return;
  }
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`STITCH site with the form: http://localhost:${PORT}/#links`));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(); process.exit(0); });
