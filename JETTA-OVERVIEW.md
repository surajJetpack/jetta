# Jetta — Technical Overview

**Autonomous AI support agent** for Jetpack Apps (monday.com marketplace) and GetSign (e-signature). Lives inside Freshdesk/Freshchat as a named agent and handles the full ticket lifecycle — triage → answer → escalate → follow up → close — escalating to humans only when judgment is genuinely required.

**Stack:** Next.js 16 (App Router, Fluid Compute) on Vercel · AI SDK · Upstash Redis (state) · Upstash Vector (RAG) · models via OpenRouter, tiered light/standard. The live model per tier is on /system, not here; this file goes stale.

**Draft mode, with an auto-sent first reply:** on Freshdesk, Jetta's reply is posted as a private-note suggestion and a human sends it. The reconciler compares what was sent against the suggestion. The exception is the **first response** (`JETTA_FIRST_RESPONSE=on` in prod since 2026-10-12, `lib/first-response.ts`): on a ticket that came in directly (FD source 1 email, 2 portal, 3 in-app form, 9 widget; never 7 chat) with no public agent reply, a temperature-0 standard-tier gate checks the reply, a private note announces it, and `/api/cron/first-response` sends it 3–7 minutes later unless a teammate replied, the ticket was tagged `jetta-hold` or closed, or the customer wrote again. Held replies fall back to a normal draft. Live chat (JettaChat) also gets replies unreviewed.

---

## Request flow

```
Freshdesk/Freshchat webhook
        │  POST /api/webhook   (shared-secret header + Redis idempotency dedupe)
        ▼
buildContext()            ── ticket + conversation, FastSpring billing account,
 (lib/context.ts)            related monday Dev items, inferred product
        ▼
runAgentLoop()            ── AI SDK generateText, multi-step tool loop (≤10 steps)
 (lib/agent.ts)              system prompt = persona + voice + decision rules
        ▼                     (lib/system-prompt.ts, versioned in source)
  [ tool calls ]           ── Freshdesk · FastSpring · monday · Slack  (13 tools)
        ▼
recordOutcome() + recordRun()   ── analytics/learning loop (Redis)
resolution sent? → scheduleFollowUp() (24h)
  (draft mode: scheduled by the reconciler, only when the human actually sent
   Jetta's suggestion; never for a turn that escalated or filed a dev item)
```

## Components

