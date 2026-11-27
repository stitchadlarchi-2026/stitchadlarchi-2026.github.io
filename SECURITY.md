# Security posture — stitchexhibition.com

Lane and data classes are recorded in [`.security.json`](.security.json). This file records
the decisions behind them and the risks accepted. The runbook is
[`deploy/README.md`](deploy/README.md); the breach procedure is [`BREACH.md`](BREACH.md).

## Lane B, since the exhibition form (2026-11-25)

Until 2026-11-25 the site was a static page that took no input. The exhibition form under
**Links → Exhibition** collects graduates' names, headshots and project details for the
STITCH committee, so the site holds third-party personal information and the whole
`cybersecurity` baseline applies.

**What is held, and where.** Per submission: a JSON record and a headshot tile on the Docker volume
`stitch-exhibition_submissions-data`, and a PNG poster on
`stitch-exhibition_submissions-files`, on NCH Consultancy's server in Australia. Every file
is also in the R2 bucket `stitch-uploads` on NCH's Cloudflare account (location hint:
Oceania) until the deletion date. Only `deploy/submissions/server.mjs` reads or writes any of
it. It binds named fields only: name, personal email, the answers to "exhibit on the night" and
"Student Directory", degree, LinkedIn, Instagram, website, place of origin, project title,
overview, the files, and the text of the consent the person ticked. The browsers' file names
are not kept. Someone who answers no to both questions gives only their name and email, and
nothing else is asked or kept.

**Personal email (since 2026-11-26, STITCH-2).** Asked of everyone, so the committee can reach
a graduate about their entry. It is contact data, not for publication: it appears in the
committee's sheet and on the review page, both behind `SUBMISSIONS_KEY`, and never in
`/_s/directory.json` or anywhere public. It is deleted with everything else on the deletion
date.

**Since 2026-11-26 the files go straight to R2.** A print-resolution PNG poster runs to
hundreds of megabytes; Cloudflare refuses request bodies over 100 MB to stitchexhibition.com, and the
home uplink is 44 Mbit/s. So the browser asks `/start` for presigned part URLs and uploads
the parts to R2 itself, then calls `/complete`; the service copies each file down from R2
afterwards (`deploy/README.md` has the diagram, `deploy/submissions/LOADTEST.md` the test).

**The R2 bucket.** Private: no public access, no custom domain. CORS allows `PUT` from
`https://stitchexhibition.com` only, exposing `ETag`. The service's key is an account token
scoped to *Workers R2 Storage Bucket Item Write* on `stitch-uploads` alone; it was tested to
be refused by every other bucket. Browsers never hold a key: each part URL is presigned for
one method, one object, one part number and one exact `Content-Length`, and expires after
24 hours. R2 refuses a part of any other length. Lifecycle: unfinished multipart uploads are
aborted after 1 day; every object is deleted on 2027-02-01.

