/**
 * STITCH usage counters.
 *
 * The page is static, so nginx cannot say what people did on it. The page
 * sends a one-word beacon instead (`/_u.js`, injected by nginx), nginx hands
 * it to this process, and this process counts it. The host metrics collector
 * reads the counts on a loopback port and keeps the durable totals: every
 * deploy restarts this process, so nothing here is meant to last.
 *
 * Two servers, two ports. Beacons arrive on EVENT_PORT, which only nginx can
 * reach over the compose network. The counts are served on USAGE_PORT, which
 * compose publishes on 127.0.0.1 only. A visitor can add to a count but can
 * never read one.
 *
 * Nothing is written to disk and no address is kept. A device is an HMAC of
 * its address under a salt made at boot and never recorded, so the set cannot
 * be reversed, cannot be matched against yesterday's, and dies with the
 * process. Node builtins only: there is no package.json and no node_modules.
 */

import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

const EVENT_PORT = Number(process.env.EVENT_PORT ?? 8080);
const USAGE_PORT = Number(process.env.USAGE_PORT ?? 9090);

const DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A ceiling on the device sets, so a flood cannot grow them without bound. */
const MAX_DEVICES = 50_000;
/** A ceiling on distinct event names, for the same reason. */
const MAX_EVENTS = 60;
/** Beacons one device may send in a minute before the rest are dropped. */
const PER_MINUTE = 120;

/**
 * `view` is a page load. Everything else is `group:name`, where the group is
 * one the monitoring card knows how to title and the name is whatever the
 * page element is called: a tab, a tier, a section, a link's host.
 */
const EVENT = /^(?:view|(?:nav|tab|tier|link|action):[a-z0-9.-]{1,48})$/;

const salt = randomBytes(32);
const startedAt = new Date().toISOString();
const events = new Map();
const devices = new Map();
const interactors = new Map();
const budget = new Map();
let visits = 0;
let lastSweep = 0;

function fingerprint(address) {
  return createHmac('sha256', salt).update(address).digest('base64url').slice(0, 16);
}

function see(set, id, now) {
  if (set.size >= MAX_DEVICES && !set.has(id)) return;
  set.set(id, now);
}

function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  budget.clear();
  for (const set of [devices, interactors]) {
    for (const [id, seen] of set) if (now - seen > DEVICE_WINDOW_MS) set.delete(id);
  }
}

function within24h(set, now) {
  let n = 0;
  for (const seen of set.values()) if (now - seen <= DEVICE_WINDOW_MS) n += 1;
  return n;
}

function count(name, address, now = Date.now()) {
  sweep(now);
  const id = fingerprint(address);
  const spent = budget.get(id) ?? 0;
  if (spent >= PER_MINUTE) return;
  if (budget.size < MAX_DEVICES) budget.set(id, spent + 1);
  if (name === 'view') {
    visits += 1;
    see(devices, id, now);
    return;
  }
  if (!events.has(name) && events.size >= MAX_EVENTS) return;
  events.set(name, (events.get(name) ?? 0) + 1);
  see(interactors, id, now);
}

/** Cloudflare names the visitor and nginx passes it on. The socket is only ever nginx. */
function address(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  return req.socket.remoteAddress ?? '';
}

const eventServer = createServer((req, res) => {
  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/e') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 64) req.destroy();
  });
  req.on('end', () => {
    const name = body.trim();
    if (EVENT.test(name)) count(name, address(req));
    res.writeHead(204).end();
  });
});

const usageServer = createServer((req, res) => {
  if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/usage') {
    res.writeHead(404).end();
    return;
  }
  const now = Date.now();
  sweep(now);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(
    JSON.stringify({
      startedAt,
      visits,
      devices24h: within24h(devices, now),
      interactors24h: within24h(interactors, now),
      events: Object.fromEntries(events),
    }),
  );
});

eventServer.listen(EVENT_PORT, '0.0.0.0', () => console.log(`beacons on :${EVENT_PORT}/e`));
usageServer.listen(USAGE_PORT, '0.0.0.0', () => console.log(`usage counters on :${USAGE_PORT}/usage`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    eventServer.close();
    usageServer.close();
    process.exit(0);
  });
}
