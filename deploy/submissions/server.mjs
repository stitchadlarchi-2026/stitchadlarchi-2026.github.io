/**
 * STITCH exhibition submissions.
 *
 * Each graduate gives their name and a personal email, and answers two
 * questions: will they exhibit on the night, and do they want to be in the
 * Student Directory. Someone who answers no to both sends nothing else, and
 * their record is stored at once. Anyone else sends their details and two
 * files: a 600 x 800 black-and-white headshot tile, cropped in their browser,
 * and, if they like, up to three PNG project images (a poster, drawings,
 * renders, anything) at 150 DPI or more. An image runs to hundreds of
 * megabytes, and stitchexhibition.com sits behind a Cloudflare plan that
 * refuses any request body over 100 MB and behind a home connection, so the
 * files never come through here at all:
 *
 *   1. POST /start     The browser sends the details, a Turnstile token and
 *                      the size and type of each file. This process checks
 *                      them, opens a multipart upload in R2 for each file and
 *                      answers with presigned part URLs.
 *   2. (browser → R2)  The browser uploads the parts straight to R2, several
 *                      at once, retrying any that fail.
 *   3. POST /complete  The browser hands back the parts' ETags. This process
 *                      completes each upload and checks the object's real size
 *                      and first bytes, pixel size included. The submission is then `uploaded`.
 *   4. (R2 → disk)     The transfer worker below copies uploaded files down to
 *                      this box, a couple at a time, whatever the rush upstairs.
 *                      A spike of 300 people becomes a queue in R2, not a queue
 *                      on the home connection. The submission is then `stored`.
 *
 * Every state lives in a JSON record on the `submissions-data` volume, written
 * atomically, so a restart resumes the queue where it stopped. Headshots are
 * kept with the records (that volume is backed up nightly); posters go to
 * `submissions-files`, and their R2 copies are kept until the deletion date
 * as the off-box copy.
 *
 * The Student Directory. A graduate who answers yes to the directory has
 * their browser send a small JPEG web copy of each project image beside its PNG; the
 * headshot tile is already small. Nothing is shown until the committee
 * approves it on the review page; a resubmission waits for approval while the
 * earlier approved profile stays up, and one that answers no takes the
 * profile down at once. The directory serves only the tile and the web copies,
 * never the image PNGs, the email or "where from", and it empties with
 * everything else on the deletion date.
 *
 * Two servers, two ports:
 *   FORM_PORT   POST /start, /complete              nginx, from the public site
 *               GET  /directory.json, /media/<id>/<kind>
 *   ADMIN_PORT  GET  /export[/posters] (all images), nginx, behind SUBMISSIONS_KEY
 *                    /status, /review, /review/media/<id>/<kind>
 *               POST /review/<id>/(approve|hide)
 *               GET  /health                        (healthcheck, local only)
 *   CONSOLE_PORT the admin console, admin.stitchexhibition.com (console.mjs)
 *
 * FORM_PORT also takes POST /ping, the page's heartbeat: a random id per open
 * tab (made fresh each page load, never stored by the page), the page it is
 * on and whether the form is being filled in or uploading. Held in memory for
 * a minute, for the console's "on the site now"; nothing is written down.
 *
 * Node builtins only: no package.json, no node_modules.
 */

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PngStrip, strip } from './metadata.mjs';
import { R2 } from './r2.mjs';
import { ZipStream, crc32, workbook } from './zip.mjs';
import { startConsole } from './console.mjs';

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
 * A project image's smallest resolution, read from the PNG's pHYs chunk. An
 * image may be anything (a poster, a drawing, a render), so no pixel size is
 * set; the DPI the file declares is the rule the committee asked for. A PNG
 * with no DPI recorded is refused. 149.5 allows for 150 DPI stored as a whole
 * number of pixels per metre (5905 or 5906). Keep in step with index.html.
 */
const MIN_DPI = 150;
/** The headshot tile the browser crops to: portrait, black and white. Keep in step with index.html. */
const TILE = { width: 600, height: 800 };
/**
 * What each upload may be. Types are checked twice: against what the browser
 * declares at /start, and against the object's real first bytes at /complete,
 * where the pixel size is checked too.
 */
const KINDS = {
  photo: { label: 'headshot', dir: DATA, types: { jpg: 4 * MB } },
  // Project images, up to three, all optional ("extra"): each is checked the
  // same way when sent, and nothing is asked if it is not.
  // (Kept under the name "poster" so earlier records and paths still work.)
  poster: { label: 'project image', dir: FILES, types: { png: 250 * MB }, image: true, extra: true, suffix: '' },
  poster2: { label: 'second project image', dir: FILES, types: { png: 250 * MB }, image: true, extra: true, suffix: ' 2' },
  poster3: { label: 'third project image', dir: FILES, types: { png: 250 * MB }, image: true, extra: true, suffix: ' 3' },
  // A web copy of each image the browser makes for the Student Directory, only
  // for someone who wants to be in it. Optional: a browser that cannot make one sends none.
  posterWeb: { label: 'web copy', dir: DATA, types: { jpg: 8 * MB }, optional: true, of: 'poster' },
  posterWeb2: { label: 'web copy', dir: DATA, types: { jpg: 8 * MB }, optional: true, of: 'poster2' },
  posterWeb3: { label: 'web copy', dir: DATA, types: { jpg: 8 * MB }, optional: true, of: 'poster3' },
};
const IMAGES = ['poster', 'poster2', 'poster3'];
const WEB_OF = { poster: 'posterWeb', poster2: 'posterWeb2', poster3: 'posterWeb3' };
/** The public and review image paths: the headshot tile and the web copies, never a PNG. */
const SHOWN = 'photo|posterWeb|posterWeb2|posterWeb3';
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const EXT_OF_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Every part but the last is this size; R2 wants at least 5 MiB. A 250 MB image is 16 parts. */
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

