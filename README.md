# cc-dashboard

LL.Media Contact Center dashboard — agent payroll (sets/sits/commission) and
VICIdial hours. Standalone frame + embedded sub-widgets, rebuilt off the
Manus-hosted Contact Center Agent Leaderboard on the GitHub + Cloudflare stack.

**Live:** https://cc-dashboard.michael-5fa.workers.dev

## Architecture

One Cloudflare Worker with Workers Assets:

- `/` — dashboard frame: dark sidebar (framework-guide pattern), each nav item
  loads a sub-widget page in an iframe.
- `/widgets/payroll/`, `/widgets/hours/` — content-only sub-widget pages,
  same-origin iframes, built to the LL.Media Widget Design Specification.
- `/api/data` — Worker signs a GCP service-account JWT, queries BigQuery,
  returns appointments + hours + agents in one payload. Edge-cached 15 min
  (`?refresh=1` busts).
- Everything is behind a shared passcode (`DASH_PASSCODE` secret). Login sets a
  30-day HttpOnly cookie; rotating the secret invalidates all sessions.

## Data / payroll rules (from the Aug 4, 2026 payroll doc)

- **Sets** — $5 × appointments booked in the previous full Mon–Sun week.
  Appointments = affiliate-212 (HomeLynk CC) sold leads in
  `leads.leads_get_all`.
- **Sits** — $5 × round(60% of appointments from two weeks ago).
- **Hourly** — $5/hr on daily VICIdial login span (`vicidial_agent_log`,
  first-to-last event), paid Mondays for the previous week.
- **Commission** — on the first Friday on/after the 5th: prior-month appts ×
  4% × $15,274 × 0.1%.
- **Attribution** — `appt_setter` never lands in BigQuery, so leads are matched
  to agents by phone against `vicidial_log` + `vicidial_closer_log`
  (APPTBK dispositions preferred, closest to `createdOn`). ~95% match; the rest
  show as an Unattributed row in the payroll table.
- Owner (user 2001, Michael LoSasso) is excluded from payroll.
- Legacy pre-June-2026 "Paid Earnings" rates are intentionally dropped.

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...           # Tokens/cloudflare_token.txt
export CLOUDFLARE_ACCOUNT_ID=5fae18315616c9ecfd8f06baa13d3e10
wrangler secret put GCP_SA_KEY < claude_gcp.json   # first time only
wrangler secret put DASH_PASSCODE                  # first time only
wrangler deploy
```

## Not built (yet)

Leaderboard, spiffs/contests, mark-as-paid tracking, alias management, and the
admin panel from the Manus version. Mark-as-paid needs a KV namespace if wanted.
