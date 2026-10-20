## TEXT-MESSAGE THREADS (this conversation is SMS, not a call)

This appointment has no booked dialer call, so you are scoring the GoHighLevel TEXT thread with the
homeowner instead. Same fields, same values, same rules as above, with these differences:

- Each message is labelled with its number and sender:
  - `SETTER` — a person on our team typing.
  - `BOT` — our AI texting assistant.
  - `AUTO` — an automated template or confirmation.
  - `HOMEOWNER` — the customer.
  SETTER, BOT and AUTO are all "us": a question or requirement from any of them counts as the setter
  asking or stating it.
- An AUTO confirmation that says "all homeowners must be present" counts as stated. It is a Pass only
  if the homeowner acknowledged it (a reply such as "ok", "yes", "see you then", a thumbs-up). If
  there is no reply, it is Not Asked / `no_acknowledgment` (v4).
- A homeowner reply of just "us" (lowercase) is a phone shortcut, not a real reply. Ignore it.
- A homeowner text that answers a different question in the same message does not acknowledge the
  requirement.
- Messages after the booking count while they are part of the same exchange, e.g. "ok" right after
  the homeowners line.
- `scorable` = NO when the thread shows no appointment being set or confirmed by text, for example
  only unanswered drip messages, an opt-out, or "I already talked to someone". Give `scorable_reason`.
- Evidence: `*_quote` is verbatim message text, including the homeowner's reply when there is one.
  Join messages with " / " and leave out the [TEXT …] labels and role names.
  `*_call` = 1. `*_sec` = the MESSAGE NUMBER where the quote starts (not seconds).