**Uploads (since 2026-11-26, STITCH-2).** A headshot and up to three project images. The headshot is cropped in the browser
to a **600 x 800** JPEG tile and turned black and white there; only the tile is uploaded, up to
**4 MB**, and `/complete` refuses any JPEG that is not exactly 600 x 800. The project images
(optional, up to three: a poster, drawings, renders, anything) are **PNG only**, up to **250 MB**
each. There is no DPI, pixel size or quality rule (removed 2026-11-27 at Bijin's request); only
the type is checked. Each file's type is
checked as declared at `/start`, and again by its real first bytes in R2 at `/complete`; a
mismatch closes the submission and removes its objects from R2 at
once. The browser decodes any JPEG, PNG or WebP headshot itself, so HEIC never reaches the
service. `metadata.mjs` removes EXIF (GPS, device, time), XMP, IPTC and comments from
every image before it is kept, leaving the pixels, the ICC colour profile and the JPEG
orientation. An image it cannot parse is kept out of the download and flagged in the sheet,
never stored with its metadata. Each project image is stripped as it streams down from R2, so a
250 MB PNG never sits in the service's memory (a 200 MB poster peaked the service at 119 MB).
Files get generated names, live outside the web root, and leave the box only inside the
committee's zips. There is no booklet.

**The Student Directory (since 2026-11-26).** A yes or no question, separate from the
consent, asks to be shown on the site's Student Directory (menu → Directory). Only on a yes
does the browser make a small JPEG web copy of each project image (2400 px) and upload it
beside its PNG (`posterWeb`, `posterWeb2`, `posterWeb3`), through the same `/start`, R2 and transfer path, metadata stripped like any image. The
headshot tile is already small and is served as it is. Nothing is public until the committee approves it at
`/_s/review` (behind `SUBMISSIONS_KEY`); approvals are kept in `approvals.state` on
`submissions-data`. The public routes are `/_s/directory.json` and `/_s/media/<id>/<kind>.jpg`, and they
serve only approved, opted-in profiles: name, degree, LinkedIn, Instagram, website, project
title, overview, the headshot tile and the images' web copies. Email, place of origin, the
exhibit answer and the image PNGs are never public. Every public link is an `https` address:
the service refuses any other scheme, and the page checks again before it makes a link. A resubmission waits for approval while the earlier approved profile
stays up; a resubmission that answers no takes the profile down at once. The review page's
approve and hide buttons accept only same-origin requests, because a browser sends its saved
Basic password with any request to the site. Public reads: **600 a minute** per address.
Public image addresses end in their extension, so Cloudflare caches them at the edge for at
most **5 minutes** (`max-age=300`): the home connection serves each image about once per
edge per five minutes, and a hidden profile's images stop being served within five minutes.
The directory empties with everything else on the deletion date.

**Rate limits and capacity, with numbers.** `/start` and `/complete`: **120 a minute** per
address. A cohort of 300 on campus Wi-Fi arrives from one university address, so this is
sized for a class; the browser waits out a 429 and retries. Turnstile is what stops a script.
At most **600** uploads open at once, and **50 GB** always left free on the disk after
counting what open uploads have promised; beyond either, `/start` answers 503. Calls from the
service to R2: at most **24** in flight. The committee downloads: **5 wrong passwords a
minute** per address, then 429 for the rest of the minute. Addresses come from
`CF-Connecting-IP` and are kept only as a keyed HMAC, in memory.

**Bot protection.** Cloudflare Turnstile (managed) on the form, verified server-side against
`TURNSTILE_SECRET`, failing closed. A honeypot field as well. Compose refuses to start the
stack without `TURNSTILE_SECRET`.

**Retention and deletion.** The service deletes every file on both volumes and every object
in the R2 bucket once `DELETE_AFTER` (default 2027-01-31 23:59:59 ACDT) has passed, and the
form answers 410. The bucket's lifecycle rule deletes every object on 2027-02-01 as well. It
checks at start and hourly, so a box that was off on the day still does it. A person who
asks to be removed emails the committee; the operator deletes their record and photo (see
`deploy/README.md`).

**Collection notice.** The form shows what is collected, the three uses (wall labels and
catalogue, this site, STITCH social media), where it is stored, the deletion date, how to
change or remove an entry, and the use of Turnstile. A required checkbox records agreement,
and the record stores the wording agreed to. This notice is the privacy policy for the form.

**Logs.** A submission logs its id and byte count. The committee download logs the keyed
HMAC of the address that opened it, or that sent a wrong password. No names, no photos, no
request bodies.

**Deploys.** The GitHub `site` check fails when the server code under `deploy/` does not
parse or an image does not build. Page edits remain advisory and never block.

**Backups.** `submissions-data` (records and headshots) is archived nightly by
`nch-backup-all`, age-encrypted to the public recipient and pushed to R2 with the write-only
token. `submissions-files` (posters, tens of GB) is not: a nightly archive of it
would fill the backup disk in days. Its off-box copy is the `stitch-uploads` bucket, which
keeps every object until the deletion date.

## The admin console (since 2026-11-27)

`admin.stitchexhibition.com` is the console for Breeze, Bijin and the STITCH account: every
submission, edits to any field, Student Directory approve and hide, removing an image,
deleting a submission, the downloads, and a live view of the site. It is `console.mjs`, a
third port (9092) on the submissions service, because that process owns the records and
must apply the edits; nginx serves it on its own `server_name`, through the same tunnel.

**Sign-in.** An emailed one-time code, to three addresses only (`CONSOLE_EMAILS` in
`compose.yaml`): `breezemathew110@gmail.com`, `bijin@nchconsultancy.com`,
`stitch.adl.archi@gmail.com`. Bijin asked for this instead of Cloudflare Access on
2026-11-27. An address not on the list gets the same answer and no email, so the page does
not reveal who may sign in. A code is six digits from `crypto.randomInt`, held only as a
SHA-256, valid ten minutes and once, and dies after five wrong tries. Each address can be
sent five codes an hour, and each network can make twenty sign-in requests in ten minutes.
The mail goes through Resend with NCH's **send-only** key (it cannot read mail, list keys
or change domains), from NCH's verified sending address; both are in `.env` as
`RESEND_API_KEY` and `CONSOLE_MAIL_FROM`. NCH runs this infrastructure, so this is NCH's
own key, not another client's.