const LIMITS = { name: 120, email: 254, degree: 120, from: 120, linkedin: 300, instagram: 300, website: 300, title: 150, overview: 1500 };
/** The project overview is a wall label, not an essay. */
const MAX_WORDS = 150;
/** Recorded with each submission. Keep in step with the notice in index.html. */
const CONSENT = 'exhibition labels and catalogue if exhibiting, stitchexhibition.com, STITCH social media; email for committee contact only, never published; deleted after 31 January 2027';

const salt = randomBytes(32);

// ---------------------------------------------------------------- live view
/** Open tabs by their heartbeat id: { page, activity, at }. Memory only. */
const presence = new Map();
const PRESENCE_MS = 50_000;
const PRESENCE_MAX = 5000;
const PING_PER_MINUTE = 3000; // a whole campus behind one address, three beats a minute each
const pingBudget = new Map();
const PAGES = new Set(['home', 'info', 'links', 'directory', 'sponsors', 'other']);
const ACTIVITIES = new Set(['browsing', 'form', 'uploading', 'submitted']);
/** What has happened lately, newest last, for the console's feed. Memory only. */
const events = [];
function activity(kind, text) {
  events.push({ at: new Date().toISOString(), kind, text });
  if (events.length > 60) events.shift();
}
/** Bumped on every change to a record or a decision, so the console knows to fetch again. */
let changes = 0;
const mask = (email) => String(email).replace(/^(.).*?(@.*)$/, '$1…$2');
const budget = new Map();
/** Directory requests one address may make in a minute: generous for browsing, not for scraping. */
const PUBLIC_PER_MINUTE = 600;
const publicBudget = new Map();
/** Directory decisions, by record id: 'approved' or 'hidden'. Missing means waiting for review. */
let approvals = {};
const APPROVALS = () => join(DATA, 'approvals.state');
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

/**
 * A link a person typed, as an https address, or '' for none, or null for one
 * that is not a web address. Only http and https get through: these links are
 * shown on the public directory.
 */
function webUrl(v, max, host) {
  const s = oneLine(v, max);
  if (!s) return '';
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
  if (host && !host.test(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}
const linkedinUrl = (v) => webUrl(v, LIMITS.linkedin, /(^|\.)linkedin\.com$/i);
const websiteUrl = (v) => webUrl(v, LIMITS.website);

/** An Instagram profile from a link, "@handle" or a bare handle. */
function instagramUrl(v) {
  const s = oneLine(v, LIMITS.instagram);
  if (!s) return '';
  const handle = /^@?([a-z0-9._]{1,30})$/i.exec(s);
  if (handle) return `https://www.instagram.com/${handle[1]}/`;
  const u = webUrl(s, LIMITS.instagram, /(^|\.)instagram\.com$/i);
  if (!u) return null;
  const path = /^\/([a-z0-9._]{1,30})\/?$/i.exec(new URL(u).pathname);
  return path ? `https://www.instagram.com/${path[1]}/` : null;
}

/** A plausible email address, or null. Only the committee ever sees it. */
function emailAddress(v) {
  const s = oneLine(v, LIMITS.email).toLowerCase();
  return /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) && !/\.\./.test(s) ? s : null;
}

/** A PNG's width and height, from its IHDR chunk at byte 16. */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A JPEG's width and height, from its first start-of-frame marker. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/**
 * A PNG's resolution in DPI, from its pHYs chunk (the lower of the two axes).
 * null: the file records none (or not in metres). undefined: the bytes given
 * end before the image data starts, so read further and ask again.
 */
function pngDpi(buf) {
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT' || type === 'IEND') return null; // pHYs must come before the image data
    if (type === 'pHYs') {
      if (i + 17 > buf.length) return undefined;
      if (buf[i + 16] !== 1) return null;
      return Math.min(buf.readUInt32BE(i + 8), buf.readUInt32BE(i + 12)) * 0.0254;
    }
    i += 12 + len;
  }
  return undefined;
}

