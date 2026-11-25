/**
 * STITCH exhibition submissions and the graduate catalogue.
 *
 * Each graduate fills in the form on the Links page: full name, degree, an optional
 * LinkedIn and "where you're from", a short project overview, the headshot
 * they picked from the portrait gallery, and optionally one project file (an
 * image or a PDF). They also choose whether their profile may appear on the
 * site's Student Directory. "Where you're from" is kept for the committee and
 * never published.
 *
 * Nothing reaches the Student Directory until the committee approves it on the
 * review page, and only if the graduate said yes. If someone submits again,
 * their latest submission is the one that counts; while it waits for
 * approval, their last approved profile stays up. Saying no takes them off.
 *
 * The committee downloads everything as one zip: `submissions.xlsx` (one row
 * per person), `photos/<Full Name>.<ext>` and `projects/<Full Name> - project.<ext>`.
 *
 * Two servers, two ports, the same split as the usage counters:
 *   FORM_PORT   POST /submit, GET /graduates.json, GET /media/<file>   public
 *   ADMIN_PORT  GET /export, /status, /review, /review/media/<file>,
 *               POST /review/<id>/(approve|hide)    behind SUBMISSIONS_KEY
 * With no key set, the admin side answers 404.
 *
 * Node builtins only: no package.json, no node_modules.
 */

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const FORM_PORT = Number(process.env.FORM_PORT ?? 8081);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 9091);
const DATA = process.env.DATA_DIR ?? '/data';
const KEY = process.env.SUBMISSIONS_KEY ?? '';
const APPROVALS = join(DATA, 'approvals.state');

/** Pixieset full-resolution downloads are a few MB; leave room for a phone photo. */
const MAX_PHOTO = 20 * 1024 * 1024;
/** A project board exported at print quality, or a PDF. */
const MAX_PROJECT = 30 * 1024 * 1024;
/** Web copies made in the browser before upload. */
const MAX_WEB = 6 * 1024 * 1024;
const MAX_BODY = MAX_PHOTO + MAX_PROJECT + 2 * MAX_WEB + 64 * 1024;
/** A ceiling on the volume, so a flood cannot fill the box's disk. */
const MAX_TOTAL = 12 * 1024 * 1024 * 1024;
/** Submissions one address may make in an hour. */
const PER_HOUR = 10;

const LIMITS = { name: 120, degree: 120, from: 120, linkedin: 300, overview: 1500 };
/** The project overview is a short paragraph, not an essay. */
const MAX_WORDS = 150;

const salt = randomBytes(32);
const budget = new Map();
let budgetSince = Date.now();
let totalBytes = 0;

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

/** jane-citizen: the profile's address on the Student Directory. */
const slugOf = (name) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'graduate';

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
function fileType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };
/** What a browser can show without help. HEIC is kept for the committee but never served. */
const SHOWABLE = new Set(['jpg', 'png', 'webp', 'pdf']);

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

function allowed(req) {
  const now = Date.now();
  if (now - budgetSince > 60 * 60 * 1000) {
    budget.clear();
    budgetSince = now;
  }
  const id = createHmac('sha256', salt).update(address(req)).digest('base64url').slice(0, 16);
  const spent = budget.get(id) ?? 0;
  if (spent >= PER_HOUR) return false;
  if (budget.size < 50_000) budget.set(id, spent + 1);
  return true;
}

