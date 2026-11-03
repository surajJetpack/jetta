# What changed in Jetta

Newest first. One entry per change people would notice: what Jetta does differently, which switch controls it, and whether it is live. The console assistant reads the top of this file at the start of every session, so this is how it hears about a change before the manual covers it in depth.

Format: `## YYYY-MM-DD: short title (#PR)`, then two to four lines in plain words.

## 2026-11-03: Cleaner AI reads (Logs, Health, Performance)
Numbers written with thousands separators ("17,277") no longer get a correct point thrown away as "invented": on the production model that was most of what the Logs read dropped. Citation markers like "[E2]" no longer show in the text. On Logs, points are one short sentence and "Worth watching" no longer lists apps having a normal day. Live on merge.

## 2026-11-03: Logs & errors page, with an hourly error watch
New admin-only console page `/logs`: errors per app from Sentry and the CloudWatch server logs, side by side with 14-day trends; what is new or spiking and hits customers (the monday accounts Sentry tagged, chat tickets from those accounts, any dev item that names the error); and an AI read that cites the numbers. An hourly cron (`/api/cron/error-watch`) does the work, so the page and the read are ready before anyone looks. Proactive: each newly flagged customer-hitting error is posted once to Slack (the ops channel, or `JETTA_ERROR_WATCH_CHANNEL`), and a dev item is drafted for one with no item: `JETTA_ERROR_WATCH_DEV_ITEMS=shadow` (the default) only lists what it would file; `on` files them, at most 2 a day. Days Sentry stored nothing (the quota gap) are skipped, so they never fake a spike. Switches: `JETTA_ERROR_WATCH` (off stops the cron), `JETTA_ERROR_WATCH_ALERTS` (off keeps the page, no Slack). Live on merge, dev items in shadow.
## 2026-11-03: GetSign triage note (shadow)
On a new GetSign ticket Jetta adds one private note with her call: a setup problem the customer can fix (what to check, the usual fix), a how-to question, a missing feature, a likely bug, or unsure (with the question that would decide it). Nothing is sent or routed by it and the reply agent never reads it; the team's reply on the same ticket grades it. The playbook behind it was built from 90 days of resolved GetSign tickets; on 29 held-back tickets it called none of the real bugs a setup problem. Switch: `JETTA_TRIAGE_SHADOW` (off unless `on`). Off on merge.

## 2026-11-03: Today, draft matching and performance sync read Jetta's ticket copy
These three no longer download tickets from Freshdesk when Jetta's own copy is up to date (synced in the last 15 minutes, or at least as new as the version Freshdesk listed), which frees most of the 40 calls a minute they shared with customer replies. When the copy is behind or missing a ticket they read Freshdesk exactly as before. Checked side by side on 10 tickets: identical status, "reply owed", matched agent reply and performance record. Switch: `JETTA_TICKET_MIRROR` (`reports` by default; `off` reads Freshdesk only). Live on merge.

## 2026-11-03: Jetta keeps its own copy of every ticket
First step towards a Jetta-native help desk: a Postgres database (Neon) now mirrors Freshdesk tickets, messages, attachment names and contacts. A new cron (`/api/cron/ticket-sync`, every 5 min) copies what changed, then fills in 180 days of history using only spare Freshdesk API budget, so customer-facing runs are never slowed. Nothing reads the copy yet, so Jetta behaves exactly as before; the console inbox and Jetta's switch-over come next. Idle until `DATABASE_URL` is set.

## 2026-11-03: Jetta can read Sentry
The Slack and console assistants can search Sentry, the apps' error tracker (`search_sentry`): grouped errors per app with event and user counts, first/last seen, the release and a link, by monday account id or slug (GetSign backend and Extract AI tag every error with the account), by monday user or board id (JobFlows), or by words from the error, up to 30 days back. It also covers the GetSign frontend, browser errors the server logs never see (those carry no account). A dev item filed from a ticket now lists the Sentry issues tagged with that customer's monday account, found from the chat widget's ids, the log search and pasted monday links. In Sentry "resolved" does not mean fixed: issues auto-resolve while still firing. When Sentry is over its error quota it stores nothing new (seen 2026-10-26 onwards); both the search and the dev item say so rather than report "no errors". Read-only integration token `SENTRY_AUTH_TOKEN`; the ticket agent never sees Sentry results. Switch: `JETTA_SENTRY` (on when the token is set; `off` disables both). Live on merge once the token is in Vercel.

## 2026-11-03: Log search follows a customer's boards
Asked about a customer (email, monday account or user id, slug), `search_app_logs` now also searches the boards that customer's log lines name, because many failures are logged against a board, not the account: asked about one customer's account in Slack, Jetta had missed a whole error type logged only against their board. Those lines come back as `via_boards`, and repeats are grouped with a count. Same `JETTA_APP_LOGS` switch. Live on merge.

