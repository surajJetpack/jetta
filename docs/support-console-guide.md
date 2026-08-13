# Jetta Console — Support Guide

> Canonical, always-current version: the **Guide** tab inside the console
> (https://jettajetpack.vercel.app/guide). This file is the email/repo copy.

Jetta is our AI support agent. It reads every incoming Freshdesk ticket,
searches the knowledge base, checks the customer's account and the dev board,
works out which app the ticket is about, and writes a suggested reply.

**On Freshdesk, nothing reaches a customer until a human sends it.** The
suggestion is posted as a **private note on the ticket** (customers never see
notes).

**Live chat is the exception** — there Jetta answers the visitor directly, with
nobody reading it first. Review happens after the fact, in the Chats tab.

Console: **https://jettajetpack.vercel.app** (log in with the username +
password you were given; sessions last 7 days).

## Replying — it all happens in Freshdesk

Copy the note's suggested reply into the reply editor, change whatever you
want, and send as yourself. **That is the whole workflow.** There is no console
step and no queue to clear.

Writing the reply *is* the feedback: Jetta reads back what you actually sent,
compares it against what it suggested, and records the difference on its own —
sent as-is, edited, or replaced entirely. You never have to tell it.

Two things worth knowing:

- If the customer writes again while a suggestion is waiting, the old one is
  marked *superseded* and Jetta writes a fresh one against the new message.
- If nobody ever replies to a ticket, its suggestion quietly *expires* after
  two weeks rather than piling up. An expired suggestion is not a black mark
  against anyone.

Every suggestion is kept at `/drafts` as an audit trail. It is not in the nav,
because it is not a queue anyone works.

## The Today tab — start your day here

One screen for the morning read. Every number counts **tickets Jetta handled**,
not all Freshdesk traffic.

- **Your briefing** — a short written read of the numbers on the page, with one
  *Start here* action. Commentary; the tiles and lists are the source of truth.
- **Emerging issues** — topics running above their normal rate: at least 3
  tickets in 24h *and* 3× the daily average of the previous 14 days, so an
  ordinary busy day doesn't cry wolf. Each shows which app it hit and whether
  the KB already answers it. "in KB" means customers can't find an answer that
  exists; "no KB article" means it needs writing.
- **Waiting on a human** — the only work here that is actually yours:
  escalations, reopened tickets (Jetta's answer didn't land — the highest
  signal item on the page), KB articles awaiting review, billing approvals, and
  candidate learnings to approve.
- **Worth documenting** — the week's unresolved tickets grouped *by theme*, so
  one article closes a whole group rather than a single ticket.

## The Evals tab — how Jetta learns

The loop that changes Jetta's behaviour, and the one tab that genuinely needs
you.

1. **Learn from human replies** — takes recently resolved tickets, replays what
   Jetta *would* have written, and compares it against what you actually sent.
   Every meaningful divergence is recorded. This is the main input: your
   ordinary replies are the training data.
2. **Distill now** — turns accumulated divergences into short candidate rules,
   e.g. *"Don't offer refunds proactively."* Patterns only; a one-off never
   becomes a rule.
3. **Approve or reject** — **nothing changes until you approve.** An approved
   rule is injected into every reply Jetta writes from then on; a rejected one
   is never proposed again. Approve narrowly — a rule is permanent instruction
   until someone **retires** it.

Rule of thumb: product **facts** belong in the Knowledge Base, **behaviour**
belongs in Evals. "The Pro plan is $29" is a KB article. "Ask which board
before troubleshooting a sync" is a learning.

## The other tabs, briefly

- **Chats** — transcripts of live chats Jetta handled alone. Skim for wrong
  facts, confident answers to things it should have escalated, or off tone.
- **Knowledge Base** — draft → in_review → published → archived. **Only
  published articles are searchable by Jetta.** Syncs daily from our websites.
- **Billing** — trial extensions and discounts Jetta won't grant itself. Repeat
  trial-stretching is flagged. Pending requests expire after 3 days, so an
  ignored one never quietly grants itself.
- **Insights** — the ops view: yesterday's rollup, volume and cost over time,
  per-model quality, and the event log. Volume is broken down per app, never as
  one "Jetpack Apps" lump.
- **Console** — system status, and a ticket tester that re-runs any ticket.
  With *Dry run* on (default) nothing is written; use it to answer "why did it
  say that?".

## Ground rules

- **Read before you send. You are the last check.** Jetta writes confidently
  whether or not it is right — check facts, prices, links and account details,
  especially anything about money.
- If a suggestion is wrong, just write your own reply. That disagreement is
  exactly what the learning loop feeds on.
- **Never cancel a subscription** unless the customer has clearly asked for it.
- Something looks broken (wrong customer data, a reply about the wrong product,
  a queue that won't clear)? Ping Suraj rather than working around it.

## Ops: the agent-reply automation rule (one-time Freshdesk admin setup)

Reconciliation also runs as an hourly poll, so this rule is an optimisation
rather than a dependency — it just makes the read-back immediate.

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
  enabling the rule — it's how Jetta's own sends avoid reconciling themselves.
