# cc-dashboard — TODO

## Next up

- [ ] **Setter attribution v2 (closes the text-set blind spot)**
  - [x] Create `leads.appt_setter_map` table (done — SA granted project write)
  - [x] Backfill loaded: 683 rows, Jun 1 – Aug 6 (`source='csv_backfill'`, Andres normalized)
  - [ ] Manny: add BigQuery "Insert Row" module to the ONE Make scenario that posts to Slack → writes phone/setter/set_at/account (`source='make'`)
  - [x] Worker attribution: setter map (leadID, else phone+date) → VICIdial phone-match → unattributed (live)
  - Note: do NOT try to edit the ~100 GHL webhook workflows that post into Leadspedia — Make is the single choke point

- [ ] **Payroll snapshots + Mark as Paid** — freeze what was actually paid so history can't drift
  - `payroll_snapshots` table in BigQuery (one row per agent per payout date)
  - Worker endpoints: save snapshot on "Mark as Paid", read snapshots for past Fridays
  - Payroll widget: past Fridays load from snapshot; current/future stay live-calculated
  - Est: ~10–15 min build

## Parked

- [ ] Create GitHub repo `michaeljlosasso/cc-dashboard` and push (commits queued locally in the build session)
- [ ] Leaderboard sub-widget (agent-facing rankings)
- [ ] Spiffs / contests sub-widget
- [ ] Confirm commission-month interpretation with partner: dashboard pays **prior full month** on the first Friday ≥ 5th (doc's literal text said "current month")

## Reference

- Live: https://cc-dashboard.michael-5fa.workers.dev (passcode: dialerportal0987)
- Build chat: https://claude.ai/cowork/cse_01G9RPR1XJfihMy8gmFT5Jc6