/** Why a file's pixel size or resolution is wrong for its kind, or ''. */
function sizeProblem(kind, ext, buf) {
  if (KINDS[kind].image) {
    const label = KINDS[kind].label;
    if (!pngSize(buf)) return `That ${label} could not be read. Please export it again as a PNG.`;
    const dpi = pngDpi(buf);
    if (!dpi) return `That ${label} has no DPI recorded. Please export it again as a PNG at ${MIN_DPI} DPI or more.`;
    if (dpi < MIN_DPI - 0.5) return `That ${label} is ${Math.round(dpi)} DPI. Please export it again as a PNG at ${MIN_DPI} DPI or more.`;
  }
  if (kind === 'photo') {
    const d = ext === 'jpg' ? jpegSize(buf) : null;
    if (!d || d.width !== TILE.width || d.height !== TILE.height) return 'Your headshot did not crop properly. Please choose it again.';
  }
  return '';
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
    publicBudget.clear();
    pingBudget.clear();
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

function publicAllowed(req) {
  minuteTick();
  const id = fingerprint(req);
  const spent = publicBudget.get(id) ?? 0;
  if (spent >= PUBLIC_PER_MINUTE) return false;
  if (publicBudget.size < 50_000) publicBudget.set(id, spent + 1);
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
  profilesCache = null;
  changes += 1;
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
  try {
    approvals = JSON.parse(await readFile(APPROVALS(), 'utf8'));
    profilesCache = null;
  } catch {
    approvals = {};
  }
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
  if (oneLine(body.ref_code, 200)) return json(res, 200, { ok: true, decoy: true });
  if (!(await human(oneLine(body.turnstile, 4096), req))) {
    return json(res, 403, { error: 'We could not confirm you are not a robot. Please reload the page and try again.' });
  }

  const name = oneLine(body.name, LIMITS.name);
  const email = emailAddress(body.email);
  const problems = {};
  if (name.split(' ').filter(Boolean).length < 2) problems.name = 'Please give your full name, first and last.';
  if (!email) problems.email = 'Please give an email address we can reach you on.';
  if (typeof body.exhibit !== 'boolean') problems.exhibit = 'Please answer yes or no.';
  if (typeof body.directory !== 'boolean') problems.directory = 'Please answer yes or no.';
  const exhibit = body.exhibit === true;
  const listed = body.directory === true;

  // No to both: nothing else is asked or kept. The record says they answered.
  if (!exhibit && !listed) {
    if (Object.keys(problems).length) return json(res, 422, { error: 'Some fields need another look.', fields: problems });
    return declined(res, { name, email });
  }

  const from = oneLine(body.from, LIMITS.from);
  const degree = oneLine(body.degree, LIMITS.degree);
  const title = oneLine(body.title, LIMITS.title);
  const overview = clean(body.overview, LIMITS.overview);
  const linkedin = linkedinUrl(body.linkedin);
  const instagram = instagramUrl(body.instagram);
  const website = websiteUrl(body.website);
  if (!degree || degree === 'other') problems.degree = 'Please choose your degree.';
  if (linkedin === null) problems.linkedin = 'That does not look like a LinkedIn link.';
  if (instagram === null) problems.instagram = 'That does not look like an Instagram handle or link.';
  if (website === null) problems.website = 'That does not look like a web address.';
  if (!title) problems.title = 'Please give your project a title.';
  if (overview.length < 20) problems.overview = 'Please write a short overview of your project.';
  else if (overview.split(/\s+/).filter(Boolean).length > MAX_WORDS) problems.overview = `Please keep it to ${MAX_WORDS} words or fewer.`;
  if (body.consent !== true) problems.consent = 'Please tick the box to agree to how your details are used.';

  const files = {};
  for (const [kind, spec] of Object.entries(KINDS)) {
    const f = body.files?.[kind];
    const size = Number(f?.size);
    const ext = EXT_OF_MIME[String(f?.type ?? '').toLowerCase()] ?? extFromName(f?.name);
    if (spec.optional) {
      // A web copy is only wanted for the directory, for an image that is sent, and only kept when it is what it says.
      if (listed && f && Number.isSafeInteger(size) && size > 0 && ext && spec.types[ext] && size <= spec.types[ext]) files[kind] = { size, ext };
      continue;
    }
    if (spec.extra && !f) continue;
    if (!f || !Number.isSafeInteger(size) || size <= 0) {
      problems[kind] = `Please attach your ${spec.label}.`;
    } else if (!ext || !spec.types[ext]) {
      problems[kind] = `Your ${spec.label} must be ${typeList(spec)}.`;
    } else if (size > spec.types[ext]) {
      problems[kind] = `That ${spec.label} is too big. The limit is ${spec.types[ext] / MB} MB for ${ext.toUpperCase()}.`;
    } else files[kind] = { size, ext };
  }
  for (const [img, web] of Object.entries(WEB_OF)) if (!files[img]) delete files[web];
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
    return await openUploads(res, { name, email, exhibit, listed, degree, linkedin, instagram, website, from, title, overview, files });
  } finally {
    reserving.count -= 1;
    reserving.bytes -= wanted;
  }
}

