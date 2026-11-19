"""
QA scorer: Credit Confirmed + All Homeowners Present, per booked appointment.

Input: one appointment = the APPTBK call plus every earlier recorded call to the same phone
(already transcribed, speaker segments in BigQuery). Output: one row for
`calls.vicidial_call_qa`. The model's quotes are verified against the transcript text before
anything is written — a quote that is not in the transcript downgrades the field to Unclear
and flags the row for human review. Pure functions, no network, except `score_with_claude`.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

RUBRIC_VERSION = "v4.3"  # v4.3 (Nov 19): stronger quote check; an unverified Fail stays Fail. v4.2 (Oct 30): any mention of the credit score = at least Unclear. v4.1 (Oct 30): stated number + any question after it = asked (financing question counts). v3: any yes to credit = Pass (hedged too). v4 (Oct 20): stated-only / unanswered = Not Asked (QA spiff)
RUBRIC_PATH = Path(__file__).with_name("qa_rubric.md")
SMS_RUBRIC_PATH = Path(__file__).with_name("qa_rubric_sms.md")
PROVIDER = os.environ.get("QA_PROVIDER", "openai")          # "openai" (gpt-5, same key as the Leadspedia analyzer) or "anthropic"
DEFAULT_MODEL = os.environ.get("QA_MODEL", "gpt-5" if PROVIDER == "openai" else "claude-sonnet-4-5")

VALUES = {"Pass", "Fail", "Unclear", "Not Asked", "N/A"}
CREDIT_REASONS = {"confirmed", "below_number", "no_clear_answer", "soft_answer", "garbled", "asked_financing", "stated_only", "not_asked", "not_scorable"}
HOMEOWNER_REASONS = {"confirmed", "acknowledged", "sole_owner", "owner_absent", "decision_maker_absent",
                     "bundled_with_credit", "no_acknowledgment", "ambiguous", "not_asked", "not_scorable"}
NOT_REQUIRED = "Not Required"


@dataclass
class CallTranscript:
    call_uuid: str
    uniqueid: str
    call_date_et: str          # "YYYY-MM-DD HH:MM:SS"
    status: str                # VICIdial disposition
    agent_name: str
    list_name: str
    duration_sec: int
    segments: list[dict]       # [{speakerLabel, startOffsetMs, text}] ordered
    full_transcript: str = ""

    def rendered(self, index: int) -> str:
        head = (f"### CALL {index} — {self.call_date_et} ET | disposition: {self.status} | "
                f"setter: {self.agent_name} | list: {self.list_name} | {self.duration_sec}s")
        if self.segments:
            body = "\n".join(
                f"[S{s.get('speakerLabel', '?')} {round((s.get('startOffsetMs') or 0) / 1000)}s] {s.get('text') or ''}"
                for s in self.segments)
        else:
            body = "[no speaker segments] " + (self.full_transcript or "")
        return head + "\n" + body


SMS_ROLE = {"human": "SETTER", "closebot": "BOT", "app_other": "BOT", "revive": "BOT",
            "workflow": "AUTO", "missed_call_textback": "AUTO", "homeowner": "HOMEOWNER"}


@dataclass
class SmsThread:
    """A GHL text thread rendered like a call so the same rubric/verification apply."""
    phone_number: str
    setter_name: str
    account: str
    booked_at_et: str          # "YYYY-MM-DD HH:MM:SS" (appt_setter_map.set_at in ET)
    messages: list[dict]       # [{message_id, sent_et, sender_type, direction, body}] chronological

    @property
    def message_ids(self) -> list[str]:
        return [m["message_id"] for m in self.messages]

    def rendered(self, index: int) -> str:
        head = (f"### TEXT THREAD {index} — appointment logged {self.booked_at_et} ET | setter credited: "
                f"{self.setter_name} | account: {self.account} | {len(self.messages)} messages")
        lines = []
        for i, m in enumerate(self.messages, 1):
            role = SMS_ROLE.get(m.get("sender_type") or "",
                                "HOMEOWNER" if m.get("direction") == "inbound" else "AUTO")
            body = " ".join((m.get("body") or "").split())
            lines.append(f"[TEXT {i} · {m.get('sent_et')} · {role}] {body}")
        return head + "\n" + "\n".join(lines)


@dataclass
class Appointment:
    appt_uniqueid: str         # uniqueid of the APPTBK call
    phone_number: str
    calls: list                   # CallTranscript list (last = APPTBK call), or [SmsThread]
    is_transfer_account: bool = False
    channel: str = "call"         # "call" | "sms"


def load_rubric() -> str:
    return RUBRIC_PATH.read_text(encoding="utf-8")


def build_prompt(appt: Appointment) -> str:
    convo = "\n\n".join(c.rendered(i + 1) for i, c in enumerate(appt.calls))
    if appt.channel == "sms":
        return (load_rubric() + "\n\n" + SMS_RUBRIC_PATH.read_text(encoding="utf-8")
                + "\n\n---\n\n# Conversation to score\n\n"
                f"Phone: {appt.phone_number} · text thread, oldest message first. No dialer call booked this "
                "appointment.\n\n" + convo)
    return (load_rubric() + "\n\n---\n\n# Conversation to score\n\n"
            f"Phone: {appt.phone_number} · {len(appt.calls)} call(s), oldest first; call {len(appt.calls)} "
            "is the one dispositioned appointment booked.\n\n" + convo)


# ---------------------------------------------------------------- parsing + verification

_JSON_RE = re.compile(r"\{.*\}", re.S)


def parse_response(text: str) -> dict[str, Any]:
    m = _JSON_RE.search(text or "")
    if not m:
        raise ValueError("no JSON object in model response")
    d = json.loads(m.group(0))
    for key, allowed in (("credit", VALUES), ("homeowners", VALUES)):
        if d.get(key) not in allowed:
            raise ValueError(f"{key} has invalid value {d.get(key)!r}")
    if d.get("credit_reason") not in CREDIT_REASONS:
        raise ValueError(f"credit_reason invalid: {d.get('credit_reason')!r}")
    if d.get("homeowners_reason") not in HOMEOWNER_REASONS:
        raise ValueError(f"homeowners_reason invalid: {d.get('homeowners_reason')!r}")
    if d.get("scorable") not in ("YES", "NO"):
        raise ValueError("scorable must be YES or NO")
    return d


_TS_RE = re.compile(r"\[S\d+ \d+s\]|\[TEXT \d+ · [^\]]*\]")


# Speaker labels the model sometimes adds to a quote ("Setter:", "Homeowner:", "S1:") and the
# thread labels in the prompt. Stripped on both sides, any case (v4.3: the scorer was quoting
# 'Setter: "…" Homeowner: "…"' and every such quote failed the check).
_ROLE_RE = re.compile(r"(?i)\b(?:setter|bot|auto|homeowner|customer|agent|caller|speaker\s*\d+|s\d+)\s*:")
_FILLER = {"uh", "um", "uhm", "erm", "mhm", "hmm"}


def _norm(text: str) -> list[str]:
    text = _ROLE_RE.sub(" ", _TS_RE.sub(" ", text or "")).lower()
    text = re.sub(r"[‘’']", "", text)          # it's / it’s -> its on both sides
    return [w for w in re.sub(r"[^a-z0-9áéíóúñü]+", " ", text).split() if w not in _FILLER]


def quote_in_transcript(quote: str | None, transcript_text: str, min_hit: float = 0.6) -> bool:
    """True if ≥60% of the quote's word-runs appear verbatim in the (normalised) transcript.

    The quote is split where the model skipped or joined text (… / " — " / quote marks), and
    each piece is checked on its own: 4-word runs for longer pieces, the whole piece for a
    2–3 word reply ("Oh, yeah."). Filler words (uh, um) are ignored on both sides because the
    model tidies them out. Tested Nov 19 2026 on 22 real quotes the old check rejected (20 now
    pass; the 2 left really were paraphrased) and on 608 quotes from other calls (2 false
    matches, both a setter's stock line that appears on many of his calls).
    """
    if not quote:
        return True
    full = " " + " ".join(_norm(transcript_text)) + " "
    grams: list[str] = []
    for piece in re.split(r"\.\.\.|…|\s[—–-]\s|\s/\s|[\"“”]", quote):
        words = _norm(piece)
        if len(words) >= 4:
            grams += [" ".join(words[i:i + 4]) for i in range(len(words) - 3)]
        elif len(words) >= 2:
            grams.append(" ".join(words))
    if not grams:
        return False
    return sum((" " + g + " ") in full for g in grams) / len(grams) >= min_hit


def verify(result: dict[str, Any], appt: Appointment) -> dict[str, Any]:
    """Downgrade any field whose quote is not in the transcript; mark the row for review."""
    text = "\n".join(c.rendered(i + 1) for i, c in enumerate(appt.calls))
    out = dict(result)
    out["needs_review"] = False
    out["review_reason"] = None
    for f in ("credit", "homeowners"):
        if out.get(f) in ("Pass", "Fail", "Unclear") and not quote_in_transcript(out.get(f"{f}_quote"), text):
            # v4.3 (Manny, Nov 19 2026): an unverified quote must never make a score BETTER.
            # A Pass we can't verify drops to Unclear (don't pay for a yes we can't see), but a
            # Fail stays a Fail and is flagged; it used to become Unclear and pay $1 for a
            # homeowner who said "590" (Travis Crouse, Nov 18).
            if out.get(f) == "Pass":
                out[f] = "Unclear"
                out[f"{f}_reason"] = "garbled" if f == "credit" else "ambiguous"
            out["needs_review"] = True
            out["review_reason"] = (out["review_reason"] or "") + f"{f} quote not found in transcript; "
    if out.get("credit") == "Fail" or out.get("homeowners") == "Fail":
        out["needs_review"] = True
        out["review_reason"] = (out["review_reason"] or "") + "Fail — listen before acting; "
    return out


# ---------------------------------------------------------------- model call

def _nullable(t: str) -> list[str]:
    return [t, "null"]


OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "scorable": {"type": "string", "enum": ["YES", "NO"]},
        "scorable_reason": {"type": _nullable("string")},
        "credit": {"type": "string", "enum": ["Pass", "Fail", "Unclear", "Not Asked", "N/A"]},
        "credit_reason": {"type": "string", "enum": sorted(CREDIT_REASONS)},
        "credit_threshold_stated": {"type": _nullable("integer")},
        "credit_quote": {"type": _nullable("string")},
        "credit_call": {"type": _nullable("integer")},
        "credit_sec": {"type": _nullable("integer")},
        "homeowners": {"type": "string", "enum": ["Pass", "Fail", "Unclear", "Not Asked", "N/A"]},
        "homeowners_reason": {"type": "string", "enum": sorted(HOMEOWNER_REASONS)},
        "homeowners_quote": {"type": _nullable("string")},
        "homeowners_call": {"type": _nullable("integer")},
        "homeowners_sec": {"type": _nullable("integer")},
        "notes": {"type": _nullable("string")},
    },
    "required": ["scorable", "scorable_reason", "credit", "credit_reason", "credit_threshold_stated", "credit_quote",
                 "credit_call", "credit_sec", "homeowners", "homeowners_reason", "homeowners_quote", "homeowners_call",
                 "homeowners_sec", "notes"],
}


def score_with_openai(appt: Appointment, model: str = DEFAULT_MODEL, api_key: str | None = None) -> tuple[dict[str, Any], str]:
    """Same call shape as the Leadspedia V3 analyzer (gpt-5, strict JSON schema, medium reasoning)."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key or os.environ["OPENAI_API_KEY"])
    rubric, convo = build_prompt(appt).split("\n\n---\n\n", 1)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": rubric}, {"role": "user", "content": convo}],
        response_format={"type": "json_schema",
                         "json_schema": {"name": "appointment_qa_v2", "strict": True, "schema": OUTPUT_SCHEMA}},
        max_completion_tokens=8000,  # v4.1: long calls ran out at 3000 (reasoning) and returned no content
        reasoning_effort="medium",
    )
    if not resp.choices or not resp.choices[0].message.content:
        raise ValueError("model returned no content")
    raw = resp.choices[0].message.content
    return verify(parse_response(raw), appt), raw


