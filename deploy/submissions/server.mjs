/**
 * STITCH exhibition submissions.
 *
 * Each graduate sends their details and three files: a headshot, their
 * project poster, and their project booklet. Master's booklets run to
 * hundreds of megabytes, and stitchexhibition.com sits behind a Cloudflare
 * plan that refuses any request body over 100 MB and behind a home
 * connection, so the files never come through here at all:
 *
 *   1. POST /start     The browser sends the details, a Turnstile token and
 *                      the size and type of each file. This process checks
 *                      them, opens a multipart upload in R2 for each file and
 *                      answers with presigned part URLs.
 *   2. (browser → R2)  The browser uploads the parts straight to R2, several
 *                      at once, retrying any that fail.
 *   3. POST /complete  The browser hands back the parts' ETags. This process
 *                      completes each upload and checks the object's real size
 *                      and first bytes. The submission is then `uploaded`.
 *   4. (R2 → disk)     The transfer worker below copies uploaded files down to
 *                      this box, a couple at a time, whatever the rush upstairs.
 *                      A spike of 300 people becomes a queue in R2, not a queue
 *                      on the home connection. The submission is then `stored`.
 *
 * Every state lives in a JSON record on the `submissions-data` volume, written
 * atomically, so a restart resumes the queue where it stopped. Headshots are
 * kept with the records (that volume is backed up nightly); posters and
 * booklets go to `submissions-files`, and their R2 copies are kept until the
 * deletion date as the off-box copy.
 *
 * Two servers, two ports:
 *   FORM_PORT   POST /start, /complete              nginx, from the public site
 *   ADMIN_PORT  GET  /export[/posters|/booklets],   nginx, behind SUBMISSIONS_KEY
 *                    /status;  GET /health           (healthcheck, local only)
 *
 * Node builtins only: no package.json, no node_modules.
 */

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { strip } from './metadata.mjs';
import { R2 } from './r2.mjs';
import { ZipStream, crc32, workbook } from './zip.mjs';

const FORM_PORT = Number(process.env.FORM_PORT ?? 8081);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 9091);
const DATA = process.env.DATA_DIR ?? '/data';
const FILES = process.env.FILES_DIR ?? '/files';
const KEY = process.env.SUBMISSIONS_KEY ?? '';
/** Cloudflare Turnstile. With no secret set, the check is skipped (local try-outs only). */
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? '';
/**
 * The day every submission is deleted, here and in R2. After it, the form is
 * closed. The collection notice on the page promises this date: change both,
 * and CONSENT below, together.
 */
const DELETE_AFTER = new Date(process.env.DELETE_AFTER ?? '2027-01-31T23:59:59+10:30');

const r2 = process.env.R2_BUCKET
  ? new R2({
      endpoint: process.env.R2_ENDPOINT,
      bucket: process.env.R2_BUCKET,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    })
  : null;

const MB = 1024 * 1024;
/**
 * What each upload may be. Types are checked twice: against what the browser
 * declares at /start, and against the object's real first bytes at /complete.
 * A poster image is capped lower than a poster PDF because its metadata is
 * stripped in memory.
 */
const KINDS = {
  photo: { label: 'headshot', dir: DATA, types: { jpg: 20 * MB, png: 20 * MB, webp: 20 * MB } },
  poster: { label: 'poster', dir: FILES, types: { pdf: 300 * MB, jpg: 60 * MB, png: 60 * MB } },
  booklet: { label: 'booklet', dir: FILES, types: { pdf: 1024 * MB } },
};
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const EXT_OF_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Every part but the last is this size; R2 wants at least 5 MiB. A 1 GB booklet is 64 parts. */
const PART_SIZE = 16 * MB;
/** How long a browser has to finish uploading once it has started. */
const UPLOAD_HOURS = 24;
/**
 * Requests one address may make to /start and /complete in a minute. A cohort
 * of 300 on campus Wi-Fi arrives from one university address, so this is
 * sized for a class, not a person; Turnstile is what stops a script.
 */