function json(res, status, body, cache = 'no-store') {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': cache });
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

async function writeAtomic(path, data) {
  const tmp = join(DATA, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ---------------------------------------------------------------- storage

async function records() {
  const out = [];
  for (const f of await readdir(DATA)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      out.push(JSON.parse(await readFile(join(DATA, f), 'utf8')));
    } catch {
      /* a half-written file from a crash: skip it */
    }
  }
  out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return out;
}

/** id -> 'approved' | 'hidden'. Missing means waiting for review. */
async function approvals() {
  try {
    return JSON.parse(await readFile(APPROVALS, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Everyone, once: their latest submission, and what the Student Directory shows
 * for them (their latest approved, public submission, unless their latest says
 * no, or the committee hid it).
 */
async function people() {
  const marks = await approvals();
  const byName = new Map();
  let all = 0;
  for (const r of await records()) {
    all += 1;
    const k = nameKey(r.name);
    const p = byName.get(k) ?? { history: [] };
    p.history.push(r);
    p.latest = r;
    byName.set(k, p);
  }
  const list = [...byName.values()].sort((a, b) => a.latest.name.localeCompare(b.latest.name, 'en-AU'));
  for (const p of list) {
    p.status = !p.latest.public ? 'private' : marks[p.latest.id] === 'approved' ? 'live' : marks[p.latest.id] === 'hidden' ? 'hidden' : 'pending';
    p.shown = null;
    if (p.latest.public && marks[p.latest.id] !== 'hidden') {
      for (let i = p.history.length - 1; i >= 0; i--) {
        const r = p.history[i];
        if (r.public && marks[r.id] === 'approved') {
          p.shown = r;
          break;
        }
      }
    }
  }
  return { list, all, marks };
}

async function measure() {
  let n = 0;
  for (const f of await readdir(DATA)) n += (await stat(join(DATA, f))).size;
  totalBytes = n;
}

const stored = (id, tag, ext, bytes) => ({ file: `${id}${tag}.${ext}`, ext, size: bytes.length, crc: crc32(bytes) });

// ---------------------------------------------------------------- submit

async function submit(req, res) {
  if (!allowed(req)) return json(res, 429, { error: 'Too many submissions from here. Try again in an hour.' });
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('multipart/form-data')) return json(res, 415, { error: 'Expected a form.' });

  let form;
  try {
    const body = await readBody(req, MAX_BODY);
    form = await new Request('http://form/', { method: 'POST', headers: { 'content-type': type }, body }).formData();
  } catch (e) {
    if (e.status === 413) return json(res, 413, { error: 'Those files are too big together. The limits are 20 MB for the photo and 30 MB for the project.' });
    return json(res, 400, { error: 'The form could not be read. Please try again.' });
  }

  // Bots fill every field; people never see this one.
  if (oneLine(form.get('website'), 200)) return json(res, 200, { ok: true });

  const name = oneLine(form.get('name'), LIMITS.name);
  const from = oneLine(form.get('from'), LIMITS.from);
  const picked = oneLine(form.get('degree'), LIMITS.degree);
  const degree = picked === 'other' ? oneLine(form.get('degree_other'), LIMITS.degree) : picked;
  const overview = clean(form.get('overview'), LIMITS.overview);
  const linkedin = linkedinUrl(form.get('linkedin'));
  const isPublic = ['yes', 'on', 'true'].includes(String(form.get('public') ?? '').toLowerCase());
  const photo = form.get('photo');
  const project = form.get('project');
  const isFile = (f) => f && typeof f !== 'string' && f.size > 0;

  const problems = {};
  if (name.split(' ').filter(Boolean).length < 2) problems.name = 'Please give your full name, first and last.';
  if (!degree) problems.degree = picked === 'other' ? 'Please write your degree.' : 'Please choose your degree.';
  if (linkedin === null) problems.linkedin = 'That does not look like a LinkedIn link.';
  if (overview.length < 20) problems.overview = 'Please write a short overview of your project.';
  else if (overview.split(/\s+/).filter(Boolean).length > MAX_WORDS) problems.overview = `Please keep it to ${MAX_WORDS} words or fewer.`;
  if (!isFile(photo)) problems.photo = 'Please attach your headshot.';
  else if (photo.size > MAX_PHOTO) problems.photo = 'That photo is too big. The limit is 20 MB.';
  if (isFile(project) && project.size > MAX_PROJECT) problems.project = 'That file is too big. The limit is 30 MB.';
  if (Object.keys(problems).length) return json(res, 422, { error: 'Some fields need another look.', fields: problems });

  const photoBytes = Buffer.from(await photo.arrayBuffer());
  const photoExt = fileType(photoBytes);
  if (!photoExt || photoExt === 'pdf') return json(res, 422, { error: 'Some fields need another look.', fields: { photo: 'Please upload a JPG, PNG, WebP or HEIC photo.' } });

  let projectBytes = null;
  let projectExt = null;
  if (isFile(project)) {
    projectBytes = Buffer.from(await project.arrayBuffer());
    projectExt = fileType(projectBytes);
    if (!projectExt) return json(res, 422, { error: 'Some fields need another look.', fields: { project: 'Please upload a JPG, PNG or PDF.' } });
  }

  /** A browser-made web copy is only kept if it really is a small JPEG. */
  const webCopy = async (field) => {
    const f = form.get(field);
    if (!isFile(f) || f.size > MAX_WEB) return null;
    const b = Buffer.from(await f.arrayBuffer());
    return fileType(b) === 'jpg' ? b : null;
  };
  const photoWeb = await webCopy('photo_web');
  const projectWeb = projectExt && projectExt !== 'pdf' ? await webCopy('project_web') : null;

  const incoming = photoBytes.length + (projectBytes?.length ?? 0) + (photoWeb?.length ?? 0) + (projectWeb?.length ?? 0);
  if (totalBytes + incoming > MAX_TOTAL) return json(res, 507, { error: 'Submissions are full. Please contact the committee.' });

  const submittedAt = new Date().toISOString();
  const id = `${submittedAt.replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const record = {
    id,
    submittedAt,
    name,
    degree,
    linkedin: linkedin ?? '',
    from,
    overview,
    public: isPublic,
    photo: { ...stored(id, '', photoExt, photoBytes), originalName: oneLine(photo.name, 200) },
    photoWeb: photoWeb ? stored(id, '.web', 'jpg', photoWeb) : null,
    project: projectBytes ? { ...stored(id, '.project', projectExt, projectBytes), originalName: oneLine(project.name, 200) } : null,
    projectWeb: projectWeb ? stored(id, '.project.web', 'jpg', projectWeb) : null,
  };

  // Files first, record last: a record on disk always has its files.
  await writeAtomic(join(DATA, record.photo.file), photoBytes);
  if (photoWeb) await writeAtomic(join(DATA, record.photoWeb.file), photoWeb);
  if (projectBytes) await writeAtomic(join(DATA, record.project.file), projectBytes);
  if (projectWeb) await writeAtomic(join(DATA, record.projectWeb.file), projectWeb);
  await writeAtomic(join(DATA, `${id}.json`), JSON.stringify(record, null, 2));
  totalBytes += incoming;

  console.log(`submission ${id} (${incoming} bytes${isPublic ? ', public' : ''})`);
  return json(res, 200, { ok: true, photoName: `${fileSafe(name)}.${photoExt}`, public: isPublic });
}

// ---------------------------------------------------------------- catalogue

/** The file a visitor gets: the web copy when there is one and the original is not showable or is large. */
function servable(original, web) {
  if (!original) return null;
  if (web) return web;
  return SHOWABLE.has(original.ext) ? original : null;
}

async function catalogue() {
  const { list } = await people();
  const used = new Set();
  const out = [];
  for (const p of list) {
    const r = p.shown;
    if (!r) continue;
    const photo = servable(r.photo, r.photoWeb);
    if (!photo) continue;
    let slug = slugOf(r.name);
    for (let n = 2; used.has(slug); n++) slug = `${slugOf(r.name)}-${n}`;
    used.add(slug);
    const proj = r.project ? (r.project.ext === 'pdf' ? r.project : servable(r.project, r.projectWeb)) : null;
    out.push({
      slug,
      name: r.name,
      degree: r.degree ?? '',
      linkedin: r.linkedin,
      overview: r.overview,
      photo: `/_s/media/${photo.file}`,
      project: proj
        ? {
            kind: proj.ext === 'pdf' ? 'pdf' : 'image',
            url: `/_s/media/${proj.file}`,
            full: r.project.ext !== 'pdf' && SHOWABLE.has(r.project.ext) ? `/_s/media/${r.project.file}` : null,
          }
        : null,
    });
  }
  return out;
}

/** Files a visitor may fetch: only those of profiles on the Student Directory. */
async function publicFiles() {
  const { list } = await people();
  const ok = new Map();
  for (const p of list) {
    const r = p.shown;
    if (!r) continue;
    for (const f of [r.photoWeb, SHOWABLE.has(r.photo.ext) ? r.photo : null, r.project && SHOWABLE.has(r.project.ext) ? r.project : null, r.projectWeb]) {
      if (f) ok.set(f.file, { f, name: r.name });
    }
  }
  return ok;
}

const SAFE_FILE = /^[0-9a-f-]+(?:\.project)?(?:\.web)?\.(?:jpg|png|webp|heic|pdf)$/;

async function sendMedia(res, entry, cache) {
  const { f, name } = entry;
  const headers = {
    'content-type': MIME[f.ext],
    'content-length': f.size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  };
  if (f.ext === 'pdf') headers['content-disposition'] = `inline; filename="${fileSafe(name).replace(/[^\x20-\x7e]/g, '_')} - project.pdf"`;
  res.writeHead(200, headers);
  createReadStream(join(DATA, f.file)).pipe(res);
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
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** A one-sheet workbook. Strings are inline, so no shared-strings part is needed. */
function workbook(rows) {
  const head = ['Full name', 'Degree', 'LinkedIn', 'Where from', 'Project overview', 'Photo file', 'Project file', 'On website?', 'Website status', 'Submitted'];
  const widths = [28, 34, 40, 22, 80, 32, 40, 12, 16, 20];
  const all = [head, ...rows];
  const sheetRows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : ci === 4 ? ' s="2"' : '';
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
 * photos and projects are streamed from disk as stored entries, using the size
 * and CRC kept at submit time, so memory stays flat however many have submitted.
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

const STATUS_WORD = { live: 'Live', pending: 'Waiting for review', hidden: 'Hidden', private: 'Not on website' };

async function exportZip(res) {
  const { list } = await people();
  const used = new Set();
  const unique = (base, ext) => {
    let b = base;
    for (let n = 2; used.has(`${b}.${ext}`.toLowerCase()); n++) b = `${base} ${n}`;
    used.add(`${b}.${ext}`.toLowerCase());
    return `${b}.${ext}`;
  };
  const rows = [];
  const files = [];
  for (const p of list) {
    const r = p.latest;
    const photoFile = unique(fileSafe(r.name), r.photo.ext);
    files.push([`photos/${photoFile}`, r.photo]);
    let projectFile = '';
    if (r.project) {
      projectFile = unique(`${fileSafe(r.name)} - project`, r.project.ext);
      files.push([`projects/${projectFile}`, r.project]);
    }
    rows.push([r.name, r.degree ?? '', r.linkedin, r.from, r.overview, photoFile, projectFile, r.public ? 'Yes' : 'No', STATUS_WORD[p.status], adelaideTime(r.submittedAt)]);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="stitch-submissions-${stamp}.zip"`,
    'cache-control': 'no-store',
  });
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
  const zip = new ZipStream(res);
  await zip.addBuffer('submissions.xlsx', inner);
  for (const [name, f] of files) await zip.addFile(name, join(DATA, f.file), f.size, f.crc);
  await zip.finish();
}

// ---------------------------------------------------------------- review page

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function reviewPage(res) {
  const { list, all } = await people();
  const order = { pending: 0, live: 1, hidden: 2, private: 3 };
  const sorted = [...list].sort((a, b) => order[a.status] - order[b.status] || a.latest.name.localeCompare(b.latest.name, 'en-AU'));
  const counts = { pending: 0, live: 0, hidden: 0, private: 0 };
  for (const p of list) counts[p.status] += 1;
  const media = (f) => (f ? `/_s/review/media/${f.file}` : '');
  const cards = sorted
    .map((p) => {
      const r = p.latest;
      const thumb = media(r.photoWeb ?? (SHOWABLE.has(r.photo.ext) ? r.photo : null));
      const proj = r.project
        ? `<a href="${media(r.project.ext === 'pdf' || !r.projectWeb ? r.project : r.projectWeb)}" target="_blank" rel="noopener">View project (${r.project.ext.toUpperCase()})</a>`
        : '<span class="muted">No project file</span>';
      const note = p.status === 'pending' && p.shown && p.shown.id !== r.id ? '<p class="note">Updated. Their earlier approved profile stays up until you approve this one.</p>' : '';
      const actions =
        p.status === 'private'
          ? '<p class="muted">They chose not to appear on the website.</p>'
          : `<form method="post" action="/_s/review/${esc(r.id)}/approve"><button ${p.status === 'live' ? 'disabled' : ''}>Approve</button></form>
             <form method="post" action="/_s/review/${esc(r.id)}/hide"><button class="ghost" ${p.status === 'hidden' ? 'disabled' : ''}>Hide</button></form>`;
      return `<article class="card ${p.status}">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<div class="noimg">HEIC photo</div>'}
        <div class="body">
          <p class="status">${STATUS_WORD[p.status]}</p>
          <h2>${esc(r.name)}</h2>
          <p class="meta">${esc(r.degree || 'No degree given')}</p>
          <p class="meta">${esc(r.from || 'No place given')}${r.linkedin ? ` · <a href="${esc(r.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</p>
          <p class="ov">${esc(r.overview)}</p>
          <p>${proj}</p>
          ${note}
          <div class="actions">${actions}</div>
        </div>
      </article>`;
    })
    .join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>STITCH - Review student directory</title>
<style>
:root{--ink:#111;--red:#C82B29;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:14px/1.5 var(--mono)}
header{padding:28px 24px 8px}h1{margin:0 0 6px;font-size:15px;letter-spacing:.08em;text-transform:uppercase}
.sum{margin:0;color:#666}.sum b{color:var(--ink);font-weight:500}.links{margin:8px 0 0}.links a{color:var(--red)}
main{padding:16px 24px 60px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{border:1px solid #ddd;display:grid;grid-template-columns:110px 1fr;gap:14px;padding:14px}
.card.pending{border-color:var(--red)}.card.private,.card.hidden{opacity:.6}
.card img,.noimg{width:110px;aspect-ratio:4/5;object-fit:cover;background:#f2f2f2;display:grid;place-items:center;font-size:11px;color:#888}
h2{margin:0;font-size:15px;font-weight:500;text-transform:uppercase;letter-spacing:.03em}
.status{margin:0 0 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--red)}
.live .status{color:#2a7a2a}.meta{margin:4px 0;color:#666}.ov{margin:8px 0;white-space:pre-wrap}
a{color:var(--ink)}.muted{color:#888}.note{font-size:12px;color:var(--red)}
.actions{display:flex;gap:8px;margin-top:10px}.actions form{margin:0}
button{font:inherit;text-transform:uppercase;letter-spacing:.03em;border:0;border-radius:0;padding:.3em .7em;background:var(--red);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);outline:1px solid var(--ink)}button[disabled]{opacity:.35;cursor:default}
.empty{color:#888}
</style></head><body>
<header><h1>STITCH student directory: review</h1>
<p class="sum"><b>${counts.pending}</b> waiting · <b>${counts.live}</b> live · <b>${counts.hidden}</b> hidden · <b>${counts.private}</b> not on website · ${all} submissions in all</p>
<p class="links"><a href="/_s/export">Download everything (zip)</a> · <a href="/#directory" target="_blank" rel="noopener">Open the Student Directory</a></p></header>
<main>${cards || '<p class="empty">No submissions yet.</p>'}</main>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(html);
}

async function mark(req, res, id, action) {
  const { list } = await people();
  const known = list.some((p) => p.history.some((r) => r.id === id));
  if (!known) return json(res, 404, { error: 'unknown' });
  const marks = await approvals();
  marks[id] = action === 'approve' ? 'approved' : 'hidden';
  await writeAtomic(APPROVALS, JSON.stringify(marks, null, 2));
  console.log(`review ${id}: ${marks[id]}`);
  res.writeHead(303, { location: '/_s/review', 'cache-control': 'no-store' }).end();
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

const fail = (res, what) => (e) => {
  console.error(`${what} failed`, e);
  if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
  else res.destroy();
};

const formServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'POST' && path === '/submit') return void submit(req, res).catch(fail(res, 'submit'));
  if (req.method === 'GET' && path === '/graduates.json') {
    return void catalogue()
      .then((g) => json(res, 200, { graduates: g }, 'public, max-age=60'))
      .catch(fail(res, 'catalogue'));
  }
  const m = req.method === 'GET' && /^\/media\/([^/]+)$/.exec(path);
  if (m && SAFE_FILE.test(m[1])) {
    return void publicFiles()
      .then((ok) => (ok.has(m[1]) ? sendMedia(res, ok.get(m[1]), 'public, max-age=86400') : res.writeHead(404).end()))
      .catch(fail(res, 'media'));
  }
  res.writeHead(404).end();
});

const adminServer = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
  if (!KEY) return void res.writeHead(404).end();
  if (!authorised(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="STITCH submissions", charset="UTF-8"', 'cache-control': 'no-store' }).end();
    return;
  }
  if (req.method === 'GET' && path === '/export') return void exportZip(res).catch(fail(res, 'export'));
  if (req.method === 'GET' && path === '/status') {
    return void people()
      .then(({ list, all }) =>
        json(res, 200, {
          people: list.length,
          submissions: all,
          live: list.filter((p) => p.shown).length,
          waiting: list.filter((p) => p.status === 'pending').length,
          names: list.map((p) => p.latest.name),
        }),
      )
      .catch(fail(res, 'status'));
  }
  if (req.method === 'GET' && path === '/review') return void reviewPage(res).catch(fail(res, 'review'));
  const media = req.method === 'GET' && /^\/review\/media\/([^/]+)$/.exec(path);
  if (media && SAFE_FILE.test(media[1])) {
    return void records()
      .then((all) => {
        for (const r of all)
          for (const f of [r.photo, r.photoWeb, r.project, r.projectWeb])
            if (f && f.file === media[1] && SHOWABLE.has(f.ext)) return sendMedia(res, { f, name: r.name }, 'private, no-store');
        res.writeHead(404).end();
      })
      .catch(fail(res, 'review media'));
  }
  const act = req.method === 'POST' && /^\/review\/([0-9a-f-]+)\/(approve|hide)$/.exec(path);
  if (act) return void mark(req, res, act[1], act[2]).catch(fail(res, 'review action'));
  res.writeHead(404).end();
});

await mkdir(DATA, { recursive: true });
await measure();
formServer.requestTimeout = 5 * 60 * 1000;
formServer.listen(FORM_PORT, '0.0.0.0', () => console.log(`form on :${FORM_PORT}`));
adminServer.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`admin on :${ADMIN_PORT}${KEY ? '' : ' (no SUBMISSIONS_KEY: admin off)'}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    formServer.close();
    adminServer.close();
    process.exit(0);
  });
}
