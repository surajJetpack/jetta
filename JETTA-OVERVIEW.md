# Jetta — Technical Overview

**Autonomous AI support agent** for Jetpack Apps (monday.com marketplace) and GetSign (e-signature). Lives inside Freshdesk/Freshchat as a named agent and handles the full ticket lifecycle — triage → answer → escalate → follow up → close — escalating to humans only when judgment is genuinely required.

**Stack:** Next.js 16 (App Router, Fluid Compute) on Vercel · AI SDK · Upstash Redis (state) · Upstash Vector (RAG) · models via OpenRouter, tiered light/standard. The live model per tier is on /system, not here; this file goes stale.

**Draft mode:** on Freshdesk, Jetta's reply is posted as a private-note suggestion and a human sends it. The reconciler compares what was sent against the suggestion. Live chat (JettaChat) is the one channel where she replies unreviewed.

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
| **Tools (13)** | Freshdesk (get ticket, search KB, reply, private note, close) · FastSpring (account, invoice, discount, cancel) · monday (search/create dev item, trial, discount) · Slack (escalate, partnerships) | `lib/tools/*` |
| **RAG grounding** | Semantic search over Upstash Vector: GetSign KB + full Freshdesk Solutions + approved Knowledge-Loop articles. Keyword fallback when vector is off | `lib/vector.ts`, `lib/knowledge/*` |
| **Follow-up cron** | Daily 09:00 UTC. Customer replied → run Jetta only if the webhook has not already answered that message. Silent → closing note + resolve, but ONLY when the FD status is open/pending/waiting on customer and there is no open escalation (`lib/followup-guard.ts`); otherwise held (`cron.followup_held`) | `app/api/cron/followup/route.ts` |
| **Chat follow-up** | Every 5 min: one check-in after 15 min of visitor silence, auto-resolve after 24h | `app/api/cron/chat-followup/route.ts` |
| **Analytics / learning** | Records every outcome; surfaces deflection rate + a "gap list" of tickets Jetta couldn't close → the document-next queue → Knowledge Loop → new KB → RAG | `app/api/admin/stats/route.ts`, `lib/kv.ts` |
| **Ops console** | Today, Chats, Support health, Performance, Team activity, Evals, KB, System, Billing, Test Jetta, plus a read-only voice assistant (⌘J). Per-user login, admin/general roles; the full map is generated from `components/jetta/console-nav.ts` | `app/(console)/*` |

## Safety rails (why it's safe to run against production)

- **Grounding rule** — product specifics (steps, settings, limits) *must* come from a retrieved KB article with its URL. Never guess/approximate. A wrong-but-confident answer is the worst outcome.
- **`STUB_MODE`** master switch → all external clients return canned data; per-integration `*_LIVE` flags allow staged rollout.
- **Dry-run mode** — `/api/admin/run` previews the full action trace with zero external writes (default on).
- **Context-sourced actions** — ticket id and account come from assembled context, never model-supplied values, so an action can't be misrouted.
- **Internal/customer separation** — monday Dev board URLs *and* internal tracking mechanics stay out of customer replies; they go only into private notes.

## Endpoints

| Route | Purpose | Auth |
|---|---|---|
| `POST /api/webhook` | Main entry — Freshdesk/Freshchat events | `x-jetta-secret` |
| `POST /api/webhook/agent-reply` | Reconcile pending drafts when an agent replies in Freshdesk | `x-jetta-secret` |
| `POST /api/admin/run` | Run/replay a ticket (dry-run default) | console login / x-admin-secret |
| `GET /api/admin/stats` | Outcome metrics + gaps + approved articles | console login / x-admin-secret |
| `GET /api/admin/logs` | Run log | console login / x-admin-secret |
| `GET /api/cron/followup` | 24h follow-up sweep | `CRON_SECRET` bearer |
| `/api/admin/kb`, `/api/slack` | KB management · Slack interactions | admin / signing |

## KPIs to highlight

- **Deflection rate** = `1 − escalated/total` — the headline metric.
- Resolved · escalated · reopened · closed counts; tool-usage distribution.
- **Gap list** — the self-improving flywheel: unresolved tickets become KB articles that feed back into retrieval.

## Demo path (2 min)

1. Ops console → **System** → paste a ticket → **Dry-run** → show the full tool trace (KB search → grounded reply → private note).
2. Insights tab → deflection rate + gap list.
3. KB manager → show an approved Knowledge-Loop article that closed a gap.
