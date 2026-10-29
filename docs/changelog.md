# What changed in Jetta

Newest first. One entry per change people would notice: what Jetta does differently, which switch controls it, and whether it is live. The console assistant reads the top of this file at the start of every session, so this is how it hears about a change before the manual covers it in depth.

Format: `## YYYY-MM-DD: short title (#PR)`, then two to four lines in plain words.

## 2026-10-29: Dev-bridge runs can use their own model (#PR)
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
