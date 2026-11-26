# What changed in Jetta

Newest first. One entry per change people would notice: what Jetta does differently, which switch controls it, and whether it is live. The console assistant reads the top of this file at the start of every session, so this is how it hears about a change before the manual covers it in depth.

Format: `## YYYY-MM-DD: short title (#PR)`, then two to four lines in plain words.

## 2026-11-26: No "customer not told" nudge when support replied just before the status change
Support often answers the customer and then sets the dev item's status a few minutes later. Jetta only counted a reply sent after the status change, so on #14854 and #14868 she asked Sujata to tell the customer something she had already told them. A public reply from us up to 2 hours before the developer's move now counts, as long as the customer has not written since. The same rule drives the developer rows of To do on the Daily report. Under `JETTA_DEV_FOLLOWUP_SUPPORT`; live on merge.

## 2026-11-25: The Today page no longer times out when the ticket copy is down
While Jetta's ticket copy was unavailable (22 to 25 November), the Today page asked Freshdesk about every ticket on its list at once, about 50 calls against a limit of 40 a minute. Freshdesk refused them, the page waited on retries and died at 60 seconds, and the briefing never appeared. It also used up the allowance ticket replies share.
Now it asks Freshdesk about 4 tickets at a time for at most 12 seconds. Tickets it could not check stay on the list as the run history left them, with a line saying how many (`today.tickets_unchecked` in the event log). The briefing's model call is limited to 40 seconds, so a slow model gives you the previous briefing, not an error.
No switch. With the ticket copy healthy, as it is now, nothing changes.

## 2026-11-25: The chat widget holds a live connection only while it is on screen
The widget kept a live connection to Jetta for as long as a visitor's page was open, even with the chat panel closed or the tab in the background, and each connection read the database twice every 1.5 seconds. About 14 were open at any moment. With the console listing 100 chats one read at a time, that came to roughly 40 million reads a month and most of the Vercel bill.
Now the live connection is held only while the chat is open in the tab the visitor is looking at. Out of view, the widget checks every 10 seconds while the visitor is waiting on an answer and every 30 otherwise, so the unread badge can lag by up to half a minute. In view, a quiet chat is checked every 3 seconds, an active one every 1.5 as before.
The console's chat list and attention badge read 100 chats in 4 reads where they used 101; their timing is unchanged. No switch. Live on merge.
## 2026-11-25: /system says when the ticket copy has stopped updating
Since at least 22 November the job that copies Freshdesk tickets into Jetta's own database (`ticket-sync`, every 5 minutes) failed on every run: the database is on Neon's free plan and its usage quota ran out, so it refused every query. /system showed nothing wrong, because the "Ticket mirror reads" row only looked at the settings.
That row now reads **SYNC FAILING** after three failed runs in a row, with how many runs have failed, when the job last worked and the database's own reason. The event log (`ticket_sync.failed`) and the cron heartbeats record that reason too, where before they kept only the query that failed or "HTTP 500".
Nothing a customer sees was affected: everything that reads the copy falls back to Freshdesk. No switch. This change only reports the problem; the copy starts filling again once the database's plan is upgraded or its quota resets.
## 2026-11-25: Dev bridge: findings reach the customer, no next-morning nudge, cleaner drafts
From ticket #14773. A developer's finding (bug or limitation confirmed, fix being worked on) is now drafted for the customer unless our last reply already said it; a bare "working on it" still gets nothing. A re-test request is written as steps, and never implies a fix is released when the developer did not say so (`JETTA_DEV_BRIDGE`).
The daily follow-up to developers (`JETTA_DEV_FOLLOWUP`) now needs about 20 working-day hours of silence, so a comment written in the evening is no longer chased at 04:30 the next morning, and it says "1 working day".
Suggested-reply notes: files the developer attached are named above the draft, bold and lists render instead of showing `**`, and a sign-off ending in a booking link is removed. Not live until this is merged.

## 2026-11-23: The Slack message to Mark reads like a person wrote it
The compliance reminder is sent from Suraj's own Slack account, so it now reads that way: a short first-person note with the request titles, no "sent automatically" footer and no link per item.
The only link is the monday board. Freshdesk ticket numbers are gone, because Mark has no Freshdesk login. When and how often he is messaged is unchanged (`JETTA_COMPLIANCE_NUDGE`).

