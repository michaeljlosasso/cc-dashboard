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

## Parked

- [x] GitHub repo created and pushed (michaeljlosasso/cc-dashboard, main)
- [x] Goals sub-widget (team + per-agent progress bars) — shipped Aug 22, replaces the
      "Leaderboard" idea. Ranked boards rejected: Jonathan took #1 in 10 of 12 weeks.
      Targets live in cc_config (`goal_team_week`, `goal_team_month`, `goal_<user>`).
- [ ] Spiffs / contests sub-widget
- [ ] Confirm commission-month interpretation with partner: dashboard pays **prior full month** on the first Friday ≥ 5th (doc's literal text said "current month")
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
