/* Spiff rules — the ONE place weekly spiff math lives.
 *
 * Loaded by the Commission tab (widgets/payroll) and the Spiffs tab
 * (widgets/spiffs), and imported by the Worker for the owner Payouts view, so
 * none of them can disagree about what a spiff paid. Keep it plain ES5-ish
 * JavaScript with no imports — it runs in both places.
 *
 * A spiff that's "on" for a week is a row in leads.cc_spiff_windows:
 *   [id, kind, start_date, end_date, rate, note, threshold, type_id]
 * `kind` picks a rule below. Turning on a saved spiff (leads.cc_spiff_types,
 * the A-list) copies its rate / threshold / note onto the window row, so
 * editing a saved spiff later never changes a week that already ran.
 *
 * Appointment rows: [booked_date, agent_user, campaign, first, last, city,
 * state, sold, phone, email, appt_at, lead_id].
 *
 * To add a NEW kind of spiff: add a rule here (and its kind to the Worker's
 * SPIFF_KINDS list). Most new spiffs won't need that — they're a saved spiff
 * using an existing rule with a different rate / goal / wording.
 */
(function () {
  "use strict";

  const A_DATE = 0, A_USER = 1, A_CAMPAIGN = 2, A_APPT_AT = 10;
  const isTransfer = (campaign) => /transfer/i.test(campaign || "");
  const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  // QA spiff points for one appointment's pill: Yes = asked and confirmed,
  // Unclear = asked, no clear answer. No / Not Asked / not scored = nothing.
  // A No that got booked anyway earns $0 on purpose (Manny, Oct 20).
  const QA_POINTS = { "Pass": 2, "Unclear": 1 };
  // The pill value the Appointments tab shows: Manny's pencil correction wins
  // over the scorer, so the bonus always follows what agents can see.
  function qaValue(ctx, leadId, topic) {
    const edit = ((ctx && ctx.qa_edit) || {})[leadId];
    if (edit && edit[topic]) return edit[topic];
    const q = ((ctx && ctx.appt_qa) || {})[leadId];
    if (!q) return "";
    return topic === "credit" ? q[0] : q[3];
  }

  // Out of territory = uncommissionable (Manny, Oct 26 2026): a booking he
  // flags out of territory pays NOTHING — no set pay, no spiff, no QA points,
  // and it doesn't count toward a team goal. Applies to bookings from Oct 19
  // on (he chose to include the week paid Oct 30); earlier weeks are already
  // paid as they were. The booking still shows on the Appointments tab.
  // Every pay screen filters through payableRows() so they can't disagree.
  const OOT_UNPAID_FROM = "2026-10-19";
  function unpaidOot(r, ctx) {
    if (!r || !r[11] || !r[A_DATE] || r[A_DATE] < OOT_UNPAID_FROM) return false;
    const out = (ctx && ctx.out_territory) || [];
    return out.indexOf(r[11]) !== -1;
  }
  function payableRows(rows, ctx) {
    const out = new Set((ctx && ctx.out_territory) || []);
    if (!out.size) return rows || [];
    return (rows || []).filter((r) => !(r[11] && r[A_DATE] >= OOT_UNPAID_FROM && out.has(r[11])));
  }

  const RULES = {
    // $rate for each booking whose appointment is the same day or the next day.
    // eLocal transfers are excluded — they're handed off, not booked, so they
    // earn the set but not the spiff. Verified against Manny's Aug 24–29 export.
    same_next: {
      label: "Same / next-day appointment",
      needsThreshold: false,
      evaluate(rows, a, b) {
        const qty = {};
        for (const r of rows) {
          const d = r[A_DATE];
          if (!d || d < a || d > b) continue;
          const u = r[A_USER], at = r[A_APPT_AT];
          if (!u || !at || isTransfer(r[A_CAMPAIGN])) continue;
          const days = Math.round((parseD(at.slice(0, 10)) - parseD(d)) / 86400000);
          if (days === 0 || days === 1) qty[u] = (qty[u] || 0) + 1;
        }
        return { qty, met: true };
      },
    },

    // $rate for EVERY appointment each agent set that week — but only if the
    // whole team reached `threshold` appointments. Counts every credited
    // appointment, transfers included, same as the Sets column. Matches the
    // Oct 5–11 team-goal spiff Manny paid by hand (88 of 80, $2 each).
    team_goal: {
      label: "Team goal bonus",
      needsThreshold: true,
      evaluate(rows, a, b, threshold) {
        const counts = {};
        let total = 0;
        for (const r of rows) {
          const d = r[A_DATE];
          if (!d || d < a || d > b) continue;
          const u = r[A_USER];
          if (!u) continue;
          counts[u] = (counts[u] || 0) + 1;
          total++;
        }
        const met = Number.isFinite(threshold) && threshold > 0 && total >= threshold;
        return { qty: met ? counts : {}, met, total, threshold };
      },
    },

    // QA spiff (Manny, week of Oct 19 2026): per booked appointment, per
    // question (credit, homeowner): Yes = 2 points, Unclear = 1 point, else 0.
    // Pays `rate` per point ($1 → $4 max per appointment). Transfers excluded.
    // Stacks on top of the week's volume spiff — it's its own track.
    qa_bonus: {
      label: "QA spiff (credit + homeowner)",
      needsThreshold: false,
      stacks: true,
      evaluate(rows, a, b, threshold, ctx) {
        const qty = {};
        for (const r of rows) {
          const d = r[A_DATE];
          if (!d || d < a || d > b) continue;
          const u = r[A_USER], lead = r[11];
          if (!u || !lead || isTransfer(r[A_CAMPAIGN])) continue;
          const pts = (QA_POINTS[qaValue(ctx, lead, "credit")] || 0)
                    + (QA_POINTS[qaValue(ctx, lead, "home")] || 0);
          if (pts) qty[u] = (qty[u] || 0) + pts;
        }
        return { qty, met: true };
      },
    },
  };

  // The volume spiff (if any) covering the bookings week [a, b]. One per week —
  // the Worker refuses overlapping volume windows. Stacking kinds (QA) are
  // found with stackFor() instead.
  function windowFor(windows, a, b) {
    return (windows || []).find((w) => RULES[w[1]] && !RULES[w[1]].stacks && w[2] <= b && w[3] >= a) || null;
  }
  function stackFor(windows, a, b) {
    return (windows || []).find((w) => RULES[w[1]] && RULES[w[1]].stacks && w[2] <= b && w[3] >= a) || null;
  }

  // -> { qty: {user: qualifying count or points}, met, total?, threshold? }
  // ctx = the dashboard payload (appt_qa, qa_edit) for rules that need QA.
  function evaluate(win, rows, a, b, ctx) {
    if (!win || !RULES[win[1]]) return { qty: {}, met: false };
    const thr = win[6] === null || win[6] === undefined || win[6] === "" ? NaN : Number(win[6]);
    return RULES[win[1]].evaluate(rows || [], a, b, thr, ctx);
  }

  // Short status line for a team-goal week, e.g. "team hit 88 of 80".
  // weekOver = the bookings week has ended (otherwise it's "so far").
  function goalLine(win, ev, weekOver) {
    if (!win || win[1] !== "team_goal" || !ev) return "";
    if (ev.met) return `team hit ${ev.total} of ${ev.threshold}`;
    return weekOver ? `team reached ${ev.total} of ${ev.threshold} — not earned`
                    : `team at ${ev.total} of ${ev.threshold} so far`;
  }

  // Browser widgets read window.SpiffRules; the Worker imports this same file
  // (src/index.js) and reads globalThis.SpiffRules for the owner Payouts view.
  (typeof window !== "undefined" ? window : globalThis).SpiffRules =
    { RULES, windowFor, stackFor, evaluate, goalLine, isTransfer, qaValue, QA_POINTS,
      OOT_UNPAID_FROM, payableRows, unpaidOot };
})();
