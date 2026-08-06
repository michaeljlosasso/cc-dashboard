# cc-dashboard — TODO

## Next up

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

- Live: https://cc-dashboard.michael-5fa.workers.dev (passcode: homelynk2026)
- Build chat: https://claude.ai/cowork/cse_01G9RPR1XJfihMy8gmFT5Jc6
