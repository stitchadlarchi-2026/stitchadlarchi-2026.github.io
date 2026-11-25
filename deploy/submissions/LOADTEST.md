# Load and failure testing — exhibition submissions

Run on 2026-11-26 against a full copy of the stack (`web`, `usage`, `submissions`)
on the production server, uploading to a separate R2 bucket, `stitch-uploads-test`.
Turnstile used Cloudflare's always-pass test secret. Each simulated student did
what the browser does: `/start`, upload every part straight to R2, `/complete`.

## The connection

| Direction | Measured | What uses it |
|---|---|---|
| Box → R2 (up) | 44 Mbit/s | the committee's exports, served from the box |
| R2 → box (down) | 368 Mbit/s | the transfer worker |

Students upload from their own connections, straight to R2, so neither number
limits them. The test drove all 300 students from this one box, so its 44 Mbit/s
uplink was saturated for the whole run. That is harsher than production, and it
is what found the problems listed below.

## Load

| Run | Result |
|---|---|
| 300 students at once, 2.2 GB in all (30 with 40 MB booklets in three parts) | **300 of 300 stored**; queue drained 2 s after the last upload; peak memory 86 MB of 512 MB; no restarts |
| Byte-for-byte check of all 600 stored PDFs against what was sent | 600 identical |
| Stored headshots carrying device data | 0 of 300 |
| One student, 1 GB booklet (64 parts) and 300 MB poster | stored; booklet came down in 24 s, poster in 10 s; peak memory 72 MB |
| `/start` under the burst | p50 5.8 s, p95 9.4 s (queued behind 900 R2 calls on a saturated uplink) |
| `/complete` under the burst | p50 1.3 s, p95 2.6 s |
| Exports after the burst | all three valid zips, 300 entries each, sheet 300 rows |
| Booklets export of 4.46 GB, 29 entries starting past 4 GiB | ZIP64 valid in Python `zipfile` and `unzip -t`, every CRC checked |

## Failures (20 checks, all passing)

Refused at start: a booklet over 1 GB; a booklet that is a JPEG; an 80 MB poster
image; a HEIC headshot; a missing file; no consent; a single name; a negative
size. Honeypot filled: answered as a success, nothing opened.

R2 refuses a part longer than the size signed into its URL (403). `/complete`
refuses a forged token, an unknown id, and missing parts (and asks the browser to
start again). JPEG bytes declared as a PDF booklet are refused at complete, and
that submission's uploads are removed from R2 at once. Two simultaneous completes
both succeed; a complete retried later still succeeds. One address is limited
after 120 requests a minute, with `Retry-After: 20`.

## Recovery

| Scenario | Result |
|---|---|
| Service restarted while a 300 MB booklet was coming down | resumed after restart; stored byte-identical; no temporary files left |
| Service cut off the network for 90 s mid-transfer | stalled transfer abandoned after 60 s, retried after the network returned; stored byte-identical |
| Open uploads at their limit; disk floor not met | `/start` answers 503, "try again in a few minutes" |
| Upload opened 30 hours ago and never completed | marked abandoned at start-up; its part URLs answer 404 |
| Deletion date passed | 3,837 files and R2 objects deleted in 12 s; volumes and bucket empty |
| Real browser (Chromium), real CORS, 3 files in 6 parts | all parts 200; ETags readable; stored; no page errors |

## Defects the testing found, fixed before deploy

1. Network errors on the service's own R2 calls failed 33 of 300 students
   outright. R2 calls are now retried on a dropped connection, a 5xx or a 429,
   with at most 24 in flight. Next run: 297 of 300, then 300 of 300.
2. Two transfers of the same submission finishing together collided on one
   temporary file name. Saves of a record now run one at a time, with unique names.
3. A Turnstile check that dropped on the network refused the student. It is
   now tried up to three times; a "no" from Cloudflare is still final.
4. A browser that lost the success answer to `/complete` and retried was told
   "not found". The completion token is now kept, so a retry gets "done".
5. A home connection that drops can leave a download hanging with nothing on it,
   for up to its three-hour timeout. A transfer that receives nothing for 60 s is
   now abandoned and retried.
6. A retried `/complete` while the first was still running could complete the
   same uploads twice. It now waits for the first.
