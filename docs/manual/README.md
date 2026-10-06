# The Jetta Manual

For the people who work tickets. Ten chapters, in the order you'll meet them.

Jetta is our AI support agent. Every incoming Freshdesk ticket runs through it: it reads the ticket, searches the knowledge base, checks the customer's account and the dev board, works out which of our apps the ticket is about, and writes a suggested reply.

The console lives at **https://jettajetpack.vercel.app**.

> **The one rule.** On Freshdesk, nothing reaches a customer until a human sends it. Live chat is the exception — there Jetta replies to visitors directly, with nobody reading first. Almost everything else in this manual follows from those two sentences.

---

## 1. What Jetta actually does

A ticket arrives. Jetta reads it, retrieves what it knows, and writes a reply — then posts that reply as a **private note on the ticket**. Customers never see private notes. You copy it, change what you want, and send it as yourself.

That means there is no queue to clear and no console step in the critical path. If you never opened the console again, tickets would still get answered, because the suggestion is sitting on the ticket where you already work.

**Not every ticket gets a suggestion.** Out-of-office replies, bounces, marketing and spam are filtered out before Jetta runs. A ticket with no private note on it is usually one Jetta was never meant to answer — not a failure.

**Live chat is different, and that difference matters.** In the website widget Jetta is the front line: it answers visitors live, unreviewed. Chapter 5 is about the review that happens afterwards instead.

---

## 2. Signing in

![The console sign-in card](images/login.webp)

Use your own username — every decision you make is recorded under your name. Sessions last seven days.

If you're an admin, you'll see a **View as general** control in the header. It's a real downgrade, not a preview: while it's on, you get exactly the surfaces a general user gets.

---

## 3. Your morning: the Today page

Start here. One screen for the overnight read: what came in, what's spiking, and what needs a person.

![The Today page end to end](images/today.webp)

Every number on this page counts **tickets Jetta handled** — not all Freshdesk traffic.

### Last 24 hours

![The Last 24 hours card, with the written briefing](images/today-last24.webp)

Four tiles — **Need you**, **Waiting in chat**, **Longest quiet**, **Came in (24h)** — then a breakdown of which app the volume landed on.

**Your briefing** sits inside this card: a short written read of the numbers on the page, regenerated when they change. It's commentary, not data — the tiles and lists below are the source of truth. **Rewrite** forces a fresh one.

### Emerging issues

![Emerging issues, showing steady themes when nothing is spiking](images/today-emerging.webp)

A topic has to clear two bars to appear here: at least **3 tickets in 24 hours** *and* **3× its daily average** over the previous 14 days. An ordinary busy day doesn't cry wolf.

Each issue shows which app it hit and whether the knowledge base already covers it. The distinction is the useful part:

- **in KB** — an answer exists and customers aren't finding it. That's a findability problem.
- **no KB article** — nothing is written. That's a writing job.

When nothing is spiking you get **Steady themes** instead: the normal background rate, so you can see what routine looks like.

### What needs you now

![What needs you now — the only list on the page that is your work](images/today-needs-you.webp)

The work on this page that is actually yours. Each row carries a state, how many exchanges have happened, and how long it's been quiet:

| State | What it means |
|---|---|
| **Needs your reply** | The last message on the ticket is the customer's. Someone owes them an answer. |
| **Active** | The customer replied recently and may still be there. |
| **Open** | Waiting on us. The ball is ours. |
| **Reopened** | Jetta's answer didn't land and the customer came back. |
| **Waiting on customer** | We've replied. A long silence here may just mean they dropped it. |

**Reopened is the highest-signal item on the page.** It means the first answer already failed once.

**Needs your reply** is read from the thread, not from the status someone set. So a row can say *needs your reply* and *waiting on customer* at once — that means the customer wrote back and nobody moved the status. Believe the thread.

### What's going wrong, and what would help