const newId = (at) => `${at.replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;

/** No to both questions: a record of the answer, with the name and email only, stored at once. */
async function declined(res, { name, email }) {
  const at = new Date().toISOString();
  const record = { id: newId(at), submittedAt: at, completedAt: at, storedAt: at, state: 'stored', name, email, exhibit: false, listed: false, files: {} };
  await save(record);
  console.log(`declined ${record.id}`);
  activity('declined', `${name}: not exhibiting, not in the directory`);
  return json(res, 200, { ok: true, done: true, names: {} });
}

async function openUploads(res, { name, email, exhibit, listed, degree, linkedin, instagram, website, from, title, overview, files }) {
  const submittedAt = new Date().toISOString();
  const id = newId(submittedAt);
  const token = randomBytes(24).toString('base64url');
  const record = {
    id,
    submittedAt,
    state: 'uploading',
    name,
    /** For the committee to reach them. Never public. */
    email,
    /** Whether they will exhibit on the night. */
    exhibit,
    /** Whether they asked to be shown in the Student Directory. */
    listed,
    degree,
    linkedin: linkedin ?? '',
    instagram: instagram ?? '',
    website: website ?? '',
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
  activity('start', `${name}: started uploading ${Object.keys(files).filter((k) => !KINDS[k].optional).length} files (${Math.round(Object.values(files).reduce((n, f) => n + f.size, 0) / MB)} MB)`);
  return json(res, 200, answer);
}

const extFromName = (n) => ({ jpg: 'jpg', jpeg: 'jpg', png: 'png' })[String(n ?? '').split('.').pop().toLowerCase()];
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

  const names = Object.fromEntries(Object.entries(r.files).filter(([k]) => !KINDS[k].optional).map(([k, f]) => [k, `${fileSafe(r.name)}${KINDS[k].suffix ?? ''}.${f.ext}`]));
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
      // 64 KB reaches a JPEG's frame header past any APP segments; a PNG's is at byte 16.
      let head = await r2.firstBytes(f.key, 64 * 1024);
      // A PNG's DPI sits before its image data, past any colour profile and
      // text chunks; a big profile or XMP block can push it past 64 KB.
      if (KINDS[kind].image && fileType(head) === 'png' && pngDpi(head) === undefined && f.size > head.length) head = await r2.firstBytes(f.key, 4 * MB);
      const type = fileType(head);
      if (size !== f.size || type !== f.ext) {
        console.log(`complete ${r.id}: ${kind} is ${type ?? 'unknown'} ${size}, declared ${f.ext} ${f.size}`);
        await r2.delete(f.key);
        problems[kind] = type && type !== f.ext && KINDS[kind].types[type]
          ? `That ${KINDS[kind].label} is really a ${type.toUpperCase()}, not a ${f.ext.toUpperCase()}. Please try again.`
          : `That ${KINDS[kind].label} is not ${typeList(KINDS[kind])}. Please choose another file.`;
        return;
      }
      const wrong = sizeProblem(kind, type, head);
      if (wrong) {
        console.log(`complete ${r.id}: ${kind} refused: ${wrong}`);
        await r2.delete(f.key);
        problems[kind] = wrong;
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
    activity('failed', `${r.name}: ${Object.values(problems)[0]}`);
    return { status: 422, body: { error: 'Some files need another look.', fields: problems, restart: true } };
  }
  r.state = 'uploaded';
  r.completedAt = new Date().toISOString();
  // The token is kept: a browser that lost this answer retries /complete, and
  // must be told "done", not "not found". From here it can only ever ask that.
  for (const f of Object.values(r.files)) delete f.uploadId;
  await save(r);
  console.log(`complete ${r.id}`);
  activity('complete', `${r.name}: upload finished`);
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
  if (KINDS[kind].image) {
    // Hundreds of MB: streamed through the PNG stripper, never held in memory.
    let received = 0;
    let crc = 0;
    let size = 0;
    const arriving = new Transform({
      transform(chunk, _enc, done) {
        alive();
        received += chunk.length;
        done(null, chunk);
      },
    });
    const counter = new Transform({
      transform(chunk, _enc, done) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        done(null, chunk);
      },
    });
    const stripper = new PngStrip();
    try {
      await pipeline(Readable.fromWeb(await r2.stream(f.key, { signal })), arriving, stripper, counter, createWriteStream(tmp), { signal });
    } catch (e) {
      // A dropped connection is retried; a file that is not a whole PNG never will be.
      // (A stream cut short also looks like a PNG with no end: that is retried too.)
      const cutShort = received !== f.size && stripper.malformed?.message === 'no IEND';
      if (!stripper.malformed || signal.aborted || cutShort) throw e;
      await rm(tmp, { force: true });
      f.problem = 'could not be read; ask for another file';
      f.stored = true;
      console.log(`transfer ${r.id}: ${kind} unreadable (${e.message})`);
      return;
    }
    if (received !== f.size) throw new Error(`${kind} came down as ${received} bytes, expected ${f.size}`);
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
          activity('stored', `${job.r.name}: files saved`);
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
  approvals = {};
  profilesCache = null;
  // In parallel: the R2 client holds them to its own limit of calls in flight.
  if (r2) await Promise.all((await r2.list('')).map((key) => r2.delete(key).then(() => (n += 1))));
  if (n) console.log(`retention: deleted ${n} files and objects (past ${DELETE_AFTER.toISOString()})`);
}

// ---------------------------------------------------------------- directory

/**
 * Everyone, once, by name: their latest stored submission, their review
 * status, and the submission the directory shows for them, if any. That is
 * the latest one they listed that the committee approved, unless their latest
 * submission says no or the committee hid it.
 */
/**
 * The directory, computed once and kept until a record or a decision changes.
 * Every public request needs it (each image checks its profile is shown), so
 * rebuilding it per request would spend the container's CPU on a crowd.
 */
let profilesCache = null;
function profiles() {
  if (!profilesCache) profilesCache = buildProfiles();
  return profilesCache;
}

function buildProfiles() {
  const byName = new Map();
  for (const r of all()) {
    if (r.state !== 'stored') continue;
    const k = nameKey(r.name);
    const p = byName.get(k) ?? { history: [] };
    p.history.push(r);
    p.latest = r;
    byName.set(k, p);
  }
  const list = [...byName.values()].sort((a, b) => a.latest.name.localeCompare(b.latest.name, 'en-AU'));
  for (const p of list) {
    const mark = approvals[p.latest.id];
    p.declined = !p.latest.listed && p.latest.exhibit === false;
    p.status = !p.latest.listed ? 'private' : mark === 'approved' ? 'live' : mark === 'hidden' ? 'hidden' : 'waiting';
    p.shown = null;
    if (p.latest.listed && mark !== 'hidden') {
      for (let i = p.history.length - 1; i >= 0; i--) {
        const r = p.history[i];
        if (r.listed && approvals[r.id] === 'approved' && usable(r.files.photo)) {
          p.shown = r;
          break;
        }
      }
    }
  }
  return list;
}

const usable = (f) => f && f.stored && f.file && !f.problem;

/** A short, readable address for a profile: #directory/jane-citizen. */
const slugOf = (name) =>
  name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'graduate';

/** What the public page gets: the fields a wall label would carry and their links, never the email, "where from" or the image PNGs. */
function directory() {
  const used = new Set();
  const out = [];
  for (const p of profiles()) {
    const r = p.shown;
    if (!r) continue;
    let slug = slugOf(r.name);
    for (let n = 2; used.has(slug); n++) slug = `${slugOf(r.name)}-${n}`;
    used.add(slug);
    out.push({
      slug,
      name: r.name,
      degree: r.degree ?? '',
      title: r.title ?? '',
      overview: r.overview,
      linkedin: r.linkedin,
      instagram: r.instagram ?? '',
      website: r.website ?? '',
      photo: mediaUrl(r, 'photo'),
      images: IMAGES.map((k) => WEB_OF[k]).filter((k) => usable(r.files[k])).map((k) => ({ kind: 'image', url: mediaUrl(r, k) })),
    });
  }
  return out;
}

/**
 * A public image's address ends in its file's extension. Cloudflare caches by
 * extension, so the edge serves the directory's images and they do not go up
 * the home connection once per visitor; a crowd at the opening on one venue
 * Wi-Fi would otherwise also meet the per-address limit below.
 */
const mediaUrl = (r, kind) => `/_s/media/${r.id}/${kind}.${r.files[kind].ext}`;
/**
 * How long a browser or Cloudflare may keep a public image. Short, because a
 * profile the committee hides must disappear: at most this long after it does.
 */
const PUBLIC_IMAGE_CACHE = 'public, max-age=300';
const gone = (res) => res.writeHead(404, { 'cache-control': 'no-store' }).end();

/** The record behind a public request, only if the directory shows it. */
function shownRecord(id) {
  for (const p of profiles()) if (p.shown?.id === id) return p.shown;
  return null;
}

async function sendFile(res, kind, f, cache, disposition) {
  res.writeHead(200, {
    'content-type': MIME[f.ext],
    'content-length': f.storedSize,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    ...(disposition ? { 'content-disposition': disposition } : {}),
  });
  await pipeline(createReadStream(join(KINDS[kind].dir, f.file)), res);
}

/** The directory as sent, rebuilt only when profiles() is. */
const directoryJson = { for: null, body: '' };

/** GET /directory.json, /media/<id>/<kind>: approved profiles only. */
async function publicGet(req, res, path) {
  if (!publicAllowed(req)) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });
  if (path === '/directory.json') {
    const current = profiles();
    if (directoryJson.for !== current) {
      directoryJson.body = JSON.stringify({ graduates: directory() });
      directoryJson.for = current;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    return res.end(directoryJson.body);
  }
  // Only the headshot tile and the images' web copies; the PNGs are never served.
  const media = new RegExp(`^/media/([0-9a-f-]{1,64})/(${SHOWN})\\.(jpg)$`).exec(path);
  if (media) {
    const r = shownRecord(media[1]);
    const f = r?.files[media[2]];
    if (!r || !usable(f) || f.ext !== media[3]) return gone(res);
    return sendFile(res, media[2], f, PUBLIC_IMAGE_CACHE);
  }
  return gone(res);
}

// ---------------------------------------------------------------- review

const STATUS_WORD = { live: 'Live', waiting: 'Waiting for review', hidden: 'Hidden', private: 'Not in directory' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function reviewPage(res) {
  const list = [...profiles()]; // a copy: profiles() is shared, and this sorts it

  const order = { waiting: 0, live: 1, hidden: 2, private: 3 };
  list.sort((a, b) => order[a.status] - order[b.status] || a.latest.name.localeCompare(b.latest.name, 'en-AU'));
  const counts = { waiting: 0, live: 0, hidden: 0, private: 0 };
  for (const p of list) counts[p.status] += 1;
  const cards = list
    .map((p) => {
      const r = p.latest;
      const photoKind = usable(r.files.photo) ? 'photo' : null;
      const poster = IMAGES.map((k, i) => [k, i]).filter(([k]) => r.files[k])
        .map(([k, i]) => usable(r.files[WEB_OF[k]])
          ? `<a href="/_s/review/media/${r.id}/${WEB_OF[k]}" target="_blank" rel="noopener">View image ${i + 1}</a>`
          : `<span class="muted">Image ${i + 1}: no web copy (it is in the images download)</span>`)
        .join(' · ');
      const links = [['LinkedIn', r.linkedin], ['Instagram', r.instagram], ['Website', r.website]]
        .filter(([, u]) => u)
        .map(([label, u]) => ` · <a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>`)
        .join('');
      const answers = `${r.exhibit === false ? 'Not exhibiting' : 'Exhibiting'} · ${esc(r.email || 'no email')}`;
      const note = p.status === 'waiting' && p.shown && p.shown.id !== r.id ? '<p class="note">Updated. Their earlier approved profile stays up until you approve this one.</p>' : '';
      const actions =
        p.status === 'private'
          ? p.declined ? '' : '<p class="muted">They did not ask to be in the Student Directory.</p>'
          : `<form method="post" action="/_s/review/${esc(r.id)}/approve"><button ${p.status === 'live' ? 'disabled' : ''}>Approve</button></form>
             <form method="post" action="/_s/review/${esc(r.id)}/hide"><button class="ghost" ${p.status === 'hidden' ? 'disabled' : ''}>Hide</button></form>`;
      return `<article class="card ${p.status}">
        ${photoKind ? `<img src="/_s/review/media/${r.id}/${photoKind}" alt="" loading="lazy">` : '<div class="noimg">No photo</div>'}
        <div class="body">
          <p class="status">${STATUS_WORD[p.status]}</p>
          <h2>${esc(r.name)}</h2>
          <p class="meta">${answers}</p>
          ${p.declined ? '<p class="muted">Not exhibiting and not in the directory: nothing else was asked.</p>' : `<p class="meta">${esc(r.degree || 'No degree given')}${links}</p>
          <p class="ov"><b>${esc(r.title || 'Untitled')}</b><br>${esc(r.overview)}</p>`}
          <p>${poster}</p>
          ${note}
          <div class="actions">${actions}</div>
        </div>
      </article>`;
    })
    .join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>STITCH - Student Directory review</title>
<style>
:root{--ink:#111;--red:#C82B29}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:14px/1.5 "IBM Plex Mono",ui-monospace,Menlo,monospace}
header{padding:28px 24px 8px}h1{margin:0 0 6px;font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--red)}
.sum{margin:0;color:#666}.sum b{color:var(--ink);font-weight:500}.links{margin:8px 0 0}.links a{color:var(--red)}
main{padding:16px 24px 60px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{border:1px solid #ddd;display:grid;grid-template-columns:110px 1fr;gap:14px;padding:14px}
.card.waiting{border-color:var(--red)}.card.private,.card.hidden{opacity:.6}
.card img,.noimg{width:110px;aspect-ratio:1;object-fit:cover;background:#f2f2f2;display:grid;place-items:center;font-size:11px;color:#888}
h2{margin:0;font-size:15px;font-weight:500;text-transform:uppercase;letter-spacing:.03em}
.status{margin:0 0 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--red)}
.live .status{color:#2a7a2a}.meta{margin:4px 0;color:#666}.ov{margin:8px 0;white-space:pre-wrap}
a{color:var(--ink)}.muted{color:#888}.note{font-size:12px;color:var(--red)}
.actions{display:flex;gap:8px;margin-top:10px}.actions form{margin:0}
button{font:inherit;text-transform:uppercase;letter-spacing:.03em;border:0;border-radius:0;padding:.3em .7em;background:var(--red);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);outline:1px solid var(--ink)}button[disabled]{opacity:.35;cursor:default}
</style></head><body>
<header><h1>Student Directory: review</h1>
<p class="sum"><b>${counts.waiting}</b> waiting · <b>${counts.live}</b> live · <b>${counts.hidden}</b> hidden · <b>${counts.private}</b> not in directory</p>
<p class="links"><a href="/#directory" target="_blank" rel="noopener">Open the Student Directory</a> · <a href="/_s/export">Download the sheet and headshots</a></p></header>
<main>${cards || '<p class="muted">No submissions yet.</p>'}</main>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(html);
}

async function reviewMedia(res, id, kind) {
  const r = records.get(id);
  const f = r?.files[kind];
  if (!usable(f) || !SHOWN.split('|').includes(kind)) return res.writeHead(404).end();
  return sendFile(res, kind, f, 'private, no-store');
}

/**
 * Approve or hide. The committee's browser sends its saved password with any
 * request to this site, so a POST from another site's page would carry it too:
 * only a same-origin request is accepted.
 */
async function decide(req, res, id, action) {
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  if ((site && site !== 'same-origin') || (!site && origin && !/^https:\/\/(www\.)?stitchexhibition\.com$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    return res.writeHead(403).end();
  }
  const r = records.get(id);
  if (!r || r.state !== 'stored') return res.writeHead(404).end();
  await setDecision(id, action);
  res.writeHead(303, { location: '/_s/review', 'cache-control': 'no-store' });
  res.end();
}

/** Approve, hide, or (null) forget the committee's decision, and write it down. */
async function setDecision(id, action) {
  if (action) approvals[id] = action === 'approve' ? 'approved' : 'hidden';
  else delete approvals[id];
  profilesCache = null;
  changes += 1;
  await saveApprovals();
  console.log(`review ${id}: ${approvals[id] ?? 'cleared'}`);
}

async function saveApprovals() {
  const tmp = join(DATA, `.approvals.${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, JSON.stringify(approvals, null, 2));
  await rename(tmp, APPROVALS());
}

