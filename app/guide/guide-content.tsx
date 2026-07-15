/**
 * The in-app tutorial — one card per console tab, built from the same
 * primitives the real screens use (StepCard, StatusChip, LiveBadge, Alert) so
 * what reviewers read here looks like what they'll click there.
 * Content mirrors docs/support-console-guide.md; this page is canonical.
 */
import {
  BarChart3,
  BookOpen,
  Hand,
  LineChart,
  Mail,
  Monitor,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { LiveBadge } from "@/components/jetta/live-badge";

export default function GuideContent() {
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
            Jetta is our AI support agent. Every incoming Freshdesk ticket flows through it: Jetta
            reads the ticket, searches the knowledge base, checks the customer&apos;s account and the
            dev board, and writes a suggested reply.
          </p>
          <p>
            <b>Nothing reaches a customer until a human sends it.</b> The suggested reply is posted
            as a <b>private note on the Freshdesk ticket</b> (customers never see notes) and also
            lands in the <b>Drafts</b> tab here. Reply straight from Freshdesk or decide in the
            console — either way your decision is the safety net and how Jetta gets better.
          </p>
          <p className="text-muted-foreground">
            Sessions last 7 days. If you get logged out, sign back in at /login with your personal
            username — decisions are recorded under your name.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-primary" /> Drafts — your daily queue
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <p className="text-muted-foreground">
            <b>The everyday flow happens in Freshdesk:</b> Jetta&apos;s suggested reply is in a
            private note on the ticket. Copy it into the reply editor, edit freely, and send as
            yourself — Jetta notices your reply, compares it with its suggestion, and records your
            decision automatically (sent as-is = approved, edited = approved with edits, something
            completely different = draft unused). No console visit needed.
          </p>
          <p className="text-muted-foreground">
            This tab is the fallback and the audit trail: each pending card is one suggested reply.
            Expand it, open the ticket link (#12345) for context, then make one of three moves:
          </p>

          <StepCard title="1 · Approve & send">
            <p className="text-sm">
              The reply is good as-is — it goes to the customer immediately. Watch the chips on the
              card first: <StatusChip tone="stale">will resolve ticket</StatusChip> means the ticket
              is closed when you approve; <StatusChip tone="published">schedules 24h follow-up</StatusChip>{" "}
              means Jetta checks back on the customer tomorrow;{" "}
              <StatusChip tone="draft">escalated to dev team</StatusChip> means the issue was also
              posted to engineering.
            </p>
          </StepCard>

          <StepCard title="2 · Edit, then approve">
            <p className="text-sm">
              The reply is close but not right: fix the text in the box and hit &quot;Approve &amp;
              send (edited)&quot;. <b>Your edit is the most valuable training signal we have</b> —
              Jetta compares what it wrote against what you actually sent and learns the difference.
              Optionally click &quot;Add feedback&quot; to tag <i>why</i> you edited (tone, policy,
              missing knowledge…).
            </p>
          </StepCard>

          <StepCard title="3 · Discard">
            <p className="text-sm">
              The reply shouldn&apos;t go out at all. You&apos;ll be asked for at least one reason
              tag and can add a one-line note saying what should have happened instead —{" "}
              <b>don&apos;t skip the note when you have 10 seconds</b>, it becomes a candidate rule
              for Jetta. Discarding sends nothing; reply to the customer manually from Freshdesk
              afterwards.
            </p>
          </StepCard>

          <p className="text-muted-foreground">
            Good to know: if a customer replies again while a draft waits, the old draft is marked{" "}
            <i>superseded</i> automatically — only ever act on pending cards. Replying in
            Freshdesk with your own text? Hit &quot;Save feedback&quot; on the card first (tags +
            note, no send happens) — it attaches automatically to whatever closes the draft, so
            Jetta learns <i>why</i> its suggestion wasn&apos;t used, not just that it wasn&apos;t.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LineChart className="size-4 text-primary" /> Evals — how Jetta learns
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <p>
            Every decision you make in Drafts is recorded automatically: approve as-is = good,
            edited = partial, discard = bad, plus your tags and notes. From there:
          </p>
          <StepCard title="Feedback → rules → better replies">
            <p className="text-sm">
              &quot;Distill now&quot; turns accumulated feedback into short candidate rules like{" "}
              <i>&quot;Don&apos;t offer refunds proactively.&quot;</i> Candidates do nothing until a
              human approves them here — once approved, the rule is injected into every future reply
              Jetta writes. A rule that stops being helpful can be <b>retired</b> at any time.
            </p>
          </StepCard>
          <p className="text-muted-foreground">
            You don&apos;t need to manage this tab day-to-day. Just know your tags and notes end up
            here — which is why honest reasons matter more than fast clicks.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="size-4 text-primary" /> Console — status &amp; ticket tester
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            The home tab shows system status — which model is answering, whether integrations are{" "}
            <LiveBadge live /> or <LiveBadge live={false} />, and the reply mode (DRAFT = everything
            held for approval).
          </p>
          <p>
            The <b>ticket tester</b> re-runs any ticket through Jetta. With <b>Dry run</b> on
            (default) it&apos;s a safe preview — you see the reply and every tool call Jetta made,
            but nothing is written anywhere. Use it to understand an odd draft (&quot;why did it say
            that?&quot;) or to check behavior after a KB fix.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-primary" /> Knowledge Base — Jetta&apos;s memory for product facts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Articles move through a lifecycle: <StatusChip tone="draft">draft</StatusChip> →{" "}
            <StatusChip tone="in_review">in_review</StatusChip> →{" "}
            <StatusChip tone="published">published</StatusChip> →{" "}
            <StatusChip tone="archived">archived</StatusChip>. <b>Only published articles are
            searchable by Jetta</b> — a fix isn&apos;t live until it&apos;s published.
          </p>
          <p>
            If Jetta keeps getting a product fact wrong, the right fix is usually a KB article (edit
            or create → review → publish), not a discard note — facts belong in the KB, behavioral
            rules belong in Evals. The KB also syncs daily from our websites, so most content
            maintains itself.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" /> Insights — how we&apos;re doing
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>
            Outcome counts (handled, drafted, escalated), knowledge-gap signals, and the
            model-quality table live here. The numbers come from the same decisions you make in
            Drafts — approval and edit rates per model are how we judge whether the current model is
            holding up. The <b>Event log</b> at the bottom records every system event — runs, skips,
            decisions, logins — for audit and analysis.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ground rules</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Never approve on autopilot.</AlertTitle>
            <AlertDescription>
              You are the safety net — check facts, links, and account details before sending. If
              the ticket is closed or the customer was already answered, discard. If something looks
              broken (wrong customer data, weird model output, stuck queue), ping Suraj rather than
              working around it.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </>
  );
}
