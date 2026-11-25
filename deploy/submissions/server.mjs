/**
 * STITCH exhibition submissions.
 *
 * Each graduate fills in the form on the Links page: full name, an optional
 * LinkedIn and "where you're from", a short project overview, and the headshot
 * they picked from the portrait gallery. nginx hands the form to this process;
 * this process checks it and writes it to the `submissions-data` volume.
 *
 * The committee downloads everything as one zip: `submissions.xlsx` (one row
 * per person) and `photos/<Full Name>.<ext>`, each headshot already renamed
 * after the person who sent it. If someone submits twice, their latest
 * submission wins.
 *
 * Two servers, two ports, the same split as the usage counters:
 *   FORM_PORT   POST /submit           reached by nginx from the public site
 *   ADMIN_PORT  GET  /export, /status  reached by nginx too, but behind a
 *                                      password (SUBMISSIONS_KEY). With no key
 *                                      set, the admin side answers 404.
 *
 * Node builtins only: no package.json, no node_modules.
 */

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { strip } from './metadata.mjs';

const FORM_PORT = Number(process.env.FORM_PORT ?? 8081);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 9091);
const DATA = process.env.DATA_DIR ?? '/data';
const KEY = process.env.SUBMISSIONS_KEY ?? '';
/** Cloudflare Turnstile. With no secret set, the check is skipped (local try-outs only). */
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? '';
/**
 * The day every submission is deleted. After it, the form is closed and the
 * volume is emptied, by this process, hourly. The collection notice on the page
 * promises this date: change both together.
 */
const DELETE_AFTER = new Date(process.env.DELETE_AFTER ?? '2027-01-31T23:59:59+10:30');

/** Pixieset full-resolution downloads are a few MB; leave room for a phone photo. */
const MAX_PHOTO = 20 * 1024 * 1024;
const MAX_BODY = MAX_PHOTO + 64 * 1024;
/**
 * A ceiling on the volume, so a flood cannot fill the box's disk. Kept under
 * 4 GB because the export is a plain zip, whose offsets cannot pass 4 GB.
 */
const MAX_TOTAL = 3.5 * 1024 * 1024 * 1024;
/**
 * Submissions one address may make in a minute. A whole cohort on campus
 * Wi-Fi arrives from one university address, so this is per minute, not per
 * hour: it stops a script, not a class.
 */
const PER_MINUTE = 20;
/** Wrong passwords one address may try in a minute on the committee's download. */
const AUTH_PER_MINUTE = 5;
/**
 * Uploads parsed at once. Each holds the whole body in memory four or five
 * times over while it is read, so this, not the container limit, is what keeps
 * a rush of 20 MB photos from running the process out of memory. The rest wait.
 */
const MAX_PARSING = 1;
const MAX_WAITING = 40;

const LIMITS = { name: 120, from: 120, linkedin: 300, overview: 1500 };
/** The project overview is a wall label, not an essay. */
const MAX_WORDS = 150;
/** Recorded with each submission. Keep in step with the notice in index.html. */
const CONSENT = 'exhibition labels and catalogue, stitchexhibition.com, STITCH social media; deleted after 31 January 2027';

const salt = randomBytes(32);
const budget = new Map();
const authFails = new Map();
let budgetSince = Date.now();
let totalBytes = 0;
let parsing = 0;
const waiting = [];

// ---------------------------------------------------------------- helpers

const clean = (v, max) =>
  String(v ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);

const oneLine = (v, max) => clean(v, max).replace(/\s+/g, ' ');

/** A name that is safe as a file name on Mac, Windows and in a zip. */
function fileSafe(name) {
  const s = name
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return s || 'Unnamed';
}

const nameKey = (name) => name.toLocaleLowerCase('en-AU').replace(/\s+/g, ' ').trim();

function linkedinUrl(v) {
  const s = oneLine(v, LIMITS.linkedin);
  if (!s) return '';
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}

/** What the bytes really are, whatever the browser said. */
function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // HEIC is refused: its metadata cannot be stripped with builtins, and Windows
  // opens it badly. An iPhone converts to JPEG by itself when the form does not
  // list HEIC as accepted, so in practice nobody has to do anything.
  return null;
}