def score_with_claude(appt: Appointment, model: str = DEFAULT_MODEL, api_key: str | None = None) -> tuple[dict[str, Any], str]:
    """Returns (parsed+verified result, raw model text). Requires the `anthropic` package."""
    import anthropic  # local import so the pure functions above stay importable without it

    client = anthropic.Anthropic(api_key=api_key or os.environ["ANTHROPIC_API_KEY"])
    msg = client.messages.create(
        model=model, max_tokens=1200, temperature=0,
        messages=[{"role": "user", "content": build_prompt(appt)}],
    )
    raw = "".join(getattr(b, "text", "") for b in msg.content)
    return verify(parse_response(raw), appt), raw


def score(appt: Appointment, model: str = DEFAULT_MODEL) -> tuple[dict[str, Any], str]:
    return (score_with_openai if PROVIDER == "openai" else score_with_claude)(appt, model=model)


# ---------------------------------------------------------------- BigQuery row

QA_TABLE = "vicidial.appointment_qa"
QA_SCHEMA = [
    ("appt_uniqueid", "STRING"), ("appt_recording_id", "INT64"), ("phone_number", "STRING"),
    ("appt_date", "TIMESTAMP"), ("agent_user", "STRING"), ("agent_name", "STRING"), ("list_name", "STRING"),
    ("calls_scored", "INT64"), ("recording_ids", "ARRAY<INT64>"),
    ("is_transfer_account", "BOOL"), ("scorable", "STRING"), ("scorable_reason", "STRING"),
    ("credit", "STRING"), ("credit_reason", "STRING"), ("credit_threshold_stated", "INT64"),
    ("credit_quote", "STRING"), ("credit_call", "INT64"), ("credit_sec", "INT64"),
    ("homeowners", "STRING"), ("homeowners_reason", "STRING"),
    ("homeowners_quote", "STRING"), ("homeowners_call", "INT64"), ("homeowners_sec", "INT64"),
    ("notes", "STRING"), ("needs_review", "BOOL"), ("review_reason", "STRING"),
    ("model", "STRING"), ("rubric_version", "STRING"), ("scored_at", "TIMESTAMP"),
    ("booked_via", "STRING"), ("sms_message_ids", "ARRAY<STRING>"),
]


