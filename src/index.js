/**
 * cc-dashboard — LL.Media Contact Center dashboard (payroll + hours).
 *
 * Static assets (frame + sub-widgets) come from Workers Assets; /api/* is
 * handled here. The Worker signs a Google service-account JWT with Web Crypto,
 * exchanges it for an access token, and queries BigQuery directly. Results are
 * cached at the edge for CACHE_SECONDS.
 *
 * Everything is behind a shared passcode:
 *   POST /api/login {passcode} -> sets an HttpOnly session cookie.
 *
 * Secrets required:
 *   GCP_SA_KEY     — full service-account JSON, as a string (bigquery.readonly)
 *   DASH_PASSCODE  — the shared passcode agents use to open the dashboard
 */

// Shared weekly spiff rules (same file the Commission/Spiffs tabs load).
// Side-effect import: it sets globalThis.SpiffRules.
import "../public/widgets/shared/spiff-rules.js";

const PROJECT = "ll-media-project";
const CACHE_SECONDS = 120; // 2 min — short enough that spiff/rate edits show up fast everywhere
// Read/write scope: admin endpoints INSERT into cc_spiffs / cc_config.
const TOKEN_SCOPE = "https://www.googleapis.com/auth/bigquery";
const COOKIE_NAME = "cc_session";
const COOKIE_DAYS = 30;

/* ------------------------------------------------------------------ auth */

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

let cachedToken = null;

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  if (!env.GCP_SA_KEY) throw new Error("GCP_SA_KEY secret is not set");
  const sa = JSON.parse(env.GCP_SA_KEY);

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: TOKEN_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(
    new TextEncoder().encode(JSON.stringify(claim))
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(sig)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

/* --------------------------------------------------------- session gate */

async function sessionValue(env) {
  // Deterministic token derived from the passcode; rotating the passcode
  // invalidates every outstanding cookie.
  const data = new TextEncoder().encode(`cc-dashboard|v1|${env.DASH_PASSCODE}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  const m = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// Two logins, one screen (Manny, Oct 20 2026): the agents' DASH_PASSCODE gives
// the agent view; Manny's ADMIN_PASSCODE gives the admin view. Which one you
// typed is baked into the cookie, so the server — never the browser — decides
// whether admin-only data is sent. Changing one password signs out only the
// people who used that password.
async function adminSessionValue(env) {
  const data = new TextEncoder().encode(`cc-dashboard|admin|v1|${env.ADMIN_PASSCODE}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdminSession(request, env) {
  if (!env.ADMIN_PASSCODE) return false;
  const c = getCookie(request, COOKIE_NAME);
  return c !== null && c === (await adminSessionValue(env));
}

async function isAuthed(request, env) {
  if (!env.DASH_PASSCODE) return true; // gate disabled until secret is set
  const c = getCookie(request, COOKIE_NAME);
  if (c === null) return false;
  return c === (await sessionValue(env)) || (await isAdminSession(request, env));
}

/* -------------------------------------------------------------- bigquery */

async function bq(env, sql) {
  const token = await getAccessToken(env);
  const resp = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        location: "US",
        timeoutMs: 60000,
        maxResults: 100000,
      }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`bigquery: ${resp.status} ${JSON.stringify(data.error || data)}`);
  }
  if (data.jobComplete === false) throw new Error("bigquery: query timed out");
  const fields = (data.schema?.fields || []).map((f) => f.name);
  const rows = (data.rows || []).map((r) => r.f.map((c) => c.v));
  return { fields, rows };
}

/* ------------------------------------------------------------------ data */

// Human agents are 20XX users. Owner (2001 / Michael LoSasso) is excluded
// from payroll, matching the appointment-setter payout convention.
const AGENT_RE = "^20[0-9]{2}$";
const EXCLUDED_USERS = "('2001')";

// Setter-name normalization applied inside SQL: one agent, one name.
// Add future aliases here (lowercased) -> canonical lowercased name.
const SETTER_ALIAS_SQL = `
  CASE
    WHEN LOWER(TRIM(setter)) IN ('andres anaya', 'andres estrada') THEN 'andres estrada'
    ELSE LOWER(TRIM(setter))
  END`;

// Junk/test leads that must never reach payroll. Leadspedia's own isTest flag
// misses these — they post as real leads with a placeholder name or from an
// internal phone. Found Aug 22 2026: two "n a" rows on 4013013422 (Manny's own
// number) on Aug 15 were paying Felix $10 he never earned.
const TEST_PHONES = "('4013013422')";
// "Convertros Call" leads are calls that rang Pella directly and were posted
// back into Leadspedia — no setter of ours booked them, so they pay no one
// (Manny, Oct 20 2026). They used to inherit a setter from an earlier booking
// or dial to the same phone (e.g. Jon, Oct 12). Applied from the first unpaid
// sets week (Oct 12) so already-paid weeks don't shift; the lead still shows
// on the Appointments tab, just Unattributed.
const CONVERTROS_FROM = "2026-10-12";
const isConvertrosSql = (alias) => `(${alias}.createdOn >= DATETIME '${CONVERTROS_FROM}'
    AND REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(${alias}.first_name,''), ' ', IFNULL(${alias}.last_name,''))), r'convertros'))`;

const JUNK_LEAD_SQL = `
    AND REGEXP_REPLACE(IFNULL(phone_home,''), r'\\D', '') NOT IN ${TEST_PHONES}
    AND LOWER(TRIM(CONCAT(IFNULL(first_name,''), ' ', IFNULL(last_name,''))))
        NOT IN ('n a', 'na', 'test test', 'test', 'a a')`;

