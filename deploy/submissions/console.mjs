/**
 * The STITCH admin console, at admin.stitchexhibition.com.
 *
 * Sign-in is a one-time code sent by email, to a short allowlist only
 * (CONSOLE_EMAILS). An address not on it is answered exactly like one that is,
 * and no email is sent, so the page does not reveal who may sign in. A code is
 * six digits, lives ten minutes, allows five tries, and is held only as a hash.
 * A session is a random token in an HttpOnly, Secure, SameSite=Strict cookie,
 * kept as a hash on the data volume so a redeploy does not sign everyone out,
 * and it lasts twelve hours.
 *
 * Signed in, the console shows who is on the site right now (from the page's
 * heartbeat, see deploy/usage/beacon.js), what the upload pipeline is doing,
 * and every submission, and lets an admin edit a submission's fields, approve
 * or hide it in the Student Directory, remove one of its images, or delete it
 * outright. Every change is written to an audit log on the data volume, with
 * who made it and what it was before. Every request that changes anything
 * must come from the console's own origin and carry a custom header, on top of
 * the SameSite cookie.
 *
 * This module holds no records of its own: everything comes from server.mjs
 * through `ctx`, which owns the records and their saving.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const SESSION_HOURS = 12;
/** Codes one address may be sent in an hour, and sign-in requests one network may make in ten minutes. */
const SENDS_PER_HOUR = 5;
const IP_PER_10_MIN = 20;
const COOKIE = 'stitch_admin';

/** Fields an admin may change, and how each is checked: the same rules as the form. */
const EDITABLE = ['name', 'email', 'exhibit', 'listed', 'degree', 'title', 'overview', 'linkedin', 'instagram', 'website', 'from'];