## 2026-11-23: Slack reminders to Mark about compliance requests
Mark Shaw often misses monday's notifications, so Jetta can now message him on Slack as well. Hourly, she reads the Security Questionnaires board and sends him one direct message listing the requests waiting on him: a new one at the next run, and a reminder every 2 working days while it stays Pending or Stuck and he has not written on the item (6 messages per item at most, nothing at weekends).
Mark is in a different Slack workspace, so the message goes from Suraj's own account there (a user token, `SLACK_COMPLIANCE_USER_TOKEN`, to `SLACK_COMPLIANCE_TO`), not from the Jetta bot.
Switch: `JETTA_COMPLIANCE_NUDGE` (off / shadow / on). Off until it and the two Slack values are set in production.

## 2026-11-22: The team can leave feedback for Jetta on a dev item
On any item on the two monday dev boards, a comment that starts with "Jetta feedback:" (an @mention before it is fine) is kept on the console's new **Feedback** page with who wrote it and on which item. Jetta thanks the writer in the same thread and does nothing else with the comment: no ticket run, no reply to the customer.
Admins and the developers in `CONSOLE_DEV_USERS` can read the page; an admin marks an entry handled. Nothing is changed automatically from feedback: a person reads it and decides.
There is no switch. It works whenever the monday webhooks are registered, with the dev bridge on or off. Not live until this is merged.

## 2026-11-22: Jetta says yes to demos and gives the booking link
A chat visitor asked "do you offer demos?" and Jetta answered that we don't; nothing told her we do. Now, on chat and on tickets, when a customer asks for a demo, call, meeting or screen-share she says yes and gives the booking link (https://calendar.app.google/zwLMTtr9LK3SeBFM7), and she is told never to say we don't offer them. First replies on tickets that ask for a call are no longer held for a person when her reply gives the link, and her second follow-up to a quiet customer may offer the call. `JETTA_BOOKING_URL` replaces the link, `off` removes it (a person arranges the call, as before). Live on merge.

## 2026-11-21: Dev items carry a summary of the logs, not every failure
A dev item filed from a ticket used to list every kind of failure the customer's account had in the last 72 hours, as raw lines. Now Jetta matches those failures against what the customer reported, writes two or three sentences on what the matching ones show, keeps those lines (shortened, each linked to CloudWatch) and says how many unrelated kinds she left out. When nothing matches she says so. If the model read fails, the full list is posted as before. Sentry issues are no longer added to these items; the assistants can still search Sentry, and items the error watch files still carry them. The developers asked for both (Swejal, 17 Nov). No new switch (`JETTA_APP_LOGS` still turns the log evidence off); live on merge.

