"""Cloud Run job `vicidial-appointment-qa`: score every booked VICIdial appointment.

Every run finds APPTBK transcripts in vicidial.call_transcripts (written by the
`vicidial-call-transcription` job) that have no row yet in vicidial.appointment_qa,
gathers every other transcribed call to the same phone in the PRIOR_DAYS before the
booking (call-backs, transfer legs), sends the whole conversation to the model (gpt-5 via the shared openai-api-key, or Claude) with
qa_rubric.md, verifies the quotes against the transcript, and writes ONE row per
appointment: Credit Confirmed and All Homeowners Present as
Pass / Fail / Unclear / Not Asked / Not Required (transfer accounts) / N/A.

Reads vicidial.* only. Writes vicidial.appointment_qa only. Never touches calls.*.

An appointment is scored when every recorded call to that phone in the window has a
final transcript row, or once the booking transcript is older than WAIT_HOURS —
whichever comes first — so a call-back that is still being transcribed is not missed.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

import google.auth
from google.cloud import bigquery

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qa_scorer as q  # noqa: E402

PROJECT = os.environ.get("GCP_PROJECT", "ll-media-project")
DS = f"{PROJECT}.vicidial"
QA_TABLE = f"{DS}.appointment_qa"
RULES_TABLE = f"{DS}.qa_list_rules"
TX_TABLE = f"{DS}.call_transcripts"
STATUSES = [s.strip() for s in os.environ.get("VICIDIAL_STATUSES", "APPTBK").split(",") if s.strip()]
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
PRIOR_DAYS = int(os.environ.get("PRIOR_DAYS", "7"))
AFTER_MINUTES = int(os.environ.get("AFTER_MINUTES", "60"))   # closer-log legs land after the APPTBK row
WAIT_HOURS = int(os.environ.get("WAIT_HOURS", "3"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
MIN_PRIOR_SEC = int(os.environ.get("MIN_PRIOR_SEC", "20"))
MODEL = os.environ.get("QA_MODEL", q.DEFAULT_MODEL)
RUN_DEADLINE_SEC = int(os.environ.get("RUN_DEADLINE_SEC", "780"))
# Text-booked appointments: leads.appt_setter_map rows with no booked dialer call are scored from
# the GHL text thread (sms.ghl_messages). Wait SMS_WAIT_HOURS so a late-landing dialer call wins.
SMS_ENABLED = os.environ.get("SMS_ENABLED", "1") == "1"
SMS_WAIT_HOURS = int(os.environ.get("SMS_WAIT_HOURS", "4"))
SMS_PRIOR_DAYS = int(os.environ.get("SMS_PRIOR_DAYS", "14"))
SMS_AFTER_HOURS = int(os.environ.get("SMS_AFTER_HOURS", "3"))
SMS_MAX_MESSAGES = int(os.environ.get("SMS_MAX_MESSAGES", "80"))
MAP_TABLE = f"{PROJECT}.leads.appt_setter_map"
MSG_TABLE = f"{PROJECT}.sms.ghl_messages"

creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
bq = bigquery.Client(project=PROJECT, credentials=creds)


def log(event: str, **kw):
    print(json.dumps({"event": event, **kw}, default=str), flush=True)


# One row per booked appointment that is not yet scored and is "ready" (all prior recorded
# calls have a final transcript row, or the booking transcript is older than WAIT_HOURS).
CANDIDATES_SQL = f"""
WITH appts AS (
  SELECT t.recording_id, t.uniqueid, t.phone_number, t.call_date, t.agent_user, t.agent_name, t.list_name, t.created_at
  FROM `{TX_TABLE}` t
  WHERE t.call_status IN UNNEST(@statuses) AND t.transcription_status = 'completed'
    AND t.call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    AND NOT EXISTS (SELECT 1 FROM `{QA_TABLE}` qa WHERE qa.appt_uniqueid = t.uniqueid)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY t.uniqueid ORDER BY t.length_in_sec DESC, t.recording_id) = 1
),
call_log AS (
  SELECT uniqueid, call_date, user, phone_number FROM `{DS}.vicidial_log`
  WHERE call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + @priorDays + 1 DAY)
  UNION ALL
  SELECT uniqueid, call_date, user, phone_number FROM `{DS}.vicidial_closer_log`
  WHERE call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + @priorDays + 1 DAY)
),
-- every recording we would want for each appointment
wanted AS (
  SELECT a.uniqueid AS appt_uniqueid, rl.recording_id
  FROM appts a
  JOIN call_log vl ON vl.phone_number = a.phone_number
    AND vl.call_date BETWEEN TIMESTAMP_SUB(a.call_date, INTERVAL @priorDays DAY) AND TIMESTAMP_ADD(a.call_date, INTERVAL @afterMin MINUTE)
  JOIN `{DS}.recording_log` rl ON rl.vicidial_id = vl.uniqueid
  WHERE REGEXP_CONTAINS(vl.user, r'^[0-9]+$') AND rl.location IS NOT NULL AND rl.location != ''
    AND (vl.uniqueid = a.uniqueid OR rl.length_in_sec >= @minPriorSec)
  GROUP BY 1, 2
),
readiness AS (
  SELECT w.appt_uniqueid,
         COUNT(*) AS wanted_n,
         COUNTIF(t.recording_id IS NOT NULL AND (t.transcription_status IN ('completed','no_speech')
                 OR STARTS_WITH(IFNULL(t.error_message,''), 'too long'))) AS final_n
  FROM wanted w
  LEFT JOIN `{TX_TABLE}` t ON t.recording_id = w.recording_id
  GROUP BY 1
)
SELECT a.*, r.wanted_n, r.final_n
FROM appts a JOIN readiness r ON r.appt_uniqueid = a.uniqueid
WHERE r.final_n >= r.wanted_n OR a.created_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @waitHours HOUR)
ORDER BY a.call_date DESC
LIMIT @batch
"""

CONVERSATION_SQL = f"""
SELECT t.recording_id, t.uniqueid, t.call_status, t.call_date, t.agent_name, t.list_name, t.length_in_sec,
       t.full_transcript, t.segments