## 2026-11-03: Jetta can read the apps' server logs
The Slack and console assistants can search each app's AWS CloudWatch logs (`search_app_logs`): by email, monday account/board/item id, slug or error word, optionally errors only, up to 14 days back. GetSign, VLOOKUP Auto-Link, TrackMy, JobFlows, Pivot Reports Pro, Triggerly, JetScan HR and Hashtask; Extract AI and Smart Columns have no logs there. A dev item filed from a ticket now carries that customer's recent log failures (last 72h), grouped with counts and the error message first. Jetta finds them by the customer's email, by the monday links and board/item ids the customer pasted (the only way in for JobFlows, Triggerly and TrackMy, which never log an email), by the monday account and user ids the GetSign in-app chat widget already knows when the ticket came from a chat (monday-verified; works with no email at all), and by the account and boards those lead to. Chat tickets' internal note now lists those ids too. Added straight to the item: the ticket agent never sees log lines, so none reach a customer. Read-only IAM user `jetta-logs-reader`; tokens and keys are masked. Switch: `JETTA_APP_LOGS` (on when the AWS keys are set; `off` disables both). Live on merge.

## 2026-11-02: Dev bridge tags whoever wrote, stays out of hand-offs, runs once per item (#175)
When Jetta answers a comment on a dev item she now @mentions the person who wrote it, not the Developer column (on #14591 she pinged Shreya three times while Swejal was answering). A comment that @mentions a colleague ("@Sujata you can reply these to the client") is a hand-off: she may draft for the customer but no longer posts on the item. Only one run per item at a time, so a comment that arrives mid-run waits and then starts its own, and the same comment posted twice is answered once (events `devbridge.deferred`, `devbridge.skipped_repost`). Live on merge.

## 2026-10-30: Support health leaves out ad campaigns and other non-support mail (#174)
/health no longer counts tickets the intake filter called marketing, spam or an auto-reply (the "AdsGPT Campaigns… invited you to test OpenAI Ads" invites, newsletters) when nobody answered them and Jetta never drafted on them. They had been showing as customers owed a reply. The webhook now keeps each verdict, and the hourly sync checks up to 5 older unanswered, unlabelled open tickets per run the same way. Live on merge; the existing ones drop off within a sync or two.

## 2026-10-29: Customer text can't pose as a system message (#173)
A customer message that imitates an instruction to Jetta ("SYSTEM: …", "ignore previous instructions", a mode ending, a tool "available again") now reaches her with a note saying it is only the customer's text and has no authority, and in chat a second ticket can't be opened on the strength of one (event `chat.injection_blocked`). In the eval, both glm-5.2 and Kimi had acted on such a line; with this, both ignored it 3 of 3 times. Live on merge.

## 2026-10-29: Dev-bridge runs can use their own model (#172)
Runs a developer starts on a dev item (answering their comment, telling the customer a fix is out) can use a different model from tickets and chat. Replaying this week's real events, Kimi K3.1 Pro passed on only what developers wrote where glm-5.2 invented UI steps and product limits; it is about 3x slower and 10x the price, so it fits this background path and not live chat. Set by `OPENROUTER_MODEL_DEVBRIDGE` (e.g. `moonshotai/kimi-k3.1-pro`); unset, these runs use the standard model as before.

## 2026-10-29: Chat knows the tickets its monday account already has (#170)
In the GetSign or app view, Jetta now sees the newest tickets opened from chats on the same monday account, including a colleague's, with their status, our last reply and engineering's progress. "Did my template get fixed?" is answered from that ticket instead of asking what the problem was. Only accounts the in-app view vouches for; never another person's email, private notes or engineering comments. Live on merge.

## 2026-10-29: Dev bridge chases its own questions and stops double drafts (#169)
When Jetta asks a developer something on a dev item and nobody answers in 3 working days, the daily follow-up chases it in the same thread, twice, then raises it in the escalation channel. This works even on Done or Waiting Customer items. Support's own "any update?" on an item now counts as one of the two asks, so the developer's silence keeps counting and reaches escalation. A developer run now sees a reply that is already drafted for the customer, so a status change and its comment no longer produce two drafts. Dev-item posts now list the files actually attached (or say none came through), so Jetta can no longer tell a developer a screenshot was forwarded when it wasn't; email-signature icons no longer count as pasted screenshots. A developer run that decides to do nothing no longer leaves a "suggested reply" note of its reasoning on the ticket. Live on merge under the existing `JETTA_DEV_BRIDGE` / `JETTA_DEV_FOLLOWUP` / `JETTA_DEV_RELAY` switches.

## 2026-10-28: Compliance requests go to Mark's board (#160)
Security questionnaires, DPAs, BAAs, NDAs, SOC 2 and other compliance requests on a ticket are filed for Mark Shaw on the Security Questionnaires board (`send_to_compliance`), with the customer's files, instead of a dev item or an escalation. Jetta's reply only confirms the hand-off; she never commits to signing, a certification or a turnaround. Live on merge; writes follow `MONDAY_ALLOW_WRITES`.

## 2026-10-28: Follow-ups on dev items with no ticket link (#168)
Only 22 of about 214 live dev items carry a Freshdesk link, so the daily follow-up never saw the rest. Now items a Reporter filed by hand get the same two asks and one escalation: the Developer is asked, or the Reporter when the item is Waiting Customer or has no Developer. Any post of Jetta's now restarts the 3-day clock. Switch: `JETTA_DEV_FOLLOWUP_UNLINKED`.

## 2026-10-25: Light tier can run on DeepSeek V4.1 Flash (#166)
The light tier (triage, KB reranking, chat-screenshot reading) can move from Claude Haiku 4.5 to `deepseek/deepseek-v4.1-flash-1017`: same rerank quality, about 7x cheaper and faster. DeepSeek runs with reasoning off, or reranks time out. Set by `OPENROUTER_MODEL_LIGHT` (reasoning override: `OPENROUTER_LIGHT_REASONING`); Haiku stays the default until that is set.

## 2026-10-22: Dev bridge, part 3: follow-ups on quiet dev items and KB drafts from developers (#165)
Daily, Jetta asks the Developer for an update on a dev item that has had no comment or status change for 3 working days while its ticket is open. A second ask follows 3 working days later, then one escalation-channel post. Developers' answers on Question items, and the docs they share after a fix (PDF, Word, text), are drafted into the KB review queue. Switches: `JETTA_DEV_FOLLOWUP`, `JETTA_DEV_KB`, both in shadow from launch.

## 2026-10-22: Dev bridge, part 2: customer → developers (#164)
When a customer adds details or files on a ticket with an open dev item, Jetta posts them on the item and @mentions the Developer. An explicit "any update?" asks the developer, once per silence. A how-to question the KB can't answer is filed as a Type = Question item (`ask_devs`). Switch: `JETTA_DEV_RELAY`, shadow since 2026-10-22.

## 2026-10-22: Dev bridge, part 1: developers → customer (#163)
A developer's comment or Dev Status change on a ticket's dev item starts a Jetta run. She answers the developer on the item, asks the customer for what's needed, or tells the customer a fix is out. Her monday posts start with "🤖 Jetta:" and show Suraj's name. Switch: `JETTA_DEV_BRIDGE`, shadow since 2026-10-22. The Type column on both dev boards gained a "Question" label.

## 2026-10-22: Ticket follow-ups stop on a colleague's close (#161, #162)
If a colleague tells the customer they are closing the ticket, Jetta's quiet-customer follow-ups stop, even when the count had already restarted.

## 2026-10-19: Follow-ups with quiet customers (#159)
A customer who goes quiet after our reply gets a check-in after 2 business days, a nudge after 3 more, then a close. Each is written in Jetta's voice and sits as a private note for an hour first. `JETTA_TICKET_FOLLOWUP`, live since 2026-10-20.

## 2026-10-15: The voice assistant opens as a chat (#156)
⌘J opens a typed chat; the mic button turns voice on mid-conversation.

## 2026-10-13: Dev board page (#152)
/dev-board shows the monday dev boards as team performance and support activity, and mines item threads for patterns and KB drafts.

## 2026-10-13: Chats inbox redesign (#148–#151)
Three-pane inbox, instant open, stacked views and a Right-now panel.

## 2026-10-13: No em dashes in customer text (#147)
Everything a customer reads goes through a filter, so Jetta's replies read like a person's.

## 2026-10-12: Jetta sends the first reply on direct tickets (#144)
On tickets that came by email, the portal or the in-app form, and nobody has answered, Jetta sends the first reply herself a few minutes after writing it, if a second check passes. `JETTA_FIRST_RESPONSE`.

## 2026-10-10: Site changes reach the KB (#143)
Pages the site sync owns update automatically; for hand-written articles a "Site changed" notice lands in the review queue.

## 2026-10-07: The KB review queue is open to everyone (#138)
General users can review and publish drafts; archiving stays admin-only.

## 2026-10-06: The dev board has the last word before a close (#137)
The follow-up cron never closes a ticket whose dev item is still in flight.