const PER_MINUTE = 120;
/** Wrong passwords one address may try in a minute on the committee's download. */
const AUTH_PER_MINUTE = 5;
/** Submissions waiting for their browser to finish, at most. Beyond it, /start asks people to wait. */
const MAX_OPEN = Number(process.env.MAX_OPEN ?? 600);
/** Space always left free on the box, after counting what is promised to open uploads. */
const DISK_FLOOR = Number(process.env.DISK_FLOOR_GB ?? 50) * 1024 * MB;
/** Files copied down from R2 at once. Each is streamed; only images are held in memory to strip. */
const TRANSFERS = Number(process.env.TRANSFERS ?? 2);
/**
 * A transfer that receives nothing for this long is abandoned and retried. A
 * home connection that drops can leave a socket open with nothing on it, and
 * without this the transfer would sit there until its three-hour timeout.
 */
const STALL_MS = Number(process.env.STALL_SECONDS ?? 60) * 1000;

const LIMITS = { name: 120, from: 120, linkedin: 300, title: 150, overview: 1500 };
/** The project overview is a wall label, not an essay. */
const MAX_WORDS = 150;
/** Recorded with each submission. Keep in step with the notice in index.html. */
const CONSENT = 'exhibition labels and catalogue, stitchexhibition.com, STITCH social media; deleted after 31 January 2027';

const salt = randomBytes(32);
const budget = new Map();
const authFails = new Map();
let budgetSince = Date.now();

/** Every record, by id. The JSON files on disk are the truth; this is their index. */
const records = new Map();
/** Starts between their capacity check and their record being saved. */
const reserving = { count: 0, bytes: 0 };
/** /complete attempts in progress, by record id. */
const completing = new Map();
const transfer = { running: 0, lastError: null, lastErrorAt: null, retryAt: 0, failures: 0 };

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

/** What the bytes really are, whatever the browser said. HEIC is refused: see metadata.mjs. */
function fileType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // A PDF may carry a little junk before its header; readers accept up to 1 KB.
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  return null;
}

function address(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  return req.socket.remoteAddress ?? '';
}

const fingerprint = (req) => createHmac('sha256', salt).update(address(req)).digest('base64url').slice(0, 16);
const hashToken = (t) => createHash('sha256').update(t).digest();

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

const closed = () => Date.now() > DELETE_AFTER.getTime();

/**
 * Ask Cloudflare whether the browser passed Turnstile. A connection that drops
 * before Cloudflare answers is tried again; a "no" is final. Fails closed.
 */
