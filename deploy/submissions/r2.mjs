/**
 * A small client for Cloudflare R2's S3 API: AWS Signature Version 4 with
 * Node builtins, and only the calls the submissions service needs.
 *
 * Browsers never hold a key. The service signs short-lived URLs for each part
 * of each upload, and the browser sends the bytes straight to R2. That is the
 * point: an upload never passes through stitchexhibition.com, whose Cloudflare
 * plan refuses request bodies over 100 MB, nor through the home connection.
 *
 * Every URL is path-style: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>.
 */

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';
/**
 * Calls to R2 in flight at once from this process. A burst of 300 people
 * starting together is 900 multipart uploads to open; queued here, they go
 * out at a steady rate instead of as one storm of TLS handshakes.
 */
const MAX_CONCURRENT = 24;
/** Tries per call. A dropped connection, a 5xx or a 429 is tried again after a growing wait. */
const ATTEMPTS = 5;
let active = 0;
const waiters = [];
const acquire = () => (active < MAX_CONCURRENT ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => (waiters.length ? waiters.shift()() : active--);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC 3986 encoding, as SigV4 wants it. `/` survives in paths, never in query values. */
function enc(s, keepSlash = false) {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

function stamp(now) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

export class R2 {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('R2 is not configured');
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.host = new URL(this.endpoint).host;
    this.bucket = bucket;
    this.id = accessKeyId;
    this.secret = secretAccessKey;
  }

  path(key = '') {
    return `/${this.bucket}${key ? `/${enc(key, true)}` : ''}`;
  }

  signingKey(date) {
    const k1 = hmac(`AWS4${this.secret}`, date);
    return hmac(hmac(hmac(k1, REGION), SERVICE), 'aws4_request');
  }

  canonicalQuery(query) {
    return Object.keys(query)
      .sort()
      .map((k) => `${enc(k)}=${enc(String(query[k]))}`)
      .join('&');
  }

  signature(date, amzDate, canonical) {
    const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    return createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
  }

  /**
   * A URL the browser can use without any key: one method, one key, one part,
   * and, when given, one exact Content-Length, valid for `expires` seconds.
   */
  presign(method, key, { query = {}, expires = 3600, contentLength, now = new Date() } = {}) {
    const { amzDate, date } = stamp(now);
    const headers = { host: this.host };
    if (contentLength !== undefined) headers['content-length'] = String(contentLength);
    const signed = Object.keys(headers).sort();
    const q = {
      ...query,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.id}/${date}/${REGION}/${SERVICE}/aws4_request`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': signed.join(';'),
    };
    const canonical = [
      method,
      this.path(key),
      this.canonicalQuery(q),
      signed.map((h) => `${h}:${headers[h]}\n`).join(''),
      signed.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    return `${this.endpoint}${this.path(key)}?${this.canonicalQuery(q)}&X-Amz-Signature=${this.signature(date, amzDate, canonical)}`;
  }

  /**
   * A signed request from the service itself, retried on a dropped connection,
   * a 5xx or a 429. Every body sent here is a string, so it can be sent again.
   * A streamed GET is not retried here: its caller retries the whole transfer.
   */
  async request(method, key, opts = {}) {
    for (let attempt = 1; ; attempt++) {
      await acquire();
      let res;
      try {
        res = await this.once(method, key, opts);
      } catch (e) {
        if (attempt >= ATTEMPTS) throw e;
        await pause(500 * 2 ** attempt * (0.5 + Math.random()));
        continue;
      } finally {
        release();
      }
      if ((res.status >= 500 || res.status === 429) && attempt < ATTEMPTS) {
        await res.body?.cancel().catch(() => {});
        await pause(500 * 2 ** attempt * (0.5 + Math.random()));
        continue;
      }
      return res;
    }
  }

  async once(method, key, { query = {}, headers = {}, body, timeout = 30_000, signal } = {}) {
    const { amzDate, date } = stamp(new Date());
    const payloadHash = body === undefined ? sha256('') : sha256(body);
    const all = {
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const signed = Object.keys(all).sort();
    const canonical = [
      method,
      this.path(key),
      this.canonicalQuery(query),
      signed.map((h) => `${h}:${all[h].trim()}\n`).join(''),
      signed.join(';'),
      payloadHash,
    ].join('\n');
    const auth = `AWS4-HMAC-SHA256 Credential=${this.id}/${date}/${REGION}/${SERVICE}/aws4_request, SignedHeaders=${signed.join(';')}, Signature=${this.signature(date, amzDate, canonical)}`;
    const { host, ...send } = all;
    const qs = this.canonicalQuery(query);
    return fetch(`${this.endpoint}${this.path(key)}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { ...send, authorization: auth },
      body,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
    });
  }

  async ok(res, what) {
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw Object.assign(new Error(`R2 ${what}: ${res.status} ${code}`), { status: res.status, code });
  }

  async createMultipart(key, contentType) {
    const res = await this.ok(
      await this.request('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } }),
      'create multipart',
    );
    const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())?.[1];
    if (!id) throw new Error('R2 create multipart: no UploadId');
    return id;
  }

  /** Browser URLs for every part, each signed for that part's exact length. */
  partUrls(key, uploadId, size, partSize, expires) {
    const urls = [];
    const count = Math.max(1, Math.ceil(size / partSize));
    for (let n = 1; n <= count; n++) {
      const length = n < count ? partSize : size - partSize * (count - 1);
      urls.push(this.presign('PUT', key, { query: { partNumber: n, uploadId }, expires, contentLength: length }));
    }
    return urls;
  }

  async completeMultipart(key, uploadId, etags) {
    const xml = `<CompleteMultipartUpload>${etags
      .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${String(e).replace(/[<>&]/g, '')}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    let res;
    try {
      res = await this.ok(
        await this.request('POST', key, { query: { uploadId }, body: xml, headers: { 'content-type': 'application/xml' } }),
        'complete multipart',
      );
    } catch (e) {
      // A retry after a completion whose answer was lost finds the upload gone
      // and the object there. The caller checks its size and type regardless.
      if (e.code === 'NoSuchUpload' && (await this.head(key)) !== null) return;
      throw e;
    }
    const text = await res.text();
    // S3 can answer 200 with an error document; treat that as the error it is.
    if (/<Error>/.test(text)) throw new Error(`R2 complete multipart: ${/<Code>([^<]+)/.exec(text)?.[1] ?? 'error'}`);
  }

  async abortMultipart(key, uploadId) {
    const res = await this.request('DELETE', key, { query: { uploadId } });
    if (!res.ok && res.status !== 404) await this.ok(res, 'abort multipart');
  }

  /** Size of an object, or null when it does not exist. */
  async head(key) {
    const res = await this.request('HEAD', key);
    if (res.status === 404) return null;
    await this.ok(res, 'head');
    return Number(res.headers.get('content-length'));
  }

  /** The first `n` bytes of an object, for checking what it really is. */
  async firstBytes(key, n) {
    const res = await this.ok(await this.request('GET', key, { headers: { range: `bytes=0-${n - 1}` } }), 'range get');
    return Buffer.from(await res.arrayBuffer());
  }

  /** The whole object as a web stream, for the transfer to disk. `signal` aborts it. */
  async stream(key, { timeout = 3 * 60 * 60 * 1000, signal } = {}) {
    const res = await this.ok(await this.request('GET', key, { timeout, signal }), 'get');
    return res.body;
  }

  async delete(key) {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) await this.ok(res, 'delete');
  }

  /** Every key under a prefix, following continuation tokens. */
  async list(prefix = '') {
    const keys = [];
    let token;
    do {
      const query = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const text = await (await this.ok(await this.request('GET', '', { query }), 'list')).text();
      for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
      token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? /<NextContinuationToken>([^<]+)</.exec(text)?.[1] : undefined;
    } while (token);
    return keys;
  }
}
