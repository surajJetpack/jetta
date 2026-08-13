# JettaChat — first-party chat widget

Jetta's own chat channel: a widget you embed on the WordPress site and inside
the monday apps, with Jetta as the **front line**. No vendor holds the
conversation, and there is no agent console behind it — when Jetta can't
resolve a chat it opens a Freshdesk ticket, which is where humans already work.

## Why it exists

Freshchat was functioning as a ticket-intake form: almost no direct human
replies on chat, and unanswered chats become Freshdesk tickets anyway. That
made the vendor's staffed-console features dead weight, and left the weakest
responder (Freddy) in front of the strongest one (Jetta, with RAG grounding,
billing lookups, dev-board context, and the learning loop).

## Architecture

```
widget (public/jettachat.js)         embedding page: launcher, localStorage, badge
   └─ iframe → /chat                 the UI (app/chat/page.tsx)
        ├─ POST /api/chat/session    create or resume; issues the HMAC token
        ├─ POST /api/chat/message    append + trigger the debounced run
        └─ GET  /api/chat/stream     SSE: new messages, typing, status
                    │
              lib/chat-store.ts      conversations in Upstash Redis
                    │
              lib/chat-run.ts        debounce → buildContext → runAgentLoop
                    │
              lib/tools/jettachat.ts Ticket adapter (same shape as freshchat.ts)
```

The agent pipeline is unchanged — `jettachat` is a third `RunChannel`
alongside `freshdesk` and `freshchat`, and the conversation is adapted into the
existing `Ticket` shape so context assembly, tools, RAG, and analytics all work
as-is.

**One deliberate divergence:** this channel has no `reply_to_ticket` tool. The
model's final text *is* the customer-visible message, delivered by
`lib/chat-run.ts`. Elsewhere a reply must be an explicit API call, so the tool
is the only way to send one; on our own transport it bought nothing and cost
delivery — chat-tuned models answer in prose, and glm-5.2 repeatedly researched
an answer, logged a note claiming it had sent it, and sent nothing. Two rounds
of prompt hardening didn't move it. Removing the tool removes the failure mode
rather than catching it.

## What's different from the ticket channel

| | Freshdesk | JettaChat |
|---|---|---|
| Review | draft mode — a human approves every reply | **none — sent immediately** |
| Escalation | Slack + private note | `create_support_ticket` → Freshdesk |
| Follow-up cron | yes | no (the ticket carries it) |
| Ticket allowlist | enforced | bypassed (`JETTACHAT_LIVE` is the gate) |
| Model tier | auto (complexity-routed) | pinned to standard |
| Sending | `reply_to_ticket` tool call | **the model's final text** (no reply tool) |

Because nothing is reviewed pre-send, the prompt's grounding rule is **absolute**
on this channel: no retrieved article containing the answer ⇒ no answer, ask a
question or open a ticket. Review moves after the fact to `/chats`.

## Setup

1. Set `JETTACHAT_SECRET` (any long random string) and `JETTACHAT_LIVE=true`.
2. Set `JETTACHAT_ALLOWED_ORIGINS` to the sites that embed it. This drives both
   CORS and the `frame-ancestors` CSP — an unlisted origin cannot embed or call
   the API. Empty means "nowhere", so this must be set before the widget works.
3. Set `JETTA_APP_URL` so escalations deep-link to transcripts.

### WordPress

```html
<script src="https://YOUR-JETTA-HOST/jettachat.js" defer data-surface="wordpress"></script>
```

### monday app view

Pass the account context — this is the advantage Freshchat structurally can't
give you. `visitor.app` populates `productHint`, which the existing attribution
precedence treats as ground truth, so billing lookups and dev-board searches
route correctly on the first turn; `mondayAccountSlug` means the trial and
discount tools stop having to ask the customer for their monday URL.

```html
<script>
  window.JettaChatConfig = {
    surface: "monday",
    visitor: {
      mondayAccountSlug: "acme",     // from the monday SDK context
      mondayAccountId: "12345",
      mondayUserId: "67890",
      app: "vlookup",                 // AppProduct slug
      email: "user@acme.com",
    },
  };
</script>
<script src="https://YOUR-JETTA-HOST/jettachat.js" defer></script>
```

`window.JettaChat` exposes `open()`, `close()`, `identify(visitor)`, `reset()`.

## Operating it

- **Kill switch:** `JETTACHAT_LIVE=false` — every chat endpoint 503s
  immediately, no redeploy of the embedding site needed.
- **Review:** `/chats` in the console. Every conversation shows its transcript,
  and each agent run shows what it retrieved, which tools fired, and what went
  out. This is the compensating control for autonomous sending — it is worth
  actually reading daily at first.
- **Ops events:** `chat.turn_superseded`, `chat.no_reply_sent`,
  `chat.rate_limited`, `chat.failed` in the `jetta:events` stream.
  `chat.no_reply_sent` is the one to watch — the loop ended with empty text and
  the apology fallback had to cover.

## Known gaps

- **No attachments.** Visitors can't send screenshots; the ticket hand-off is
  the path for anything needing a file.
- **`cf_product` labels are transcribed, not verified.** `createTicket` retries
  without the field if Freshdesk rejects it, so a hand-off can't fail on this —
  but confirm the dropdown values against a real ticket and fix
  `CF_PRODUCT_LABELS` in `lib/tools/freshdesk.ts` if attribution comes through
  empty.
- **No business-hours awareness.** Jetta answers at 3am the same as 3pm, which
  is the point, but there is no "we're offline" mode if you ever want one.