## 2026-11-21: Cleaner dev board posts, from the team's feedback
Four fixes to what Jetta writes on the dev boards. One customer message now gets one post on the item (ticket #14815 got an update request and a relay a second apart). A name she typed is no longer shown next to the real @mention. Her theory about a cause is filed on its own line, "Possible cause (Jetta's guess from the ticket, not verified)", and the reproduction steps hold only what the customer did. When an item is set to Waiting Customer with no request in the comments, she reads the ticket first and stays quiet if a colleague has already asked the customer. No switch; live on merge.

## 2026-11-21: Jetta follows up with support on the dev boards, faster with developers, and brings the product manager in on feature requests
When the developers have answered, need more from the customer, or finished an item, and the customer has not been told, Jetta now asks the support person on the item at the next hourly run (:55), with no waiting period; once more a working day later; then one post in the escalation channel. A new feature request a customer is waiting on gets one comment bringing in the product manager (Binod, `DEV_BOARD_PM`). Switch: `JETTA_DEV_FOLLOWUP_SUPPORT` (off, shadow, on). Off until set.
Developers are asked about a quiet item after one working day, not three (`JETTA_DEV_QUIET_WORKDAYS`), and Saturday and Sunday are both days off for every dev board follow-up (`JETTA_DEV_WEEKEND`). These two apply as soon as this is deployed, wherever `JETTA_DEV_FOLLOWUP` is on.

## 2026-11-21: A finished dev item ends the escalation, and a skipped follow-up leaves a note
Jetta never follows up with a quiet customer while the ticket is escalated in Slack, and she remembered an escalation until the ticket was resolved. On #14752 the developers finished their item the next morning, the escalation stayed on record, and the follow-up due four days later was refused; nothing on the ticket said so, and the customer heard nothing for nine days.
Now the escalation is over once every dev item filed for the ticket is finished, and she follows up as usual. A ticket stopped for an escalation is looked at again once a day. An escalation with no dev item still holds.
When she will not follow up because of the status, an open escalation or a dev item in flight, she leaves one private note saying why. No switch; applies wherever `JETTA_TICKET_FOLLOWUP` is on.

## 2026-11-20: The daily Slack report no longer carries the To do list
The post is now one message: the summary line and the Team table. What needs doing (customers waiting, developer updates to pass on) stays on the console's Daily report page, and the summary line links to it as "N to do".
No switch; applies to the next post. The Daily report page is unchanged.

## 2026-11-20: A daily team report in Slack
Each morning (03:30 UTC) Jetta can post a short report about the day before as two Slack tables (To do, and Team: Name, Freshdesk, monday dev boards, Other), with every ticket and dev item linked. It has the team's numbers, a To do list when there is one, and one line per person, Jetta included.
To do: customers waiting more than 4 hours for a reply, tickets waiting over 14 days to reply to or close, and developer updates the customer has not been told about yet (developers answered, need more from the customer, or shipped a fix), from the Dev board.
Per person, support team first and developers and others after: Freshdesk replies, first replies, chats, items filed and comments on both monday dev boards, Slack, console. Each count is a link that opens the list behind it on a new console page, Daily report (/team-report, admin), which shows the same report for any day. Alphabetical, not ranked. Worked out by rule from the Team activity, Performance, Support health and Dev board stores; no model writes it.
Off until `JETTA_TEAM_REPORT_CHANNEL` holds a Slack channel id; `JETTA_TEAM_REPORT_TZ` sets whose calendar day "yesterday" is (unset: `JETTA_TZ`). Not live yet. Admins can read the exact text for any day without posting at `/api/admin/team-report?day=YYYY-MM-DD`.

## 2026-11-20: A developer can be given the Dev board and Logs & errors
Both pages were admin-only, so a developer with a general login could not see the two pages written for them without being made a full admin.
Now a general user named in `CONSOLE_DEV_USERS` (comma-separated usernames) sees **Dev board** and **Logs & errors** in the sidebar and ⌘K, and the data behind them loads, including what the pages do: sync, a KB draft from a thread, and the error watch run. Everything else stays as it was for a general user: no Insights, Performance, Team activity, Self-review, Evals, Articles or System.
Off until the variable is set; takes effect on the next deploy. An admin viewing as general loses the two pages unless listed too.

## 2026-11-20: A console login can be added with one variable per person
Console logins lived in two lists, `CONSOLE_USERS` and `CONSOLE_USERS_EXTRA`, which Vercel stores write-only. Adding a colleague meant retyping every password already in the list, or locking those people out.
Now `CONSOLE_USER_<NAME>` set to a password signs that person in as `<name>` in lower case (`CONSOLE_USER_NIRANJAN` is the login `niranjan`). Deleting the variable removes the login and ends their open sessions. The two lists still work; a name in both uses the per-person password. A password with a comma is ignored.
A new login is a general user unless the name is also in `CONSOLE_ADMINS`. Setting or deleting a variable takes effect on the next deploy.

## 2026-11-20: On the dev board, a drafted reply is called a draft
In draft mode Jetta's reply to the customer is only a suggested reply on the ticket (a private note) until a colleague sends it. In a run a developer started she still wrote on the dev item, and in her own note, "I have replied to / asked the customer", and developers took that as sent.
Now she is told the reply is a draft and says so: "I have drafted a reply to the customer; it goes out once a colleague in support approves it." If her comment does not say it, one line saying the reply has not gone out yet is added to the comment. A private note alone is never described as a reply.
No switch; applies whenever `JETTA_REPLY_MODE` is draft and the dev bridge is on. With replies on auto nothing changes.

## 2026-11-19: A saved chat is verified again, and monday's token is fetched fresh
The chat widget used to take monday's session token once, when the page loaded, and a conversation was verified only when it was first opened. So a visitor who already had a saved chat was never verified, and "Start a new chat" reused a token that had expired, which silently left the new chat unverified.
Now an embedding app can give the widget a function, `JettaChatConfig.getMondaySessionToken`, which is called each time a session is opened or resumed. A resumed conversation is checked again with that token: it becomes verified (or its 24 hours are renewed, and it follows the board now in view) when the token is for the same account, user and app the conversation already carries; a different account changes nothing.
The widget no longer keeps the token: a plain `visitor.mondaySessionToken` still works but is removed from the page's config, used once and forgotten. No switch; live for any embed that passes a token. The GetSign board view does not pass one yet.


## 2026-11-18: Customer app state: a busy board is not read as the whole board
The GetSign backend lists at most the newest twelve workflows on a board. When there are more it now says so, and Jetta is told: a workflow missing from her list may still exist, and the session and failure figures cover only the listed ones. She will not tell a customer a workflow does not exist, or that a board is quiet, on the strength of a partial list.
Failures now arrive from the backend as a fixed description, never the stored error text, which could name a signer. Both changes come from the GetSign developers' review of the backend route. `JETTA_APP_STATE` is still off.

## 2026-11-17: Jetta can answer from the customer's own GetSign setup (in-app chat)
For a visitor chatting from inside the GetSign app, with a monday session token verified in the last 24 hours, Jetta can read that account's own setup from the GetSign backend: plan and what it includes, usage against limits, settings, the workflows on the board in view (which column the signer's email comes from, auto-send, reminders, link expiry, templates), session counts and failures on record. Read-only. No signer names or emails, documents or links.
She answers from it as something she knows and never says she looked, checked or can see their account. How the product works and the steps to fix something still come from a KB article. A visitor monday has not vouched for, on the website for example, gets no lookup: she asks, and may suggest opening the chat from inside GetSign.
The switch is `JETTA_APP_STATE` (off, shadow, on; row on /system), and it is off. It also needs `GETSIGN_API_BASE_URL` and `GETSIGN_SUPPORT_KEY`, and two changes on the GetSign side that are not live yet: the board view must pass monday's session token and the board, and the backend needs the support route. Until then nothing is read.