const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function startConsole(ctx, { port, emails, origin, mailFrom, resendKey, logCodes }) {
  const allowed = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const statics = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/console.js': ['console.js', 'application/javascript; charset=utf-8'],
    '/console.css': ['console.css', 'text/css; charset=utf-8'],
  };
  for (const [path, [file, type]] of Object.entries(statics)) statics[path] = [await readFile(join(HERE, 'console', file)), type];

  // ------------------------------------------------------------ sign-in state
  const codes = new Map(); // email -> { hash, exp, tries }
  const sends = new Map(); // email -> [times]
  const ipBudget = new Map(); // fingerprint -> count, cleared every ten minutes
  setInterval(() => ipBudget.clear(), 10 * 60_000).unref();

  const SESSIONS = join(ctx.DATA, 'console-sessions.state');
  let sessions = {};
  try {
    sessions = JSON.parse(await readFile(SESSIONS, 'utf8'));
  } catch {}
  async function saveSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(sessions)) if (s.exp < now) delete sessions[k];
    const tmp = join(ctx.DATA, `.console-sessions.${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, JSON.stringify(sessions));
    await rename(tmp, SESSIONS);
  }

  function who(req) {
    const m = /(?:^|;\s*)stitch_admin=([A-Za-z0-9_-]{20,100})/.exec(req.headers.cookie ?? '');
    if (!m) return null;
    const s = sessions[sha(m[1])];
    if (!s || s.exp < Date.now()) return null;
    return s.email;
  }

  async function sendCode(email, code) {
    if (!resendKey) {
      if (logCodes) console.log(`console: code for ${email}: ${code} (dev only: no mail key)`);
      else console.error('console: no RESEND_API_KEY, cannot send a sign-in code');
      return;
    }
    const text = `Your code to sign in to the STITCH admin console is ${code}.\n\nIt works for ${CODE_MINUTES} minutes, once. If you did not ask for it, ignore this email.\n\n${origin}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: mailFrom,
        to: [email],
        subject: `STITCH admin code: ${code}`,
        text,
        html: `<p style="font-family:ui-monospace,Menlo,monospace;font-size:15px">Your code to sign in to the STITCH admin console:</p><p style="font-family:ui-monospace,Menlo,monospace;font-size:28px;letter-spacing:.2em;color:#C82B29"><b>${code}</b></p><p style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#666">It works for ${CODE_MINUTES} minutes, once. If you did not ask for it, ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`console: mail to ${ctx.mask(email)} failed (${res.status})`);
    else console.log(`console: mail to ${ctx.mask(email)} accepted by Resend`);
  }

  // ------------------------------------------------------------ helpers
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  function body(req, max = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          reject(Object.assign(new Error('too big'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('bad json'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }
  /** A change must come from the console's own page: same origin and the custom header a form on another site cannot send. */
  function sameSite(req) {
    if (req.headers['x-stitch'] !== '1') return false;
    const o = req.headers.origin;
    return !o || o === origin;
  }
  async function audit(email, action, r, detail) {
    const line = JSON.stringify({ at: new Date().toISOString(), by: email, action, id: r?.id, name: r?.name, ...detail });
    await appendFile(join(ctx.DATA, 'audit.log'), line + '\n');
    ctx.activity('admin', `${email.split('@')[0]}: ${action}${r ? ` ${r.name}` : ''}`);
  }
  async function readAudit(limit = 300) {
    try {
      const lines = (await readFile(join(ctx.DATA, 'audit.log'), 'utf8')).trim().split('\n');
      return lines.slice(-limit).reverse().map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** A submission as the console shows it. No token hash, no storage keys. */
  function view(r, latestIds, statusById) {
    const files = {};
    for (const [k, f] of Object.entries(r.files ?? {})) {
      files[k] = { ext: f.ext, size: f.storedSize ?? f.size, stored: !!f.stored, problem: f.problem ?? null, viewable: ctx.usable(f) };
    }
    return {
      id: r.id, state: r.state, submittedAt: r.submittedAt, completedAt: r.completedAt ?? null,
      name: r.name, email: r.email ?? '', exhibit: r.exhibit !== false, listed: !!r.listed,
      degree: r.degree ?? '', title: r.title ?? '', overview: r.overview ?? '',
      linkedin: r.linkedin ?? '', instagram: r.instagram ?? '', website: r.website ?? '', from: r.from ?? '',
      declined: r.exhibit === false && !r.listed,
      decision: ctx.approvals()[r.id] ?? null,
      latest: latestIds.has(r.id),
      status: statusById.get(r.id) ?? null,
      editedAt: r.editedAt ?? null, editedBy: r.editedBy ?? null,
      files,
    };
  }

  // Site-wide numbers from the usage counters, refreshed at most every 30 s.
  let usage = { at: 0, data: null };
  async function usageNow() {
    if (Date.now() - usage.at < 30_000) return usage.data;
    usage.at = Date.now();
    try {
      const r = await fetch(ctx.USAGE_URL, { signal: AbortSignal.timeout(2000) });
      usage.data = r.ok ? await r.json() : null;
    } catch {
      usage.data = null;
    }
    return usage.data;
  }

  function live() {
    const now = Date.now();
    const p = { total: 0, byPage: {}, form: 0, uploading: 0, submitted: 0 };
    for (const v of ctx.presence.values()) {
      if (now - v.at > ctx.PRESENCE_MS) continue;
      p.total += 1;
      p.byPage[v.page] = (p.byPage[v.page] ?? 0) + 1;
      if (v.activity === 'form') p.form += 1;
      if (v.activity === 'uploading') p.uploading += 1;
      if (v.activity === 'submitted') p.submitted += 1;
    }
    const openUploads = ctx.all().filter((r) => r.state === 'uploading');
    const st = ctx.statusReport();
    return {
      now: new Date(now).toISOString(),
      version: ctx.version(),
      presence: p,
      pipeline: {
        uploading: openUploads.map((r) => ({ name: r.name, since: r.submittedAt, mb: Math.round(Object.values(r.files).reduce((n, f) => n + f.size, 0) / 1048576) })),
        comingDown: st.queue,
        lastTransferError: st.lastTransferError,
      },
      totals: { people: st.people, exhibiting: st.exhibiting, declinedBoth: st.declinedBoth, directory: st.directory, flagged: st.flagged.length },
      activity: ctx.recent(),
    };
  }

  // ------------------------------------------------------------ routes
  async function route(req, res, path) {
    if (req.method === 'GET' && statics[path]) {
      const [buf, type] = statics[path];
      res.writeHead(200, { 'content-type': type, 'cache-control': path === '/' ? 'no-store' : 'no-cache' });
      return res.end(buf);
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && !sameSite(req)) return json(res, 403, { error: 'refused' });

    if (path === '/api/login' && req.method === 'POST') {
      const fp = ctx.fingerprint(req);
      const spent = (ipBudget.get(fp) ?? 0) + 1;
      ipBudget.set(fp, spent);
      if (spent > IP_PER_10_MIN) return json(res, 429, { error: 'Too many tries. Please wait ten minutes.' });
      const email = String((await body(req)).email ?? '').trim().toLowerCase().slice(0, 254);
      if (allowed.has(email)) {
        const recent = (sends.get(email) ?? []).filter((t) => Date.now() - t < 3600_000);
        if (recent.length < SENDS_PER_HOUR) {
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          codes.set(email, { hash: sha(`${email}:${code}`), exp: Date.now() + CODE_MINUTES * 60_000, tries: 0 });
          sends.set(email, [...recent, Date.now()]);
          console.log(`console: code sent to ${ctx.mask(email)}`);
          sendCode(email, code).catch((e) => console.error('console: mail failed', e.message));
        } else console.log(`console: send limit for ${ctx.mask(email)}`);
      } else console.log(`console: sign-in asked for an address not on the list (${ctx.fingerprint(req)})`);
      // The same answer either way.
      return json(res, 200, { ok: true });
    }
    if (path === '/api/verify' && req.method === 'POST') {
      const fp = ctx.fingerprint(req);
      const spent = (ipBudget.get(fp) ?? 0) + 1;
      ipBudget.set(fp, spent);
      if (spent > IP_PER_10_MIN) return json(res, 429, { error: 'Too many tries. Please wait ten minutes.' });
      const b = await body(req);
      const email = String(b.email ?? '').trim().toLowerCase();
      const code = String(b.code ?? '').replace(/\D/g, '');
      const c = codes.get(email);
      const bad = () => json(res, 401, { error: 'That code is not right, or it has expired. Ask for a new one.' });
      if (!c || c.exp < Date.now() || code.length !== 6) return bad();
      c.tries += 1;
      const ok = timingSafeEqual(Buffer.from(c.hash), Buffer.from(sha(`${email}:${code}`)));
      if (!ok) {
        if (c.tries >= CODE_TRIES) codes.delete(email);
        return bad();
      }
      codes.delete(email);
      const token = randomBytes(32).toString('base64url');
      sessions[sha(token)] = { email, exp: Date.now() + SESSION_HOURS * 3600_000, at: new Date().toISOString() };
      await saveSessions();
      console.log(`console: ${ctx.mask(email)} signed in`);
      await audit(email, 'signed in', null, {});
      const secure = origin.startsWith('https:') ? '; Secure' : '';
      return json(res, 200, { ok: true, email }, { 'set-cookie': `${COOKIE}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
    }

    const email = who(req);
    if (path === '/api/me') return json(res, 200, { email });
    if (!email) return json(res, 401, { error: 'Please sign in.' });

    if (path === '/api/logout' && req.method === 'POST') {
      const m = /(?:^|;\s*)stitch_admin=([A-Za-z0-9_-]{20,100})/.exec(req.headers.cookie ?? '');
      if (m) delete sessions[sha(m[1])];
      await saveSessions();
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (path === '/api/live' && req.method === 'GET') return json(res, 200, { ...live(), usage: await usageNow() });
    if (path === '/api/submissions' && req.method === 'GET') {
      const latestIds = new Set(ctx.latestStored().map((r) => r.id));
      const statusById = new Map(ctx.profiles().map((p) => [p.latest.id, p.status]));
      const list = ctx.all().slice().reverse().map((r) => view(r, latestIds, statusById));
      return json(res, 200, { version: ctx.version(), submissions: list });
    }
    if (path === '/api/audit' && req.method === 'GET') return json(res, 200, { entries: await readAudit() });
    if (path === '/api/export' && req.method === 'GET') return ctx.exportMain(res);
    if (path === '/api/export/images' && req.method === 'GET') return ctx.exportImages(res);

    const media = /^\/api\/media\/([0-9a-f-]{1,64})\/([a-zA-Z0-9]{1,16})$/.exec(path);
    if (media && req.method === 'GET') {
      const r = ctx.records.get(media[1]);
      const f = r?.files?.[media[2]];
      if (!r || !ctx.KINDS[media[2]] || !ctx.usable(f)) return json(res, 404, { error: 'not found' });
      const original = ctx.IMAGES.includes(media[2]);
      const name = `${ctx.fileSafe(r.name)}${ctx.KINDS[media[2]].suffix ?? ''}.${f.ext}`.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      return ctx.sendFile(res, media[2], f, 'private, no-store', original ? `attachment; filename="${name}"` : undefined);
    }

    const one = /^\/api\/submissions\/([0-9a-f-]{1,64})(?:\/(approve|hide|clear)|\/files\/([a-zA-Z0-9]{1,16}))?$/.exec(path);
    if (one) {
      const r = ctx.records.get(one[1]);
      if (!r) return json(res, 404, { error: 'That submission is gone.' });

      if (one[2] && req.method === 'POST') {
        if (r.state !== 'stored') return json(res, 409, { error: 'Only a stored submission can be approved or hidden.' });
        const before = ctx.approvals()[r.id] ?? null;
        await ctx.decide(r.id, one[2] === 'clear' ? null : one[2]);
        await audit(email, one[2] === 'approve' ? 'approved' : one[2] === 'hide' ? 'hid' : 'reset review of', r, { before });
        return json(res, 200, { ok: true });
      }

      if (one[3] && req.method === 'DELETE') {
        const kind = one[3];
        if (!ctx.IMAGES.includes(kind) || !r.files[kind]) return json(res, 404, { error: 'No such image.' });
        await ctx.removeFiles(r, [kind, ctx.WEB_OF[kind]]);
        await audit(email, `removed ${ctx.KINDS[kind].label} from`, r, {});
        return json(res, 200, { ok: true });
      }

      if (!one[2] && !one[3] && req.method === 'PATCH') {
        const b = await body(req);
        const before = {};
        const after = {};
        const problems = {};
        for (const key of EDITABLE) {
          if (!(key in b)) continue;
          let v = b[key];
          if (key === 'exhibit' || key === 'listed') {
            if (typeof v !== 'boolean') { problems[key] = 'Yes or no.'; continue; }
          } else if (key === 'email') {
            v = ctx.check.email(v);
            if (!v) { problems.email = 'That does not look like an email address.'; continue; }
          } else if (key === 'linkedin' || key === 'instagram' || key === 'website') {
            v = ctx.check[key](v);
            if (v === null) { problems[key] = 'That does not look like a valid link.'; continue; }
          } else if (key === 'overview') {
            v = ctx.check.text(v, ctx.LIMITS.overview);
            if (v.split(/\s+/).filter(Boolean).length > ctx.MAX_WORDS) { problems.overview = `Keep it to ${ctx.MAX_WORDS} words.`; continue; }
          } else {
            v = ctx.check.line(v, ctx.LIMITS[key] ?? 150);
            if (key === 'name' && v.split(' ').filter(Boolean).length < 2) { problems.name = 'A first and last name.'; continue; }
          }
          const old = key === 'exhibit' ? r.exhibit !== false : key === 'listed' ? !!r.listed : (r[key] ?? '');
          if (old !== v) {
            before[key] = old;
            after[key] = v;
          }
        }
        if (Object.keys(problems).length) return json(res, 422, { error: 'Some fields need another look.', fields: problems });
        if (!Object.keys(after).length) return json(res, 200, { ok: true, changed: [] });
        Object.assign(r, after, { editedAt: new Date().toISOString(), editedBy: email });
        await ctx.save(r);
        await audit(email, 'edited', r, { before, after });
        return json(res, 200, { ok: true, changed: Object.keys(after) });
      }

      if (!one[2] && !one[3] && req.method === 'DELETE') {
        if (String((await body(req)).confirm ?? '') !== r.name) return json(res, 422, { error: 'Type the name exactly to delete.' });
        await ctx.forget(r);
        await audit(email, 'deleted', r, { email: r.email ?? '', state: r.state });
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    route(req, res, path).catch((e) => {
      if (e.status === 413 || e.status === 400) return json(res, e.status, { error: 'That request could not be read.' });
      console.error(`console ${path} failed`, e);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    });
  });
  server.listen(port, '0.0.0.0', () => console.log(`console on :${port} for ${allowed.size} addresses${resendKey ? '' : ' (no mail key)'}`));
  return server;
}

