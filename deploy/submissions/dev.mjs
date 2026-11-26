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
 * Submissions work without anything else: with no R2 settings in your shell,
 * a stand-in for R2 (dev-r2.mjs) runs beside it and keeps the uploads in
 * `.dev-submissions/r2/`. To try a real test bucket instead, set R2_ENDPOINT,
 * R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY first (its CORS must
 * allow http://localhost:8000).
 *
 * The Student Directory is at http://localhost:8000/#directory, and the
 * committee's review page at http://localhost:8000/_s/review (password `dev`).
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
const R2_PORT = 18900;

const r2Env = {};
if (!process.env.R2_BUCKET) {
  const { startDevR2 } = await import('./dev-r2.mjs');
  await startDevR2(join(root, '.dev-submissions', 'r2'), R2_PORT);
  Object.assign(r2Env, { R2_ENDPOINT: `http://127.0.0.1:${R2_PORT}`, R2_BUCKET: 'dev', R2_ACCESS_KEY_ID: 'dev', R2_SECRET_ACCESS_KEY: 'dev' });
}

const child = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, ...r2Env, DATA_DIR: join(root, '.dev-submissions', 'data'), FILES_DIR: join(root, '.dev-submissions', 'files'), SUBMISSIONS_KEY: 'dev', TURNSTILE_SECRET: '', DISK_FLOOR_GB: process.env.DISK_FLOOR_GB ?? '1', FORM_PORT: '18081', ADMIN_PORT: '19091' },
});

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const routes = {
  '/_s/start': [18081, '/start'], '/_s/complete': [18081, '/complete'],
  '/_s/export': [19091, '/export'], '/_s/export/posters': [19091, '/export/posters'],
  '/_s/status': [19091, '/status'],
  '/_s/directory.json': [18081, '/directory.json'],
};
const prefixes = [['/_s/media/', 18081], ['/_s/review', 19091]];

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const pre = prefixes.find(([p]) => path.startsWith(p));
  const route = routes[path] ?? (pre && [pre[1], path.slice(3)]);
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