## 2026-11-17: Fix: the GitHub features were silently doing nothing in production
The GetSign reference read, the release watcher, the fix lookup and repeat problems all refused to run while `STUB_MODE` was on. Production runs with `STUB_MODE` on and each integration switched live by its own `*_LIVE` flag, and GitHub has none, so nothing was read from GitHub and the model steps were skipped, while every run reported success and /system showed the features as on. Found from the logs: the daily sync reported the reference as "shipped" with the token set and no fetch error.
Now the token alone (`JETTA_GETSIGN_REFERENCE_TOKEN`) decides whether GitHub is read, and the model key alone decides whether a model is asked, as everywhere else in Jetta. Nothing else about `STUB_MODE` changes.
Effect on merge: the reference is read live at the next daily sync, the release watcher starts reading releases and fills its memory of fixes on its next hourly run, and the fix lookup (on) and repeat problems (shadow) start working.

## 2026-11-17: Repeat problems: the same bug from several customers reaches the developers as one
When a GetSign ticket reports the same malfunction as earlier tickets from other customers, Jetta now groups them. She states each ticket's problem in one sentence, quoting any error message, and compares those, not the topic label, so reports of one failure end up together even when worded differently. One customer's second ticket about the same thing does not count twice.
At three different customers in 30 days, or two when one wrote in after a fix for it was already in production, she tells the developers once on one dev item (one a ticket already has, a clear match on the board, or one she files titled "[Repeat problem] …", at most two a day), listing every ticket. Each later ticket adds one line. Support gets a private note on each ticket naming the others and the item.
When she files a dev item for a ticket whose problem already has one, the report joins that item and no second item is made. The reply is written without any of this: she does not tell a customer that others are affected. The grouping can be wrong, and her comment asks the developers to check.
The switch is `JETTA_REPEAT_PROBLEMS` (off, shadow, on; row on /system), and it is off. Shadow groups tickets and logs `problems.shadow` events, and writes nothing to monday or Freshdesk.

## 2026-11-17: Has this already been fixed? Jetta checks GetSign tickets against recent fixes
The release watcher now remembers what it reads from GitHub: every fix, whether it is in production or merged and waiting for the next release. On its first run it also reads the last 60 days of releases into that memory, and nothing else.
When a GetSign ticket arrives, Jetta checks it against those fixes. A match goes to support in one private note on the ticket (what was fixed, in production or not yet released, the link), and onto the dev item if she files one, flagged as a possible cause when it shipped in the last 14 days.
The reply is written without any of this: the ticket agent is never shown a match, so Jetta does not tell a customer a fix shipped. That is support's call from the note. Matches can be wrong.
The switch is `JETTA_FIX_LOOKUP` (off, shadow, on; row on /system), and it is off. Shadow logs `fixlookup.shadow` events and writes nothing. It needs `JETTA_RELEASE_WATCH` not to be off, since that is what fills the memory.

