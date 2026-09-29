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
| `compose.yaml` | The stack: `web` (nginx) + `cloudflared` (this app's own tunnel). Compose project `stitch-exhibition` |
| `deploy/nginx.conf` | Security headers, gzip, cache policy, and the `www` → apex redirect |
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
STITCH is an information page: no forms, no accounts, no database. Bijin asked
for a pipeline that reports rather than blocks, so the workflow always succeeds
and puts what it noticed in the job summary.

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

## Rebuilding the tunnel from nothing

```bash
cd ~/stitch-exhibition
./deploy/provision-tunnel.sh           # rewrites .env with a working token
docker compose -f compose.yaml -p stitch-exhibition --env-file .env up -d --build
```