def _int_or_none(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def build_row(appt: Appointment, result: dict[str, Any], *, agent_user: str, model: str, scored_at: str,
              appt_recording_id: int | None = None, appt_date: str | None = None) -> dict[str, Any]:
    r = dict(result)
    if appt.channel == "sms":
        return _build_sms_row(appt, r, model=model, scored_at=scored_at, appt_date=appt_date)
    last = appt.calls[-1]
    if appt.is_transfer_account:
        # Transfer accounts: nothing for the setter to ask. Keep the model's view in the quote
        # columns for audit, but the headline value is Not Required.
        r["credit"], r["homeowners"] = NOT_REQUIRED, NOT_REQUIRED
        r["credit_reason"], r["homeowners_reason"] = "transfer_account", "transfer_account"
        r["needs_review"] = False
    return {
        "appt_uniqueid": appt.appt_uniqueid,
        "appt_recording_id": _int_or_none(appt_recording_id if appt_recording_id is not None else last.call_uuid),
        "phone_number": appt.phone_number,
        "appt_date": appt_date or last.call_date_et.replace(" ", "T"),
        "agent_user": agent_user, "agent_name": last.agent_name, "list_name": last.list_name,
        "calls_scored": len(appt.calls),
        "recording_ids": [v for v in (_int_or_none(c.call_uuid) for c in appt.calls) if v is not None],
        "is_transfer_account": appt.is_transfer_account,
        "scorable": r.get("scorable"), "scorable_reason": r.get("scorable_reason"),
        "credit": r.get("credit"), "credit_reason": r.get("credit_reason"),
        "credit_threshold_stated": _int_or_none(r.get("credit_threshold_stated")),
        "credit_quote": r.get("credit_quote"), "credit_call": _int_or_none(r.get("credit_call")),
        "credit_sec": _int_or_none(r.get("credit_sec")),
        "homeowners": r.get("homeowners"), "homeowners_reason": r.get("homeowners_reason"),
        "homeowners_quote": r.get("homeowners_quote"), "homeowners_call": _int_or_none(r.get("homeowners_call")),
        "homeowners_sec": _int_or_none(r.get("homeowners_sec")),
        "notes": r.get("notes"), "needs_review": bool(r.get("needs_review")), "review_reason": r.get("review_reason"),
        "model": model, "rubric_version": RUBRIC_VERSION, "scored_at": scored_at,
        "booked_via": "Call", "sms_message_ids": [],
    }


def sms_uniqueid(phone10: str, set_at_compact: str) -> str:
    return f"sms-{phone10}-{set_at_compact}"


def _build_sms_row(appt: Appointment, r: dict[str, Any], *, model: str, scored_at: str,
                   appt_date: str | None) -> dict[str, Any]:
    t = appt.calls[0]
    msg_n = lambda v: _int_or_none(v)  # *_sec holds the message number for text threads
    return {
        "appt_uniqueid": appt.appt_uniqueid, "appt_recording_id": None, "phone_number": appt.phone_number,
        "appt_date": appt_date or t.booked_at_et.replace(" ", "T"),
        "agent_user": None, "agent_name": t.setter_name, "list_name": t.account,
        "calls_scored": 0, "recording_ids": [], "is_transfer_account": appt.is_transfer_account,
        "scorable": r.get("scorable"), "scorable_reason": r.get("scorable_reason"),
        "credit": r.get("credit"), "credit_reason": r.get("credit_reason"),
        "credit_threshold_stated": _int_or_none(r.get("credit_threshold_stated")),
        "credit_quote": r.get("credit_quote"), "credit_call": None, "credit_sec": msg_n(r.get("credit_sec")),
        "homeowners": r.get("homeowners"), "homeowners_reason": r.get("homeowners_reason"),
        "homeowners_quote": r.get("homeowners_quote"), "homeowners_call": None,
        "homeowners_sec": msg_n(r.get("homeowners_sec")),
        "notes": r.get("notes"), "needs_review": bool(r.get("needs_review")), "review_reason": r.get("review_reason"),
        "model": model, "rubric_version": RUBRIC_VERSION, "scored_at": scored_at,
        # a thread with no booking conversation in it is not evidence it was booked by text
        "booked_via": "Text" if r.get("scorable") == "YES" else "Unknown",
        "sms_message_ids": t.message_ids,
    }


def qa_table_ddl(project: str = "ll-media-project") -> str:
    cols = ",\n  ".join(f"{n} {t}" for n, t in QA_SCHEMA)
    return (f"CREATE TABLE IF NOT EXISTS `{project}.{QA_TABLE}` (\n  {cols}\n)\n"
            "PARTITION BY DATE(appt_date) CLUSTER BY agent_name, list_name")