## 2026-11-17: Jetta reads what the GetSign team ships to production
A new hourly cron, `release-watch`, reads GitHub for merges into production in the four GetSign app repositories (board view, backend, application, item view) and works out which changes a customer could notice.
When a shipped fix looks like the fix for an open dev item, Jetta asks the Developer on that item whether it is. She tells no customer herself: the developer confirms by setting Dev Status to Deployed to Prod, and the dev bridge sends the news as before. Published GetSign articles about the changed area get a "Release changed" notice in the KB review queue (the article is never edited), and one what-shipped note goes to Slack.
The switch is `JETTA_RELEASE_WATCH` (off, shadow, on; row on /system), and it is off. It reads GitHub with `JETTA_GETSIGN_REFERENCE_TOKEN`, which now needs Pull requests read on those four repositories; without the token the watcher does nothing. Start it on shadow: it logs `release.*_shadow` events and writes nothing.

## 2026-11-17: Self-review: the judge reads everything Jetta read, and "bad" means serious
I read 12 replies the self-review judge had marked bad against the runs behind them. About 5 were serious, 4 were minor, and 1 was wrong (2 more likely): the judge saw only the first 3,000 characters of each lookup while Jetta reads whole articles, so it called a step "unsupported" that was in the article she quoted. It now reads up to 16,000 characters per lookup.
Every problem the judge names is now serious or minor. One serious problem makes a reply bad; minor ones alone (a hedged suggestion, an obvious inference, wording) make it weak at worst. The Self-review page marks the minor ones.
New rule check, no model: a reply that says "I've flagged this to the team" or "I've added this to your ticket" when the run handed nothing to anyone is bad (missed escalation).
Live on merge (`JETTA_SELF_REVIEW`, unchanged). Replies judged before today keep their old grade, so expect the bad count to drop from 2026-11-17 for this reason alone; compare days only from then on.

## 2026-11-16: The GetSign app reference becomes knowledge base drafts, and stays current
The GetSign developers' configuration reference (every screen, tab and setting, and why a workflow will not save) is now six articles in the KB review queue, origin "GetSign app reference", scoped to GetSign. They are drafts: Jetta cannot use one until a person publishes it, and the reference follows the app's development branch, so check the screen is live first.
Every day the `kb-sync` cron reads the reference again. A changed section is redrafted by the model with file and code names left out (a redraft that names one is refused); an untouched draft is updated, an article a person edited or published is never overwritten and gets a "Reference changed" notice instead, a new section becomes a new draft, a dropped one removes an untouched draft or files a "Reference dropped" notice. A rejected draft stays rejected until its section changes.
The daily read needs `JETTA_GETSIGN_REFERENCE_TOKEN` (read-only GitHub token for the GetSign app repository; row on /system). It is not set yet, so until it is Jetta files the six articles from the copy shipped with the code and does not see later changes.
Jetta is also now told that an article with no link is internal: answer from it, give no link, invent none.

## 2026-11-16: Crons: five smaller ways to go quiet
The ticket mirror (`ticket-sync`) no longer stalls on one ticket it cannot store: it stops at that ticket, keeps what it did, and after three runs in a row at the same one goes round it (`ticket_sync.ticket_failed`, then `ticket_sync.ticket_passed_over`, in the event log). The daily missed-reply check stops starting runs when it is nearly out of time, spaces its Freshdesk reads, and keeps a job that failed for the next day instead of dropping it. The ticket follow-up reads the `jetta-hold` tag fresh at send time, so a tag added a minute earlier is honoured. Self-review and Logs alerts are no longer silenced when the Slack post itself failed (`selfreview.alert_failed`, `errorwatch.alert_failed`); they are tried again on the next run. A ticket's run history now expires 180 days after its last run. No switch; live on merge.

## 2026-11-16: The manual catches up with today's changes
The admin manual, the general handbook, the /system rows and the overview now describe what shipped today: who can archive and delete articles, what a chat visitor can and cannot get (billing, monday account, limits), how a first reply is retried or cancelled, the ticket follow-up as it really works (three touches, each announced an hour ahead), the dev-board thread replies and follow-up rules, and what happens when monday or billing writes are off. The general handbook's "what needs an admin" table was out of date on publishing and on trials and discounts, which have been open to the whole team since October and September. No behaviour change.

