# Breach response — stitchexhibition.com

1. **Who decides:** the STITCH committee, as the organisation that collected the data, on advice from the operator, Bijin Johnson (NCH Consultancy), `info@nchconsultancy.com`. Committee contact: `stitch.adl.archi@gmail.com`.
2. **What is held:** graduates' full names, headshots (location and camera data removed), optional LinkedIn URLs and places of origin, and project overviews, on the volume `stitch-exhibition_submissions-data`. No passwords, no payment data, no contact details beyond LinkedIn.
3. **First hour:** if the attacker may still be in, stop the tunnel: `docker compose -p stitch-exhibition stop cloudflared`. Rotate `SUBMISSIONS_KEY` in `.env` and redeploy, which locks out the committee download. Check the `submissions` logs for `opened by` lines from unknown fingerprints.
4. **Assess within 30 days** (Notifiable Data Breaches scheme): was the volume, a backup **and** its age key, or the export zip exposed? Most of this data is collected for publication. Serious harm is unlikely unless unpublished overviews or places of origin leaked with names.
5. **Notify** if serious harm is likely: the OAIC form at https://www.oaic.gov.au/privacy/notifiable-data-breaches/report-a-data-breach and every affected graduate, through the committee.
6. **Notice template:**

> On <date> we found that <what happened>. The information involved was <your name, headshot, project overview, and the LinkedIn link and place of origin if you gave them>. No passwords or payment details were involved; the form did not collect any. We have <what was done>. Questions: stitch.adl.archi@gmail.com. You can also contact the OAIC at oaic.gov.au.

7. **Record** the incident on Jira project `STITCH` as a Bug.