| Area | What it does | Where |
|---|---|---|
| **Agent loop** | Provider-agnostic multi-step tool loop; reads `signals` to detect a logged resolution | `lib/agent.ts`, `lib/llm.ts` |
| **System prompt** | Persona, voice, and mandatory decision rules (confidence, grounding, escalation, closing). Behavior changes happen here, not in code | `lib/system-prompt.ts` |
| **Tools (13)** | Freshdesk (get ticket, search KB, reply, private note, close) · FastSpring (account, invoice, discount, cancel) · monday (search/create dev item, read comments, ask_devs, update_dev_item, reply_on_dev_item, send_to_compliance, trial, discount) · Slack (escalate, partnerships) | `lib/tools/*` |
| **RAG grounding** | Semantic search over Upstash Vector: GetSign KB + full Freshdesk Solutions + approved Knowledge-Loop articles + the GetSign app reference (hand-written articles pinned to the app team's configuration doc, filed as review-queue drafts by the daily kb-sync, which re-reads the doc and redrafts an article when its section changes; published ones only). Keyword fallback when vector is off | `lib/vector.ts`, `lib/knowledge/*`, `lib/getsign-reference.ts` |
| **Ticket follow-ups** | Every 20 min: a customer who went quiet after our reply gets a check-in after 2 business days, a nudge after 3 more, then a close + resolve after 3 more, each written from the thread, in Jetta's name, at the hour the customer last wrote. Each touch sits on the ticket as a private note for ~1h first; any reply or `jetta-hold` stops it, a colleague's reply restarts the count. Never over an open escalation or an in-flight dev item (only "Waiting Customer" items get check-ins, never the close). Armed by `JETTA_TICKET_FOLLOWUP=on` | `lib/ticket-followup*.ts`, `app/api/cron/ticket-followup/route.ts` |
| **Compliance routing** | Questionnaires, DPAs/BAAs/NDAs, SOC 2 and compliance questions go to Mark Shaw (external) on the Security Questionnaires board (`send_to_compliance`, one item per ticket, files forwarded); replies never commit to signing, certifications or turnaround; an open compliance item holds the ticket open like a dev item. Writes follow `MONDAY_ALLOW_WRITES`; board/owner via `MONDAY_BOARD_ID_COMPLIANCE`, `MONDAY_COMPLIANCE_OWNER_ID` | `lib/tools/monday.ts` (`createComplianceItem`), `lib/system-prompt.ts` (`COMPLIANCE_*`) |
| **Dev bridge** | Freshdesk ⇄ monday dev boards, two-way, four switches each `off`/`shadow`/`on`: developers' comments and Dev Status changes start ticket runs (`JETTA_DEV_BRIDGE`, `reply_on_dev_item`); customer info, "any update?" and KB-less how-to questions go to the item (`JETTA_DEV_RELAY`, `update_dev_item`, `ask_devs` → Type = Question); quiet items get two asks then one escalation (`JETTA_DEV_FOLLOWUP`, daily cron; items with no ticket link that a Reporter filed join via `JETTA_DEV_FOLLOWUP_UNLINKED`, asking the Reporter when the item waits on the customer or has no Developer); developers' answers and docs become KB drafts (`JETTA_DEV_KB`). Posts as Suraj's monday user, prefixed "🤖 Jetta:", @Developer; never changes columns An item's ticket link is stored when it is filed (`lib/dev-item-links.ts`), so the item stays tied to its ticket however long its thread gets; a customer's answer to a developer's in-thread question is posted back into that thread. | `lib/dev-bridge.ts`, `lib/dev-followup.ts`, `lib/dev-kb.ts`, `app/api/webhook/monday-activity`, `app/api/cron/dev-followup` |
| **Release watcher** | Hourly: reads merges into production in the four GetSign app repositories on GitHub (read-only, `JETTA_GETSIGN_REFERENCE_TOKEN`). A release is a `dev`/`qa` → `main` pull request; its fixes are the pull requests named in its commits, grouped by branch across repositories, back-merges skipped. A light-tier call labels each fix customer-visible or not. For a visible fix: an open GetSign dev item it resolves is found (exact when the pull request links the item, else keyword shortlist + standard-tier pick) and, if `shouldSuggest` agrees, the Developer is asked on the item to confirm by setting Dev Status, which is what tells the customer (dev bridge); published articles about the area get a `--release-change` notice in the review queue (`meta.revises`, never indexed); one note goes to Slack. `JETTA_RELEASE_WATCH` off/shadow/on; each write has its own done-marker and the per-repository cursor moves only after a clean run | `lib/release-watch.ts`, `lib/github.ts`, `app/api/cron/release-watch` |
| **Fix lookup** | The release watcher also keeps every fix it reads in a Redis hash (`jetta:fixes:v1`, 120 days, keyed by branch): `released` with its release date, or `merged` (in `dev`, read on a second cursor, not yet shipped); its first run seeds 60 days of releases, store only. In `buildContext`, for GetSign Freshdesk tickets, the ticket text is shortlisted against customer-visible fixes by distinctive-word overlap and a standard-tier call confirms which are the same problem (cached per ticket text for 6h). The result is `ctx.recentFixes`, which is NEVER rendered into the prompt and returned by no tool, so a reply cannot claim a fix. The system writes it in two places: one private note for support per ticket per fix (after the run, from the webhook), and `releaseEvidence` on a dev item Jetta files, next to the log and Sentry evidence, flagged as a possible regression when the fix shipped within 14 days. `JETTA_FIX_LOOKUP` off/shadow/on | `lib/fix-store.ts`, `lib/fix-lookup.ts`, `lib/context.ts`, `lib/tools/index.ts` (`create_dev_item`), `app/api/webhook/route.ts` |
| **Repeat problems** | Groups GetSign tickets that report the same malfunction, by comparing the tickets with each other (the topic label is too coarse and may not quote an error). `problemForTicket` runs in `buildContext` after triage (customer queries only): a light-tier call states the ticket's symptom in one sentence, or says it is not a malfunction and stops; earlier symptoms sharing its distinctive words are shortlisted (30 days) and one standard-tier call says which are the same malfunction; no shortlist, no second call; a ticket already in another problem is never pulled out of it; decided once per ticket, stored in Redis (`jetta:problems:tickets:v1`, `jetta:problems:v1`, 45 days). `ctx.problem` is NEVER rendered into the prompt. `raiseProblem` runs from the webhook after the run: at 3 distinct customers in 30 days (requester hashed, never stored), or 2 when one wrote in after a released fix (`ctx.recentFixes`), it finds the item (a ticket's own, a strong board match, or files `[Repeat problem] …`, cap 2/day), comments once with every ticket (@Developer, `rememberJettaPost`), adds one line per later ticket, and posts a private note on each ticket. `create_dev_item` adds a ticket to its problem's item (`addTicketToItem`) instead of filing a second. The dev bridge still tells only the item's first ticket when it ships. `JETTA_REPEAT_PROBLEMS` off/shadow/on | `lib/problems.ts`, `lib/problem-store.ts`, `lib/context.ts`, `lib/tools/index.ts` (`create_dev_item`), `lib/tools/monday.ts` (`addTicketToItem`), `app/api/webhook/route.ts` |
| **Ticket mirror** | Jetta's own Postgres (Neon) copy of every Freshdesk ticket, message, attachment name and contact — the foundation for a Jetta-native help desk (Option C). Every 5 min the `ticket-sync` cron copies changed tickets (including agent replies made in FD, which send no webhook), then backfills 180 days of history with spare API budget. Every Freshdesk call now records the remaining per-minute budget (`jetta:fd:ratelimit`); the mirror yields when fewer than 15 calls are left. Read by /today, draft reconcile and the performance sync when current (`lib/ticket-mirror/read.ts`, switch `JETTA_TICKET_MIRROR`, default `reports`), Freshdesk otherwise; ticket replies still read Freshdesk | `lib/db/*`, `lib/ticket-mirror/sync.ts`, `lib/tools/fd-budget.ts`, `lib/email-clean.ts`, `app/api/cron/ticket-sync` |
| **Missed-reply backstop** | Daily 09:00 UTC: a customer reply the webhook never answered gets a Jetta run | `app/api/cron/followup/route.ts` |
| **Chat follow-up** | Every 5 min: one check-in after 15 min of visitor silence, auto-resolve after 24h | `app/api/cron/chat-followup/route.ts` |
| **Analytics / learning** | Records every outcome; surfaces deflection rate + a "gap list" of tickets Jetta couldn't close → the document-next queue → Knowledge Loop → new KB → RAG | `app/api/admin/stats/route.ts`, `lib/kv.ts` |
| **Ops console** | Today, Chats, Support health, Performance, Team activity, Evals, KB, System, Billing, Test Jetta, plus a read-only voice assistant (⌘J). Per-user login, admin/general roles; the full map is generated from `components/jetta/console-nav.ts` | `app/(console)/*` |

