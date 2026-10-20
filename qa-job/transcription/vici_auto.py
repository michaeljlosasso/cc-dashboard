"""Cloud Run job `vicidial-call-transcription`: auto-transcribe recent VICIdial calls.

Every run picks up to BATCH_SIZE recordings for calls with a status in
VICIDIAL_STATUSES (default APPTBK) from the last LOOKBACK_DAYS that are not yet
in vicidial.call_transcripts, transcribes them with Google Speech v2 chirp_3
(2-speaker diarization, same as the Leadspedia pipeline) and writes them to
vicidial.call_transcripts, keyed on recording_id.

It never touches the calls.* (Leadspedia) tables. Same logic as
vici_transcribe.py (the on-demand script used by the vicidial-call-recording-pull
skill), so rows from either path are identical and neither re-transcribes the
other's work.

Retry rules:
- completed / no_speech rows are final.
- failed rows are retried after RETRY_HOURS (e.g. MP3 conversion still pending).
- recordings over MAX_SECONDS are recorded once as failed "too long" and skipped
  (BatchRecognize rejects audio over 20 minutes).
"""
import hashlib, json, os, re, time, uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import google.auth
import requests
from google.auth.transport.requests import AuthorizedSession
from google.cloud import bigquery, storage

PROJECT = os.environ.get("GCP_PROJECT", "ll-media-project")
TABLE = f"{PROJECT}.vicidial.call_transcripts"
BUCKET = "ll-media-project-call-recordings"
AUDIO_PROXY = "https://vicidial-audio-proxy-v3-fln7xiyq5a-uc.a.run.app"
SPEECH = "https://us-speech.googleapis.com/v2"
RECOGNIZER = f"projects/{PROJECT}/locations/us/recognizers/_"
MODEL = os.environ.get("SPEECH_MODEL", "chirp_3")
LANG = "en-US"
STATUSES = [s.strip() for s in os.environ.get("VICIDIAL_STATUSES", "APPTBK").split(",") if s.strip()]
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "25"))
RETRY_HOURS = int(os.environ.get("RETRY_HOURS", "2"))
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "1190"))
REQUESTED_BY = "job:vicidial-call-transcription"
# v4 (Oct 20 2026, Manny): booked-phone coverage. Besides APPTBK, also transcribe every call of
# MIN_BOOKED_SEC+ to a phone in leads.appt_setter_map placed from 1 day before it was set to 60 min
# after, whatever its disposition. The real booking conversation is often dispositioned
# RECYLE/DQ while the APPTBK row is a 2-second wrap-up, which left those bookings unscorable.
# Only bookings set on/after BOOKED_FROM (Eastern date). Empty disables.
BOOKED_FROM = os.environ.get("BOOKED_FROM", "2026-10-19").strip()
MIN_BOOKED_SEC = int(os.environ.get("MIN_BOOKED_SEC", "20"))

creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
bq = bigquery.Client(project=PROJECT, credentials=creds)
gcs = storage.Client(project=PROJECT, credentials=creds)
speech = AuthorizedSession(creds)


def log(event, **kw):
    print(json.dumps({"event": event, **kw}, default=str), flush=True)


CANDIDATES_SQL = f"""
WITH call_log AS (
  SELECT uniqueid, call_date, status, user, list_id, lead_id, phone_number, campaign_id, 1 AS pref FROM `{PROJECT}.vicidial.vicidial_log`
  WHERE call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + 1 DAY)
  UNION ALL
  SELECT uniqueid, call_date, status, user, list_id, lead_id, phone_number, campaign_id, 2 FROM `{PROJECT}.vicidial.vicidial_closer_log`
  WHERE call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + 1 DAY)
)
SELECT rl.recording_id, rl.vicidial_id AS uniqueid, rl.location, rl.length_in_sec, rl.start_time,
       vl.call_date, vl.status, vl.user, COALESCE(u.full_name, vl.user) AS agent_name,
       vl.list_id, TRIM(l.list_name) AS list_name, vl.campaign_id, vl.lead_id, vl.phone_number
FROM `{PROJECT}.vicidial.recording_log` rl
JOIN call_log vl ON vl.uniqueid = rl.vicidial_id
LEFT JOIN `{PROJECT}.vicidial.vicidial_lists` l ON CAST(l.list_id AS STRING) = CAST(vl.list_id AS STRING)
LEFT JOIN `{PROJECT}.vicidial.vicidial_users` u ON u.user = vl.user
WHERE (
    vl.status IN UNNEST(@statuses)
    OR (@bookedFrom != '' AND rl.length_in_sec >= @minBookedSec AND EXISTS (
      SELECT 1 FROM `{PROJECT}.leads.appt_setter_map` m
      WHERE m.set_at >= TIMESTAMP(@bookedFrom, 'America/New_York')
        AND RIGHT(REGEXP_REPLACE(IFNULL(m.phone, ''), r'[^0-9]', ''), 10)
            = RIGHT(REGEXP_REPLACE(IFNULL(vl.phone_number, ''), r'[^0-9]', ''), 10)
        -- call_date is Eastern wall-clock in a UTC-labelled TIMESTAMP; set_at is real UTC
        AND DATETIME(vl.call_date) BETWEEN DATETIME_SUB(DATETIME(m.set_at, 'America/New_York'), INTERVAL 1 DAY)
                                       AND DATETIME_ADD(DATETIME(m.set_at, 'America/New_York'), INTERVAL 60 MINUTE)))
  )
  AND REGEXP_CONTAINS(vl.user, r'^[0-9]+$')
  AND rl.location IS NOT NULL AND rl.location != ''
  AND rl.start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND NOT EXISTS (
    SELECT 1 FROM `{TABLE}` t
    WHERE t.recording_id = rl.recording_id
      AND (t.transcription_status IN ('completed', 'no_speech')
           OR STARTS_WITH(IFNULL(t.error_message, ''), 'too long')
           OR t.created_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @retryHours HOUR)))
QUALIFY ROW_NUMBER() OVER (PARTITION BY rl.recording_id ORDER BY vl.pref, vl.call_date DESC) = 1
ORDER BY rl.start_time DESC
LIMIT @batch
"""


