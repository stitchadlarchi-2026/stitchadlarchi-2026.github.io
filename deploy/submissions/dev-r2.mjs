/**
 * A stand-in for R2 on your own computer, for `dev.mjs` only. It answers the
 * handful of S3 calls the service and the form make (multipart upload, head,
 * range and whole GETs, delete, list) and keeps the objects in
 * `.dev-submissions/r2/`. It checks no signatures: it is not a server to run
 * anywhere but localhost, and nothing here reaches the live site (the
 * Dockerfile copies only the service's own files).
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function startDevR2(dir, port) {
  await mkdir(join(dir, 'objects'), { recursive: true });
  await mkdir(join(dir, 'parts'), { recursive: true });
  const file = (key) => join(dir, 'objects', Buffer.from(key).toString('base64url'));
  const uploads = new Map();

  const body = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'PUT, GET, HEAD',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'ETag',
  };
  const xml = (res, status, text) => res.writeHead(status, { 'content-type': 'application/xml', ...cors }).end(`<?xml version="1.0" encoding="UTF-8"?>${text}`);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://r2');
      const [, , ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      const q = url.searchParams;
      if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();

      if (req.method === 'POST' && q.has('uploads')) {
        const id = randomBytes(8).toString('hex');
        uploads.set(id, { key, parts: [] });
        return xml(res, 200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        const data = await body(req);
        const part = join(dir, 'parts', `${q.get('uploadId')}.${q.get('partNumber')}`);
        await writeFile(part, data);
        up.parts[Number(q.get('partNumber')) - 1] = part;
        return res.writeHead(200, { etag: `"${createHash('md5').update(data).digest('hex')}"`, ...cors }).end();
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        await body(req);
        const up = uploads.get(q.get('uploadId'));
        if (!up) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        const whole = Buffer.concat(await Promise.all(up.parts.map((p) => readFile(p))));
        await writeFile(file(up.key), whole);
        await Promise.all(up.parts.map((p) => rm(p, { force: true })));
        uploads.delete(q.get('uploadId'));
        return xml(res, 200, '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      }
      if (req.method === 'DELETE') {
        if (q.has('uploadId')) uploads.delete(q.get('uploadId'));
        else await rm(file(key), { force: true });
        return res.writeHead(204, cors).end();
      }
      if (req.method === 'GET' && q.get('list-type') === '2') {
        const keys = (await readdir(join(dir, 'objects'))).map((n) => Buffer.from(n, 'base64url').toString());
        const prefix = q.get('prefix') ?? '';
        return xml(res, 200, `<ListBucketResult>${keys.filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        let size;
        try {
          size = (await stat(file(key))).size;
        } catch {
          return res.writeHead(404, cors).end();
        }
        const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? '');
        const startAt = range ? Number(range[1]) : 0;
        const end = range ? Math.min(size - 1, Number(range[2] ?? size - 1)) : size - 1;
        const headers = { 'content-length': end - startAt + 1, ...cors };
        if (q.get('response-content-disposition')) headers['content-disposition'] = q.get('response-content-disposition');
        if (key.endsWith('.pdf')) headers['content-type'] = 'application/pdf';
        res.writeHead(range ? 206 : 200, req.method === 'HEAD' ? { ...headers, 'content-length': size } : headers);
        if (req.method === 'HEAD') return res.end();
        return createReadStream(file(key), { start: startAt, end }).pipe(res);
      }
      return xml(res, 400, '<Error><Code>NotImplemented</Code></Error>');
    } catch (e) {
      console.error('dev R2:', e.message);
      if (!res.headersSent) res.writeHead(500, cors).end();
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