## Safety rails (why it's safe to run against production)

- **Grounding rule** — product specifics (steps, settings, limits) *must* come from a retrieved KB article with its URL. Never guess/approximate. A wrong-but-confident answer is the worst outcome.
- **`STUB_MODE`** master switch → all external clients return canned data; per-integration `*_LIVE` flags allow staged rollout.
- **Dry-run mode** — `/api/admin/run` previews the full action trace with zero external writes (default on).
- **Context-sourced actions** — ticket id and account come from assembled context, never model-supplied values, so an action can't be misrouted.
- **Proven identity only** — on the chat widget, a monday account counts only with monday's signed session token, and billing is never looked up or changed there: a typed email proves nothing. On tickets the billing lookup is for the requester's own address.
- **Honest results** — a write that is switched off, a lookup that failed, a post that landed elsewhere and a tool that declined are each reported as that, to the model and to everything that reads the run. Nothing is counted as done because it was attempted.
- **A missing secret refuses** — every cron, webhook and Slack request is checked in one place (`lib/request-auth.ts`); on a deployment an unset secret means 401, never open.
- **Internal/customer separation** — monday Dev board URLs *and* internal tracking mechanics stay out of customer replies; they go only into private notes.

## Endpoints

| Route | Purpose | Auth |
|---|---|---|
| `POST /api/webhook` | Main entry — Freshdesk/Freshchat events | `x-jetta-secret` |
| `POST /api/webhook/agent-reply` | Reconcile pending drafts when an agent replies in Freshdesk | `x-jetta-secret` |
| `POST /api/admin/run` | Run/replay a ticket (dry-run default) | console login for a dry run, admin for a live one / x-admin-secret |
| `GET /api/admin/stats` | Outcome metrics + gaps + approved articles | console login / x-admin-secret |
| `GET /api/admin/logs` | Run log | console login / x-admin-secret |
| `GET /api/cron/followup` | Missed-reply backstop | `CRON_SECRET` bearer |
| `GET /api/cron/ticket-followup` | Ticket follow-ups (`?dry=1&preview=1` to read without sending) | `CRON_SECRET` bearer |
| `/api/admin/kb`, `/api/slack` | KB management · Slack interactions | console login (admin to archive, or to delete a live article) / signing |

## KPIs to highlight

- **Deflection rate** = `1 − escalated/total` — the headline metric.
- Resolved · escalated · reopened · closed counts; tool-usage distribution.
- **Gap list** — the self-improving flywheel: unresolved tickets become KB articles that feed back into retrieval.

## Demo path (2 min)

1. Ops console → **System** → paste a ticket → **Dry-run** → show the full tool trace (KB search → grounded reply → private note).
2. Insights tab → deflection rate + gap list.
3. KB manager → show an approved Knowledge-Loop article that closed a gap.