## 2026-11-16: A tool that declined no longer counts as done
When one of Jetta's tools runs and refuses (a ticket not opened because it is the same issue as the existing one, a hand-off not made because the team was already asked and nobody came, a dev item not filed because writes are off), the run now records that nothing happened. Before, a refusal looked the same as a success to everything reading the run afterwards. In chat that meant a visitor could be told "I've passed this to our team" when no ticket had been opened, and outcomes could show an escalation or a ticket that never existed. Live on merge, no switch.

## 2026-11-16: A dev item stays attached to its ticket however long its thread gets
The ticket a dev item was filed for is written in the item's first update, and every read of an item takes only its newest updates (5, 20 or 50). On a busy item that first update scrolled out, and the item stopped counting as its ticket's: a second item could be filed for the same ticket, `update_dev_item` disappeared from the run, the dev bridge found no ticket to act on, and the ticket follow-up could close a ticket whose item was still open. The link is now stored when Jetta files an item and learned from any item read while its filing update is still visible, and every lookup uses it. Items already past that point need a one-off run of `scripts/backfill-dev-item-links.ts` (dry run by default).

## 2026-11-16: Crons: four that could go quiet or double up
Chat follow-up (`JETTACHAT_FOLLOWUP`) read the 200 oldest idle chats, and resolved chats stay in the index for 90 days, so on a store with more than 200 of them it stopped nudging, auto-resolving and picking up unanswered hand-offs while still reporting "ok". It now reads the most recently idle, within the last 14 days. Ticket follow-up (`JETTA_TICKET_FOLLOWUP`): two overlapping runs can no longer send the same follow-up twice, and when the closing email goes out but Freshdesk refuses the status change, the next run closes the ticket (`ticket_followup.resolved_late`) instead of leaving it open. The ticket mirror marks a ticket up to date only after its messages are stored, so a failed read no longer leaves a stale thread that looks current. The Freshdesk rate-limit reading is now really shared between instances. Error watch no longer silences an issue for 30 days when the daily cap or a failure stopped it being filed.

## 2026-11-16: Dev bridge: comments get through, and the daily follow-up is fairer
After an item is finished and Jetta has asked its developer for a KB note (`JETTA_DEV_KB`), later comments on that item used to go to the KB drafter and nowhere else for up to 30 days; they now also start the usual ticket run, so a developer's question or explanation reaches the ticket. In shadow mode the KB request no longer counts as asked. The daily developer follow-up (`JETTA_DEV_FOLLOWUP`) no longer stops at the first item that fails, and its 15-a-day allowance is only spent on things it actually does. An engineer who answers on an item without being in its Developer column now counts as engineering at work; only the item's Reporter and the support roster (`DEV_BOARD_SUPPORT`) count as chasing. Jetta's question to a developer is chased only when she marks it as one, and passing on the customer's answer closes it. /activity and /dev-board no longer count her own comments as a person's work.

## 2026-11-16: Thread answers: who is told, and for how long a thread counts
Follow-up to #196. When Jetta posts a customer's answer into a developer's thread she now @mentions whoever asked there as well as the item's Developers, and says so plainly when nobody could be mentioned (no Developer on the item). The "file failed to upload" correction now stays in that thread instead of landing as a separate comment. A thread only counts as waiting for the customer's answer for 14 days after her reply in it, and context she adds through a second `create_dev_item` on the same ticket settles it like any other relay. Not yet confirmed against monday: whether a reply inside a thread can carry files at all; when it cannot, the correction says the files are on the ticket.

## 2026-11-16: A missing secret now refuses, everywhere
Every route a machine calls checks its secret the same way (`lib/request-auth.ts`), and a secret that is not set is a refusal on any deployment. Before, four crons (missed-reply backstop, KB sync, daily overview, dev follow-up), both Freshdesk webhooks, Slack and the retired Freshchat webhook let anyone in when their variable was unset. The console's open "dev" mode (no `CONSOLE_USERS` and no `ADMIN_SECRET`) now only works on a developer's machine; on a deployment that state is locked. Needs `CRON_SECRET`, `WEBHOOK_SECRET` and `SLACK_SIGNING_SECRET` set in every Vercel environment that should receive traffic. The Freshchat webhook answers 401 unless `FRESHCHAT_WEBHOOK_PUBLIC_KEY` is set.