async function human(token, req) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: address(req) }),
        signal: AbortSignal.timeout(10_000),
      });
      return (await r.json()).success === true;
    } catch (e) {
      console.error(`turnstile check failed (try ${attempt})`, e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return false;
}

function json(res, status, body) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (status === 429) headers['retry-after'] = '20';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        reject(Object.assign(new Error('too large'), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- records

/**
 * Write a record beside its name, then rename it into place. Saves of one
 * record run one at a time, in order (two transfers of the same submission
 * finish together), and each writes the record as it is when its turn comes.
 */
const saving = new Map();
function save(r) {
  records.set(r.id, r);
  const turn = (saving.get(r.id) ?? Promise.resolve()).then(async () => {
    const { tokenHash, ...rest } = r;
    const body = JSON.stringify({ ...rest, tokenHash: tokenHash ? Buffer.from(tokenHash).toString('hex') : undefined }, null, 2);
    const tmp = join(DATA, `.${r.id}.${randomBytes(4).toString('hex')}.json`);
    await writeFile(tmp, body);
    await rename(tmp, join(DATA, `${r.id}.json`));
  });
  const settled = turn.catch(() => {});
  saving.set(r.id, settled);
  settled.then(() => saving.get(r.id) === settled && saving.delete(r.id));
  return turn;
}

async function load() {
  for (const f of await readdir(DATA)) {
    if (f.startsWith('.')) {
      await rm(join(DATA, f), { force: true }); // a write cut short by a crash
      continue;
    }
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await readFile(join(DATA, f), 'utf8'));
      if (r.tokenHash) r.tokenHash = Buffer.from(r.tokenHash, 'hex');
      records.set(r.id, r);
    } catch {
      console.error(`unreadable record ${f}`);
    }
  }
  for (const f of await readdir(FILES)) if (f.startsWith('.')) await rm(join(FILES, f), { force: true });
}

const all = () => [...records.values()].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

/** One entry per person: the latest stored submission under each name. */
function latestStored() {
  const byName = new Map();
  for (const r of all()) if (r.state === 'stored') byName.set(nameKey(r.name), r);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-AU'));
}

/** Bytes promised to uploads that are open or waiting to come down. */
function promised() {
  let n = 0;
  for (const r of records.values()) {
    if (r.state !== 'uploading' && r.state !== 'uploaded') continue;
    for (const f of Object.values(r.files)) if (!f.stored) n += f.size;
  }
  return n;
}

async function diskFree() {
  const s = await statfs(FILES);
  return s.bavail * s.bsize;
}

// ---------------------------------------------------------------- start

async function start(req, res) {
  if (closed()) return json(res, 410, { error: 'Submissions have closed.' });
  if (!r2) return json(res, 503, { error: 'Uploads are not set up on this server.' });
  if (!allowed(req)) return json(res, 429, { error: 'Lots of people are sending from your network. Please wait a minute and try again.' });
  const body = await readJson(req);

  // Bots fill every field; people never see this one.
  if (oneLine(body.website, 200)) return json(res, 200, { ok: true, decoy: true });
  if (!(await human(oneLine(body.turnstile, 4096), req))) {
    return json(res, 403, { error: 'We could not confirm you are not a robot. Please reload the page and try again.' });
  }

  const name = oneLine(body.name, LIMITS.name);
  const from = oneLine(body.from, LIMITS.from);
  const title = oneLine(body.title, LIMITS.title);
  const overview = clean(body.overview, LIMITS.overview);
  const linkedin = linkedinUrl(body.linkedin);
  const problems = {};
  if (name.split(' ').filter(Boolean).length < 2) problems.name = 'Please give your full name, first and last.';
  if (linkedin === null) problems.linkedin = 'That does not look like a LinkedIn link.';
  if (!title) problems.title = 'Please give your project a title.';
  if (overview.length < 20) problems.overview = 'Please write a short overview of your project.';
  else if (overview.split(/\s+/).filter(Boolean).length > MAX_WORDS) problems.overview = `Please keep it to ${MAX_WORDS} words or fewer.`;
  if (body.consent !== true) problems.consent = 'Please tick the box to agree to how your details are used.';

  const files = {};
  for (const [kind, spec] of Object.entries(KINDS)) {
    const f = body.files?.[kind];
    const size = Number(f?.size);
    const ext = EXT_OF_MIME[String(f?.type ?? '').toLowerCase()] ?? extFromName(f?.name);
    if (!f || !Number.isSafeInteger(size) || size <= 0) {
      problems[kind] = `Please attach your ${spec.label}.`;
    } else if (!ext || !spec.types[ext]) {
      problems[kind] = `Your ${spec.label} must be ${typeList(spec)}.`;
    } else if (size > spec.types[ext]) {
      problems[kind] = `That ${spec.label} is too big. The limit is ${spec.types[ext] / MB} MB for ${ext.toUpperCase()}.`;
    } else files[kind] = { size, ext };
  }
  if (Object.keys(problems).length) return json(res, 422, { error: 'Some fields need another look.', fields: problems });

  const open = [...records.values()].filter((r) => r.state === 'uploading').length + reserving.count;
  const wanted = Object.values(files).reduce((n, f) => n + f.size, 0);
  if (open >= MAX_OPEN || (await diskFree()) - promised() - reserving.bytes - wanted < DISK_FLOOR) {
    console.error(`start refused: open=${open} promised=${promised() + reserving.bytes} wanted=${wanted}`);
    return json(res, 503, { error: 'Lots of people are sending right now. Please try again in a few minutes.' });
  }
  reserving.count += 1;
  reserving.bytes += wanted;
  try {
    return await openUploads(res, { name, linkedin, from, title, overview, files });
  } finally {
    reserving.count -= 1;
    reserving.bytes -= wanted;
  }
}

async function openUploads(res, { name, linkedin, from, title, overview, files }) {
  const submittedAt = new Date().toISOString();
  const id = `${submittedAt.replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(24).toString('base64url');
  const record = {
    id,
    submittedAt,
    state: 'uploading',
    name,
    linkedin: linkedin ?? '',
    from,
    title,
    overview,
    /** What the person agreed to, in the words of the notice they ticked. */
    consent: CONSENT,
    tokenHash: hashToken(token),
    files: {},
  };
  const answer = { ok: true, id, token, partSize: PART_SIZE, files: {} };
  const opened = await Promise.allSettled(
    Object.entries(files).map(async ([kind, f]) => {
      const key = `submissions/${id}/${kind}.${f.ext}`;
      const uploadId = await r2.createMultipart(key, MIME[f.ext]);
      record.files[kind] = { key, uploadId, size: f.size, ext: f.ext, stored: false };
      answer.files[kind] = { urls: r2.partUrls(key, uploadId, f.size, PART_SIZE, UPLOAD_HOURS * 3600) };
    }),
  );
  const failed = opened.find((o) => o.status === 'rejected');
  if (failed) {
    console.error(`start ${id}: R2 failed`, failed.reason?.message);
    for (const f of Object.values(record.files)) r2.abortMultipart(f.key, f.uploadId).catch(() => {});
    return json(res, 503, { error: 'Uploads are busy right now. Please try again in a minute.' });
  }
  await save(record);
  console.log(`start ${id} (${Object.entries(files).map(([k, f]) => `${k} ${f.size}`).join(', ')})`);
  return json(res, 200, answer);
}

const extFromName = (n) => ({ jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', pdf: 'pdf' })[String(n ?? '').split('.').pop().toLowerCase()];
const typeList = (spec) => {
  const t = Object.keys(spec.types).map((e) => e.toUpperCase());
  return t.length === 1 ? `a ${t[0]}` : `a ${t.slice(0, -1).join(', ')} or ${t.at(-1)}`;
};

// ---------------------------------------------------------------- complete

async function complete(req, res) {
  if (!r2) return json(res, 503, { error: 'Uploads are not set up on this server.' });
  if (!allowed(req)) return json(res, 429, { error: 'Lots of people are sending from your network. Please wait a minute and try again.' });
  const body = await readJson(req);
  const r = records.get(String(body.id ?? ''));
  const given = hashToken(String(body.token ?? ''));
  if (!r || !r.tokenHash || !timingSafeEqual(given, r.tokenHash)) return json(res, 404, { error: 'That upload was not found. Please start again.' });

  const names = Object.fromEntries(Object.entries(r.files).map(([k, f]) => [k, `${fileSafe(r.name)}.${f.ext}`]));
  // A browser that lost the first answer retries. If that first attempt is
  // still running, wait for it rather than complete the same uploads twice.
  if (completing.has(r.id)) {
    const first = await completing.get(r.id);
    return json(res, first.status, first.body);
  }
  if (r.state === 'uploaded' || r.state === 'stored') return json(res, 200, { ok: true, names }); // a retried /complete
  if (r.state !== 'uploading') return json(res, 410, { error: 'That upload has expired. Please start again.' });
  const attempt = finish(r, body, names);
  completing.set(r.id, attempt);
  try {
    const out = await attempt;
    return json(res, out.status, out.body);
  } finally {
    completing.delete(r.id);
  }
}

/** Complete each upload in R2 and check what arrived. Resolves to the answer for the browser. */
async function finish(r, body, names) {

  const problems = {};
  await Promise.all(Object.entries(r.files).map(async ([kind, f]) => {
    if (f.completed) return;
    const etags = body.files?.[kind]?.etags;
    const parts = Math.max(1, Math.ceil(f.size / PART_SIZE));
    if (!Array.isArray(etags) || etags.length !== parts || !etags.every((e) => typeof e === 'string' && e.length < 100)) {
      problems[kind] = `Your ${KINDS[kind].label} did not finish uploading. Please try again.`;
      return;
    }
    try {
      await r2.completeMultipart(f.key, f.uploadId, etags);
      const size = await r2.head(f.key);
      const type = fileType(await r2.firstBytes(f.key, 1024));
      if (size !== f.size || type !== f.ext) {
        console.log(`complete ${r.id}: ${kind} is ${type ?? 'unknown'} ${size}, declared ${f.ext} ${f.size}`);
        await r2.delete(f.key);
        problems[kind] = type && type !== f.ext && KINDS[kind].types[type]
          ? `That ${KINDS[kind].label} is really a ${type.toUpperCase()}, not a ${f.ext.toUpperCase()}. Please try again.`
          : `That ${KINDS[kind].label} is not ${typeList(KINDS[kind])}. Please choose another file.`;
        return;
      }
      f.completed = true;
    } catch (e) {
      console.error(`complete ${r.id}: ${kind}`, e.message);
      problems[kind] = `Your ${KINDS[kind].label} did not finish uploading. Please try again.`;
    }
  }));
  if (Object.keys(problems).length) {
    // A completed multipart upload cannot be reopened, so a submission with any
    // bad file is closed here and the browser starts again from /start. What
    // did upload is removed from R2 now rather than at the janitor's next pass.
    for (const f of Object.values(r.files)) {
      if (f.completed) await r2.delete(f.key).catch(() => {});
      else await r2.abortMultipart(f.key, f.uploadId).catch(() => {});
    }
    r.state = 'failed';
    delete r.tokenHash;
    await save(r);
    return { status: 422, body: { error: 'Some files need another look.', fields: problems, restart: true } };
  }
  r.state = 'uploaded';
  r.completedAt = new Date().toISOString();
  // The token is kept: a browser that lost this answer retries /complete, and
  // must be told "done", not "not found". From here it can only ever ask that.
  for (const f of Object.values(r.files)) delete f.uploadId;
  await save(r);
  console.log(`complete ${r.id}`);
  kick();
  return { status: 200, body: { ok: true, names } };
}

// ---------------------------------------------------------------- transfer

/**
 * Copy one file down from R2: stream it to a temporary name beside its final
 * one, check its length, strip images of their metadata, then rename it into
 * place. A crash leaves only a dot-file, removed at the next start.
 */
async function bringDown(r, kind, f) {
  const stall = new AbortController();
  let last = Date.now();
  const watch = setInterval(() => {
    if (Date.now() - last > STALL_MS) stall.abort(new Error(`stalled: nothing received for ${STALL_MS / 1000} s`));
  }, 5000);
  try {
    return await copyDown(r, kind, f, stall.signal, () => (last = Date.now()));
  } finally {
    clearInterval(watch);
  }
}

async function copyDown(r, kind, f, signal, alive) {
  const dir = KINDS[kind].dir;
  const final = `${r.id}.${kind}.${f.ext}`;
  const tmp = join(dir, `.${final}.part`);
  if (f.ext === 'pdf') {
    let crc = 0;
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        alive();
        crc = crc32(chunk, crc);
        size += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(await r2.stream(f.key, { signal })), counter, createWriteStream(tmp), { signal });
    if (size !== f.size) throw new Error(`${kind} came down as ${size} bytes, expected ${f.size}`);
    f.crc = crc;
    f.storedSize = size;
  } else {
    const chunks = [];
    for await (const c of Readable.fromWeb(await r2.stream(f.key, { signal }))) {
      alive();
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    if (raw.length !== f.size) throw new Error(`${kind} came down as ${raw.length} bytes, expected ${f.size}`);
    let clean;
    try {
      clean = strip(raw, f.ext);
    } catch {
      // Not a photo this process can read. Kept out of the download rather than
      // kept with its metadata; the committee sees it flagged in the sheet.
      f.problem = 'could not be read; ask for another file';
      f.stored = true;
      console.log(`transfer ${r.id}: ${kind} unreadable`);
      return;
    }
    await writeFile(tmp, clean);
    f.crc = crc32(clean);
    f.storedSize = clean.length;
  }
  await rename(tmp, join(dir, final));
  f.file = final;
  f.stored = true;
}

/** The next file waiting to come down, oldest submission first. */
function nextJob(busy) {
  for (const r of all()) {
    if (r.state !== 'uploaded') continue;
    for (const [kind, f] of Object.entries(r.files)) {
      if (!f.stored && !busy.has(f.key)) return { r, kind, f };
    }
  }
  return null;
}

const busy = new Set();
function kick() {
  if (Date.now() < transfer.retryAt) return;
  while (transfer.running < TRANSFERS) {
    const job = nextJob(busy);
    if (!job) return;
    busy.add(job.f.key);
    transfer.running += 1;
    const t0 = Date.now();
    bringDown(job.r, job.kind, job.f)
      .then(async () => {
        if (Object.values(job.r.files).every((f) => f.stored)) {
          job.r.state = 'stored';
          job.r.storedAt = new Date().toISOString();
        }
        await save(job.r);
        transfer.failures = 0;
        console.log(`transfer ${job.r.id}: ${job.kind} ${job.f.size} bytes in ${Date.now() - t0} ms`);
      })
      .catch((e) => {
        // R2 or the network failed: back off, doubling up to five minutes, and try again.
        transfer.failures += 1;
        transfer.lastError = `${job.kind}: ${e.message}`;
        transfer.lastErrorAt = new Date().toISOString();
        transfer.retryAt = Date.now() + Math.min(5 * 60_000, 2000 * 2 ** Math.min(transfer.failures, 8));
        console.error(`transfer ${job.r.id}: ${job.kind} failed (${e.message}); retrying`);
        rm(join(KINDS[job.kind].dir, `.${job.r.id}.${job.kind}.${job.f.ext}.part`), { force: true }).catch(() => {});
      })
      .finally(() => {
        busy.delete(job.f.key);
        transfer.running -= 1;
        setTimeout(kick, Math.max(0, transfer.retryAt - Date.now()));
      });
  }
}

// ---------------------------------------------------------------- housekeeping

/**
 * Uploads never completed within UPLOAD_HOURS are given up: their parts are
 * aborted in R2 (the bucket's lifecycle rule does the same after a day, as a
 * second line) and the record is marked abandoned. The person was never told
 * they were done, so nothing is lost that they believe was sent.
 */
async function janitor() {
  const cutoff = Date.now() - UPLOAD_HOURS * 3600_000 - 3600_000;
  for (const r of records.values()) {
    if (r.state !== 'uploading' || Date.parse(r.submittedAt) > cutoff) continue;
    for (const f of Object.values(r.files)) {
      if (f.uploadId) await r2?.abortMultipart(f.key, f.uploadId).catch(() => {});
      if (f.completed) await r2?.delete(f.key).catch(() => {});
    }
    r.state = 'abandoned';
    delete r.tokenHash;
    await save(r);
    console.log(`abandoned ${r.id}`);
  }
}

/**
 * The retention promise, kept by the process that holds the data: once the
 * date in the collection notice has passed, every record and file here goes,
 * and every object in the R2 bucket with them. Checked at start and hourly,
 * so a box that was off on the day still does it. Backups already taken are
 * not touched here; see SECURITY.md.
 */
async function purgeIfDue() {
  if (!closed()) return;
  let n = 0;
  for (const dir of [DATA, FILES]) {
    for (const f of await readdir(dir)) {
      await rm(join(dir, f), { force: true, recursive: true });
      n += 1;
    }
  }
  records.clear();
  // In parallel: the R2 client holds them to its own limit of calls in flight.
  if (r2) await Promise.all((await r2.list('')).map((key) => r2.delete(key).then(() => (n += 1))));
  if (n) console.log(`retention: deleted ${n} files and objects (past ${DELETE_AFTER.toISOString()})`);
}

// ---------------------------------------------------------------- export

function adelaideTime(iso) {
  return iso
    ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
    : '';
}

/** Each person's files, named after them, without two people colliding. */
function named(people) {
  const used = new Set();
  return people.map((p) => {
    let base = fileSafe(p.name);
    for (let n = 2; used.has(base.toLowerCase()); n++) base = `${fileSafe(p.name)} ${n}`;
    used.add(base.toLowerCase());
    const out = {};
    for (const [kind, f] of Object.entries(p.files)) out[kind] = f.problem ? null : `${base}.${f.ext}`;
    return { p, out };
  });
}

const mb = (n) => (n ? `${(n / MB).toFixed(1)} MB` : '');

function zipHeaders(res, label) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="stitch-${label}-${new Date().toISOString().slice(0, 10)}.zip"`,
    'cache-control': 'no-store',
  });
}