// Appointments = sold affiliate-212 (HomeLynk CC) leads. appt_setter is not
// synced to BigQuery, so attribution priority is:
//   1. leads.appt_setter_map (CSV backfill by leadID, Make rows by phone+date)
//   2. VICIdial phone match (outbound + inbound closer, APPTBK preferred)
//   3. unattributed
const SQL_APPTS = `
WITH sold AS (
  SELECT leadID,
         RIGHT(REGEXP_REPLACE(IFNULL(phone_home,''), r'\\D', ''), 10) AS ph,
         createdOn, sold, phone_home, email_address,
         campaignName, first_name, last_name, city, state
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND IFNULL(isTest,'No') != 'Yes'  -- unsold appts count too (Manny, Aug 7 2026)
    AND createdOnDate >= '2026-01-01'${JUNK_LEAD_SQL}
),
agent_calls AS (
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10) AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  UNION ALL
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10) AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_closer_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
)
SELECT
  FORMAT_DATETIME('%Y-%m-%d', s.createdOn) AS booked_date,
  IF(s.createdOn >= DATETIME '${CONVERTROS_FROM}'
     AND REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(ANY_VALUE(s.first_name),''), ' ', IFNULL(ANY_VALUE(s.last_name),''))), r'convertros'), NULL,
  ARRAY_AGG(c.user
    ORDER BY IF(c.status='APPTBK',0,1),
             ABS(TIMESTAMP_DIFF(c.call_date, TIMESTAMP(s.createdOn), SECOND))
    LIMIT 1)[SAFE_OFFSET(0)]) AS agent_user,
  ANY_VALUE(s.campaignName) AS campaign,
  ANY_VALUE(s.first_name) AS first_name,
  ANY_VALUE(s.last_name) AS last_name,
  ANY_VALUE(s.city) AS city,
  ANY_VALUE(s.state) AS state,
  ANY_VALUE(s.sold) AS sold,
  ANY_VALUE(s.phone_home) AS phone,
  ANY_VALUE(s.email_address) AS email,
  CAST(NULL AS STRING) AS appt_at,
  s.leadID AS lead_id
FROM sold s
LEFT JOIN agent_calls c ON c.ph = s.ph
GROUP BY s.leadID, s.createdOn
ORDER BY booked_date
`;

// v2 — setter map first, phone-match fallback. Used when leads.appt_setter_map
// exists; buildPayload falls back to SQL_APPTS if this errors (table missing).
const SQL_APPTS_V2 = `
WITH sold AS (
  SELECT leadID,
         RIGHT(REGEXP_REPLACE(IFNULL(phone_home,''), r'\\D', ''), 10) AS ph,
         createdOn, sold, phone_home, email_address,
         -- Leadspedia's createdOn is Eastern wall-clock time; the Make feed's
         -- set_at is a real UTC timestamp. Reading createdOn as UTC put them
         -- 4 hours apart and, for a phone booked twice in one day, matched
         -- the wrong setter (Oct 13: Felix's GES Bath went to Bernardo).
         -- Corrected from the first unpaid week (Oct 5, 2026) onward ONLY:
         -- earlier weeks are already paid as originally attributed, and with
         -- no payroll snapshots a global fix would rewrite paid history
         -- (27 bookings back to April). Don't move this cutoff earlier.
         TIMESTAMP(createdOn, IF(createdOn >= DATETIME '2026-10-05', 'America/New_York', 'UTC')) AS created_ts,
         campaignName, first_name, last_name, city, state
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND IFNULL(isTest,'No') != 'Yes'  -- unsold appts count too (Manny, Aug 7 2026)
    AND createdOnDate >= '2026-01-01'${JUNK_LEAD_SQL}
),
map AS (
  SELECT leadID AS map_lead_id,
         RIGHT(REGEXP_REPLACE(IFNULL(phone,''), r'\\D', ''), 10) AS ph,
         set_at, appointment_at,
         ${SETTER_ALIAS_SQL} AS setter_key
  FROM \`${PROJECT}.leads.appt_setter_map\`
  WHERE setter IS NOT NULL
),
users AS (
  SELECT LOWER(TRIM(full_name)) AS fn, ANY_VALUE(user) AS user
  FROM \`${PROJECT}.vicidial.vicidial_users\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  GROUP BY fn
),
agent_calls AS (
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10) AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  UNION ALL
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10) AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_closer_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
),
picked AS (
  SELECT
    s.leadID, s.createdOn,
    ANY_VALUE(s.campaignName) AS campaign,
    ANY_VALUE(s.first_name) AS first_name,
    ANY_VALUE(s.last_name) AS last_name,
    ANY_VALUE(s.city) AS city,
    ANY_VALUE(s.state) AS state,
    ANY_VALUE(s.sold) AS sold,
    ANY_VALUE(s.phone_home) AS phone,
    ANY_VALUE(s.email_address) AS email,
    ARRAY_AGG(mi.setter_key IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] AS set_by_id,
    ARRAY_AGG(mp.setter_key IGNORE NULLS
      ORDER BY ABS(TIMESTAMP_DIFF(mp.set_at, s.created_ts, SECOND))
      LIMIT 1)[SAFE_OFFSET(0)] AS set_by_phone,
    -- Appointment time comes from whichever map row matched this lead, ordered
    -- the same way, so a repeat caller can't inherit a later booking's date.
    ARRAY_AGG(mi.appointment_at IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] AS appt_at_id,
    ARRAY_AGG(mp.appointment_at IGNORE NULLS
      ORDER BY ABS(TIMESTAMP_DIFF(mp.set_at, s.created_ts, SECOND))
      LIMIT 1)[SAFE_OFFSET(0)] AS appt_at_phone,
    ARRAY_AGG(c.user IGNORE NULLS
      ORDER BY IF(c.status='APPTBK',0,1),
               ABS(TIMESTAMP_DIFF(c.call_date, TIMESTAMP(s.createdOn), SECOND))
      LIMIT 1)[SAFE_OFFSET(0)] AS call_user
  FROM sold s
  LEFT JOIN map mi ON mi.map_lead_id = s.leadID
  LEFT JOIN map mp ON mp.ph = s.ph
    AND ABS(TIMESTAMP_DIFF(mp.set_at, s.created_ts, HOUR)) <= 168
  LEFT JOIN agent_calls c ON c.ph = s.ph
  GROUP BY s.leadID, s.createdOn
)
SELECT
  FORMAT_DATETIME('%Y-%m-%d', p.createdOn) AS booked_date,
  IF(${isConvertrosSql("p")}, NULL, COALESCE(u.user, p.call_user)) AS agent_user,
  p.campaign, p.first_name, p.last_name, p.city, p.state, p.sold, p.phone, p.email,
  FORMAT_DATETIME('%Y-%m-%d %H:%M', COALESCE(p.appt_at_id, p.appt_at_phone)) AS appt_at,
  p.leadID AS lead_id
FROM picked p
LEFT JOIN users u ON u.fn = COALESCE(p.set_by_id, p.set_by_phone)
ORDER BY booked_date
`;