/** Remove some of a submission's files: from this box and from R2. */
async function removeFiles(r, kinds) {
  for (const kind of kinds) {
    const f = r.files[kind];
    if (!f) continue;
    if (f.file) await rm(join(KINDS[kind]?.dir ?? FILES, f.file), { force: true });
    if (f.uploadId) await r2?.abortMultipart(f.key, f.uploadId).catch(() => {});
    if (f.key) await r2?.delete(f.key).catch((e) => console.error(`remove ${r.id} ${kind}: R2`, e.message));
    delete r.files[kind];
  }
  await save(r);
}

/** Delete a submission entirely: its files here and in R2, its record, its decision. */
async function forget(r) {
  await removeFiles(r, Object.keys(r.files ?? {}));
  await rm(join(DATA, `${r.id}.json`), { force: true });
  records.delete(r.id);
  if (approvals[r.id]) {
    delete approvals[r.id];
    await saveApprovals();
  }
  profilesCache = null;
  changes += 1;
  console.log(`forgot ${r.id}`);
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
    // Every name this person's files would take, so "Jane Citizen 2" (a second
    // Jane) never collides with Jane's second image.
    const take = (base) => Object.entries(p.files).map(([kind, f]) => [kind, `${base}${KINDS[kind]?.suffix ?? ''}.${f.ext}`]);
    let names = take(fileSafe(p.name));
    for (let n = 2; names.some(([, x]) => used.has(x.toLowerCase())); n++) names = take(`${fileSafe(p.name)} (${n})`);
    const out = {};
    for (const [kind, x] of names) {
      used.add(x.toLowerCase());
      out[kind] = p.files[kind].problem ? null : x;
    }
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
  const status = new Map(profiles().map((p) => [p.latest.id, p.status]));
  const declined = (p) => p.exhibit === false && !p.listed;
  const file = (p, out, kind, folder) => (declined(p) ? '' : out[kind] ? `${folder}/${out[kind]}` : `${KINDS[kind].label} ${p.files[kind]?.problem ?? 'missing'}`);
  const rows = people.map(({ p, out }) => [
    p.name,
    p.email ?? '',
    p.exhibit === false ? 'No' : 'Yes',
    p.listed ? 'Yes' : 'No',
    p.degree ?? '',
    p.linkedin ?? '',
    p.instagram ?? '',
    p.website ?? '',
    p.from ?? '',
    p.title ?? '',
    p.overview ?? '',
    file(p, out, 'photo', 'photos'),
    p.files.poster ? file(p, out, 'poster', 'images') : '',
    p.files.poster2 ? file(p, out, 'poster2', 'images') : '',
    p.files.poster3 ? file(p, out, 'poster3', 'images') : '',
    mb(IMAGES.reduce((n, k) => n + (p.files[k]?.storedSize ?? 0), 0)),
    STATUS_WORD[status.get(p.id)] ?? '',
    adelaideTime(p.completedAt ?? p.submittedAt),
  ]);
  const sheet = await workbook(
    ['Full name', 'Personal email', 'Exhibiting', 'Asked for directory', 'Degree', 'LinkedIn', 'Instagram', 'Website', 'Where from', 'Project title', 'Project overview', 'Headshot', 'Image 1', 'Image 2', 'Image 3', 'Images size', 'Directory', 'Submitted'],
    [28, 32, 11, 12, 34, 40, 36, 36, 24, 36, 80, 34, 34, 34, 34, 12, 18, 20],
    rows,
    [10],
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

/** Every project image, renamed after its person (Jane Citizen.png, Jane Citizen 2.png). Tens of GB; ZIP64 past 4 GB. */
async function exportImages(res) {
  const people = named(latestStored());
  zipHeaders(res, 'images');
  const zip = new ZipStream(res);
  for (const { p, out } of people) {
    for (const kind of IMAGES) {
      const f = p.files[kind];
      if (out[kind]) await zip.addFile(`images/${out[kind]}`, join(KINDS[kind].dir, f.file), f.storedSize, f.crc);
    }
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
    exhibiting: people.filter((p) => p.exhibit !== false).length,
    declinedBoth: people.filter((p) => p.exhibit === false && !p.listed).length,
    submissions: count,
    queue: { waiting: waiting.length, waitingMB: Math.round(waitingBytes / MB), transferring: transfer.running },
    lastTransferError: transfer.lastError ? { at: transfer.lastErrorAt, error: transfer.lastError } : null,
    flagged: people.flatMap((p) => Object.entries(p.files).filter(([, f]) => f.problem).map(([k, f]) => `${p.name}: ${k} ${f.problem}`)),
    names: people.map((p) => p.name),
    directory: Object.fromEntries(['live', 'waiting', 'hidden', 'private'].map((s) => [s, profiles().filter((p) => p.status === s).length])),
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
  if (req.method === 'GET') {
    return void publicGet(req, res, path).catch((e) => {
      console.error(`${path} failed`, e.message);
      if (!res.headersSent) json(res, 500, { error: 'failed' });
      else res.destroy();
    });
  }
  if (req.method === 'POST' && path === '/ping') return ping(req, res);
  const handler = req.method === 'POST' && { '/start': start, '/complete': complete }[path];
  if (!handler) return res.writeHead(404).end();
  handler(req, res).catch((e) => {
    if (e.status === 413 || e.status === 400) return json(res, e.status, { error: 'The form could not be read. Please try again.' });
    console.error(`${path} failed`, e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
  });
});

/** POST /ping: "<id> <page> <activity>", a tab's heartbeat. Always 204. */
function ping(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    body += c;
    if (body.length > 100) req.destroy();
  });
  req.on('end', () => {
    res.writeHead(204, { 'cache-control': 'no-store' }).end();
    minuteTick();
    const who = fingerprint(req);
    const spent = pingBudget.get(who) ?? 0;
    if (spent >= PING_PER_MINUTE) return;
    if (pingBudget.size < 50_000) pingBudget.set(who, spent + 1);
    const m = /^([A-Za-z0-9_-]{8,40}) ([a-z]{2,12}) ([a-z]{2,12})$/.exec(body.trim());
    if (!m) return;
    const page = PAGES.has(m[2]) ? m[2] : 'other';
    if (m[3] === 'gone') return void presence.delete(m[1]);
    if (!ACTIVITIES.has(m[3])) return;
    if (!presence.has(m[1]) && presence.size >= PRESENCE_MAX) {
      const now = Date.now();
      for (const [k, v] of presence) if (now - v.at > PRESENCE_MS) presence.delete(k);
      if (presence.size >= PRESENCE_MAX) return;
    }
    presence.set(m[1], { page, activity: m[3], at: Date.now() });
  });
}

const ADMIN = { '/export': (res) => exportMain(res), '/export/posters': (res) => exportImages(res), '/status': async (res) => json(res, 200, statusReport()), '/review': (res) => reviewPage(res) };

/** The admin route for a request, or null. Review media and decisions carry an id in the path. */
function adminRoute(req, path) {
  if (req.method === 'GET' && ADMIN[path]) return (res) => ADMIN[path](res);
  const media = req.method === 'GET' && new RegExp(`^/review/media/([0-9a-f-]{1,64})/(${SHOWN})$`).exec(path);
  if (media) return (res) => reviewMedia(res, media[1], media[2]);
  const act = req.method === 'POST' && /^\/review\/([0-9a-f-]{1,64})\/(approve|hide)$/.exec(path);
  if (act) return (res) => decide(req, res, act[1], act[2]);
  return null;
}

const adminServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
  const route = KEY && adminRoute(req, path);
  if (!route) return res.writeHead(404).end();
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
  route(res).catch((e) => {
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
every(60 * 1000, async () => {
  const now = Date.now();
  for (const [k, v] of presence) if (now - v.at > PRESENCE_MS) presence.delete(k);
}, 'presence');

if (process.env.CONSOLE_PORT && process.env.CONSOLE_EMAILS) {
  await startConsole(
    {
      DATA, records, all, save, profiles, latestStored, usable, statusReport, KINDS, IMAGES, WEB_OF, LIMITS, MAX_WORDS,
      approvals: () => approvals, decide: setDecision, removeFiles, forget, sendFile, exportMain, exportImages, fileSafe,
      fingerprint, mask, presence, PRESENCE_MS, activity, recent: () => events.slice().reverse(), version: () => changes,
      USAGE_URL: process.env.USAGE_URL ?? 'http://usage:9090/usage',
      check: { email: emailAddress, linkedin: linkedinUrl, instagram: instagramUrl, website: websiteUrl, line: oneLine, text: clean },
    },
    {
      port: Number(process.env.CONSOLE_PORT),
      emails: process.env.CONSOLE_EMAILS.split(','),
      origin: process.env.CONSOLE_ORIGIN ?? 'https://admin.stitchexhibition.com',
      mailFrom: process.env.CONSOLE_MAIL_FROM ?? '',
      resendKey: process.env.RESEND_API_KEY ?? '',
      logCodes: process.env.DEV_LOG_CODES === '1',
    },
  );
}
formServer.listen(FORM_PORT, '0.0.0.0', () => console.log(`form on :${FORM_PORT} (/start, /complete)${r2 ? '' : ' — no R2: uploads off'}`));
adminServer.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`admin on :${ADMIN_PORT}${KEY ? '' : ' (no SUBMISSIONS_KEY: export off)'}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    formServer.close();
    adminServer.close();
    process.exit(0);
  });
}
