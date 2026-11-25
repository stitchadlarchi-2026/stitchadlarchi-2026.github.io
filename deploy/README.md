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
| `compose.yaml` | The stack: `web` (nginx) + `usage` (view and click counters) + `submissions` (the exhibition form) + `cloudflared` (this app's own tunnel). Compose project `stitch-exhibition` |
| `deploy/nginx.conf` | Security headers, gzip, cache policy, the `www` → apex redirect, and the usage beacon |
| `deploy/usage/` | The usage counters. `beacon.js` is added to every page by nginx as it serves it, so `index.html` never carries it. It sends one word per page view or click: no cookie, no storage, no identifier. `server.mjs` counts the words and serves the totals on `127.0.0.1:9094` for the monitoring page. If it is down, the page is unaffected |
| `deploy/submissions/` | The exhibition form on the Links page. `server.mjs` checks each submission (full name, optional LinkedIn and place, project overview, headshot) and writes it to the `submissions-data` volume. The committee downloads everything as one zip from `/_s/export`: `submissions.xlsx` plus `photos/<Full Name>.jpg`, latest entry per person. Password: `SUBMISSIONS_KEY` in `.env`. `dev.mjs` runs the site and the form locally for trying changes |
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

Graduates fill in the form under **Links → Exhibition**. Each submission is a
JSON record and a photo on the `submissions-data` volume, written atomically, so
a record on disk always has its photo. The decisions behind the limits are in
`SECURITY.md`.

- **Photos:** JPG, PNG or WebP, up to 20 MB, checked by their bytes. Location,
  camera and other metadata are removed before the photo is saved. HEIC is
  refused; iPhones convert to JPEG by themselves for this form.
- **Limits:** 20 submissions a minute per address, one upload processed at a
  time (up to 40 wait), 3.5 GB in all.
- **Bot check:** Cloudflare Turnstile, widget **STITCH exhibition form**. The
  stack will not start without `TURNSTILE_SECRET` in `.env`.
- **Deletion:** after 31 January 2027 the service empties the volume and the
  form closes, as the notice on the form promises. To move the date, change
  `DELETE_AFTER` in `server.mjs`, the notice in `index.html`, and `CONSENT` in
  `server.mjs`, together.
- **Backups:** nightly, by `nch-backup-all` on the server.

```bash
# set the download password, without printing it (once; already done 2026-11-25)
echo "SUBMISSIONS_KEY=$(openssl rand -base64 24)" >> ~/stitch-exhibition/.env

# the committee's download, from anywhere (any username, the key as password)
https://stitchexhibition.com/_s/export      # submissions.xlsx + photos/<Full Name>.jpg
https://stitchexhibition.com/_s/status      # headcount and names, as JSON

# remove one person on request: find their records, then delete each record and its photo
docker exec stitch-exhibition-submissions-1 grep -l '"name": "Full Name"' /data/*.json
docker exec stitch-exhibition-submissions-1 rm /data/<id>.json /data/<id>.jpg
```

With no `SUBMISSIONS_KEY`, the form still takes submissions and the download
answers 404. Five wrong passwords in a minute lock that address out for the rest
of the minute. If the service is down, the page is unaffected and the form says
it could not send.

## Rebuilding the tunnel from nothing

```bash
cd ~/stitch-exhibition
./deploy/provision-tunnel.sh           # rewrites .env with a working token
docker compose -f compose.yaml -p stitch-exhibition --env-file .env up -d --build
```