/** The sheet and every headshot: the small download the committee opens first. */
async function exportMain(res) {
  const people = named(latestStored());
  const rows = people.map(({ p, out }) => [
    p.name,
    p.linkedin,
    p.from,
    p.title ?? '',
    p.overview,
    out.photo ? `photos/${out.photo}` : `headshot ${p.files.photo?.problem ?? 'missing'}`,
    out.poster ? `posters/${out.poster}` : `poster ${p.files.poster?.problem ?? 'missing'}`,
    mb(p.files.poster?.storedSize),
    out.booklet ? `booklets/${out.booklet}` : `booklet ${p.files.booklet?.problem ?? 'missing'}`,
    mb(p.files.booklet?.storedSize),
    adelaideTime(p.completedAt ?? p.submittedAt),
  ]);
  const sheet = await workbook(
    ['Full name', 'LinkedIn', 'Where from', 'Project title', 'Project overview', 'Headshot', 'Poster', 'Poster size', 'Booklet', 'Booklet size', 'Submitted'],
    [28, 40, 24, 36, 80, 34, 34, 12, 34, 12, 20],
    rows,
    [4],
  );
  zipHeaders(res, 'submissions');
  const zip = new ZipStream(res);
  await zip.addBuffer('submissions.xlsx', sheet);
  for (const { p, out } of people) {
    const f = p.files.photo;
    if (out.photo) await zip.addFile(`photos/${out.photo}`, join(DATA, f.file), f.storedSize, f.crc);
  }
  await zip.finish();
}