let CRC_TABLE;
function crc32(buf, crc = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function address(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  return req.socket.remoteAddress ?? '';
}

const fingerprint = (req) => createHmac('sha256', salt).update(address(req)).digest('base64url').slice(0, 16);

/** Both per-address budgets reset together, every minute. */
function minuteTick() {
  const now = Date.now();
  if (now - budgetSince > 60 * 1000) {
    budget.clear();
    authFails.clear();
    budgetSince = now;
  }
}

function allowed(req) {
  minuteTick();
  const id = fingerprint(req);
  const spent = budget.get(id) ?? 0;
  if (spent >= PER_MINUTE) return false;
  if (budget.size < 50_000) budget.set(id, spent + 1);
  return true;
}

/** A place to parse one upload, or null when too many are already queued. */
function slot() {
  if (parsing < MAX_PARSING) {
    parsing += 1;
    return Promise.resolve(release);
  }
  if (waiting.length >= MAX_WAITING) return null;
  return new Promise((resolve) => waiting.push(() => resolve(release)));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else parsing -= 1;
}

const closed = () => Date.now() > DELETE_AFTER.getTime();

/** Ask Cloudflare whether the browser passed Turnstile. Fails closed. */
async function human(token, req) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: address(req) }),
      signal: AbortSignal.timeout(8000),
    });
    return (await r.json()).success === true;
  } catch (e) {
    console.error('turnstile check failed', e.message);
    return false;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) return reject(Object.assign(new Error('too large'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        reject(Object.assign(new Error('too large'), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- storage

async function records() {
  const out = [];
  for (const f of await readdir(DATA)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(join(DATA, f), 'utf8')));
    } catch {
      /* a half-written file from a crash: skip it */
    }
  }
  out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return out;
}

/** One row per person: the latest submission under each name. */
async function latestPerPerson() {
  const byName = new Map();
  let all = 0;
  for (const r of await records()) {
    all += 1;
    byName.set(nameKey(r.name), r);
  }
  return { people: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-AU')), all };
}

async function measure() {
  let n = 0;
  for (const f of await readdir(DATA)) n += (await stat(join(DATA, f))).size;
  totalBytes = n;
}

// ---------------------------------------------------------------- submit

async function submit(req, res) {
  if (closed()) return json(res, 410, { error: 'Submissions have closed.' });
  if (!allowed(req)) return json(res, 429, { error: 'Too many submissions from here. Please wait a minute and try again.' });
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('multipart/form-data')) return json(res, 415, { error: 'Expected a form.' });

  const wait = slot();
  if (!wait) return json(res, 503, { error: 'Lots of people are sending right now. Please try again in a minute.' });
  const done = await wait;
  try {
    await accept(req, res, type);
  } finally {
    done();
  }
}

async function accept(req, res, type) {
  let form;
  try {
    const body = await readBody(req, MAX_BODY);
    form = await new Request('http://form/', { method: 'POST', headers: { 'content-type': type }, body }).formData();
  } catch (e) {
    if (e.status === 413) return json(res, 413, { error: 'That photo is too big. The limit is 20 MB.' });
    return json(res, 400, { error: 'The form could not be read. Please try again.' });
  }

  // Bots fill every field; people never see this one.
  if (oneLine(form.get('website'), 200)) return json(res, 200, { ok: true });
  if (!(await human(oneLine(form.get('cf-turnstile-response'), 4096), req))) {
    return json(res, 403, { error: 'We could not confirm you are not a robot. Please reload the page and try again.' });
  }

  const name = oneLine(form.get('name'), LIMITS.name);
  const from = oneLine(form.get('from'), LIMITS.from);
  const overview = clean(form.get('overview'), LIMITS.overview);
  const linkedin = linkedinUrl(form.get('linkedin'));
  const photo = form.get('photo');

  const problems = {};
  if (name.split(' ').filter(Boolean).length < 2) problems.name = 'Please give your full name, first and last.';
  if (linkedin === null) problems.linkedin = 'That does not look like a LinkedIn link.';
  if (overview.length < 20) problems.overview = 'Please write a short overview of your project.';
  else if (overview.split(/\s+/).filter(Boolean).length > MAX_WORDS) problems.overview = `Please keep it to ${MAX_WORDS} words or fewer.`;
  if (!photo || typeof photo === 'string' || photo.size === 0) problems.photo = 'Please attach your headshot.';
  else if (photo.size > MAX_PHOTO) problems.photo = 'That photo is too big. The limit is 20 MB.';
  if (form.get('consent') !== 'yes') problems.consent = 'Please tick the box to agree to how your details are used.';
  if (Object.keys(problems).length) return json(res, 422, { error: 'Some fields need another look.', fields: problems });

  const raw = Buffer.from(await photo.arrayBuffer());
  const ext = imageType(raw);
  const badPhoto = { error: 'Some fields need another look.', fields: { photo: 'Please upload a JPG, PNG or WebP photo.' } };
  if (!ext) return json(res, 422, badPhoto);
  // Location and device data are removed before anything is written. A photo
  // that cannot be parsed is refused rather than kept with its metadata.
  let bytes;
  try {
    bytes = strip(raw, ext);
  } catch {
    return json(res, 422, badPhoto);
  }
  if (totalBytes + bytes.length > MAX_TOTAL) return json(res, 507, { error: 'Submissions are full. Please contact the committee.' });

  const submittedAt = new Date().toISOString();
  const id = `${submittedAt.replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const record = {
    id,
    submittedAt,
    name,
    linkedin: linkedin ?? '',
    from,
    overview,
    /** What the person agreed to, in the words of the notice they ticked. */
    consent: CONSENT,
    // The browser's file name is not kept: it can be anything, and nobody needs it.
    photo: { file: `${id}.${ext}`, ext, size: bytes.length, crc: crc32(bytes) },
  };

  // Photo first, record last, each written beside its name and then renamed into
  // place: a record on disk always has its photo.
  await writeFile(join(DATA, `.${id}.${ext}`), bytes);
  await rename(join(DATA, `.${id}.${ext}`), join(DATA, `${id}.${ext}`));
  await writeFile(join(DATA, `.${id}.json`), JSON.stringify(record, null, 2));
  await rename(join(DATA, `.${id}.json`), join(DATA, `${id}.json`));
  totalBytes += bytes.length;

  console.log(`submission ${id} (${bytes.length} bytes)`);
  return json(res, 200, { ok: true, photoName: `${fileSafe(name)}.${ext}` });
}

// ---------------------------------------------------------------- export

const xml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = (i) => String.fromCharCode(65 + i);

function adelaideTime(iso) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Adelaide',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** A one-sheet workbook. Strings are inline, so no shared-strings part is needed. */
function workbook(rows) {
  const head = ['Full name', 'LinkedIn', 'Where from', 'Project overview', 'Photo file', 'Submitted'];
  const widths = [28, 40, 24, 80, 32, 20];
  const all = [head, ...rows];
  const sheetRows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : ci === 3 ? ' s="2"' : '';
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const NS = 'http://schemas.openxmlformats.org';
  return [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Submissions" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
}

/**
 * A zip written straight to the response. Small parts are deflated in memory;
 * photos are streamed from disk as stored entries, using the size and CRC kept
 * at submit time, so memory stays flat however many people have submitted.
 */
class ZipStream {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.central = [];
  }
  write(buf) {
    this.offset += buf.length;
    return this.out.write(buf) ? Promise.resolve() : new Promise((r) => this.out.once('drain', r));
  }
  header(nameBuf, method, crc, csize, usize) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(0, 10);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    this.central.push({ nameBuf, method, crc, csize, usize, offset: this.offset });
    return Buffer.concat([h, nameBuf]);
  }
  async addBuffer(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    await this.write(this.header(nameBuf, 8, crc32(data), deflated.length, data.length));
    await this.write(deflated);
  }
  async addFile(name, path, size, crc) {
    const nameBuf = Buffer.from(name, 'utf8');
    await this.write(this.header(nameBuf, 0, crc, size, size));
    for await (const chunk of createReadStream(path)) await this.write(chunk);
  }
  async finish() {
    const start = this.offset;
    for (const e of this.central) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt32LE(0, 12);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.nameBuf]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}

async function exportZip(res) {
  const { people } = await latestPerPerson();
  const used = new Set();
  const rows = [];
  const photos = [];
  for (const p of people) {
    let base = fileSafe(p.name);
    for (let n = 2; used.has(`${base}.${p.photo.ext}`.toLowerCase()); n++) base = `${fileSafe(p.name)} ${n}`;
    const file = `${base}.${p.photo.ext}`;
    used.add(file.toLowerCase());
    photos.push({ file, p });
    rows.push([p.name, p.linkedin, p.from, p.overview, file, adelaideTime(p.submittedAt)]);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="stitch-submissions-${stamp}.zip"`,
    'cache-control': 'no-store',
  });
  const zip = new ZipStream(res);
  // The workbook is itself a zip, kept whole inside the outer one.
  const inner = await new Promise((resolve) => {
    const parts = [];
    const sink = { write: (b) => (parts.push(b), true), once() {}, end: () => resolve(Buffer.concat(parts)) };
    const z = new ZipStream(sink);
    (async () => {
      for (const [name, text] of workbook(rows)) await z.addBuffer(name, Buffer.from(text, 'utf8'));
      await z.finish();
    })();
  });
  await zip.addBuffer('submissions.xlsx', inner);
  for (const { file, p } of photos) {
    await zip.addFile(`photos/${file}`, join(DATA, p.photo.file), p.photo.size, p.photo.crc);
  }
  await zip.finish();
}