FROM `{TX_TABLE}` t
WHERE t.phone_number = @phone AND t.transcription_status = 'completed'
  AND t.call_date BETWEEN TIMESTAMP_SUB(@apptDate, INTERVAL @priorDays DAY) AND TIMESTAMP_ADD(@apptDate, INTERVAL @afterMin MINUTE)
  AND (t.uniqueid = @apptUniqueid OR t.length_in_sec >= @minPriorSec)
ORDER BY t.call_date, t.recording_id
"""

RULES_SQL = f"SELECT list_name, is_transfer_account FROM `{RULES_TABLE}`"

# Appointments (Michael's table) with no booked dialer call near set_at, not a transfer account,
# not yet scored, with at least one homeowner text in the thread. Reads leads.* / sms.*; never writes them.
SMS_CANDIDATES_SQL = f"""
WITH m AS (
  SELECT DISTINCT RIGHT(REGEXP_REPLACE(phone, r'[^0-9]', ''), 10) AS phone10, set_at, setter, TRIM(account) AS account
  FROM `{MAP_TABLE}`
  WHERE set_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    AND set_at <= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @waitHours HOUR)
),
apptbk AS (
  SELECT RIGHT(phone_number, 10) AS phone10, TIMESTAMP(DATETIME(call_date), 'America/New_York') AS appt_at
  FROM `{DS}.vicidial_log` WHERE status IN UNNEST(@statuses)
    AND call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + 3 DAY)
  UNION ALL
  SELECT RIGHT(phone_number, 10), TIMESTAMP(DATETIME(call_date), 'America/New_York')
  FROM `{DS}.vicidial_closer_log` WHERE status IN UNNEST(@statuses)
    AND call_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + 3 DAY)
)
SELECT m.*, FORMAT_TIMESTAMP('%Y%m%d%H%M%S', m.set_at) AS set_compact,
       FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', m.set_at, 'America/New_York') AS set_et
FROM m
WHERE m.phone10 IS NOT NULL AND LENGTH(m.phone10) = 10
  AND m.account NOT IN (SELECT TRIM(list_name) FROM `{RULES_TABLE}` WHERE is_transfer_account)
  AND NOT EXISTS (SELECT 1 FROM apptbk a WHERE a.phone10 = m.phone10
                  AND a.appt_at BETWEEN TIMESTAMP_SUB(m.set_at, INTERVAL 2 DAY) AND TIMESTAMP_ADD(m.set_at, INTERVAL 1 DAY))
  AND NOT EXISTS (SELECT 1 FROM `{QA_TABLE}` qa
                  WHERE qa.appt_uniqueid = CONCAT('sms-', m.phone10, '-', FORMAT_TIMESTAMP('%Y%m%d%H%M%S', m.set_at)))
  AND EXISTS (SELECT 1 FROM `{MSG_TABLE}` g WHERE g.contact_phone10 = m.phone10 AND g.direction = 'inbound'
              AND g.date_added BETWEEN TIMESTAMP_SUB(m.set_at, INTERVAL @priorDays DAY) AND TIMESTAMP_ADD(m.set_at, INTERVAL @afterHours HOUR))