## 2026-11-16: Chat: an account or email is only trusted when it is proven
On the chat widget, a monday account now counts as the visitor's only when the embed passes monday's signed session token (`visitor.mondaySessionToken`; the Install page snippets include it). An app view that sends no token is treated like a support link: Jetta confirms the account before a trial or discount request and does not look up the account's earlier tickets. FastSpring billing is no longer looked up or changed from chat, because a typed email proves nothing; Jetta opens a ticket and the team answers by email. On tickets the billing lookup is for the requester's own address only. New ceilings, live on merge, no switch: 40 new chats per network per hour, 3 chat tickets per email per day, 30 chat tickets and 20 "ask the team" pings per hour across the channel; hitting one logs `chat.ticket_capped` or `chat.handoff_capped`.

## 2026-11-16: A customer's answer goes in the developer's thread (#196)
When a developer asks for something inside a thread on a dev item and Jetta replies there, the customer's answer is now posted as a reply in that same thread instead of as a new update. "The customer is asking for an update" posts stay top-level. Live.

## 2026-11-16: Jetta reports what actually happened
Four places where "nothing happened" used to read as success. With billing writes off (`FASTSPRING_ALLOW_WRITES`), cancel and discount now say nothing was changed, to the customer-facing run and in Slack, instead of "Subscription cancelled". With monday writes off (`MONDAY_ALLOW_WRITES`) or monday not connected, filing a dev item, a question or a compliance request says nothing was filed and hands off through Slack, instead of returning a made-up item. A FastSpring lookup that failed (their system down or rate-limited) is reported as failed, no longer as "no account", so a legacy customer is not told they are billed through monday. And a tool call that threw no longer counts as done: a failed escalation is not recorded as an escalation, and a failed ticket creation no longer has the chat say a ticket was opened. Live on merge.

## 2026-11-16: Console: four things only an admin can now do
Deleting a published or archived article (from the article page, the bulk bar, or "reject" in the review queue, which now only ever deletes a draft), archiving in bulk, wiping all chat conversations, and running Jetta live on a ticket from the System page now need an admin account; each was open to every login. General users can still draft, publish, reject drafts and run a dry-run preview. The ops event log is admin-only too, since it holds sign-in attempts and IP addresses. A live run is logged as `console.live_run` with who started it. `scripts/console-roles-test.ts` lists who may call every console API route.

## 2026-11-16: First responses: fewer ways for an announced reply to vanish
A message with a pasted screenshot is no longer handed to Jetta as a prompt-injection attempt (her own image note was tripping the detector). At send time, a Freshdesk error (rate limit, 5xx) is retried each minute for an hour and then handed to a person with a note, instead of being treated as "ticket not found" and dropped. A customer's out-of-office auto-reply no longer cancels the queued reply. When the customer really did write again, the cancel now leaves a note saying nothing was sent. If two replies are queued for one ticket, the one answering the newer message wins. And a run killed at the function time limit no longer leaves that customer message marked as handled for 30 days: the marker now lapses after 15 minutes unless the run finishes. Live on merge.

## 2026-11-10: Logs watches Cloudflare
The Logs page has a Cloudflare section: server errors (5xx) on each site's production hosts (getsign.io, jetpackapps.io, jobflows.co), what the firewall blocked, each Worker's errors, and an hourly check that each site's busiest hosts answer. Click a number for the hosts, paths and firewall rules behind it; the AI read cites Cloudflare too. A site or Worker far above its usual day (or, while history builds, with errors a high share of its traffic) alerts the ops channel once a day; a host down two runs in a row alerts every 6 hours. Firewall blocks are page-only. Dev and staging hosts are shown, never flagged. Read-only token. `JETTA_CLOUDFLARE` (off leaves Cloudflare out). Live on merge once `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set in Vercel.

