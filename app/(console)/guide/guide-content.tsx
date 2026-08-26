/**
 * The in-app tutorial — one card per thing you do, built from the same
 * primitives the real screens use (StepCard, StatusChip, LiveBadge, Alert) so
 * what people read here looks like what they'll click there.
 *
 * Split by role, from one source. The general half is the support job: what
 * Jetta is, the morning read, replying, the chats she answers alone, asking
 * her things in Slack, and the ground rules. The admin half is everything that
 * changes every future reply, spends money, or decides who may embed the chat.
 *
 * One component rather than two files, deliberately: a general user's guide and
 * an admin's guide describing the same product will drift the moment they are
 * separately maintained, and the half that goes stale is always the one fewer
 * people read.
 *
 * This page is canonical; docs/support-console-guide.md is the older prose
 * version. Keep it honest about the two things people get wrong: Freshdesk
 * tickets always wait for a human, and live chat does not.
 */
import {
  AtSign,
  BarChart3,
  BookOpen,
  CreditCard,
  Flame,
  GraduationCap,
  Hand,
  Mail,
  MessageSquare,
  Monitor,
  ShieldCheck,
  Sunrise,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { LiveBadge } from "@/components/jetta/live-badge";
import { SectionHeader } from "@/components/jetta/page-header";

export default function GuideContent({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hand className="size-4 text-primary" /> What Jetta is
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Jetta is our AI support agent. Every incoming Freshdesk ticket flows through it: it reads
            the ticket, searches the knowledge base, checks the customer&apos;s account and the dev
            board, works out which app the ticket is about, and writes a suggested reply.
          </p>
          <p>
            <b>On Freshdesk, nothing reaches a customer until a human sends it.</b> Jetta&apos;s
            suggestion is posted as a <b>private note on the ticket</b> (customers never see notes).
            You copy it into the reply editor, edit freely, and send as yourself. There is no console
            step and no queue to clear.
          </p>
          <p>
            <b>Live chat is the exception</b> — there Jetta answers the visitor directly, with no
            human in front of it. That is why the Chats tab exists: review happens after the fact.
          </p>
          <p className="text-muted-foreground">
            Not everything that arrives gets a suggestion. Out-of-office replies, bounces, marketing
            and spam are filtered out before Jetta runs, so a ticket with no private note on it is
            usually one she was never meant to answer.
          </p>
          <p className="text-muted-foreground">
            Sessions last 7 days. If you get logged out, sign back in at /login with your personal
            username — anything you decide is recorded under your name.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sunrise className="size-4 text-primary" /> Today — start your day here
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <p>
            One screen for the morning read: what came in overnight, what is trending, and what needs
            a person. Every number counts <b>tickets Jetta handled</b>, not all Freshdesk traffic.
          </p>

          <StepCard title="Your briefing">
            <p className="text-sm">
              A short written read of the numbers on the page, regenerated whenever they change, with
              one <b>Start here</b> action. It is commentary — the tiles and lists are the source of
              truth. <b>Rewrite</b> forces a fresh one.
            </p>
          </StepCard>

          <StepCard
            title={
              <span className="inline-flex items-center gap-1.5">
                <Flame className="size-4" /> Emerging issues
              </span>
            }
          >
            <p className="text-sm">
              Topics running above their normal rate — at least <b>3 tickets in 24h</b> and{" "}
              <b>3× the daily average</b> of the previous 14 days, so an ordinary busy day
              doesn&apos;t cry wolf. Each one shows which app it hit and whether the KB already
              answers it: <StatusChip tone="published">in KB</StatusChip> means customers can&apos;t
              find an answer that exists, <StatusChip tone="draft">no KB article</StatusChip> means
              it needs writing. Brand-new themes show as{" "}
              <StatusChip tone="stale">new issue</StatusChip>.
            </p>
          </StepCard>

          <StepCard title="Waiting on a human">
            <p className="text-sm">
              The work on this page that is actually yours: escalations Jetta handed to the team, and
              tickets a customer <b>reopened</b> — Jetta&apos;s answer didn&apos;t land, which is the
              highest-signal thing here.
              {isAdmin && (
                <>
                  {" "}
                  Admins also see KB articles awaiting review, billing approvals, and candidate
                  learnings to approve.
                </>
              )}
            </p>
          </StepCard>

          {/* The section itself is admin-only on /today, so only admins should
              read about it here. */}
          {isAdmin && (
            <StepCard title="Worth documenting">
              <p className="text-sm">
                The week&apos;s unresolved tickets grouped <b>by theme</b>, worst-covered first, so one
                article closes a whole group rather than a single ticket.
              </p>
            </StepCard>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-primary" /> Replying — it all happens in Freshdesk
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <p>
            Jetta&apos;s suggested reply sits in a private note on the ticket. Copy it into the reply
            editor, change whatever you want, and send as yourself. <b>That is the whole workflow.</b>
          </p>
          <p>
            Writing the reply <i>is</i> the feedback. Jetta reads back what you actually sent,
            compares it with what it suggested, and records the difference on its own — sent as-is,
            edited, or replaced entirely. You never have to tell it.
          </p>
          <p className="text-muted-foreground">
            Two things worth knowing. If the customer writes again while a suggestion is waiting, the
            old one is marked <i>superseded</i> and Jetta writes a fresh one against the new message.
            And if nobody ever replies to a ticket, its suggestion quietly <i>expires</i> after two
            weeks rather than piling up — an expired suggestion is not a black mark against anyone.
          </p>
          <p className="text-muted-foreground">
            Every suggestion is kept at <code>/drafts</code> as an audit trail. It is not in the nav
            because it is not a queue anyone works.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="size-4 text-primary" /> Chats — where Jetta answers alone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <p>
            In the website and in-app chat widget, Jetta is the front line: she replies to the
            visitor live, with <b>nobody reading it first</b>. This tab is the compensating control
            for that. Skim the transcripts — you are reading for wrong facts, a confident answer to
            something she should have escalated, or a tone we wouldn&apos;t use.
          </p>

          <StepCard title="Who the visitor is">
            <p className="text-sm">
              There is <b>no form before the chat</b> — a visitor types immediately, so
              conversations start as <b>Anonymous</b> in this list. Collecting a name and email is
              Jetta&apos;s job, done in the conversation: she asks in her first reply, repeats the
              ask until she has both, and keeps the help brief for anyone who won&apos;t say who
              they are. The moment they answer, the name appears here.
            </p>
            <p className="mt-1.5 text-sm">
              <b>Why it&apos;s mandatory:</b> without an email there is no ticket, no follow-up and
              no account lookup. If you take over an anonymous chat, getting their email becomes
              your job — the header will remind you. Inside the monday apps she never needs to ask:
              the embed supplies who they are.
            </p>
          </StepCard>

          <StepCard title="Taking over a live chat">
            <p className="text-sm">
              A visitor who asks for a person moves to{" "}
              <StatusChip tone="stale">waiting</StatusChip> and pins to the top of the list, and
              Slack gets a ping. <b>Join</b> puts you in the conversation — from then on you are
              typing to the visitor yourself and Jetta stops answering. <b>Hand back</b> returns them
              to her. The visitor sees who is speaking, so a handover is never silent.
            </p>
          </StepCard>

          <StepCard title="Turning a chat into a ticket">
            <p className="text-sm">
              <b>Create ticket</b> opens a Freshdesk ticket carrying the whole transcript, with a
              subject and an optional note you write. The conversation becomes{" "}
              <StatusChip tone="in_review">ticketed</StatusChip> and the two point at each other, so
              neither side is a dead end. Jetta does this herself when she can&apos;t resolve
              something — the button is for when you decide before she does.
            </p>
            <p className="mt-1.5 text-sm">
              <b>The chat does not stop.</b> A visitor who keeps typing still gets answers, and
              anything new they say — a symptom, a screenshot, that it&apos;s now urgent — is pushed
              onto the ticket as a private note, because the ticket only carries the transcript as
              it stood when it was opened. She never gives out the ticket number.
            </p>
            <p className="mt-1.5 text-sm">
              <b>One ticket per issue, not per conversation.</b> Everything about the same problem
              is a note on the one ticket. If the visitor raises something genuinely separate — a
              billing question in the middle of a bug report — that gets its own ticket, and both
              are listed on the conversation. She also opens a fresh one if the original has since
              been resolved or closed and the visitor comes back, rather than noting a thread nobody
              is watching.
            </p>
          </StepCard>

          <StepCard title="When a chat becomes a new chat">
            <p className="text-sm">
              A visitor who comes back within <b>24 hours</b> picks up the same conversation; after
              that they get a fresh one, and there is a <b>+</b> in the widget header for starting
              one deliberately. Nothing is deleted either way — the old transcript stays here for
              the full retention window. The window is on <b>/chats/settings</b>, and it wants to
              stay comfortably longer than a real conversation: someone still discussing the ticket
              they just got would otherwise land in a clean chat and open a second one for the same
              problem.
            </p>
          </StepCard>

          <StepCard title="Attachments — and what Jetta can see">
            <p className="text-sm">
              Visitors can send screenshots, and <b>in chat Jetta reads them</b>: every uploaded
              image gets described before she answers, with any error message transcribed word for
              word, and that description stays with her for the rest of the conversation. PDFs are
              skipped — the useful ones are multi-page and a summary of page one misleads.
            </p>
            <p className="mt-1.5 text-sm">
              <b>This is chat only.</b> The same screenshot attached to a Freshdesk ticket is
              invisible to her — she is never told a file is there and answers without it, saying
              nothing to indicate she missed anything. If a ticket turns on what&apos;s in an image,
              assume her suggestion didn&apos;t account for it.
            </p>
          </StepCard>

          <p className="text-muted-foreground">
            Anything you find belongs in the Knowledge Base if it&apos;s a fact, or in Evals if
            it&apos;s a behaviour. {!isAdmin && "Flag either to an admin."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AtSign className="size-4 text-primary" /> Jetta in Slack — ask her things
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            You can message Jetta directly in Slack, or mention her in a channel, and she will answer
            like a teammate who looks things up fast. She can check tickets, search the knowledge
            base, pull up a customer&apos;s account, read the dev board — including what engineering
            commented on an item — and explain her own past decisions.
          </p>
          <p>
            <b>She is read-only there, by construction.</b> She cannot reply to a customer, close or
            change a ticket, touch the dev board, or move money. Ask her to and she&apos;ll say so
            rather than pretending. The privileged actions live as typed commands in the escalation
            channel, where everyone can see them happen.
          </p>
          <p className="text-muted-foreground">
            This is the way in if you don&apos;t have a Freshdesk login — asking her is faster than
            asking someone who does. She cites ticket numbers and article titles so you can check
            her, and she names the specific app rather than saying &quot;Jetpack Apps&quot;.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ground rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Read before you send. You are the last check.</AlertTitle>
            <AlertDescription>
              Jetta writes confidently whether or not she is right. Check facts, prices, links and
              account details before a suggestion goes out under your name — especially anything
              about money. If a suggestion is wrong, just write your own reply; that disagreement is
              exactly what the learning loop feeds on.
            </AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            Never cancel a subscription unless the customer has clearly asked for it. If something
            looks broken — wrong customer data, a reply about the wrong product, a queue that
            won&apos;t clear — ping Suraj rather than working around it.
          </p>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <SectionHeader className="pt-2" meta="Not shown to general users">
            Admin
          </SectionHeader>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GraduationCap className="size-4 text-primary" /> Evals — how Jetta learns
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <p>
                This is the loop that changes Jetta&apos;s behaviour, and the one tab that genuinely
                needs you.
              </p>

              <StepCard title="1 · Learn from human replies">
                <p className="text-sm">
                  Takes recently resolved tickets, replays what Jetta <i>would</i> have written, and
                  compares it against what was actually sent. Every meaningful divergence is
                  recorded. This is the main input now — ordinary replies are the training data, with
                  no extra work asked of anyone.
                </p>
              </StepCard>

              <StepCard title="2 · Distill now">
                <p className="text-sm">
                  Turns accumulated divergences into short candidate rules — things like{" "}
                  <i>&quot;Don&apos;t offer refunds proactively.&quot;</i> Patterns only: a one-off
                  never becomes a rule.
                </p>
              </StepCard>

              <StepCard title="3 · Approve or reject">
                <p className="text-sm">
                  <b>Nothing changes until you approve.</b> An approved rule is injected into every
                  reply Jetta writes from then on; a rejected one is remembered so it&apos;s never
                  proposed again. Approve narrowly — each rule is permanent instruction until someone{" "}
                  <b>retires</b> it.
                </p>
              </StepCard>

              <p className="text-muted-foreground">
                Rule of thumb: product <b>facts</b> belong in the Knowledge Base, <b>behaviour</b>{" "}
                belongs here. &quot;The Pro plan is $29&quot; is a KB article. &quot;Ask which board
                before troubleshooting a sync&quot; is a learning.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="size-4 text-primary" /> Knowledge Base — Jetta&apos;s memory for
                facts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                Articles move through <StatusChip tone="draft">draft</StatusChip> →{" "}
                <StatusChip tone="in_review">in_review</StatusChip> →{" "}
                <StatusChip tone="published">published</StatusChip> →{" "}
                <StatusChip tone="archived">archived</StatusChip>.{" "}
                <b>Only published articles are searchable by Jetta</b> — a fix isn&apos;t live until
                it&apos;s published.
              </p>
              <p>
                If Jetta keeps getting a product fact wrong, the fix is a KB article. The KB also
                syncs daily from our websites, so most content maintains itself; what you add by hand
                is the stuff that only lives in someone&apos;s head.
              </p>
              <p className="text-muted-foreground">
                When Today says a spiking topic is already{" "}
                <StatusChip tone="published">in KB</StatusChip>, the article exists but isn&apos;t
                reaching people — usually a wording problem, not a missing page.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="size-4 text-primary" /> Billing — approvals Jetta can&apos;t
                self-serve
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                When a customer asks for a trial extension or a discount, Jetta doesn&apos;t grant
                it. She files a request here (and in Slack) with the account, the amount and the
                ticket, and waits for a person. Requests that look like repeat trial-stretching are
                flagged for you.
              </p>
              <p className="text-muted-foreground">
                Pending requests expire after 3 days on their own, so an ignored request never
                quietly grants itself. Whether an approval actually reaches the billing system is a
                separate switch — check <b>System</b> if an approval seems to do nothing.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="size-4 text-primary" /> Insights — how we&apos;re doing
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                The ops view, and the counterpart to Today: yesterday&apos;s rollup with its own AI
                narrative, volume and cost over time, per-model quality, and knowledge-gap signals.
                Volume is broken down <b>per app</b> — GetSign, VLOOKUP Auto-Link, TrackMy and the
                rest — never as one lump, because &quot;Jetpack Apps&quot; spans nine products and
                tells you nothing about where to look.
              </p>
              <p className="text-muted-foreground">
                The <b>Event log</b> at the bottom records every system event — runs, skips,
                escalations, logins — and is the first place to look when something behaved oddly.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Monitor className="size-4 text-primary" /> System — what Jetta can currently do
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                Four questions, in order of how much they matter. <b>What Jetta can change</b> —
                whether replies reach customers unreviewed, and whether board, billing and trial
                writes are <LiveBadge live label="ARMED" /> or <LiveBadge live={false} label="DRY RUN" />
                . <b>Channels</b> — how customers reach her, and whether each one is actually
                credentialed rather than just switched on. <b>Which tickets Jetta touches</b> — the
                filters that decide whether she runs at all; a ticket excluded here gets no
                suggestion and no note, which looks exactly like her ignoring it.{" "}
                <b>Reasoning &amp; retrieval</b> — the models and how the knowledge base is searched.
              </p>
              <p>
                The <b>ticket tester</b> re-runs any ticket through Jetta. With <b>Dry run</b> on
                (default) nothing is written anywhere — you just see the reply she would send and
                every tool call she made. Use it to answer &quot;why did she say that?&quot;, or to
                check a KB fix actually worked before trusting it.
              </p>
              <p className="text-muted-foreground">
                Every row says what it means in practice and names the setting behind it. If
                something looks wrong here, it is a deploy, not a form.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" /> Roles, channels and the chat widget
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <StepCard title="Who sees what">
                <p className="text-sm">
                  General users get three tabs — Today, Chats, Guide — because that is the shape of
                  their day. It is a <b>navigation</b> decision, not a permission: the API routes are
                  the real boundary and are deliberately more permissive, so a direct link still
                  works for them. What they genuinely cannot do is approve a learning, publish an
                  article, or decide anything that spends money. <b>View as general</b> in the top
                  bar is a real downgrade, not a preview — the APIs honour it too.
                </p>
              </StepCard>

              <StepCard title="Where Jetta posts">
                <p className="text-sm">
                  One Slack channel per job: dev escalations, someone waiting in a live chat, and
                  approvals plus the daily KB report. They are separate because an engineer scanning
                  for bugs learns to skim a channel where most messages aren&apos;t bugs — and the
                  one that was gets skimmed with them. <b>System</b> shows whether Jetta is actually
                  in each channel and able to post; a channel she isn&apos;t in accepts nothing, and
                  the first symptom is a visitor waiting for a person who was announced to an empty
                  room.
                </p>
              </StepCard>

              <StepCard title="The chat widget">
                <p className="text-sm">
                  <b>Chat settings</b> controls the widget&apos;s behaviour without a deploy, and{" "}
                  <b>Install</b> has the snippet for a new site. Which origins may embed it is an
                  admin decision because it is a security boundary — anyone who can embed the widget
                  can start conversations that Jetta answers unsupervised.
                </p>
              </StepCard>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
