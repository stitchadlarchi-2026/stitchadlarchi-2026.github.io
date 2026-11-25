# Deploying stitchexhibition.com

Breeze designs the page. This directory is everything that puts it on the
internet. Nobody has to run any of it by hand — **a push to `main` is the
deploy** — but when something looks wrong, this is where to look.

## What happens when you push to `main`

```
  push to main
       │
       ▼
  GitHub Actions (.github/workflows/checks.yml)
       │   looks the site over, builds the image, reports in the job summary
       │   never fails, never blocks
       ▼
  nch-deploy on Bijin's server, every 2 minutes
       │   git pull --ff-only  →  docker compose up -d --build  →  wait for healthy
       ▼
  nginx container  →  Cloudflare Tunnel  →  https://stitchexhibition.com
```

Expect the change to be live **within about three minutes** of the push: up to
two for the poller to come round, plus a few seconds to rebuild a static image.

Nothing in this repository reaches into the server, and the server holds no
GitHub credential that can write here. The server pulls; GitHub never pushes.

## The pieces

| Path | What it is |
|---|---|
| `Dockerfile` | Bakes the site into `nginx:1.29-alpine`. Copies the whole repo, then strips the infrastructure back out, so new pages and assets ship without anyone editing it |
| `compose.yaml` | The stack: `web` (nginx) + `usage` (view and click counters) + `submissions` (the exhibition form, with the R2 bucket `stitch-uploads`) + `cloudflared` (this app's own tunnel). Compose project `stitch-exhibition` |
| `deploy/nginx.conf` | Security headers, gzip, cache policy, the `www` → apex redirect, and the usage beacon |
| `deploy/usage/` | The usage counters. `beacon.js` is added to every page by nginx as it serves it, so `index.html` never carries it. It sends one word per page view or click: no cookie, no storage, no identifier. `server.mjs` counts the words and serves the totals on `127.0.0.1:9094` for the monitoring page. If it is down, the page is unaffected |
| `deploy/submissions/` | The exhibition form on the Links page: each graduate's details plus a headshot, a poster and a booklet. The files go from the browser straight to the R2 bucket `stitch-uploads`; `server.mjs` signs the upload URLs, checks what arrived, and copies it down to this box. `r2.mjs` talks to R2, `zip.mjs` builds the committee's downloads, `metadata.mjs` strips image metadata. `dev.mjs` runs the site and the form locally. See *Exhibition submissions* below |
| `deploy/provision-tunnel.sh` | Creates or reuses the Cloudflare tunnel and DNS. Idempotent; safe to re-run |
| `.env.example` | The variable names. The real `.env` lives only on the server and is gitignored |

## Hostnames

| Host | Serves |
|---|---|
| `stitchexhibition.com` | The site. This is the canonical address |
| `www.stitchexhibition.com` | `301` to the apex |

Both are proxied CNAMEs onto the `stitch-exhibition` named tunnel, on Bijin's
own Cloudflare account. No port is open on the router; nothing is published
beyond `127.0.0.1:8094` on the box itself, for local checking.

## What the checks block, and what they don't

The server's deploy poller refuses to deploy a commit whose GitHub `site` check
did not pass. Bijin asked for a pipeline that never blocks the page, so the site
notes (titles, missing files) are advisory and go in the job summary.

Two things do block, and only for the server code under `deploy/`: every
`deploy/*/*.mjs` must parse, and the web, usage and submissions images must
build. The stack holds exhibition submissions, and a server that cannot start
would lose them. A blocked commit leaves the last good one running. Nothing in
`index.html` or the assets can fail these steps, so **a commit that breaks the
page will still deploy**: the page is one file, and a mistake shows on the site
straight away.

## On the server

```bash
nch-deploy status                      # deployed commit, and any drift
nch-deploy check                       # what would deploy next, and why
nch-deploy run --only stitch-exhibition   # don't; let the timer do it
nch-deploy rollback stitch-exhibition  # back to the previous image, now

docker compose -p stitch-exhibition -f compose.yaml ps
docker logs stitch-exhibition-cloudflared-1 --tail 50
curl -sI http://127.0.0.1:8094/        # the site without going through Cloudflare
```

The stack is registered in `/etc/docker-stacks.conf`, so it comes back by itself
after the box's Sunday-morning reboot, and on the monitoring page at
`platform.nchconsultancy.com/admin/monitoring` as **STITCH Exhibition**.

## Exhibition submissions

Graduates fill in the form under **Links → Exhibition**: their details, a
headshot, their project poster and their project booklet. The decisions behind
every limit are in `SECURITY.md`; the load test behind them is in
`deploy/submissions/LOADTEST.md`.

### How a submission travels

```
 browser ──1. POST /_s/start (details, Turnstile, file sizes)──▶ submissions
         ◀──── presigned part URLs, valid 24 h ────────────────
 browser ──2. PUT each 16 MB part, 4 at a time, retried ──────▶ R2 bucket stitch-uploads
 browser ──3. POST /_s/complete (the parts' ETags) ───────────▶ submissions
                                     checks size + first bytes in R2 ──▶ "uploaded"
 submissions ◀──4. transfer worker, 2 files at a time ──────── R2  ──▶ "stored"
```

The files never pass through nginx, through Cloudflare's 100 MB limit on a
request to stitchexhibition.com, or up the home connection. A rush of 300
people becomes a queue in R2 that the box drains at its own pace (R2 to the
box measured 368 Mbit/s; a 1 GB booklet comes down in about 25 s). Every
submission is a JSON record on the `submissions-data` volume, so a restart
picks the queue up where it stopped.

- **Files:** headshot JPG, PNG or WebP up to 20 MB; poster PDF up to 300 MB,
  or JPG or PNG up to 60 MB; booklet PDF up to 1 GB. Types are checked twice:
  as declared at start, and by each file's real first bytes in R2 at complete.
  Image metadata (location, camera) is removed before anything is kept. HEIC is
  refused; iPhones convert to JPEG by themselves for this form.
- **Where it lands:** records and headshots on `submissions-data` (backed up
  nightly by `nch-backup-all`); posters and booklets on `submissions-files`.
  Every object stays in R2 as well, as the off-box copy of the big files, until
  the deletion date.
- **Limits:** 120 starts or completes a minute per address (a class on campus
  Wi-Fi shares one); 600 uploads open at once; 50 GB always kept free on the
  disk, after counting what open uploads have promised. Above any of them the
  form asks people to try again in a few minutes.
- **Bot check:** Cloudflare Turnstile, widget **STITCH exhibition form**.
- **Unfinished uploads:** given up after 24 hours, and their parts aborted in R2.
- **Deletion:** after 31 January 2027 the service empties both volumes and the
  R2 bucket, and the form closes, as the notice on the form promises. The
  bucket's lifecycle rule deletes everything on 1 February 2027 as well. To move
  the date, change `DELETE_AFTER` and `CONSENT` in `server.mjs`, the notice in
  `index.html` and the bucket rule, together.
- **Configuration** (all in `.env`; compose will not start without them):
  `SUBMISSIONS_KEY`, `TURNSTILE_SECRET`, `R2_ENDPOINT`, `R2_BUCKET`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. The R2 key can reach the
  `stitch-uploads` bucket and nothing else.

```bash
# the committee's downloads, from anywhere (any username, the key as password)
https://stitchexhibition.com/_s/export            # submissions.xlsx + photos/<Full Name>.jpg
https://stitchexhibition.com/_s/export/posters    # posters/<Full Name>.pdf   (large)
https://stitchexhibition.com/_s/export/booklets   # booklets/<Full Name>.pdf  (very large)
https://stitchexhibition.com/_s/status            # headcount, the queue, anything flagged

# the queue, from the box
docker logs stitch-exhibition-submissions-1 --since 1h | grep -E 'start|complete|transfer'

# remove one person on request: find their records, then delete their files here and in R2
docker exec stitch-exhibition-submissions-1 grep -l '"name": "Full Name"' /data/*.json
docker exec stitch-exhibition-submissions-1 sh -c 'rm /data/<id>.* /files/<id>.*'
#   ...and the three objects under submissions/<id>/ in the stitch-uploads bucket
#   (Cloudflare dashboard → R2 → stitch-uploads)
```

The exports take each person's latest *stored* submission. Someone whose newest
entry is still coming down from R2 appears with their previous one, and in
`stillComingDown` in `/_s/status`. With no `SUBMISSIONS_KEY`, the downloads
answer 404. Five wrong passwords in a minute lock that address out for the rest
of the minute. If the service is down, the page is unaffected and the form says
it could not send.

### Student Directory

Graduates who tick "Show my profile in the Student Directory" also upload small
JPEG web copies of their headshot and image poster (kinds `photoWeb` and
`posterWeb`, optional, through the same `/start` → R2 → transfer path). Nothing
is public until the committee approves it at `https://stitchexhibition.com/_s/review`
(same password as the downloads). The page lists everyone as waiting, live,
hidden or not in the directory, with Approve and Hide; decisions go to
`/data/approvals.state`. The Directory page reads `/_s/directory.json`, the
images come from `/_s/media/<id>/<kind>.<ext>` (Cloudflare caches them for up to five
minutes, so a hidden profile's images are gone within five minutes), and a PDF poster from `/_s/poster/<id>`,
which redirects to a 15-minute presigned R2 link so it never goes up the home
connection. The sheet has "Asked for directory" and "Directory" columns.

To try it locally, `node deploy/submissions/dev.mjs` now runs a stand-in for R2
(`dev-r2.mjs`, localhost only, never in the image) when no R2 settings are in
the shell, so the whole flow works without a bucket: submit at
`http://localhost:8000/#links`, approve at `/_s/review` (password `dev`), and see
it at `/#directory`.

**Exports are served from this box, so they go up the home connection** (about
44 Mbit/s measured): the sheet and headshots take seconds, but tens of GB of
booklets take hours. Start the booklets download well before it is needed.

## Rebuilding the tunnel from nothing

```bash
cd ~/stitch-exhibition
./deploy/provision-tunnel.sh           # rewrites .env with a working token
docker compose -f compose.yaml -p stitch-exhibition --env-file .env up -d --build
```