## 2026-11-04: Self-review checks what Jetta did on the dev board
The Self-review page has a new "What she did" section: dev items filed, questions to developers, posts to developers, escalations, closes, compliance and billing actions over 7 days, read from every run's tool calls. Rule checks, no model, name each time a guard was bypassed: a second dev item for one ticket (as on 14457), the same post to developers twice in a day, a ticket closed after it was escalated (as on 14453), a dev item filed with no repro steps, a board write that did not land, and any subscription cancellation. New findings go to the ops channel once. Also fixed: the 40-a-day judging cap now counts replies judged that day, not replies written that day. Same `JETTA_SELF_REVIEW` switches. Live on merge.
## 2026-11-04: Self-review: Jetta checks her own work every hour (#191)
New admin-only console page `/self-review`, fed by an hourly cron (`/api/cron/self-review`). Reliability, no model: every cron now leaves a heartbeat, so a job that stopped or keeps failing shows as late or failing; also failed runs, runs that ended with no reply and no hand-off, slow runs, and new or spiking error events, each against Jetta's own recent normal. Quality: an independent model (Kimi K3.1 Pro by default, `JETTA_SELF_REVIEW_MODEL`; never the glm-5.2 that writes replies) grades a few of her recent chat answers, email drafts and dev-bridge replies against what the customer asked and the evidence her run gathered, plus rule checks (internal links, ticket numbers, dead links, links that appear nowhere in the evidence); at most 40 a day (`JETTA_SELF_REVIEW_DAILY`). The page shows the 7-day score, a 14-day trend, every judged reply with the judge's reasons, and suggested fixes grouped as KB gap, behaviour, tool or policy. New reliability problems, any chat answer judged bad, and a daily scorecard (from 09:00) go to the ops channel. Read-only: nothing it finds changes what Jetta does. Switches: `JETTA_SELF_REVIEW` (off stops the cron), `JETTA_SELF_REVIEW_ALERTS` (off keeps the page, no Slack). Live on merge.

## 2026-11-04: Today shows replies Jetta drafted that nobody sent; Health ignores out-of-office
On /today, a ticket where Jetta's suggested reply has sat in a private note for 4 hours or more, and the customer is still the last to have written, now appears on the worklist with a "draft not sent" chip (#13894 sat 13 days like this). It leaves the list as soon as anyone replies or the ticket closes. Answered and closed tickets with old drafts never appear. On /health and /performance, a customer's out-of-office or bounce no longer counts as the customer writing, so a ticket whose last message is an away notice stops showing as "waiting on us" (#14675). The next performance sync re-reads every ticket once to apply this, mostly from Jetta's own ticket copy. No switch. Live on merge.

## 2026-11-04: Customer replies are judged on what they say
When a customer replies on an existing ticket, the filter that skips out-of-office, bounce and marketing mail now reads the reply itself. It used to re-read the ticket's first message every time, so a ticket whose opener was once tagged as noise had every later reply dropped: EBSCO's #14641 lost eight replies that way. It also lets a customer's out-of-office on a real ticket get skipped (it used to pass, because the opener was real). Mail that monday.com Support relays through its Zendesk desk counts as written by a person, and only its newest entry is read, so "any update on the refund?" (#14583) is no longer taken for an auto-reply. Same `JETTA_INTAKE_FILTER` switch. Live on merge.

## 2026-11-03: Cleaner AI reads (Logs, Health, Performance)
Numbers written with thousands separators ("17,277") no longer get a correct point thrown away as "invented": on the production model that was most of what the Logs read dropped. Citation markers like "[E2]" no longer show in the text. On Logs, points are one short sentence and "Worth watching" no longer lists apps having a normal day. Live on merge.

## 2026-11-03: Logs & errors page, with an hourly error watch
New admin-only console page `/logs`: errors per app from Sentry and the CloudWatch server logs, side by side with 14-day trends; what is new or spiking and hits customers (the monday accounts Sentry tagged, chat tickets from those accounts, any dev item that names the error); and an AI read that cites the numbers. An hourly cron (`/api/cron/error-watch`) does the work, so the page and the read are ready before anyone looks. Proactive: each newly flagged customer-hitting error is posted once to Slack (the ops channel, or `JETTA_ERROR_WATCH_CHANNEL`), and a dev item is drafted for one with no item: `JETTA_ERROR_WATCH_DEV_ITEMS=shadow` (the default) only lists what it would file; `on` files them, at most 2 a day. Days Sentry stored nothing (the quota gap) are skipped, so they never fake a spike. Switches: `JETTA_ERROR_WATCH` (off stops the cron), `JETTA_ERROR_WATCH_ALERTS` (off keeps the page, no Slack). Live on merge, dev items in shadow.
## 2026-11-03: Logs page links to the error itself
On Logs & errors, each grouped CloudWatch failure has an "Open in CloudWatch" link to its newest log line (the stream, narrowed to ten seconds around it), and every alert and dev-item row links straight to its Sentry issue, or to the log line for a logs spike. The Slack logs-spike alert links each line too. CloudWatch links need an AWS console login. Links appear from the next error-watch run.

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
