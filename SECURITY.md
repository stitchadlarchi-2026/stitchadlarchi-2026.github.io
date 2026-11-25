# Security posture — stitchexhibition.com

Lane and data classes are recorded in [`.security.json`](.security.json). This file records
the decisions behind them and the risks accepted. The runbook is
[`deploy/README.md`](deploy/README.md); the breach procedure is [`BREACH.md`](BREACH.md).

## Lane B, since the exhibition form (2026-11-25)

Until 2026-11-25 the site was a static page that took no input. The exhibition form under
**Links → Exhibition** collects graduates' names, headshots and project details for the
STITCH committee, so the site holds third-party personal information and the whole
`cybersecurity` baseline applies.

**What is held, and where.** Per submission: a JSON record and a headshot on the Docker volume
`stitch-exhibition_submissions-data`, and a poster and a booklet on
`stitch-exhibition_submissions-files`, on NCH Consultancy's server in Australia. Every file
is also in the R2 bucket `stitch-uploads` on NCH's Cloudflare account (location hint:
Oceania) until the deletion date. Only `deploy/submissions/server.mjs` reads or writes any of
it. It binds named fields only: name, degree, LinkedIn, place of origin, project title, overview, the three files,
and the text of the consent the person ticked. The browsers' file names are not kept.

**Since 2026-11-26 the files go straight to R2.** A master's booklet runs to hundreds of
megabytes; Cloudflare refuses request bodies over 100 MB to stitchexhibition.com, and the
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

**Uploads.** Headshot JPEG, PNG or WebP up to **20 MB**; poster PDF up to **300 MB**, or JPEG
or PNG up to **60 MB**; booklet PDF up to **1 GB**. Each file's type is checked as declared at
`/start`, and again by its real first bytes in R2 at `/complete`; a mismatch closes the
submission and removes its objects from R2 at once. HEIC is refused, because its metadata
cannot be removed with Node builtins; an iPhone converts to JPEG by itself when the form does
not list HEIC. `metadata.mjs` removes EXIF (GPS, device, time), XMP, IPTC and comments from
every image before it is kept, leaving the pixels, the ICC colour profile and the JPEG
orientation. An image it cannot parse is kept out of the download and flagged in the sheet,
never stored with its metadata. PDFs are stored as sent. Files get generated names, live
outside the web root, and leave the box only inside the committee's zips.

**The Student Directory (proposed 2026-11-26).** A second tick box, separate from the
consent, asks to be shown on the site's Student Directory (menu → Directory). Only then does
the browser make small JPEG web copies of the headshot (1200 px) and of an image poster
(2400 px) and upload them beside the originals, through the same `/start`, R2 and transfer
path, metadata stripped like any image. Nothing is public until the committee approves it at
`/_s/review` (behind `SUBMISSIONS_KEY`); approvals are kept in `approvals.state` on
`submissions-data`. The public routes are `/_s/directory.json`, `/_s/media/<id>/<kind>` and
`/_s/poster/<id>`, and they serve only approved, opted-in profiles: name, degree, LinkedIn,
project title, overview, the web copies, and a PDF poster by a **15-minute presigned R2
GET**, never streamed up the home connection. Place of origin, booklets and the original
files are never public. A resubmission waits for approval while the earlier approved profile
stays up; a resubmission without the tick takes the profile down at once. The review page's
approve and hide buttons accept only same-origin requests, because a browser sends its saved
Basic password with any request to the site. Public reads: **600 a minute** per address.
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
token. `submissions-files` (posters and booklets, tens of GB) is not: a nightly archive of it
would fill the backup disk in days. Its off-box copy is the `stitch-uploads` bucket, which
keeps every object until the deletion date.

## Accepted risks (2026-11-25, revisit 2027-01-31)

- **One shared password on the committee download, no MFA.** The baseline asks for
  Cloudflare Access on a client-facing admin path. Bijin chose a password only on
  2026-11-25. Mitigations: HTTPS only, a 32-character random key in `.env`, a
  constant-time compare, 5 wrong tries a minute per address, and a 404 for the download when
  no key is set. Anyone holding the password can download every submission. The data is also
  intended for publication, and it is deleted on 2027-01-31.
- **No encryption at rest on the host disk.** The server's root volume is plain LVM, with no
  LUKS (audit 2026-09-01, item 1, still open). The submissions are not field-encrypted either:
  they are names, photos and overviews intended for wall labels, the website and social
  media. They are held for ten weeks.
- **Backups outlive the deletion date.** `nch-backup-all` keeps local copies for 14 days.
  The R2 copies are immutable and follow the bucket's own retention. On 2027-02-01, confirm
  that the last backup that holds submissions has aged out of both.
- **The R2 copy of the posters and booklets is not an attacker-resistant backup.** The
  service's own key can delete objects in `stitch-uploads`, so a compromised server could
  remove both copies. The nightly backups do resist that (write-only token), but cover only
  records and headshots. Accepted: the files are the graduates' own work, which they still
  hold, and they can be asked to send them again.
- **Uploads land in a Cloudflare bucket first.** The location hint is Oceania, which is a
  hint, not a guarantee of where Cloudflare stores the bytes. The collection notice says the
  files upload to Cloudflare's storage service and that copies are held by Cloudflare.
- **The `/start` budget can be spent by one campus address.** 120 a minute per address is
  shared by everyone behind that address. The browser retries a 429 after 20 s, three times.
- **Presigned GETs for PDF posters in the directory (proposed 2026-11-26).** The service's
  key signs a GET for one object for 15 minutes; anyone holding that URL in that window can
  read that poster. Accepted: it is only ever signed for an approved, opted-in profile's
  poster, which the person asked to publish.
- **HEIC refused, PNG and WebP orientation not kept.** A sideways PNG from a phone is
  possible but rare. The committee can rotate it.

## Lane A record (2026-09-29 to 2026-11-25)

A static page with no input, no accounts and no data, served by nginx through its own
Cloudflare Tunnel, with a view and click counter that keeps no address (2026-10-02).