def ms(d):
    if d is None:
        return None
    m = re.match(r"^([0-9.]+)s$", str(d))
    return int(float(m.group(1)) * 1000) if m else None


def normalize(result):
    parts, words = [], []
    for r in result.get("results", []):
        alt = (r.get("alternatives") or [{}])[0]
        if alt.get("transcript"):
            parts.append(alt["transcript"].strip())
        for w in alt.get("words") or []:
            if w.get("word"):
                words.append({"w": w["word"].strip(), "s": str(w.get("speakerLabel") or "UNKNOWN"),
                              "a": ms(w.get("startOffset")), "b": ms(w.get("endOffset"))})
    full = " ".join(parts).strip()
    segs, cur = [], None
    for w in words:
        if cur is None or cur["speaker"] != w["s"]:
            if cur:
                segs.append(cur)
            cur = {"segment_index": len(segs), "speaker": w["s"], "start_ms": w["a"], "end_ms": w["b"], "text": w["w"]}
        else:
            cur["text"] += " " + w["w"]
            cur["end_ms"] = w["b"] if w["b"] is not None else cur["end_ms"]
    if cur:
        segs.append(cur)
    if not segs and full:
        segs = [{"segment_index": 0, "speaker": "UNKNOWN", "start_ms": None, "end_ms": None, "text": full}]
    speakers = len({w["s"] for w in words if w["s"] != "UNKNOWN"})
    return full, segs, (len(words) or len(full.split())), speakers


def write_rows(rows):
    target = bq.get_table(TABLE)
    stage = f"{PROJECT}.vicidial._stg_auto_{uuid.uuid4().hex[:10]}"
    t = bigquery.Table(stage, schema=target.schema)
    t.expires = datetime.now(timezone.utc) + timedelta(hours=2)
    bq.create_table(t)
    try:
        bq.load_table_from_json(rows, stage, job_config=bigquery.LoadJobConfig(schema=target.schema)).result()
        # Replace earlier failed attempts; never overwrite a completed/no_speech row.
        bq.query(f"""DELETE FROM `{TABLE}` T WHERE T.transcription_status = 'failed'
                     AND EXISTS (SELECT 1 FROM `{stage}` S WHERE S.recording_id = T.recording_id AND S.transcript_version = T.transcript_version)""").result()
        bq.query(f"""INSERT INTO `{TABLE}` SELECT * FROM `{stage}` S
                     WHERE NOT EXISTS (SELECT 1 FROM `{TABLE}` T WHERE T.recording_id = S.recording_id AND T.transcript_version = S.transcript_version)""").result()
    finally:
        bq.delete_table(stage, not_found_ok=True)


