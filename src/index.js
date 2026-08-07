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

const PROJECT = "ll-media-project";
const CACHE_SECONDS = 900; // 15 min — Leadspedia/VICIdial sync into BQ continuously
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

async function isAuthed(request, env) {
  if (!env.DASH_PASSCODE) return true; // gate disabled until secret is set
  const c = getCookie(request, COOKIE_NAME);
  return c !== null && c === (await sessionValue(env));
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

// Appointments = sold affiliate-212 (HomeLynk CC) leads. appt_setter is not
// synced to BigQuery, so attribution priority is:
//   1. leads.appt_setter_map (CSV backfill by leadID, Make rows by phone+date)
//   2. VICIdial phone match (outbound + inbound closer, APPTBK preferred)
//   3. unattributed
const SQL_APPTS = `
WITH sold AS (
  SELECT leadID,
         REGEXP_REPLACE(phone_home, r'\\D', '') AS ph,
         createdOn,
         campaignName, first_name, last_name, city, state
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND sold = 'Yes' AND IFNULL(isTest,'No') != 'Yes'
    AND createdOnDate >= '2026-01-01'
),
agent_calls AS (
  SELECT REGEXP_REPLACE(phone_number, r'\\D', '') AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  UNION ALL
  SELECT REGEXP_REPLACE(phone_number, r'\\D', '') AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_closer_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
)
SELECT
  FORMAT_DATETIME('%Y-%m-%d', s.createdOn) AS booked_date,
  ARRAY_AGG(c.user
    ORDER BY IF(c.status='APPTBK',0,1),
             ABS(TIMESTAMP_DIFF(c.call_date, TIMESTAMP(s.createdOn), SECOND))
    LIMIT 1)[SAFE_OFFSET(0)] AS agent_user,
  ANY_VALUE(s.campaignName) AS campaign,
  ANY_VALUE(s.first_name) AS first_name,
  ANY_VALUE(s.last_name) AS last_name,
  ANY_VALUE(s.city) AS city,
  ANY_VALUE(s.state) AS state
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
         REGEXP_REPLACE(phone_home, r'\\D', '') AS ph,
         createdOn,
         campaignName, first_name, last_name, city, state
  FROM \`${PROJECT}.leads.leads_get_all\`
  WHERE affiliateID = 212 AND sold = 'Yes' AND IFNULL(isTest,'No') != 'Yes'
    AND createdOnDate >= '2026-01-01'
),
map AS (
  SELECT leadID AS map_lead_id,
         REGEXP_REPLACE(phone, r'\\D', '') AS ph,
         set_at,
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
  SELECT REGEXP_REPLACE(phone_number, r'\\D', '') AS ph, user, status, call_date
  FROM \`${PROJECT}.vicidial.vicidial_log\`
  WHERE REGEXP_CONTAINS(user, r'${AGENT_RE}') AND user NOT IN ${EXCLUDED_USERS}
  UNION ALL
  SELECT REGEXP_REPLACE(phone_number, r'\\D', '') AS ph, user, status, call_date
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
    ARRAY_AGG(mi.setter_key IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] AS set_by_id,
    ARRAY_AGG(mp.setter_key IGNORE NULLS
      ORDER BY ABS(TIMESTAMP_DIFF(mp.set_at, TIMESTAMP(s.createdOn), SECOND))
      LIMIT 1)[SAFE_OFFSET(0)] AS set_by_phone,
    ARRAY_AGG(c.user IGNORE NULLS
      ORDER BY IF(c.status='APPTBK',0,1),
               ABS(TIMESTAMP_DIFF(c.call_date, TIMESTAMP(s.createdOn), SECOND))
      LIMIT 1)[SAFE_OFFSET(0)] AS call_user
  FROM sold s
  LEFT JOIN map mi ON mi.map_lead_id = s.leadID
  LEFT JOIN map mp ON mp.ph = s.ph
    AND ABS(TIMESTAMP_DIFF(mp.set_at, TIMESTAMP(s.createdOn), HOUR)) <= 168
  LEFT JOIN agent_calls c ON c.ph = s.ph
  GROUP BY s.leadID, s.createdOn
)
SELECT
  FORMAT_DATETIME('%Y-%m-%d', p.createdOn) AS booked_date,
  COALESCE(u.user, p.call_user) AS agent_user,
  p.campaign, p.first_name, p.last_name, p.city, p.state
FROM picked p
LEFT JOIN users u ON u.fn = COALESCE(p.set_by_id, p.set_by_phone)
ORDER BY booked_date
`;

const SQL_HOURS = `
SELECT
  a.user,
  FORMAT_DATE('%Y-%m-%d', DATE(a.event_time)) AS d,
  ROUND(TIMESTAMP_DIFF(MAX(a.event_time), MIN(a.event_time), SECOND)/3600.0, 2) AS login_hours,
  COUNT(DISTINCT a.uniqueid) AS calls
FROM \`${PROJECT}.vicidial.vicidial_agent_log\` a
WHERE REGEXP_CONTAINS(a.user, r'${AGENT_RE}') AND a.user NOT IN ${EXCLUDED_USERS}
GROUP BY a.user, d
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

function sqlStr(s, max) {
  return "'" + String(s).slice(0, max || 200).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

async function buildPayload(env) {
  // Prefer setter-map attribution; fall back to phone-match-only if the
  // appt_setter_map table doesn't exist yet.
  const apptsPromise = bq(env, SQL_APPTS_V2).catch(() => bq(env, SQL_APPTS));
  const [appts, hours, agents, meta, spiffs, config] = await Promise.all([
    apptsPromise,
    bq(env, SQL_HOURS),
    bq(env, SQL_AGENTS),
    bq(env, SQL_META),
    bq(env, SQL_SPIFFS).catch(() => ({ rows: [] })),
    bq(env, SQL_CONFIG).catch(() => ({ rows: [] })),
  ]);

  const agentMap = {};
  for (const [user, name] of agents.rows) agentMap[user] = name;

  const configMap = {};
  for (const [k, v] of config.rows) configMap[k] = Number(v);

  return {
    generated_at: new Date().toISOString(),
    meta: { last_sync: (meta.rows[0] || [])[0] || null },
    agents: agentMap,
    // [booked_date, agent_user|null, campaign, first, last, city, state]
    appts: appts.rows,
    // [user, date, login_hours, calls]
    hours: hours.rows.map((r) => [r[0], r[1], Number(r[2]), Number(r[3])]),
    // [id, agent_user, amount, note, award_date]
    spiffs: spiffs.rows.map((r) => [r[0], r[1], Number(r[2]), r[3], r[4]]),
    // {set_bonus, sit_bonus, sit_rate, close_rate, avg_project, rev_share, hourly_rate}
    config: configMap,
  };
}

/* ------------------------------------------------------------- admin ops */

function isAdmin(body, env) {
  return !!env.ADMIN_PASSCODE && body && body.admin === env.ADMIN_PASSCODE;
}

async function bustDataCache(url) {
  const cacheKey = new Request(new URL("/api/data", url.origin).toString(), { method: "GET" });
  await caches.default.delete(cacheKey);
}

async function handleAdmin(request, env, url) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  if (!isAdmin(body, env)) {
    return new Response(JSON.stringify({ error: "bad admin passcode" }), {
      status: 403, headers: JSON_HEADERS,
    });
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

  if (url.pathname === "/api/spiff/delete") {
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
    await bq(env, `DELETE FROM \`${PROJECT}.leads.cc_spiffs\` WHERE id = '${id}'`);
    await bustDataCache(url);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  if (url.pathname === "/api/config") {
    const ALLOWED = ["set_bonus", "sit_bonus", "sit_rate", "close_rate", "avg_project", "rev_share", "hourly_rate"];
    const values = body.values || {};
    const pairs = [];
    for (const k of ALLOWED) {
      if (values[k] === undefined) continue;
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

    const authed = await isAuthed(request, env);

    /* ---- admin (spiffs + config) ---- */
    if ((path === "/api/spiff" || path === "/api/spiff/delete" || path === "/api/config") && request.method === "POST") {
      if (!authed) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
      }
      try {
        return await handleAdmin(request, env, url);
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
      if (path === "/api/data") {
        const bust = url.searchParams.get("refresh") === "1";
        const cache = caches.default;
        const cacheKey = new Request(new URL("/api/data", url.origin).toString(), {
          method: "GET",
        });

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
          const payload = await buildPayload(env);
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
