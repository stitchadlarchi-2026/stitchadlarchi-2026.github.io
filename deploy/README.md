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
| `deploy/submissions/` | The exhibition form (Links → Exhibition) and the Student Directory. `server.mjs` checks each submission (full name, optional LinkedIn and place, a 150-word overview, headshot, optional project image or PDF, and whether it may go on the site) and writes it to the `submissions-data` volume. The committee approves profiles at `/_s/review` and downloads everything from `/_s/export`: `submissions.xlsx`, `photos/<Full Name>.jpg`, `projects/<Full Name> - project.<ext>`. Password: `SUBMISSIONS_KEY` in `.env`. `dev.mjs` runs the site, form and review page locally |
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

## Why the checks never fail

The server's deploy poller refuses to deploy a commit whose GitHub checks did
not pass, which is right for an application that takes input and holds data.
STITCH is an information page with one form, no accounts and no database
beyond the submissions volume. Bijin asked for a pipeline that reports rather
than blocks, so the workflow always succeeds and puts what it noticed in the
job summary.

The trade is explicit: **a commit that breaks the page will deploy.** The page
is one file and a mistake is visible on the site immediately, which is the
cheapest possible feedback loop. To make something here block a deploy, remove
the `exit 0` from that step in `.github/workflows/checks.yml`.

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
JSON record plus its files on the `submissions-data` volume, written
atomically, so a record on disk always has its files. Limits: 20 MB for the
headshot (JPG, PNG, WebP or HEIC), 30 MB for the project (JPG, PNG, WebP or
PDF), types checked by their bytes; 10 submissions an hour per address; 12 GB
in all. The browser also sends small JPEG web copies, which the Student Directory
serves instead of the full-size files.

**The Student Directory (`#directory`) shows only profiles the graduate opted in to and the
committee approved** at `/_s/review`. A resubmission waits for approval while
the earlier approved profile stays up; a resubmission without the opt-in takes
the profile down at once. Approvals live in `approvals.state` on the volume.
Public routes: `/_s/graduates.json` and `/_s/media/<file>` (approved files only).

```bash
# once, before the first deploy that includes it: set the download password
echo "SUBMISSIONS_KEY=$(openssl rand -base64 24)" >> ~/stitch-exhibition/.env

# the committee's download, from anywhere (any username, the key as password)
https://stitchexhibition.com/_s/review         # approve or hide Student Directory profiles
https://stitchexhibition.com/_s/export         # everything, as one zip
https://stitchexhibition.com/_s/status         # headcount and names, as JSON

# back it up: this volume is the only data in the stack
docker run --rm -v stitch-exhibition_submissions-data:/data -v "$PWD":/out alpine \
  tar czf /out/stitch-submissions-$(date +%F).tgz -C /data .
```

With no `SUBMISSIONS_KEY`, the form still takes submissions, and the review
page and download answer 404, so nothing can be approved for the Student Directory. If the service is down, the page is unaffected and the form says
it could not send.

## Rebuilding the tunnel from nothing

```bash
cd ~/stitch-exhibition
./deploy/provision-tunnel.sh           # rewrites .env with a working token
docker compose -f compose.yaml -p stitch-exhibition --env-file .env up -d --build
```
