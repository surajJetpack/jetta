# Jetta Console — Reviewer Guide

Jetta drafts a reply for every incoming Freshdesk ticket. **Nothing reaches a
customer until one of us approves it.** Your job in the console: decide each
draft, and — through those decisions — teach Jetta.

Console: **https://jettajetpack.vercel.app** (log in with the username +
password you were given; sessions last 7 days).

## The Drafts tab — your queue

Each pending card is one suggested reply. Click the header to expand it, check
the ticket link (`#12345 ↗`) for context, then pick one of three moves:

1. **Approve & send** — the reply is good as-is. It goes to the customer
   immediately. If the card says "will resolve ticket", the ticket is closed
   too; "schedules 24h follow-up" means Jetta checks back tomorrow.
2. **Edit, then approve** — the reply is close but not right: fix the text in
   the box and hit "Approve & send (edited)". *Your edit is the most valuable
   training signal we have* — Jetta compares what it wrote against what you
   sent and learns the difference. Optionally open "add feedback" to tag why
   you edited.
3. **Discard…** — the reply shouldn't go out at all. You'll be asked to pick
   at least one reason tag (wrong action, missing product knowledge, tone,
   policy, …) and can add a one-line note saying what should have happened
   instead. Don't skip the note when you have 10 seconds — it directly becomes
   a candidate rule for Jetta. Discarding sends nothing; reply to the customer
   manually from Freshdesk afterwards.

Notes:
- If a customer replies again while a draft is waiting, the old draft is
  marked *superseded* automatically — only ever act on pending cards.
- The private notes you see on tickets in Freshdesk are Jetta's internal work
  log. Drafts only ever appear here in the console, never on the ticket.

## The Evals tab — how Jetta learns

Every decision you make is recorded (approve = good, edited = partial,
discard = bad, plus your tags/notes). Periodically someone hits **"Distill
now"**, which turns accumulated feedback into short candidate rules like
*"Don't offer refunds proactively."* Candidates do nothing until a human
approves them here — once approved, the rule is injected into every future
reply Jetta writes. You can also **retire** a rule that stops being helpful.

You don't need to manage this tab day-to-day; just know your tags and notes
end up here, which is why honest reasons matter more than fast clicks.

## Ground rules

- **Never approve on autopilot.** You are the safety net — check facts,
  links, and account details before sending.
- **Closed ticket / customer already answered?** Discard, don't approve.
- Something looks broken (wrong customer data, weird model output, stuck
  queue)? Ping Suraj rather than working around it.
