# Jetta Console — Reviewer Guide

> Canonical, always-current version: the **Guide** tab inside the console
> (https://jettajetpack.vercel.app/guide). This file is the email/repo copy.

Jetta drafts a reply for every incoming Freshdesk ticket. **Nothing reaches a
customer until one of us sends it.** The suggested reply is posted as a
**private note on the Freshdesk ticket** (customers never see notes) and also
appears in the console's Drafts tab.

**The everyday flow happens in Freshdesk:** copy the note's suggested reply
into the reply editor, edit freely, send as yourself. Jetta notices your reply,
compares it with its suggestion, and records your decision automatically
(sent as-is = approved, edited = approved with edits, something completely
different = draft unused). No console visit needed.

Console (fallback + audit trail): **https://jettajetpack.vercel.app** (log in
with the username + password you were given; sessions last 7 days).

## The Drafts tab — the console fallback

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
- When you're about to reply with something entirely your own, discard the
  draft in the console first (with a reason tag) when you have 10 seconds —
  otherwise Jetta only learns that its draft went unused, not why.

## Ops: the agent-reply automation rule (one-time Freshdesk admin setup)

The "decision recorded automatically" flow depends on a Freshdesk automation:

- Admin → Workflows → Automations → **Ticket updates** → new rule
  "Jetta — reconcile agent reply".
- **When**: Reply is sent, performed by **Agent** (do not include private
  notes or forwards).
- **Action**: Trigger webhook — `POST
  https://jettajetpack.vercel.app/api/webhook/agent-reply`, encoding JSON,
  custom header `x-jetta-secret: <WEBHOOK_SECRET>` (same secret as the main
  rule), content (custom JSON):

  ```json
  {"event": "agent_replied", "ticket_id": "{{ticket.id}}", "updated_at": "{{ticket.updated_at}}"}
  ```

- Env prerequisite: `FRESHDESK_AGENT_ID` must be set in prod (Jetta's own
  agent id, from `GET /api/v2/agents/me` with Jetta's API key) **before**
  enabling the rule — it's how console-approved sends avoid reconciling
  themselves.

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