ORDER BY m.set_at DESC
LIMIT @batch
"""

SMS_THREAD_SQL = f"""
SELECT message_id, FORMAT_DATETIME('%Y-%m-%d %H:%M', date_added_et) AS sent_et, sender_type, direction, body
FROM `{MSG_TABLE}`
WHERE contact_phone10 = @phone AND message_type LIKE '%SMS%'
  AND date_added BETWEEN TIMESTAMP_SUB(@setAt, INTERVAL @priorDays DAY) AND TIMESTAMP_ADD(@setAt, INTERVAL @afterHours HOUR)
  AND IFNULL(TRIM(body), '') != ''
QUALIFY ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY pulled_at DESC) = 1
ORDER BY date_added, message_id
"""


def et_string(ts: datetime) -> str:
    # vicidial call_date is Eastern wall-clock stored in a UTC-labelled TIMESTAMP: format, never convert.
    return ts.strftime("%Y-%m-%d %H:%M:%S")


def load_conversation(appt: dict, rules: dict[str, bool]) -> q.Appointment:
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("phone", "STRING", appt["phone_number"]),
        bigquery.ScalarQueryParameter("apptDate", "TIMESTAMP", appt["call_date"]),
        bigquery.ScalarQueryParameter("apptUniqueid", "STRING", appt["uniqueid"]),
        bigquery.ScalarQueryParameter("priorDays", "INT64", PRIOR_DAYS),
        bigquery.ScalarQueryParameter("afterMin", "INT64", AFTER_MINUTES),
        bigquery.ScalarQueryParameter("minPriorSec", "INT64", MIN_PRIOR_SEC),
    ])
    calls = []
    for r in bq.query(CONVERSATION_SQL, job_config=cfg).result():
        segs = [{"speakerLabel": s.get("speaker"), "startOffsetMs": s.get("start_ms"), "text": s.get("text")}
                for s in (r["segments"] or [])]
        calls.append(q.CallTranscript(
            call_uuid=str(r["recording_id"]), uniqueid=r["uniqueid"], call_date_et=et_string(r["call_date"]),
            status=r["call_status"] or "", agent_name=r["agent_name"] or "", list_name=r["list_name"] or "",
            duration_sec=int(r["length_in_sec"] or 0), segments=segs, full_transcript=r["full_transcript"] or ""))
    # the booking call must be last in the prompt; move any same-uniqueid legs to the end in order
    booking = [c for c in calls if c.uniqueid == appt["uniqueid"]]
    others = [c for c in calls if c.uniqueid != appt["uniqueid"]]
    return q.Appointment(appt_uniqueid=appt["uniqueid"], phone_number=appt["phone_number"], calls=others + booking,
                         is_transfer_account=bool(rules.get((appt["list_name"] or "").strip(), False)))


def write_rows(rows: list[dict]):
    if not rows:
        return
    # Overlapping executions (a manual run + the scheduled one) can score the same appointment;
    # re-check right before writing so appointment_qa keeps one row per appt_uniqueid.
    ids = [r["appt_uniqueid"] for r in rows]
    cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter("ids", "STRING", ids)])
    existing = {r["appt_uniqueid"] for r in bq.query(
        f"SELECT appt_uniqueid FROM `{QA_TABLE}` WHERE appt_uniqueid IN UNNEST(@ids)", job_config=cfg).result()}
    if existing:
        log("appointment_qa_skip_already_scored", count=len(existing))
        rows = [r for r in rows if r["appt_uniqueid"] not in existing]
        if not rows:
            return
    target = bq.get_table(QA_TABLE)
    bq.load_table_from_json(rows, QA_TABLE, job_config=bigquery.LoadJobConfig(schema=target.schema)).result()


def load_sms_thread(c: dict) -> q.SmsThread:
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("phone", "STRING", c["phone10"]),
        bigquery.ScalarQueryParameter("setAt", "TIMESTAMP", c["set_at"]),
        bigquery.ScalarQueryParameter("priorDays", "INT64", SMS_PRIOR_DAYS),
        bigquery.ScalarQueryParameter("afterHours", "INT64", SMS_AFTER_HOURS),
    ])
    msgs = [dict(r.items()) for r in bq.query(SMS_THREAD_SQL, job_config=cfg).result()]
    return q.SmsThread(phone_number=c["phone10"], setter_name=c["setter"] or "", account=c["account"] or "",
                       booked_at_et=c["set_et"], messages=msgs[-SMS_MAX_MESSAGES:])


def score_sms(started: float, rows: list[dict]) -> int:
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("statuses", "STRING", STATUSES),
        bigquery.ScalarQueryParameter("days", "INT64", LOOKBACK_DAYS),
        bigquery.ScalarQueryParameter("waitHours", "INT64", SMS_WAIT_HOURS),
        bigquery.ScalarQueryParameter("priorDays", "INT64", SMS_PRIOR_DAYS),
        bigquery.ScalarQueryParameter("afterHours", "INT64", SMS_AFTER_HOURS),
        bigquery.ScalarQueryParameter("batch", "INT64", BATCH_SIZE),
    ])
    todo = [dict(r.items()) for r in bq.query(SMS_CANDIDATES_SQL, job_config=cfg).result()]
    log("appointment_qa_sms_candidates", count=len(todo))
    failures = 0
    for c in todo:
        if time.time() - started > RUN_DEADLINE_SEC:
            log("appointment_qa_deadline", phase="sms")
            break
        uid = q.sms_uniqueid(c["phone10"], c["set_compact"])
        try:
            thread = load_sms_thread(c)
            conv = q.Appointment(appt_uniqueid=uid, phone_number=c["phone10"], calls=[thread], channel="sms")
            result, _raw = q.score(conv, model=MODEL)
            row = q.build_row(conv, result, agent_user="", model=MODEL,
                              scored_at=datetime.now(timezone.utc).isoformat(),
                              appt_date=c["set_et"].replace(" ", "T"))
            rows.append(row)
            log("appointment_qa_sms_scored", uniqueid=uid, messages=len(thread.messages), credit=row["credit"],
                homeowners=row["homeowners"], booked_via=row["booked_via"])
        except Exception as e:
            failures += 1
            log("appointment_qa_item_failed", uniqueid=uid, error=str(e)[:500])
    return failures


def main():
    started = time.time()
    rules = {r["list_name"].strip(): bool(r["is_transfer_account"]) for r in bq.query(RULES_SQL).result()}
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("statuses", "STRING", STATUSES),
        bigquery.ScalarQueryParameter("days", "INT64", LOOKBACK_DAYS),
        bigquery.ScalarQueryParameter("priorDays", "INT64", PRIOR_DAYS),
        bigquery.ScalarQueryParameter("afterMin", "INT64", AFTER_MINUTES),
        bigquery.ScalarQueryParameter("minPriorSec", "INT64", MIN_PRIOR_SEC),
        bigquery.ScalarQueryParameter("waitHours", "INT64", WAIT_HOURS),
        bigquery.ScalarQueryParameter("batch", "INT64", BATCH_SIZE),
    ])
    todo = [dict(r.items()) for r in bq.query(CANDIDATES_SQL, job_config=cfg).result()]
    log("appointment_qa_candidates", count=len(todo), provider=q.PROVIDER, model=MODEL, rubric=q.RUBRIC_VERSION)
    rows, failures = [], 0
    for appt in todo:
        if time.time() - started > RUN_DEADLINE_SEC:
            log("appointment_qa_deadline", scored=len(rows), remaining=len(todo) - len(rows) - failures)
            break
        try:
            conv = load_conversation(appt, rules)
            if not conv.calls:
                raise RuntimeError("no completed transcript for the booking call")
            result, _raw = q.score(conv, model=MODEL)
            row = q.build_row(conv, result, agent_user=appt["agent_user"] or "", model=MODEL,
                              scored_at=datetime.now(timezone.utc).isoformat(),
                              appt_recording_id=int(appt["recording_id"]), appt_date=appt["call_date"].isoformat())
            rows.append(row)
            log("appointment_qa_scored", uniqueid=appt["uniqueid"], calls=len(conv.calls),
                credit=row["credit"], homeowners=row["homeowners"], needs_review=row["needs_review"])
        except Exception as e:  # one bad appointment never stops the run; it is retried next run
            failures += 1
            log("appointment_qa_item_failed", uniqueid=appt.get("uniqueid"), error=str(e)[:500])
    if SMS_ENABLED:
        failures += score_sms(started, rows)
    write_rows(rows)
    log("appointment_qa_completed", status="success", scored=len(rows), failed=failures,
        seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