/** Every poster or every booklet, renamed after its person. Tens of GB; ZIP64 past 4 GB. */
async function exportKind(res, kind) {
  const people = named(latestStored());
  zipHeaders(res, `${kind}s`);
  const zip = new ZipStream(res);
  for (const { p, out } of people) {
    const f = p.files[kind];
    if (out[kind]) await zip.addFile(`${kind}s/${out[kind]}`, join(KINDS[kind].dir, f.file), f.storedSize, f.crc);
  }
  await zip.finish();
}

function statusReport() {
  const count = {};
  for (const r of records.values()) count[r.state] = (count[r.state] ?? 0) + 1;
  const waiting = [];
  let waitingBytes = 0;
  for (const r of all()) {
    if (r.state !== 'uploaded') continue;
    waiting.push(r.name);
    for (const f of Object.values(r.files)) if (!f.stored) waitingBytes += f.size;
  }
  const people = latestStored();
  return {
    people: people.length,
    submissions: count,
    queue: { waiting: waiting.length, waitingMB: Math.round(waitingBytes / MB), transferring: transfer.running },
    lastTransferError: transfer.lastError ? { at: transfer.lastErrorAt, error: transfer.lastError } : null,
    flagged: people.flatMap((p) => Object.entries(p.files).filter(([, f]) => f.problem).map(([k, f]) => `${p.name}: ${k} ${f.problem}`)),
    names: people.map((p) => p.name),
    stillComingDown: waiting,
  };
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
  const handler = req.method === 'POST' && { '/start': start, '/complete': complete }[path];
  if (!handler) return res.writeHead(404).end();
  handler(req, res).catch((e) => {
    if (e.status === 413 || e.status === 400) return json(res, e.status, { error: 'The form could not be read. Please try again.' });
    console.error(`${path} failed`, e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
  });
});

