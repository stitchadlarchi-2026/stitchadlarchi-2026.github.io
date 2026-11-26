# Breach response — stitchexhibition.com

1. **Who decides:** the STITCH committee, as the organisation that collected the data, on advice from the operator, Bijin Johnson (NCH Consultancy), `info@nchconsultancy.com`. Committee contact: `stitch.adl.archi@gmail.com`.
2. **What is held:** graduates' full names and personal email addresses, their answers to "exhibit" and "Student Directory", black-and-white headshot tiles, project posters (PNG), optional LinkedIn, Instagram and website links and places of origin, and project overviews, on the volumes `stitch-exhibition_submissions-data` and `stitch-exhibition_submissions-files`, and in the R2 bucket `stitch-uploads` on NCH's Cloudflare account. No passwords, no payment data. The emails are contact details, never published: an exposure of them is the part most likely to be serious harm (phishing).
3. **First hour:** if the attacker may still be in, stop the tunnel: `docker compose -p stitch-exhibition stop cloudflared`. Rotate `SUBMISSIONS_KEY` in `.env` and redeploy, which locks out the committee download. Revoke the R2 token named "stitch-uploads (stitch-exhibition submissions service)" in the Cloudflare dashboard (Manage Account → Account API Tokens, on the NCH account) and mint a new one; outstanding upload URLs die with it. Check the `submissions` logs for `opened by` lines from unknown fingerprints.
4. **Assess within 30 days** (Notifiable Data Breaches scheme): was the volume, a backup **and** its age key, or the export zip exposed? Most of this data is collected for publication. Serious harm is unlikely unless unpublished overviews or places of origin leaked with names.
5. **Notify** if serious harm is likely: the OAIC form at https://www.oaic.gov.au/privacy/notifiable-data-breaches/report-a-data-breach and every affected graduate, through the committee.
6. **Notice template:**

> On <date> we found that <what happened>. The information involved was <your name, personal email, headshot, project overview, and the LinkedIn, Instagram and website links and place of origin if you gave them>. No passwords or payment details were involved; the form did not collect any. We have <what was done>. Questions: stitch.adl.archi@gmail.com. You can also contact the OAIC at oaic.gov.au.

7. **Record** the incident on Jira project `STITCH` as a Bug.