// Call QA for the Appointments table (Credit / Homeowner pills). Scores come
// from vicidial.appointment_qa (written by the vicidial-appointment-qa Cloud
// Run job — read-only here, never write to vicidial.*). Manny's view
// leads.vw_appointments_qa pairs each setter-map row with its scored call.
// Two fixes on top of the view:
//   - the job can score the same call twice; keep the latest scored_at
//   - Make rows carry no leadID, so map them to the Leadspedia lead by phone
//     + nearest createdOn (Eastern -> real UTC) within 24h
const SQL_APPT_QA = `
WITH q AS (
  SELECT appt_uniqueid, phone_number, appt_date, scorable, credit, credit_reason, credit_quote,
         homeowners, homeowners_reason, homeowners_quote,
         needs_review, review_reason, scored_at
  FROM \`${PROJECT}.vicidial.appointment_qa\`
  WHERE appt_uniqueid IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY appt_uniqueid ORDER BY scored_at DESC) = 1
),
v AS (
  SELECT DISTINCT NULLIF(TRIM(leadID), '') AS leadID,
         RIGHT(REGEXP_REPLACE(IFNULL(phone,''), r'\\D', ''), 10) AS ph, set_at
  FROM \`${PROJECT}.leads.vw_appointments_qa\`
),
-- Same pairing as the view (phone, call within 2 days before / 1 day after the set), but when a
-- booking has more than one score, prefer a real (scorable) one, then the closest, then the newest.
-- The scorer's fallback writes a scorable row for bookings whose only score was "not scorable".
vq AS (
  SELECT v.leadID, v.ph, v.set_at, q.appt_uniqueid, q.scored_at
  FROM v JOIN q
    ON q.phone_number = v.ph
   AND TIMESTAMP(DATETIME(q.appt_date), 'America/New_York')
       BETWEEN TIMESTAMP_SUB(v.set_at, INTERVAL 2 DAY) AND TIMESTAMP_ADD(v.set_at, INTERVAL 1 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY v.ph, v.set_at
    ORDER BY IF(q.scorable = 'YES', 0, 1),
             ABS(TIMESTAMP_DIFF(v.set_at, TIMESTAMP(DATETIME(q.appt_date), 'America/New_York'), MINUTE)),
             q.scored_at DESC) = 1
),
l AS (
  SELECT leadID, RIGHT(REGEXP_REPLACE(IFNULL(phone_home,''), r'\\D', ''), 10) AS ph,
         TIMESTAMP(createdOn, 'America/New_York') AS ts
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND createdOnDate >= '2026-10-01'
),
lv AS (
  SELECT vq.appt_uniqueid, vq.set_at, ANY_VALUE(vq.scored_at) AS scored_at,
         COALESCE(ANY_VALUE(vq.leadID),
           ARRAY_AGG(l.leadID IGNORE NULLS ORDER BY ABS(TIMESTAMP_DIFF(l.ts, vq.set_at, SECOND)) LIMIT 1)[SAFE_OFFSET(0)]) AS lead_id
  FROM vq LEFT JOIN l ON vq.leadID IS NULL AND l.ph = vq.ph AND ABS(TIMESTAMP_DIFF(l.ts, vq.set_at, HOUR)) <= 24
  GROUP BY vq.appt_uniqueid, vq.set_at, vq.ph
)
SELECT lv.lead_id, q.credit, IFNULL(q.credit_reason,'') AS credit_reason, IFNULL(q.credit_quote,'') AS credit_quote,
       q.homeowners, IFNULL(q.homeowners_reason,'') AS homeowners_reason, IFNULL(q.homeowners_quote,'') AS homeowners_quote,
       IF(q.needs_review, 1, 0) AS needs_review, IFNULL(q.review_reason,'') AS review_reason
FROM lv JOIN q USING (appt_uniqueid)
WHERE lv.lead_id IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY lv.lead_id ORDER BY IF(q.scorable = 'YES', 0, 1), q.scored_at DESC) = 1
`;

// ADMIN ONLY. Which appointments were probably set by text, not a call.
// Nothing records the channel, so this is inferred: no dialer call of 60s+
// to that phone in the 24h before the lead posted (or 30 min after) = SMS.
// Both sides compared as Eastern wall-clock (createdOn and call_date both are).
// Manny feeds Jonathan the SMS work and doesn't want the team seeing it, which
// is why this only ships in the admin payload.
const SQL_APPT_SMS = `
WITH l AS (
  SELECT leadID, RIGHT(REGEXP_REPLACE(IFNULL(phone_home,''), r'\\D', ''), 10) AS ph, createdOn
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND IFNULL(isTest,'No') != 'Yes' AND createdOnDate >= '2026-06-01'
    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(campaignName,'')), r'transfer')
    -- Convertros Call leads are phone calls to Pella, never texts (Manny, Oct 20)
    AND NOT REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(first_name,''), ' ', IFNULL(last_name,''))), r'convertros')
),
c AS (
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10) AS ph, DATETIME(call_date) AS dt
  FROM \`${PROJECT}.vicidial.vicidial_log\`
  WHERE length_in_sec >= 60 AND call_date >= '2026-05-30'
  UNION ALL
  SELECT RIGHT(REGEXP_REPLACE(IFNULL(phone_number,''), r'\\D', ''), 10), DATETIME(call_date)
  FROM \`${PROJECT}.vicidial.vicidial_closer_log\`
  WHERE length_in_sec >= 60 AND call_date >= '2026-05-30'
)
SELECT l.leadID
FROM l LEFT JOIN c
  ON c.ph = l.ph
 AND c.dt BETWEEN DATETIME_SUB(l.createdOn, INTERVAL 24 HOUR) AND DATETIME_ADD(l.createdOn, INTERVAL 30 MINUTE)
WHERE LENGTH(l.ph) = 10
GROUP BY l.leadID
HAVING COUNT(c.ph) = 0
`;

// Manny's manual QA corrections (pencil on the Appointments tab, admin only).
// Our own table — never written into vicidial.appointment_qa, which the
// scoring job rewrites. One row per lead+topic; an edit always wins.
const SQL_QA_OVERRIDE = `
SELECT lead_id, topic, value, IFNULL(note,'') AS note
FROM \`${PROJECT}.leads.cc_qa_override\`
`;
const QA_VALUES = ["Pass", "Fail", "Unclear", "Not Asked"];

// Territory (Manny, Oct 20 2026): every appointment is in territory unless he
// flags it out from the admin view. Display only — never changes pay.
const SQL_TERRITORY = `
SELECT lead_id, IFNULL(note,'') AS note
FROM \`${PROJECT}.leads.cc_territory_override\`
WHERE NOT in_territory
`;

