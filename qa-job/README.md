# vicidial-appointment-qa (snapshot)

The Cloud Run job that scores booked appointments for Credit / Homeowners and writes
`vicidial.appointment_qa`. Its source wasn't in any repo this chat could reach, so this
folder is a copy pulled from the live image, kept here so rubric changes are reviewable.
The job is owned by its own chat; this is a reference copy, not the build source of truth.

- Live image (Oct 20 2026): `vicidial-appointment-qa:v3-1-20261020152559` — rubric v3 + fallback path.
- Built as a thin layer: `Dockerfile` = v1 image + `main.py` + `qa_rubric.md` + `qa_scorer.py`.
- Previous image: `v1-20261015191845` (rubric v2).

## v3 changes (Manny, Oct 20 2026)
- Credit: any yes to the credit question is a Pass, including hedged ones ("I think so",
  "probably", "absolutely"). Mangled thresholds ("1650") read as 650; questions worded as
  qualifying for tax credits / incentives count.
- Quote check: an ellipsis in a quote means text was skipped; each piece is verified on its
  own, so correctly trimmed quotes no longer get downgraded to Unclear/garbled.

## Re-score done Oct 20 2026
52 rows with credit = Unclear from the previous 14 days were backed up to
`leads.appointment_qa_backup_20261020`, deleted, and re-scored by the job under v3.

## Rollback
```
gcloud run jobs update vicidial-appointment-qa --region us-central1 \
  --image us-central1-docker.pkg.dev/ll-media-project/gcf-artifacts/vicidial-appointment-qa:v1-20261015191845
```
(Rows re-scored under v3 keep rubric_version='v3'; restore from the backup table if needed.)

## v3.1 — no more blanks (Oct 20 2026, Manny)
Bookings set on/after 2026-10-19 that still had no real score now always get one.
- **Transcription** (`vicidial-call-transcription`): its live code is NOT the image — it's the
  Secret Manager secret `vicidial-transcription-script`, mounted at /vici. Version 4 (copy in
  `transcription/vici_auto.py`) also transcribes every 20s+ call to a booked phone from 1 day
  before the set to 60 min after, any disposition (`BOOKED_FROM`, default 2026-10-19).
  Rollback: `gcloud run jobs update vicidial-call-transcription --region us-central1
  --update-secrets=/vici/vici_auto.py=vicidial-transcription-script:3`
- **Scorer** fallback (`score_fallback` in main.py, `FALLBACK_FROM`): for each appt_setter_map
  row with no scorable score: score those calls; else the text thread; else write Not Asked
  (no evidence). "Not scorable" on a known booking is recorded as Not Asked. Rows use
  appt_uniqueid `map-<phone>-<set_at>`.
- Dashboard join prefers a scorable row when a booking has more than one.
- First run filled Angela Wagner (Pass / Not Asked), Paul Wehrle, John Mcgee, Diana Campo (Not Asked).