const ADMIN = { '/export': (res) => exportMain(res), '/export/posters': (res) => exportKind(res, 'poster'), '/export/booklets': (res) => exportKind(res, 'booklet'), '/status': async (res) => json(res, 200, statusReport()) };

const adminServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
  if (!KEY || req.method !== 'GET' || !ADMIN[path]) return res.writeHead(404).end();
  minuteTick();
  const who = fingerprint(req);
  if ((authFails.get(who) ?? 0) >= AUTH_PER_MINUTE) return res.writeHead(429, { 'retry-after': '60', 'cache-control': 'no-store' }).end();
  if (!authorised(req)) {
    // A browser's first request carries no password at all; only a wrong one counts.
    if (req.headers.authorization && authFails.size < 50_000) authFails.set(who, (authFails.get(who) ?? 0) + 1);
    if (req.headers.authorization) console.log(`${path}: wrong password from ${who}`);
    return res.writeHead(401, { 'www-authenticate': 'Basic realm="STITCH submissions", charset="UTF-8"', 'cache-control': 'no-store' }).end();
  }
  console.log(`${path}: opened by ${who}`);
  ADMIN[path](res).catch((e) => {
    console.error(`${path} failed`, e);
    if (!res.headersSent) json(res, 500, { error: 'failed' });
    else res.destroy();
  });
});

await mkdir(DATA, { recursive: true });
await mkdir(FILES, { recursive: true });
await purgeIfDue();
await load();
await janitor().catch((e) => console.error('janitor failed', e));
const every = (ms, fn, label) => setInterval(() => fn().catch((e) => console.error(`${label} failed`, e)), ms).unref();
every(60 * 60 * 1000, purgeIfDue, 'retention');
every(15 * 60 * 1000, janitor, 'janitor');
every(30 * 1000, async () => kick(), 'transfer');
kick();
formServer.listen(FORM_PORT, '0.0.0.0', () => console.log(`form on :${FORM_PORT} (/start, /complete)${r2 ? '' : ' — no R2: uploads off'}`));
adminServer.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`admin on :${ADMIN_PORT}${KEY ? '' : ' (no SUBMISSIONS_KEY: export off)'}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    formServer.close();
    adminServer.close();
    process.exit(0);
  });
}