// Hours = actual logged-in time: talk + wait + pause + dispo + dead seconds.
// Paused breaks (LUNCH/BRK/ADMIN) count; logged-out time does not. Capped at
// the day's first-to-last span so overlapping timers can't overpay.
// Manual adjustments (holidays, flat shifts, dialer outages) live in
// leads.cc_hours_adjust and are layered on top here. We never write into
// vicidial_agent_log — that's the dialer's own table and the sync would
// clobber it. One adjustment row per user per day (enforced by MERGE on
// write), so 'set' vs 'add' is never ambiguous:
//   set -> the day's paid hours BECOME this number, logged time ignored
//   add -> this number is added on top of whatever was logged
// FULL OUTER JOIN, not LEFT: an agent who never logged in on a holiday has
// no row in the log at all, and a LEFT join would drop their flat shift.
const SQL_HOURS = `
WITH logged AS (
  SELECT
    a.user,
    DATE(a.event_time) AS d,
    ROUND(LEAST(
      SUM(IFNULL(a.pause_sec,0)+IFNULL(a.wait_sec,0)+IFNULL(a.talk_sec,0)+IFNULL(a.dispo_sec,0)+IFNULL(a.dead_sec,0)),
      TIMESTAMP_DIFF(MAX(a.event_time), MIN(a.event_time), SECOND)
    )/3600.0, 2) AS login_hours,
    COUNT(DISTINCT a.uniqueid) AS calls
  FROM \`${PROJECT}.vicidial.vicidial_agent_log\` a
  WHERE REGEXP_CONTAINS(a.user, r'${AGENT_RE}') AND a.user NOT IN ${EXCLUDED_USERS}
  GROUP BY a.user, d
),
adj AS (
  SELECT user, work_date AS d, mode, hours, note
  FROM \`${PROJECT}.leads.cc_hours_adjust\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
)
SELECT
  COALESCE(l.user, j.user) AS user,
  FORMAT_DATE('%Y-%m-%d', COALESCE(l.d, j.d)) AS d,
  ROUND(CASE
    WHEN j.mode = 'set' THEN j.hours
    WHEN j.mode = 'add' THEN IFNULL(l.login_hours, 0) + j.hours
    ELSE IFNULL(l.login_hours, 0)
  END, 2) AS login_hours,
  IFNULL(l.calls, 0) AS calls,
  IF(j.user IS NULL, 0, 1) AS adjusted,
  ROUND(IFNULL(l.login_hours, 0), 2) AS logged_hours,
  IFNULL(j.note, '') AS adj_note
FROM logged l
FULL OUTER JOIN adj j ON l.user = j.user AND l.d = j.d
ORDER BY d
`;

// Paused time by break code (LUNCH / BRK / ADMIN / everything else -> OTHER)
const SQL_BREAKS = `
SELECT
  a.user,
  FORMAT_DATE('%Y-%m-%d', DATE(a.event_time)) AS d,
  CASE UPPER(IFNULL(NULLIF(TRIM(a.sub_status),''), IFNULL(NULLIF(TRIM(a.pause_type),''),'OTHER')))
    WHEN 'LUNCH' THEN 'LUNCH'
    WHEN 'BRK' THEN 'BRK'
    WHEN 'ADMIN' THEN 'ADMIN'
    ELSE 'OTHER'
  END AS code,
  ROUND(SUM(IFNULL(a.pause_sec,0))/3600.0, 2) AS hrs
FROM \`${PROJECT}.vicidial.vicidial_agent_log\` a
WHERE REGEXP_CONTAINS(a.user, r'${AGENT_RE}') AND a.user NOT IN ${EXCLUDED_USERS}
  AND IFNULL(a.pause_sec,0) > 0
GROUP BY a.user, d, code
ORDER BY d
`;

const SQL_AGENTS = `
SELECT user, ANY_VALUE(full_name) AS full_name
FROM \`${PROJECT}.vicidial.vicidial_users\`
WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  AND full_name NOT IN ('OPEN USER')
GROUP BY user
`;

const SQL_META = `
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(synced_at)) AS last_sync
FROM \`${PROJECT}.vicidial.vicidial_agent_log\`
`;

// Admin-managed tables. Both queries fail gracefully (empty) until Manny
// creates leads.cc_spiffs / leads.cc_config and grants the SA dataEditor.
const SQL_SPIFFS = `
SELECT id, agent_user, amount, IFNULL(note,'') AS note,
       FORMAT_DATE('%Y-%m-%d', award_date) AS d
FROM \`${PROJECT}.leads.cc_spiffs\`
ORDER BY award_date DESC, created_at DESC
`;

const SQL_CONFIG = `
SELECT key, value FROM \`${PROJECT}.leads.cc_config\`
`;

// Spiff windows: which weeks a programmatic spiff (e.g. same/next-day) is
// switched on. Spiffs change week to week, so nothing pays unless a window
// covers it. Managed from the Spiffs sub-widget.
const SQL_SPIFF_WINDOWS = `
SELECT id, kind, FORMAT_DATE('%Y-%m-%d', start_date) AS s,
       FORMAT_DATE('%Y-%m-%d', end_date) AS e, rate, IFNULL(note,'') AS note,
       threshold, IFNULL(type_id,'') AS type_id
FROM \`${PROJECT}.leads.cc_spiff_windows\`
ORDER BY start_date DESC
`;

// The A-list: saved spiffs Manny can turn on for any week (admin only).
// kind must be one of SPIFF_KINDS — rules public/widgets/shared/spiff-rules.js
// knows how to pay.
const SQL_SPIFF_TYPES = `
SELECT id, name, kind, rate, threshold, IFNULL(note,'') AS note
FROM \`${PROJECT}.leads.cc_spiff_types\`
WHERE NOT IFNULL(archived, FALSE)
ORDER BY sort, name
`;
const SPIFF_KINDS = ["same_next", "team_goal", "qa_bonus"];
// Kinds that stack on top of the week's volume spiff (their own track).
const STACKING_KINDS = ["qa_bonus"];


