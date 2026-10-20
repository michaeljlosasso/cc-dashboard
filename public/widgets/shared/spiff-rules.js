/* Spiff rules — the ONE place weekly spiff math lives.
 *
 * Loaded by the Commission tab (widgets/payroll) and the Spiffs tab
 * (widgets/spiffs) so the two can never disagree about what a spiff paid.
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
  };

  // The programmatic spiff (if any) covering the bookings week [a, b].
  // One per week — the Worker refuses overlapping windows.
  function windowFor(windows, a, b) {
    return (windows || []).find((w) => RULES[w[1]] && w[2] <= b && w[3] >= a) || null;
  }

  // -> { qty: {user: qualifying count}, met, total?, threshold? }
  function evaluate(win, rows, a, b) {
    if (!win || !RULES[win[1]]) return { qty: {}, met: false };
    const thr = win[6] === null || win[6] === undefined || win[6] === "" ? NaN : Number(win[6]);
    return RULES[win[1]].evaluate(rows || [], a, b, thr);
  }

  // Short status line for a team-goal week, e.g. "team hit 88 of 80".
  // weekOver = the bookings week has ended (otherwise it's "so far").
  function goalLine(win, ev, weekOver) {
    if (!win || win[1] !== "team_goal" || !ev) return "";
    if (ev.met) return `team hit ${ev.total} of ${ev.threshold}`;
    return weekOver ? `team reached ${ev.total} of ${ev.threshold} — not earned`
                    : `team at ${ev.total} of ${ev.threshold} so far`;
  }

  window.SpiffRules = { RULES, windowFor, evaluate, goalLine, isTransfer };
})();