def main():
    started = time.time()
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("statuses", "STRING", STATUSES),
        bigquery.ScalarQueryParameter("days", "INT64", LOOKBACK_DAYS),
        bigquery.ScalarQueryParameter("retryHours", "INT64", RETRY_HOURS),
        bigquery.ScalarQueryParameter("batch", "INT64", BATCH_SIZE),
        bigquery.ScalarQueryParameter("bookedFrom", "STRING", BOOKED_FROM),
        bigquery.ScalarQueryParameter("minBookedSec", "INT64", MIN_BOOKED_SEC),
    ])
    todo = [dict(r.items()) for r in bq.query(CANDIDATES_SQL, job_config=cfg).result()]
    log("vicidial_transcription_candidates", count=len(todo), statuses=STATUSES, lookbackDays=LOOKBACK_DAYS, bookedFrom=BOOKED_FROM)
    if not todo:
        log("vicidial_transcription_completed", status="no_op", seconds=round(time.time() - started, 1))
        return

    jobs = []
    for m in todo:
        when = m["call_date"] or m["start_time"]
        row = {"recording_id": m["recording_id"], "transcript_version": 1, "uniqueid": m["uniqueid"], "lead_id": m["lead_id"],
               "list_id": m["list_id"], "list_name": m["list_name"], "campaign_id": m["campaign_id"], "phone_number": m["phone_number"],
               "agent_user": m["user"], "agent_name": m["agent_name"], "call_status": m["status"],
               "call_date": when.isoformat() if when else None, "length_in_sec": m["length_in_sec"],
               "recording_location": m["location"], "provider": "google_cloud_speech_v2", "model": MODEL,
               "language_code": LANG, "requested_by": REQUESTED_BY, "segments": []}
        loc = m["location"] or ""
        if (m["length_in_sec"] or 0) > MAX_SECONDS:
            row.update(transcription_status="failed", error_message=f"too long ({m['length_in_sec']}s) - BatchRecognize limit is 20 min")
            jobs.append((row, None)); continue
        if not loc.lower().endswith(".mp3"):
            row.update(transcription_status="failed", error_message="not an .mp3 yet (VICIdial conversion pending) - retry later")
            jobs.append((row, None)); continue
        try:
            resp = requests.get(f"{AUDIO_PROXY}?path={quote(re.sub(r'^https?://[^/]+', '', loc), safe='')}", timeout=60)
            if resp.status_code != 200 or not resp.headers.get("content-type", "").startswith("audio"):
                raise RuntimeError(f"audio proxy {resp.status_code} {resp.headers.get('content-type')}")
            audio = resp.content
            key = f"vicidial/{(when or datetime.now(timezone.utc)):%Y/%m}/{m['recording_id']}.mp3"
            blob = gcs.bucket(BUCKET).blob(key)
            if not blob.exists():
                blob.upload_from_string(audio, content_type="audio/mpeg")
            uri = f"gs://{BUCKET}/{key}"
            row.update(gcs_uri=uri, audio_sha256=hashlib.sha256(audio).hexdigest(), audio_bytes=len(audio))
            body = {"config": {"autoDecodingConfig": {}, "languageCodes": [LANG], "model": MODEL,
                               "features": {"enableAutomaticPunctuation": True, "enableWordTimeOffsets": True,
                                            "diarizationConfig": {"minSpeakerCount": 2, "maxSpeakerCount": 2}}},
                    "files": [{"uri": uri}], "recognitionOutputConfig": {"inlineResponseConfig": {}}}
            r = speech.post(f"{SPEECH}/{RECOGNIZER}:batchRecognize", json=body, timeout=90)
            r.raise_for_status()
            jobs.append((row, r.json()["name"]))
        except Exception as e:
            row.update(transcription_status="failed", error_message=str(e)[:500])
            jobs.append((row, None))

    deadline = time.time() + 600
    pending = [j for j in jobs if j[1]]
    while pending and time.time() < deadline:
        time.sleep(10)
        still = []
        for row, op in pending:
            try:
                o = speech.get(f"{SPEECH}/{op}", timeout=60).json()
            except Exception:
                still.append((row, op)); continue
            if not o.get("done"):
                still.append((row, op)); continue
            res = (o.get("response", {}).get("results") or {}).get(row["gcs_uri"], {})
            if o.get("error") or res.get("error"):
                row.update(transcription_status="failed", error_message=json.dumps(o.get("error") or res.get("error"))[:500])
                continue
            transcript = res.get("transcript") or res.get("inlineResult", {}).get("transcript") or {}
            full, segs, wc, spk = normalize(transcript)
            # No transcript at all = silence / hold music: a final answer, not an error to retry forever.
            row.update(full_transcript=full or None, segments=segs, word_count=wc, speaker_count=spk,
                       transcription_status="completed" if full else "no_speech")
        pending = still
    for row, _ in pending:
        row.update(transcription_status="failed", error_message="speech operation still running after 10 min - retried next run")

    now = datetime.now(timezone.utc).isoformat()
    rows = [dict(r, created_at=now) for r, _ in jobs]
    write_rows(rows)
    counts = {}
    for r in rows:
        counts[r["transcription_status"]] = counts.get(r["transcription_status"], 0) + 1
    for r in rows:
        if r["transcription_status"] == "failed":
            log("vicidial_transcription_item_failed", recording_id=r["recording_id"], error=r.get("error_message"))
    log("vicidial_transcription_completed", status="success", seconds=round(time.time() - started, 1), **counts)


if __name__ == "__main__":
    main()