**Sessions.** A 32-byte random token in a cookie that is `HttpOnly`, `Secure`,
`SameSite=Strict` and host-only on the admin host, so the public site never sees it. The
service keeps only the token's SHA-256, in `console-sessions.state` on `submissions-data`
(so a redeploy does not sign anyone out), for twelve hours. Every request that changes
anything must carry the console's own `Origin` and an `X-Stitch: 1` header, which a form or
image on another site cannot send. The console page runs only its own script: its CSP is
`default-src 'none'` with `script-src 'self'`, and every value from a submission is put on
the page as text, never as HTML. Edits pass the same checks as the form (email shape, https
links only, the 150-word overview).

**Audit.** Every sign-in and every change (edit with before and after, approve, hide,
image removed, submission deleted) is appended to `audit.log` on `submissions-data`, with
who and when, and shown in the console's change log. It is deleted with everything else on
the deletion date. Deleting a submission removes its record, its files on the box and its
objects in R2 at once; the nightly backups keep their copy until they age out (14 days).

**Live view.** `beacon.js`, which nginx already adds to the public page, now also sends a
heartbeat to `/_s/ping` every 20 seconds while a tab is open: a random id made fresh on
each page load and kept only in a variable, the page (home, info, links, directory,
sponsors), and whether the form is open and being filled in, uploading, or just submitted.
No cookie, no storage, no IP kept; the service holds it in memory for 50 seconds, and at
most 5000 tabs. That is what "on the site now" counts. The activity feed (started,
finished, failed, saved, admin changes) is the last 60 events, in memory only.

## Accepted risks (2026-11-25, revisit 2027-01-31)

- **Email codes, not Cloudflare Access, on the admin console (2026-11-27).** Anyone who
  controls one of the three inboxes can sign in and change or delete submissions. Bijin
  chose this on 2026-11-27. Mitigations: a three-address allowlist, ten-minute single-use
  codes, rate limits, twelve-hour sessions, and the audit log of every change.
- **One shared password on the committee download, no MFA.** The baseline asks for
  Cloudflare Access on a client-facing admin path. Bijin chose a password only on
  2026-11-25. Mitigations: HTTPS only, a 32-character random key in `.env`, a
  constant-time compare, 5 wrong tries a minute per address, and a 404 for the download when
  no key is set. Anyone holding the password can download every submission. The data is also
  intended for publication, and it is deleted on 2027-01-31.
- **No encryption at rest on the host disk.** The server's root volume is plain LVM, with no
  LUKS (audit 2026-09-01, item 1, still open). The submissions are not field-encrypted either:
  they are names, photos and overviews intended for wall labels, the website and social
  media, and personal emails held for the committee alone. They are held for ten weeks.
- **Backups outlive the deletion date.** `nch-backup-all` keeps local copies for 14 days.
  The R2 copies are immutable and follow the bucket's own retention. On 2027-02-01, confirm
  that the last backup that holds submissions has aged out of both.
- **The R2 copy of the posters is not an attacker-resistant backup.** The
  service's own key can delete objects in `stitch-uploads`, so a compromised server could
  remove both copies. The nightly backups do resist that (write-only token), but cover only
  records and headshots. Accepted: the files are the graduates' own work, which they still
  hold, and they can be asked to send them again.
- **Uploads land in a Cloudflare bucket first.** The location hint is Oceania, which is a
  hint, not a guarantee of where Cloudflare stores the bytes. Since 2026-11-26 the collection
  notice on the form no longer mentions Cloudflare, the server in Australia or the deletion
  date (the committee asked for the shorter notice). Those facts are recorded here only.
- **The `/start` budget can be spent by one campus address.** 120 a minute per address is
  shared by everyone behind that address. The browser retries a 429 after 20 s, three times.
- **A browser without an image's web copy.** A phone may run out of memory decoding a
  200 MB PNG to make the 2400 px copy. The form then sends none, and that profile shows no
  copy of that image in the directory; the committee sees "no web copy" on the review page and
  has the PNG in the images download (`/_s/export/posters`).

## Lane A record (2026-09-29 to 2026-11-25)

A static page with no input, no accounts and no data, served by nginx through its own
Cloudflare Tunnel, with a view and click counter that keeps no address (2026-10-02).
