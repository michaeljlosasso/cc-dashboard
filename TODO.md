# cc-dashboard — TODO

## Next up

- [ ] **Setter attribution v2 (closes the text-set blind spot)**
  - [x] Create `leads.appt_setter_map` table (done — SA granted project write)
  - [x] Backfill loaded: 683 rows, Jun 1 – Aug 6 (`source='csv_backfill'`, Andres normalized)
  - [x] Worker endpoint `POST /api/appt` live (header `X-Ingest-Key`, writes `source='make'`) — deployed + smoke-tested Aug 22
  - [ ] Manny: add HTTP "Make a request" module to the ONE Make scenario that posts to Slack → POST to `/api/appt`
  - [x] Worker attribution: setter map (leadID, else phone+date) → VICIdial phone-match → unattributed (live)
  - Note: do NOT try to edit the ~100 GHL webhook workflows that post into Leadspedia — Make is the single choke point

- [ ] **Payroll snapshots + Mark as Paid** — freeze what was actually paid so history can't drift
  - `payroll_snapshots` table in BigQuery (one row per agent per payout date)
  - Worker endpoints: save snapshot on "Mark as Paid", read snapshots for past Fridays
  - Payroll widget: past Fridays load from snapshot; current/future stay live-calculated
  - Est: ~10–15 min build

- [ ] **Auto same/next-day spiffs** — blocked on the Make module above
  - Once `appointment_date` flows in from Make, compute same/next-day ($5 each) automatically
  - Retires the manual weekly spiff paste

- [x] **Manual hour adjustments** — `leads.cc_hours_adjust`, layered over VICIdial in `SQL_HOURS`.
      Admin → "+ Adjust Hours" in the Hours widget. Two modes: `set` (pay exactly this, ignore
      logged time) and `add` (on top of logged). One row per user per day, MERGE on write, so
      re-submitting a day is a correction not a double entry. Adjusted cells show purple with a
      hover reason. Seeded: Labor Day Mon Sep 7 2026 — 8 hr flat for 2002/2004/2007/2008, 6 hr
      for 2009 (Andres), `set` mode so Jonathan's 5.52 logged is replaced, not stacked.
      NOTE: we never write to `vicidial.vicidial_agent_log` — the dialer sync would clobber it.

## Parked

- [x] GitHub repo created and pushed (michaeljlosasso/cc-dashboard, main)
- [x] Goals sub-widget (team + per-agent progress bars) — shipped Aug 22, replaces the
      "Leaderboard" idea. Ranked boards rejected: Jonathan took #1 in 10 of 12 weeks.
      Targets live in cc_config (`goal_team_week`, `goal_team_month`, `goal_<user>`).
- [ ] Spiffs / contests sub-widget
- [x] Monthly commission retired after August 2026 (`LAST_COMMISSION_MONTH` in payroll widget). Pays Fri Sep 11 as owed, never again after. Safe to strip the code entirely after Sep 11.
- [ ] Optional: move shell to cc.llmedia.info (nicer URL for agents; makes widgets same-site if Access is ever wanted)

## Sub-widgets

| Page | Source | Notes |
|---|---|---|
| Commission | in-repo `/widgets/payroll/` | admin: +Spiff, Rates |
| Hours | in-repo `/widgets/hours/` | logged-in time only; breaks card |
| Appointments | in-repo `/widgets/appointments/` | no revenue data shown |
| Zips | `llmedia-zip-lookup-widget.michael-5fa.workers.dev` | migrated off Manus Aug 20; `?code=` gate |

## Reference

- Live: https://cc-dashboard.michael-5fa.workers.dev (passcode: dialerportal0987)
- Build chat: https://claude.ai/cowork/cse_01G9RPR1XJfihMy8gmFT5Jc6