![What's going wrong](images/today-going-wrong.webp)

A written read of the patterns behind the queue — which topics have stalled escalations, which have nothing in the knowledge base, which themes have already failed an answer.

![What would help](images/today-would-help.webp)

The same analysis turned into specific jobs, usually "write this article, because it has *this* many tickets and nothing written."

### Worth documenting

![Worth documenting, grouped by theme rather than by ticket](images/today-documenting.webp)

The week's unresolved tickets grouped **by theme**, worst-covered first, so one article closes a whole group rather than a single ticket. Each group lists the tickets and chats behind it.

---

## 4. Replying to a ticket

This is the whole job, and it happens in Freshdesk — not here.

Open the ticket. Jetta's suggestion is in a private note. Copy it into the reply editor, change whatever you want, send as yourself. That's it.

<div class="placeholder">Screenshot needed: Jetta's suggestion as a private note on a Freshdesk ticket.</div>

**Writing the reply *is* the feedback.** Jetta reads back what you actually sent, compares it against what it suggested, and records the difference on its own — sent as-is, edited, or replaced entirely. You never have to tell it anything, and there is no button to press. This is the single most important thing to understand about the whole system: chapter 7 exists because of this paragraph.

<div class="placeholder">Screenshot needed: the reply editor with an edited version of Jetta's suggestion.</div>

Two behaviours worth knowing:

- If the customer writes again while a suggestion is waiting, the old one is marked **superseded** and Jetta writes a fresh one against the new message.
- If nobody ever replies, the suggestion quietly **expires** after two weeks instead of piling up. An expired suggestion is not a black mark against anyone.

### When the customer goes quiet

When you send a reply that **resolves** the ticket, and it was Jetta's suggestion (as-is or edited), Jetta schedules a follow-up. The follow-up sweep runs once a day at **09:00 UTC** and picks up anything at least 24 hours old. If the customer still hasn't answered, it posts one fixed note ("I haven't heard back, so I'll assume this is resolved…") and sets the ticket to **Resolved**.

It only closes a ticket that is actually waiting on the customer:

- **Only Open, Pending or Waiting on Customer.** Escalated to Dev, Working on it, HOLD, Validating, Customer responded: all mean the next move is ours, so the ticket is left alone.
- **Never while an escalation is open.** If Jetta escalated the ticket to the team, it is not closed automatically, whatever the status says.
- **No follow-up for a suggestion you replaced.** If you wrote your own reply instead ("passed to the devs, we'll update you"), Jetta's suggestion doesn't count as a resolution, and nothing is scheduled.
- **An escalation is never a resolution.** A turn where Jetta escalated or filed a dev item can't schedule a follow-up.

If the customer replies to a closed ticket, Jetta picks it up and writes a suggestion even if Freshdesk hasn't reopened the ticket yet. Held tickets show in the event log as `cron.followup_held`. Ask Jetta in the console "what's going to be auto-closed?" to see the queue.

These rules exist because of tickets 14453 and 14404, where escalated customers were told their issue was assumed resolved.

### The audit trail

![Suggestions — an audit trail, not a queue](images/drafts.webp)

Every suggestion Jetta has ever proposed is kept at `/drafts`. It shows a pending count, and that count will look alarming — it is not a backlog. **Nobody works this queue.** The private note on the ticket is the real surface; this is the paper trail for when you need to ask "what did it say, and when?"

That's also why `/drafts` isn't in the navigation.

---

## 5. Live chat: where Jetta answers alone

![The chat inbox](images/chats.webp)

In the website widget, Jetta replies to visitors live with nobody reading first. This page is the compensating control for that. Skim the transcripts, reading for three things: a wrong fact, a confident answer to something that should have been escalated, or a tone we wouldn't use.

The filters across the top are **Needs a person**, **With Jetta**, **Ticketed**, **All live** and **Resolved**. "All live" is everything still going; a finished conversation moves to Resolved and out of the working view.

### Reading and taking over a conversation

![A transcript, with the reply box and controls](images/chats-transcript.webp)

Pick a conversation and the transcript opens beside the list. Three controls matter:

- **Take the chat** — you join the conversation. From then on you're typing to the visitor yourself and Jetta stops answering. Sending a message takes the conversation and silences Jetta, so don't type a note to yourself in there.
- **Make a ticket** — opens a Freshdesk ticket carrying the whole transcript. The conversation becomes **Ticketed** and the two point at each other, so neither side is a dead end.
- **Resolve** — files the conversation under **Resolved** and out of the live list. The visitor is told nothing and nothing is deleted; the transcript stays here for the retention window. **Reopen** takes its place if you change your mind, and a new message from the visitor reopens it by itself.

A visitor who asks for a person moves to **Needs a person**, pins to the top, and pings Slack. The visitor always sees who is speaking, so a handover is never silent. If nobody takes the chat within a minute, Slack is pinged again (a louder second call) and the visitor sees "Still trying to find someone". If nobody takes it after that, Jetta **opens a Freshdesk ticket** with the transcript, tells the visitor the ticket number and that the team will email them, and posts the ticket link in Slack so nobody jumps into the chat late. Both the wait and the number of calls are in chat settings. A visitor who never gave an email can't get a ticket, so Jetta takes the chat back herself. She doesn't ask for a person a second time that day. A handoff left unanswered for over two hours is ended quietly, without a message, and shows under **With Jetta**.

Jetta opens tickets herself when she can't resolve something — the button is for when you decide before she does.

### Chats that finish themselves

Most chats end with the visitor simply not replying. Jetta closes those herself: about **15 minutes** after her answer she checks in once, and if nobody has come back **24 hours** later she marks the conversation **Resolved**. If the transcript already says it was sorted — "perfect, thanks" — she skips the check-in and resolves it there and then.

Four things she will never do, so you can trust the bucket:

- speak in a conversation a colleague has taken, or one where a visitor is waiting for a person;
- check in when the visitor spoke last — that means *she* owes the reply, and it stays under **With Jetta** for someone to look at;
- check in on a **Ticketed** chat, where a colleague is answering by email — those resolve quietly, and the ticket is untouched;
- check in twice.

Resolved by **jetta** in the transcript header means she made the call; your name means you did.


---

## 6. Asking Jetta in Slack

Jetta answers direct messages and questions in the agent panel. It is **read-only there by construction**: it can look things up and explain them, but it cannot change anything from a DM. That makes it a safe Freshdesk stand-in for people who don't have a Freshdesk login.

<div class="placeholder">Screenshot needed: a DM conversation with Jetta answering a lookup question.</div>

Escalations land in **#jetta-escalations**. When Jetta posts there, it's because it decided a person was needed — treat the channel as a worklist, not a feed.

<div class="placeholder">Screenshot needed: an escalation post in #jetta-escalations.</div>

### Talking to Jetta in the console

Admins can also talk to Jetta **by voice, inside the console**. Press **⌘J**, click the round button at the bottom right, or choose **Ask Jetta** in ⌘K. Ask out loud or type in the box. It knows this manual, the live configuration on System, and which page you are on. It can look up tickets, the knowledge base, customer accounts, the dev board, Today, Support health, Performance, Team activity, chat conversations and their transcripts, billing requests and their history, the ticket follow-up queue and the event log, and it can **take you there** while you keep talking. It goes to the specific thing, not just the page: a section ("what needs me today"), or the list of tickets behind a number on Support health or Performance ("show me the reopened GetSign tickets").
- When it mentions tickets, dev board items or articles, it puts **clickable links** in the panel, and ticket numbers in its answers are links too. It only shows links its lookups actually returned.
- The ticket lists behind numbers have their own links now (`/health?drill=…`), so you can paste one into Slack and it opens the same list.

- It is **read-only**, the same as in Slack. It cannot reply to a customer, change a ticket, approve anything or write to the dev board. Ask it where to do that and it will take you there.
- For "why" questions, and anything that combines several lookups, Jetta **thinks deeper on its own**. It hands the question to a slower reasoning model, answers, then switches back to the quick model. The panel shows "Thinking deeper…" while it works. There is no button for this.
- Talk over it to interrupt, and the mic button mutes you.
- **Minimising stops listening.** The microphone closes, and nothing you say is heard until you reopen the panel. Reopening picks the conversation back up. The red button ends the conversation and clears it.
- Every lookup it makes is logged as `assistant.tool` in the event log, with who asked.

---

## 7. Teaching Jetta: the Evals page

![The Evals page](images/evals.webp)

This is the loop that changes how Jetta writes, and the one page that genuinely needs a human. Nothing here applies until someone approves it.

### Draft quality

The top card scores the last 30 days: **Decisions**, **Sent as-is**, **Edited**, **Discarded** — plus the reasons your edits clustered around, tagged things like `product-knowledge-gap`, `conciseness` and `judgment-call`.

Read the tags before the numbers. A high discard rate with `product-knowledge-gap` on most of them is a knowledge base problem, not a writing problem.

### From your replies to a rule

![Candidate learnings and approved learnings](images/evals-learnings.webp)

Three steps, in order:

1. **Learn from human replies** — replays recently resolved tickets, compares what Jetta would have written against what you actually sent, and records every meaningful divergence. Your ordinary replies are the training data.
2. **Distill now** — turns accumulated divergences into short candidate rules. Patterns only; a one-off never becomes a rule.
3. **Approve or reject** — nothing changes until you approve. Approved rules are injected into every reply's system prompt from then on, strongest first, capped at 20 per product.

**Approve narrowly.** A rule is permanent instruction until someone **retires** it. Here's a real one, and note how tightly it's scoped:

> For any GetSign pricing or plan question, use ONLY the official 'GetSign Pricing' KB article. Never quote prices, plan names, or quotas from comparison or feature articles — those are stale and conflicting.

That rule exists because a customer was quoted a wrong price. It names one article, one topic, one product.

### Which goes where

The line that saves the most confusion:

| Kind of thing | Where it belongs |
|---|---|
| A **fact** — "the Pro plan is $29" | Knowledge Base |
| A **behaviour** — "ask which board before troubleshooting a sync" | Evals |

---

## 8. The Knowledge Base

![The article list, with retrieval testing](images/kb.webp)

What Jetta knows about the products. Articles move through four states — **draft → in review → published → archived** — and only one of them matters day to day:

**Only published articles are searchable by Jetta.** A perfect draft is invisible to her.

The list shows each article's state, hit count, version, and a **DUP?** flag where two articles look like duplicates. **Test retrieval** is the box to use when you want to know what Jetta would actually find for a given question — it's the fastest way to answer "why did she say that?" about a fact.

The knowledge base syncs daily from our websites, so most articles maintain themselves.

### The review queue

![The review queue](images/kb-review.webp)

Draft articles waiting to be published, from two sources: the Knowledge Loop (Slack escalations) and Freshdesk mining. Nothing here reaches Jetta yet.

Approving does two things at once — it publishes the article *and* embeds it for retrieval. That's the moment it starts affecting answers.

---

## 9. The other pages, briefly

### Billing

![Trials and discounts waiting on a person](images/billing.webp)

Trial extensions and discounts Jetta won't grant itself, filed for a human. Approve or reject here or in Slack. Pending requests expire after three days, so an ignored one never quietly grants itself. The **History** card below the queue lists past decisions: who approved or rejected what, and when.

### Support health

Team-level support health over the last 28 days: volume, first-reply times against target, who is waiting on a reply, reopens, and which apps and themes drive the load. Every number opens the list of tickets behind it, and those lists have their own links (`/health?drill=…`) you can paste into Slack. **Sync** pulls fresh Freshdesk data, and there is a written AI read of the numbers. Everyone can see this page.

### Performance (admin)

What customers got before and after Jetta went live: reply times, how much of the work was Jetta's, handoffs to people, knowledge gaps worth writing up, and per-agent numbers. Like Support health, every number opens its tickets, and there's a written AI read that cites them.

### Team activity (admin)

What each person did and where: Freshdesk replies, chats, Slack, monday dev items and console actions, as a scorecard and a timeline. It's kept current from Slack and monday as things happen, with an hourly catch-up sync.

### Test Jetta

The testing playbook: you play the customer, through a guided wizard, to learn how Jetta behaves. Test tickets and dev items are marked `[TEST]`, and the page offers to clean them up when you are done.

### Insights

![Insights](images/analytics.webp)

The ops view. **Daily overview** is yesterday's rollup with a written narrative and a **Regenerate** button.

![Daily overview](images/analytics-daily.webp)

Below it: decisions per day, edit and discard rate, token spend, and per-model quality. Volume is always broken down per app — never as one "Jetpack Apps" lump.

![Learning and gap analytics](images/analytics-learning.webp)

![The activity log](images/analytics-runs.webp)

**Activity log** is every run in detail, and the **Event log** below it is the raw stream — where you go when you need to know exactly what happened and when.

### System

![What Jetta can change, and what's connected](images/system.webp)

The truth page. Every capability is a separate opt-in, independent of whether the integration is connected — an integration can be fully live and still unable to write anything. It shows whether replies are in draft mode, which channels are live, which tickets Jetta touches, and which models answer.

If you ever want to know whether Jetta *can* do something, this page answers it rather than the docs.

---

## 10. Ground rules

**Read before you send. You are the last check.** Jetta writes confidently whether or not it's right. Check facts, prices, links and account details — especially anything about money.

**If a suggestion is wrong, just write your own reply.** Don't work around it or fix it half-way. That disagreement is exactly what the learning loop feeds on, and a replaced reply teaches more than an edited one.

**Never cancel a subscription** unless the customer has clearly asked for it. No exceptions, no inference from silence.

**If something looks broken** — wrong customer data, a reply about the wrong product, a queue that won't clear — ping Suraj rather than working around it.

---

## Appendix: the chat widget

Two admin pages, included so you know they exist.

![Chat settings](images/chats-settings.webp)

Appearance and limits for the widget. The **Access & limits** section is shared across brands and is security-relevant: the list of origins allowed to embed the chat is what stops anyone else putting our chat on their site. Every change is recorded in the event log with your name.

![Install](images/chats-install.webp)

How the widget gets onto a site, including a checker that tells you whether an origin will work *before* you theme it and find an empty corner of the page.

---

## About this manual

Every screenshot is generated from the live console by `scripts/manual-shots.mjs`, so the manual can be regenerated rather than slowly going out of date:

```
MANUAL_USER=… MANUAL_PASS=… node scripts/manual-shots.mjs
```

The harness refuses to photograph a page showing an error, and swaps real email addresses for a consistent fake cast before each shot. The four gaps marked above are Freshdesk and Slack screens, which it can't reach.