function sqlStr(s, max) {
  return "'" + String(s).slice(0, max || 200).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

async function buildPayload(env, admin) {
  // Prefer setter-map attribution; fall back to phone-match-only if the
  // appt_setter_map table doesn't exist yet.
  const apptsPromise = bq(env, SQL_APPTS_V2).catch(() => bq(env, SQL_APPTS));
  const [appts, hours, agents, meta, spiffs, config, breaks, windows, apptQa, apptSms, qaOverride, spiffTypes, territory] = await Promise.all([
    apptsPromise,
    bq(env, SQL_HOURS),
    bq(env, SQL_AGENTS),
    bq(env, SQL_META),
    bq(env, SQL_SPIFFS).catch(() => ({ rows: [] })),
    bq(env, SQL_CONFIG).catch(() => ({ rows: [] })),
    bq(env, SQL_BREAKS).catch(() => ({ rows: [] })),
    bq(env, SQL_SPIFF_WINDOWS).catch(() => ({ rows: [] })),
    bq(env, SQL_APPT_QA).catch(() => ({ rows: [] })),
    admin ? bq(env, SQL_APPT_SMS).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
    bq(env, SQL_QA_OVERRIDE).catch(() => ({ rows: [] })),
    admin ? bq(env, SQL_SPIFF_TYPES).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
    bq(env, SQL_TERRITORY).catch(() => ({ rows: [] })),
  ]);

  const agentMap = {};
  for (const [user, name] of agents.rows) agentMap[user] = name;

  const configMap = {};
  for (const [k, v] of config.rows) {
    // Per-agent hourly rates (hourly_rate_<user>) are admin-only: agents must
    // not be able to see each other's pay in the payload.
    if (!admin && /^hourly_rate_/.test(k)) continue;
    configMap[k] = Number(v);
  }

  return {
    generated_at: new Date().toISOString(),
    meta: { last_sync: (meta.rows[0] || [])[0] || null },
    agents: agentMap,
    // [booked_date, agent_user|null, campaign, first, last, city, state, sold,
    //  phone, email, appt_at, lead_id]  — appt_at drives the same/next-day spiff.
    appts: appts.rows,
    // lead_id -> [credit, credit_reason, credit_quote, homeowners,
    //             homeowners_reason, homeowners_quote, needs_review, review_reason]
    // credit/homeowners: Pass | Fail | Unclear | Not Asked | Not Required | N/A
    appt_qa: Object.fromEntries(apptQa.rows.map((r) => [r[0], [
      r[1], r[2], r[3], r[4], r[5], r[6], Number(r[7]), r[8],
    ]])),
    // [user, date, login_hours, calls, adjusted, logged_hours, adj_note]
    // login_hours is the PAID number (adjustments already applied); columns
    // 4-6 exist so the Hours widget can show what was really logged and why.
    hours: hours.rows.map((r) => [
      r[0], r[1], Number(r[2]), Number(r[3]),
      Number(r[4]), Number(r[5]), r[6] || "",
    ]),
    // [id, agent_user, amount, note, award_date]
    spiffs: spiffs.rows.map((r) => [r[0], r[1], Number(r[2]), r[3], r[4]]),
    // [user, date, code, hours]
    breaks: breaks.rows.map((r) => [r[0], r[1], r[2], Number(r[3])]),
    // [id, kind, start_date, end_date, rate, note, threshold|null, type_id]
    spiff_windows: windows.rows.map((r) => [r[0], r[1], r[2], r[3], Number(r[4]), r[5],
      r[6] === null || r[6] === undefined ? null : Number(r[6]), r[7] || ""]),
    // ADMIN ONLY. Saved spiffs: [id, name, kind, rate, threshold|null, note]
    ...(admin ? { spiff_types: spiffTypes.rows.map((r) => [r[0], r[1], r[2], Number(r[3]),
      r[4] === null || r[4] === undefined ? null : Number(r[4]), r[5]]) } : {}),
    // {set_bonus, sit_bonus, sit_rate, close_rate, avg_project, rev_share, hourly_rate}
    config: configMap,
    // lead_id -> {credit?: value, home?: value}. Manny's corrections; everyone
    // sees the corrected pill. The note is admin-only (qa_edit_note).
    qa_edit: qaOverride.rows.reduce((m, [id, topic, value]) => {
      if (topic === "credit" || topic === "home") (m[id] = m[id] || {})[topic] = value;
      return m;
    }, {}),
    ...(admin ? { qa_edit_note: qaOverride.rows.reduce((m, [id, topic, , note]) => {
      if (note) (m[id] = m[id] || {})[topic] = note;
      return m;
    }, {}) } : {}),
    // Lead IDs flagged out of territory (everyone sees the flag; note is admin-only).
    out_territory: territory.rows.map((r) => r[0]),
    ...(admin ? { out_territory_note: Object.fromEntries(territory.rows.filter((r) => r[1]).map((r) => [r[0], r[1]])) } : {}),
    admin: !!admin,
    // ADMIN ONLY — never in the agent payload. Lead IDs that look texted.
    ...(admin ? { appt_sms: apptSms.rows.map((r) => r[0]) } : {}),
  };
}

/* ------------------------------------------------------------- admin ops */

/* ------------------------------------------------------ widget pass ----
 * A short-lived bearer token that lets a widget on another origin trust a
 * request that started here. It proves one thing only: "this browser held a
 * valid cc-dashboard session at time T". It carries no identity and no
 * permissions, so a leaked pass is worth 15 minutes of the widget and nothing
 * else. The signing secret never leaves the Worker — the frame only ever sees
 * the finished pass.
 */
// Reuses the b64url() defined up top for the Google JWT signing — same
// no-padding, URL-safe encoding, and it already takes an ArrayBuffer.
async function mintWidgetPass(secret, aud) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, aud, src: "cc", iat: now, exp: now + 900 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

function isAdmin(body, env) {
  return !!env.ADMIN_PASSCODE && body && body.admin === env.ADMIN_PASSCODE;
}

async function bustDataCache(url) {
  for (const p of ["/api/data", "/api/data?role=admin"]) {
    await caches.default.delete(new Request(new URL(p, url.origin).toString(), { method: "GET" }));
  }
}

async function handleAdmin(request, env, url, adminSess) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  // Logged in with the admin password = admin. The older per-tab passcode
  // prompt still works too, so nothing breaks while tabs move over.
  if (!adminSess && !isAdmin(body, env)) {
    return new Response(JSON.stringify({ error: "bad admin passcode" }), {
      status: 403, headers: JSON_HEADERS,
    });
  }

  /* ---- owner-only payout view ----
   * Every dollar figure an agent must never see is computed HERE and returned
   * only after isAdmin() passes. Nothing in the agent-facing bundle contains
   * pay rates, hourly cost, or per-agent totals — so "view source" gets them
   * nothing. Do not move any of this into a widget's JavaScript.
   */
  if (url.pathname === "/api/admin/payroll") {
    const week = String(body.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("bad week (want YYYY-MM-DD Monday)");
    const end = new Date(`${week}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    const weekEnd = end.toISOString().slice(0, 10);

    const payload = await buildPayload(env, true);

    const cfg = payload.config || {};
    const rate = {
      appt: Number(cfg.set_bonus ?? 5),
      same_next: Number(cfg.sit_bonus ?? 5),
      demo: Number(cfg.demo_bonus ?? 5),
      hourly: Number(cfg.hourly_rate ?? 0),
    };
    // Per-agent hourly override: cc_config key hourly_rate_<user> (e.g.
    // hourly_rate_2002 = 7.5 for Jonathan, Oct 20 2026). Everyone else gets
    // the flat hourly_rate. The $5 was a placeholder until then, so this
    // applies to every week, not from a date.
    const hourlyFor = (u) => {
      const v = cfg[`hourly_rate_${u}`];
      return v === undefined || v === null || isNaN(Number(v)) ? rate.hourly : Number(v);
    };
    const hourlyOverrides = {};
    for (const u of Object.keys(payload.agents)) {
      if (hourlyFor(u) !== rate.hourly) hourlyOverrides[u] = hourlyFor(u);
    }

    // name -> user, so setter-map rows (keyed by name) can join the agent list.
    const byName = {};
    for (const [user, name] of Object.entries(payload.agents)) {
      byName[String(name).trim().toLowerCase()] = user;
    }

    const row = (u) => ({
      user: u, name: payload.agents[u] || u,
      appts: 0, spiff_qty: 0, qa_points: 0,
      demos: null, spiffs: 0, hours: 0,
    });
    const agg = {};
    const get = (u) => (agg[u] || (agg[u] = row(u)));

    for (const [d, u] of payload.appts) {
      if (!u || d < week || d > weekEnd) continue;
      get(u).appts++;
    }
    // Programmatic spiff: ONLY when one was turned on for this week, using the
    // same shared rules as the Commission tab (it used to count same/next-day
    // every week, spiff or not, which overstated weeks with no spiff).
    const SR = globalThis.SpiffRules;
    const spiffWin = SR.windowFor(payload.spiff_windows, week, weekEnd);
    const spiffEv = SR.evaluate(spiffWin, payload.appts, week, weekEnd);
    const spiffRate = spiffWin ? Number(spiffWin[4]) : 0;
    for (const [u, n] of Object.entries(spiffEv.qty)) get(u).spiff_qty += n;
    // QA spiff stacks on top (points × rate), from the same shared rules.
    const qaWin = SR.stackFor(payload.spiff_windows, week, weekEnd);
    const qaEv = SR.evaluate(qaWin, payload.appts, week, weekEnd, payload);
    const qaRate = qaWin ? Number(qaWin[4]) : 0;
    for (const [u, n] of Object.entries(qaEv.qty)) get(u).qa_points += n;
    for (const [, u, amount, , d] of payload.spiffs) {
      if (!u || d < week || d > weekEnd) continue;
      get(u).spiffs += Number(amount);
    }
    for (const [u, d, hrs] of payload.hours) {
      if (d < week || d > weekEnd) continue;
      get(u).hours += Number(hrs);
    }

    const agents = Object.values(agg).map((r) => {
      const sn = r.spiff_qty;
      const appt_pay = r.appts * rate.appt;
      const sn_pay = sn * spiffRate;
      const qa_pay = r.qa_points * qaRate;
      const hourly_rate = hourlyFor(r.user);
      const hourly_pay = Math.round(r.hours * hourly_rate * 100) / 100;
      const payout = appt_pay + sn_pay + qa_pay + r.spiffs;
      return {
        ...r,
        hours: Math.round(r.hours * 100) / 100,
        same_next: sn,
        appt_pay, sn_pay, qa_pay, hourly_rate, hourly_pay,
        payout,                                  // Friday: appointment side only
        total_cost: Math.round((payout + hourly_pay) * 100) / 100,
        cost_per_appt: r.appts
          ? Math.round(((payout + hourly_pay) / r.appts) * 100) / 100
          : null,
      };
    }).sort((a, b) => b.payout - a.payout);

    return new Response(JSON.stringify({
      week, week_end: weekEnd, rates: { ...rate, hourly_overrides: hourlyOverrides }, agents,
      // The week's programmatic spiff, if any: what it was and whether it paid.
      spiff: spiffWin ? {
        kind: spiffWin[1], note: spiffWin[5], rate: spiffRate,
        goal: SR.goalLine(spiffWin, spiffEv, weekEnd < new Date().toISOString().slice(0, 10)),
      } : null,
      qa_spiff: qaWin ? { note: qaWin[5], rate: qaRate } : null,
    }), { headers: { ...JSON_HEADERS, "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/spiff") {
    const amount = Number(body.amount);
    const agentUser = String(body.agent_user || "");
    const date = String(body.award_date || "");
    if (!/^20[0-9]{2}$/.test(agentUser)) throw new Error("bad agent_user");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) throw new Error("bad amount");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad award_date");
    const id = crypto.randomUUID();
    await bq(env, `
      INSERT INTO \`${PROJECT}.leads.cc_spiffs\` (id, agent_user, amount, note, award_date, created_at)
      VALUES ('${id}', '${agentUser}', ${amount}, ${sqlStr(body.note || "")}, DATE '${date}', CURRENT_TIMESTAMP())
    `);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true, id }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/spiff-window") {
    const kind = String(body.kind || "");
    const start = String(body.start_date || ""), end = String(body.end_date || "");
    const rate = Number(body.rate);
    const typeId = String(body.type_id || "");
    if (!SPIFF_KINDS.includes(kind)) throw new Error("unknown spiff kind");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("bad dates");
    if (end < start) throw new Error("end before start");
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) throw new Error("bad rate");
    if (typeId && !/^[a-z0-9-]{1,40}$/.test(typeId)) throw new Error("bad saved spiff");
    let threshold = "NULL";
    if (kind === "team_goal") {
      const t = Number(body.threshold);
      if (!Number.isInteger(t) || t < 1 || t > 10000) throw new Error("team goal needs a whole number of appointments");
      threshold = String(t);
    }
    // One volume spiff per week, plus at most one stacking spiff (QA):
    // overlapping windows on the same track would make the Commission tab pick
    // one arbitrarily. Turn the old one off first.
    const stacks = STACKING_KINDS.includes(kind);
    const clash = await bq(env, `
      SELECT COUNT(*) FROM \`${PROJECT}.leads.cc_spiff_windows\`
      WHERE start_date <= DATE '${end}' AND end_date >= DATE '${start}'
        AND (kind IN (${STACKING_KINDS.map((k) => `'${k}'`).join(",")})) = ${stacks ? "TRUE" : "FALSE"}
    `);
    if (Number((clash.rows[0] || [0])[0]) > 0) {
      throw new Error("a spiff is already on for those dates — turn it off first");
    }
    const id = crypto.randomUUID();
    await bq(env, `
      INSERT INTO \`${PROJECT}.leads.cc_spiff_windows\`
        (id, kind, start_date, end_date, rate, note, threshold, type_id, created_at)
      VALUES ('${id}', '${kind}', DATE '${start}', DATE '${end}', ${rate},
              ${sqlStr(body.note || "", 200)}, ${threshold}, ${typeId ? `'${typeId}'` : "NULL"},
              CURRENT_TIMESTAMP())
    `);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true, id }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/spiff-window/delete") {
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
    await bq(env, `DELETE FROM \`${PROJECT}.leads.cc_spiff_windows\` WHERE id = '${id}'`);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/hours-adjust") {
    const user = String(body.user || "");
    const date = String(body.work_date || "");
    const mode = String(body.mode || "set");
    const hours = Number(body.hours);
    if (!/^20[0-9]{2}$/.test(user)) throw new Error("bad user");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
    if (mode !== "set" && mode !== "add") throw new Error("bad mode");
    // 24 is a hard ceiling — a typo like 80 instead of 8.0 would otherwise
    // sail through and quietly overpay by ten times.
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new Error("bad hours");
    // MERGE, not INSERT: one row per user per day keeps set/add unambiguous
    // and makes re-submitting the same day a correction, not a double entry.
    await bq(env, `
      MERGE \`${PROJECT}.leads.cc_hours_adjust\` t
      USING (SELECT '${user}' AS user, DATE '${date}' AS work_date) s
        ON t.user = s.user AND t.work_date = s.work_date
      WHEN MATCHED THEN UPDATE SET
        mode = '${mode}', hours = ${hours},
        note = ${sqlStr(body.note || "", 200)}, created_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN INSERT (user, work_date, mode, hours, note, created_at)
        VALUES (s.user, s.work_date, '${mode}', ${hours},
                ${sqlStr(body.note || "", 200)}, CURRENT_TIMESTAMP())
    `);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  /* QA correction. value = Pass|Fail|Unclear|Not Asked sets it; empty value
   * removes the edit so the scorer's answer shows again. */
  if (url.pathname === "/api/qa-override") {
    const id = String(body.lead_id || "");
    const topic = String(body.topic || "");
    const value = String(body.value || "");
    if (!/^[A-Za-z0-9]{6,16}$/.test(id)) throw new Error("bad lead id");
    if (topic !== "credit" && topic !== "home") throw new Error("bad topic");
    if (value && !QA_VALUES.includes(value)) throw new Error("bad value");
    if (!value) {
      await bq(env, `
        DELETE FROM \`${PROJECT}.leads.cc_qa_override\`
        WHERE lead_id = '${id}' AND topic = '${topic}'
      `);
    } else {
      await bq(env, `
        MERGE \`${PROJECT}.leads.cc_qa_override\` t
        USING (SELECT '${id}' AS lead_id, '${topic}' AS topic) s
          ON t.lead_id = s.lead_id AND t.topic = s.topic
        WHEN MATCHED THEN UPDATE SET
          value = '${value}', note = ${sqlStr(body.note || "", 300)}, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (lead_id, topic, value, note, updated_at)
          VALUES (s.lead_id, s.topic, '${value}', ${sqlStr(body.note || "", 300)}, CURRENT_TIMESTAMP())
      `);
    }
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  /* Territory flag. in_territory=false marks it out; true removes the flag
   * (in territory is the default, so it's not stored). */
  if (url.pathname === "/api/territory") {
    const id = String(body.lead_id || "");
    if (!/^[A-Za-z0-9]{6,16}$/.test(id)) throw new Error("bad lead id");
    if (typeof body.in_territory !== "boolean") throw new Error("in_territory must be true or false");
    if (body.in_territory) {
      await bq(env, `DELETE FROM \`${PROJECT}.leads.cc_territory_override\` WHERE lead_id = '${id}'`);
    } else {
      await bq(env, `
        MERGE \`${PROJECT}.leads.cc_territory_override\` t
        USING (SELECT '${id}' AS lead_id) s ON t.lead_id = s.lead_id
        WHEN MATCHED THEN UPDATE SET in_territory = FALSE, note = ${sqlStr(body.note || "", 300)}, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (lead_id, in_territory, note, updated_at)
          VALUES (s.lead_id, FALSE, ${sqlStr(body.note || "", 300)}, CURRENT_TIMESTAMP())
      `);
    }
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/hours-adjust/delete") {
    const user = String(body.user || "");
    const date = String(body.work_date || "");
    if (!/^20[0-9]{2}$/.test(user)) throw new Error("bad user");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
    await bq(env, `
      DELETE FROM \`${PROJECT}.leads.cc_hours_adjust\`
      WHERE user = '${user}' AND work_date = DATE '${date}'
    `);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/spiff/delete") {
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
    await bq(env, `DELETE FROM \`${PROJECT}.leads.cc_spiffs\` WHERE id = '${id}'`);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/config") {
    const ALLOWED = ["set_bonus", "sit_bonus", "sit_rate", "close_rate", "avg_project", "rev_share", "hourly_rate", "spiff_bonus"];
    // Goals widget targets: goal_team_week, goal_team_month, and one per agent
    // (goal_2002 …). Agent keys are open-ended so a new hire needs no deploy.
    const GOAL_RE = /^goal_(team_week|team_month|20[0-9]{2})$/;
    const values = body.values || {};
    const pairs = [];
    for (const k of Object.keys(values)) {
      if (!ALLOWED.includes(k) && !GOAL_RE.test(k)) continue;
      const v = Number(values[k]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`bad value for ${k}`);
      pairs.push([k, v]);
    }
    if (!pairs.length) throw new Error("no values");
    for (const [k, v] of pairs) {
      await bq(env, `
        MERGE \`${PROJECT}.leads.cc_config\` t
        USING (SELECT '${k}' AS key, ${v} AS value) s ON t.key = s.key
        WHEN MATCHED THEN UPDATE SET value = s.value, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (key, value, updated_at) VALUES (s.key, s.value, CURRENT_TIMESTAMP())
      `);
    }
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true, updated: pairs.length }), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: JSON_HEADERS });
}