function authorised(req) {
  if (!KEY) return false;
  const h = String(req.headers.authorization ?? '');
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const want = Buffer.from(KEY);
  return given.length === want.length && timingSafeEqual(given, want);
}

// ---------------------------------------------------------------- servers

const formServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'POST' && path === '/submit') {
    submit(req, res).catch((e) => {
      console.error('submit failed', e);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
    });
    return;
  }
  res.writeHead(404).end();
});

const adminServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
  if (!KEY || req.method !== 'GET' || !['/export', '/status'].includes(path)) {
    res.writeHead(404).end();
    return;
  }
  minuteTick();
  const who = fingerprint(req);
  if ((authFails.get(who) ?? 0) >= AUTH_PER_MINUTE) {
    res.writeHead(429, { 'retry-after': '60', 'cache-control': 'no-store' }).end();
    return;
  }
  if (!authorised(req)) {
    // A browser's first request carries no password at all; only a wrong one counts.
    if (req.headers.authorization && authFails.size < 50_000) authFails.set(who, (authFails.get(who) ?? 0) + 1);
    if (req.headers.authorization) console.log(`export: wrong password from ${who}`);
    res.writeHead(401, { 'www-authenticate': 'Basic realm="STITCH submissions", charset="UTF-8"', 'cache-control': 'no-store' }).end();
    return;
  }
  console.log(`${path}: opened by ${who}`);
  const run =
    path === '/export'
      ? exportZip(res)
      : latestPerPerson().then(({ people, all }) =>
          json(res, 200, { people: people.length, submissions: all, latest: people.at(-1)?.submittedAt ?? null, names: people.map((p) => p.name) }),
        );
  run.catch((e) => {
    console.error(`${path} failed`, e);
    if (!res.headersSent) json(res, 500, { error: 'failed' });
    else res.destroy();
  });
});

/**
 * The retention promise, kept by the process that holds the data: once the
 * date in the collection notice has passed, every file on the volume goes.
 * Checked at start and hourly, so a box that was off on the day still does it.
 * Backups already taken are not touched here; see SECURITY.md.
 */
async function purgeIfDue() {
  if (!closed()) return;
  let n = 0;
  for (const f of await readdir(DATA)) {
    await rm(join(DATA, f), { force: true, recursive: true });
    n += 1;
  }
  totalBytes = 0;
  if (n) console.log(`retention: deleted ${n} files (past ${DELETE_AFTER.toISOString()})`);
}

await mkdir(DATA, { recursive: true });
await purgeIfDue();
await measure();
setInterval(() => purgeIfDue().catch((e) => console.error('retention failed', e)), 60 * 60 * 1000).unref();
formServer.requestTimeout = 5 * 60 * 1000;
formServer.listen(FORM_PORT, '0.0.0.0', () => console.log(`form on :${FORM_PORT}/submit`));
adminServer.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`admin on :${ADMIN_PORT}${KEY ? '' : ' (no SUBMISSIONS_KEY: export off)'}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    formServer.close();
    adminServer.close();
    process.exit(0);
  });
}
