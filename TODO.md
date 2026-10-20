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

- [x] **Spiffs tab is now an earnings tracker** (Oct 8 2026). Month picker, tiles, per-Friday
      table, month-by-month history; the on/off schedule stays underneath. A month = the Friday
      paydays inside it (Manny's call: matches deposits, nothing split). Spiffs only, not sets/sits.
      Spiff math is COPIED from widgets/payroll — change both together. Nav: Spiffs moved to
      Payroll, Appointments moved to Team. Month-by-month history card and ON/OFF tiles removed (Manny).

- [ ] **Timezone bug in phone-tier attribution, fixed only from Oct 5 2026.** Leadspedia createdOn
      is Eastern; Make's set_at is UTC; the query compared them as the same zone. Fixed via
      created_ts in SQL_APPTS_V2 with a cutoff at the first unpaid week. A global fix would
      move 27 historical bookings (Apr–Sep, incl. Sep 16 + Sep 22 already paid). Revisit only
      together with payroll snapshots. The VICIdial call-tier comparison was NOT changed
      (call_date's zone unverified).

- [x] **Admin login** (Oct 20 2026). Same login screen, two passwords: DASH_PASSCODE = agent view,
      ADMIN_PASSCODE = admin view (Manny's). Role is baked into the cookie; server decides what data
      ships. /api/me, /api/logout (cookie is HttpOnly — the old JS sign-out never actually worked).
      Admin payload cached separately (/api/data?role=admin). Admin session satisfies handleAdmin, and
      the shell sets sessionStorage cc_admin_pc="session" so older tabs' admin controls just appear.
      Old per-tab passcode prompts still accept ADMIN_PASSCODE; retire them tab by tab.
      Owner button removed; Owner section shows automatically for admin.
- [x] **SMS channel (admin only)** on Appointments: column, filter, export. Inferred — no 60s+ dialer
      call to the phone 24h before the lead posted. Agrees with the QA job's text-vs-call scoring
      234/241. Manny feeds Jonathan the SMS; agents must not see this.

- [x] **Per-agent hourly rate** (Oct 20 2026): cc_config `hourly_rate_<user>` overrides the flat
      `hourly_rate` ($5). Jonathan (2002) = $7.50. Applies to every week ($5 was a placeholder).
      Stripped from the agent payload — admin only. Payouts table skips unattributed appts.

- [x] **Convertros Call leads pay no one** (Oct 20 2026, Manny). Pella's own inbound calls posted back
      into Leadspedia; they used to inherit a setter by phone. Forced Unattributed from CONVERTROS_FROM
      (2026-10-12, first unpaid sets week). 4 older ones stay credited (paid weeks): Bernardo Sep 10 +
      Sep 24, Oscar Sep 11, Andres Oct 9. Verified vs Manny's Oct 12–18 export: setters now match 86/86.
- [ ] Open (Manny to decide): unsold/trashed eLocal transfers still pay the $5 set (DelRossi/Felix,
      B. Williams/Bernardo, Oct 16); trashed "Not Match" appt Paul Cail/Jon Oct 13.

- [x] **Admin QA corrections** (Oct 20 2026). Pencil next to each Credit/Homeowner pill (admin only) →
      Yes/No/Unclear/Not Asked + optional note, or undo. Saved to `leads.cc_qa_override` (lead_id+topic,
      MERGE) via /api/qa-override; never touches vicidial.appointment_qa. Edit wins everywhere (pill,
      filters, export); everyone sees the corrected pill, note is admin-only. Hover shows scorer's original.

- [x] **QA rubric v3** (Oct 20 2026, Manny): any yes to the credit question = Pass (hedged too),
      "1650" = 650, tax-credit wording counts; quote check respects ellipses. Job image
      vicidial-appointment-qa:v3-*, reference copy + rollback in qa-job/. 52 Unclear-credit rows
      (last 14 days) backed up to leads.appointment_qa_backup_20261020 and re-scored.

- [x] **Saved spiffs (the A-list)** (Oct 20 2026). `leads.cc_spiff_types` = reusable spiffs; the Spiffs
      tab's "Saved spiff" dropdown fills $, goal and wording, and turning one on copies them onto a
      `cc_spiff_windows` row (new cols threshold, type_id) — editing a saved spiff never changes past weeks.
      Rules live ONLY in public/widgets/shared/spiff-rules.js (same_next, team_goal), loaded by both the
      Commission and Spiffs tabs. Worker: SPIFF_KINDS allow-list, one programmatic spiff per week
      (overlap refused). Verified: all 14 Fridays' payouts unchanged; team_goal reproduces Oct 5–11 ($176).
      New spiff = a row in cc_spiff_types if an existing rule fits; else a new rule + SPIFF_KINDS entry.
      Owner Payouts (/api/admin/payroll) now imports the same spiff-rules.js (globalThis.SpiffRules) —
      fixed Oct 20: it used to count same/next every week (Aug 31, Sep 21, Oct 5, Oct 19 overstated).

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
| Zips | `llmedia-zip-lookup-widget.michael-5fa.workers.dev` | migrated off Manus Aug 20; `?code=` gate. Repo `michaeljlosasso/llmedia-zip-lookup-widget` (see its HANDOFF.md — the deployed Worker source is NOT in that repo). Own chat: cse_01YB9G6vT8MbrnkFJoWp85ir |

## Reference

- Live: https://cc-dashboard.michael-5fa.workers.dev (passcode: dialerportal0987)
- Build chat: https://claude.ai/cowork/cse_01G9RPR1XJfihMy8gmFT5Jc6