/* --------------------------------------------------------------- handler */

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* ---- login ---- */
    if (path === "/api/login" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      if (env.ADMIN_PASSCODE && body.passcode === env.ADMIN_PASSCODE) {
        const v = await adminSessionValue(env);
        return new Response(JSON.stringify({ ok: true, admin: true }), {
          headers: {
            ...JSON_HEADERS,
            "Set-Cookie": `${COOKIE_NAME}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`,
          },
        });
      }
      if (!env.DASH_PASSCODE || body.passcode === env.DASH_PASSCODE) {
        const v = env.DASH_PASSCODE ? await sessionValue(env) : "open";
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            ...JSON_HEADERS,
            "Set-Cookie": `${COOKIE_NAME}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`,
          },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "Wrong passcode" }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }

    /* ---- logout ----
     * The session cookie is HttpOnly, so the page's JavaScript can't delete
     * it — only the server can. Signs out this browser only. */
    if (path === "/api/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          ...JSON_HEADERS,
          "Cache-Control": "no-store",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    const authed = await isAuthed(request, env);
    const adminSess = authed && (await isAdminSession(request, env));

    /* ---- Make.com appointment ingest ---- */
    // POST /api/appt  with header X-Ingest-Key: <INGEST_KEY>
    // Body: {phone, setter, appointment_date?, account?, lead_id?, first_name?, last_name?}
    // Writes one row to leads.appt_setter_map with source='make'.
    if (path === "/api/appt" && request.method === "POST") {
      if (!env.INGEST_KEY || request.headers.get("X-Ingest-Key") !== env.INGEST_KEY) {
        return new Response(JSON.stringify({ error: "bad ingest key" }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
      try {
        let b = {};
        try { b = await request.json(); } catch (_) {}
        const phone = String(b.phone || "").trim();
        const setter = String(b.setter || "").trim();
        if (!phone) throw new Error("phone required");
        if (!setter) throw new Error("setter required");

        // Make sends GHL's calendar.startTime, e.g. "2026-08-24T14:00:00" —
        // wall-clock local time in the calendar's own timezone, no offset. It's
        // stored as DATETIME (not TIMESTAMP) so no timezone maths can shift the
        // hour. appointment_date is kept alongside it for the date-only reads.
        // Also accepts YYYY-MM-DD and MM/DD/YYYY; anything else -> NULL.
        let ad = "NULL", at = "NULL";
        const raw = String(b.appointment_date || b.appointment_at || "").trim();
        let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) {
          const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (us) m = [null, us[3], us[1].padStart(2, "0"), us[2].padStart(2, "0")];
        }
        if (m) {
          const ymd = `${m[1]}-${m[2]}-${m[3]}`;
          ad = `DATE '${ymd}'`;
          // Time part is optional — a date-only value still gets a DATETIME at 00:00.
          const t = raw.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
          const hms = t ? `${t[1]}:${t[2]}:${t[3] || "00"}` : "00:00:00";
          at = `DATETIME '${ymd} ${hms}'`;
        }

        await bq(env, `
          INSERT INTO \`${PROJECT}.leads.appt_setter_map\`
            (phone, setter, set_at, account, lead_first, lead_last, leadID, source,
             appointment_date, appointment_at)
          VALUES (${sqlStr(phone, 40)}, ${sqlStr(setter, 80)}, CURRENT_TIMESTAMP(),
                  ${sqlStr(b.account || "", 120)}, ${sqlStr(b.first_name || "", 60)},
                  ${sqlStr(b.last_name || "", 60)}, ${sqlStr(b.lead_id || "", 40)},
                  'make', ${ad}, ${at})
        `);
        await bustDataCache(url);
        return new Response(JSON.stringify({ ok: true, setter, phone }), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: String(err && err.message ? err.message : err) }),
          { status: 400, headers: JSON_HEADERS }
        );
      }
    }

    /* ---- admin (spiffs + config) ---- */
    if ((path === "/api/spiff" || path === "/api/spiff/delete" || path === "/api/config"
         || path === "/api/spiff-window" || path === "/api/spiff-window/delete"
         || path === "/api/hours-adjust" || path === "/api/hours-adjust/delete"
         || path === "/api/qa-override" || path === "/api/territory"
         || path === "/api/admin/payroll") && request.method === "POST") {
      if (!authed) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
      }
      try {
        return await handleAdmin(request, env, url, adminSess);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: String(err && err.message ? err.message : err) }),
          { status: 400, headers: JSON_HEADERS }
        );
      }
    }

    /* ---- api ---- */
    if (path.startsWith("/api/")) {
      if (path === "/api/health") {
        return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
          headers: JSON_HEADERS,
        });
      }
      if (!authed) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: JSON_HEADERS,
        });
      }
      if (path === "/api/widget-pass") {
        const widget = url.searchParams.get("widget") || "";
        if (widget !== "reverse-lookup") {
          return new Response(JSON.stringify({ error: "unknown widget" }), {
            status: 400, headers: JSON_HEADERS,
          });
        }
        if (!env.WIDGET_PASS_SECRET) {
          return new Response(JSON.stringify({ error: "widget pass not configured" }), {
            status: 500, headers: JSON_HEADERS,
          });
        }
        const pass = await mintWidgetPass(env.WIDGET_PASS_SECRET, "reverse-lookup");
        // no-store, always: a cached pass is a pass that outlives its 15 minutes
        // and can be replayed by the next person on a shared machine.
        return new Response(JSON.stringify({ pass }), {
          headers: { ...JSON_HEADERS, "Cache-Control": "no-store" },
        });
      }

      if (path === "/api/me") {
        return new Response(JSON.stringify({ admin: adminSess }), {
          headers: { ...JSON_HEADERS, "Cache-Control": "no-store" },
        });
      }

      if (path === "/api/data") {
        const bust = url.searchParams.get("refresh") === "1";
        const cache = caches.default;
        // Admin and agent payloads are cached separately — the agent copy
        // must never contain the admin-only fields.
        const cacheKey = new Request(
          new URL(adminSess ? "/api/data?role=admin" : "/api/data", url.origin).toString(),
          { method: "GET" }
        );

        if (!bust) {
          const hit = await cache.match(cacheKey);
          if (hit) {
            const r = new Response(hit.body, hit);
            r.headers.set("X-Cache", "HIT");
            r.headers.set("Cache-Control", "no-store");
            return r;
          }
        }

        try {
          const payload = await buildPayload(env, adminSess);
          const body = JSON.stringify(payload);
          const edgeCopy = new Response(body, {
            headers: { ...JSON_HEADERS, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
          });
          ctx.waitUntil(cache.put(cacheKey, edgeCopy));
          return new Response(body, {
            headers: { ...JSON_HEADERS, "Cache-Control": "no-store", "X-Cache": "MISS" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: String(err && err.message ? err.message : err) }),
            { status: 500, headers: JSON_HEADERS }
          );
        }
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    /* ---- static, behind the gate ---- */
    // Workers Assets serves login.html at the clean URL /login (it 307s the
    // .html form), so always gate-rewrite to /login to avoid redirect loops.
    // The logo files stay public so the sign-in page can render its branding.
    const PUBLIC_PATHS = new Set(["/login", "/logo.png", "/logo-full.png"]);
    if (!authed && !PUBLIC_PATHS.has(path)) {
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html")) {
        return env.ASSETS.fetch(new Request(new URL("/login", url.origin), { method: "GET" }));
      }
      return new Response("unauthorized", { status: 401 });
    }

    return env.ASSETS.fetch(request);
  },
};
