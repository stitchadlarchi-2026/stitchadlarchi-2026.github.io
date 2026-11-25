# Security posture — stitchexhibition.com

Lane and data classes are recorded in [`.security.json`](.security.json). This file records
the decisions behind them and the risks accepted. The runbook is
[`deploy/README.md`](deploy/README.md); the breach procedure is [`BREACH.md`](BREACH.md).

## Lane B, since the exhibition form (2026-11-25)

Until 2026-11-25 the site was a static page that took no input. The exhibition form under
**Links → Exhibition** collects graduates' names, headshots and project details for the
STITCH committee, so the site holds third-party personal information and the whole
`cybersecurity` baseline applies.

**What is held, and where.** One JSON record and one photo per submission, on the Docker
volume `stitch-exhibition_submissions-data`, on NCH Consultancy's server in Australia. Only
`deploy/submissions/server.mjs` reads or writes it. It binds named fields only: name,
LinkedIn, place of origin, overview, photo, and the text of the consent the person ticked.
The browser's file name is not kept.

**Uploads.** JPEG, PNG or WebP only, identified by their bytes. HEIC is refused, because its
metadata cannot be removed with Node builtins; an iPhone converts to JPEG by itself when the
form does not list HEIC. **20 MB** a photo, **3.5 GB** in all (the export is a plain zip,
which cannot pass 4 GB). `metadata.mjs` removes EXIF (GPS, device, time), XMP, IPTC and
comments before anything is written, keeping only the pixels, the ICC colour profile and the
JPEG orientation. A photo it cannot parse is refused, never stored with its metadata. Files
get generated names, live outside the web root, and leave only inside the export zip.

**Rate limits, with numbers.** Submit: **20 a minute** per address. The baseline's upload
default; an hourly limit would lock out a cohort on campus Wi-Fi behind one university
address. One upload is parsed at a time and up to **40** wait, so a rush cannot exhaust the
256 MB container. The committee download: **5 wrong passwords a minute** per address, then
429 for the rest of the minute. Addresses come from `CF-Connecting-IP` and are kept only as a
keyed HMAC, in memory.

**Bot protection.** Cloudflare Turnstile (managed) on the form, verified server-side against
`TURNSTILE_SECRET`, failing closed. A honeypot field as well. Compose refuses to start the
stack without `TURNSTILE_SECRET`.

**Retention and deletion.** The service deletes every file on the volume once
`DELETE_AFTER` (default 2027-01-31 23:59:59 ACDT) has passed, and the form answers 410. It
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

**Backups.** The volume is archived nightly by `nch-backup-all`, age-encrypted to the public
recipient and pushed to R2 with the write-only token.

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
- **HEIC refused, PNG and WebP orientation not kept.** A sideways PNG from a phone is
  possible but rare. The committee can rotate it.

## Lane A record (2026-09-29 to 2026-11-25)

A static page with no input, no accounts and no data, served by nginx through its own
Cloudflare Tunnel, with a view and click counter that keeps no address (2026-10-02).
