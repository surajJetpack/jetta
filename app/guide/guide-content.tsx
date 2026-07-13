/**
 * The in-app tutorial — one card per console tab, hand-built with the same
 * CSS primitives the real screens use (.step, .state/.badge chips, .warn) so
 * what reviewers read here looks like what they'll click there.
 * Content mirrors docs/support-console-guide.md; this page is canonical.
 */

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`state ${cls}`}>{children}</span>;
}

export default function GuideContent() {
  return (
    <>
      <section className="card">
        <h2>👋 What Jetta is</h2>
        <p>
          Jetta is our AI support agent. Every incoming Freshdesk ticket flows through it: Jetta
          reads the ticket, searches the knowledge base, checks the customer&apos;s account and the
          dev board, and writes a suggested reply.
        </p>
        <p style={{ marginTop: 8 }}>
          <b>Nothing reaches a customer until someone here approves it.</b> The suggested reply
          lands in the <b>Drafts</b> tab as a pending card; your decision — approve, edit, or
          discard — is both the safety net and how Jetta gets better over time.
        </p>
        <p className="muted" style={{ marginTop: 8 }}>
          Sessions last 7 days. If you get logged out, sign back in at /login with your personal
          username — decisions are recorded under your name.
        </p>
      </section>

      <section className="card">
        <h2>✉️ Drafts — your daily queue</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          This is where you&apos;ll spend most of your time. Each pending card is one suggested
          reply. Click the card header to expand it, open the ticket link (#12345 ↗) for context,
          then make one of three moves:
        </p>

        <div className="step">
          <div className="tool">1 · Approve &amp; send</div>
          <div className="io">
            The reply is good as-is — it goes to the customer immediately. Watch the chips on the
            card first: <Chip cls="stale">will resolve ticket</Chip> means the ticket is closed
            when you approve; <Chip cls="published">schedules 24h follow-up</Chip> means Jetta
            checks back on the customer tomorrow; <Chip cls="draft">escalated to dev team</Chip>{" "}
            means the issue was also posted to engineering.
          </div>
        </div>

        <div className="step">
          <div className="tool">2 · Edit, then approve</div>
          <div className="io">
            The reply is close but not right: fix the text in the box and hit &quot;Approve &amp;
            send (edited)&quot;. <b>Your edit is the most valuable training signal we have</b> —
            Jetta compares what it wrote against what you actually sent and learns the difference.
            Optionally click &quot;add feedback&quot; to tag <i>why</i> you edited (tone, policy,
            missing knowledge…).
          </div>
        </div>

        <div className="step">
          <div className="tool">3 · Discard</div>
          <div className="io">
            The reply shouldn&apos;t go out at all. You&apos;ll be asked for at least one reason
            tag and can add a one-line note saying what should have happened instead —{" "}
            <b>don&apos;t skip the note when you have 10 seconds</b>, it becomes a candidate rule
            for Jetta. Discarding sends nothing; reply to the customer manually from Freshdesk
            afterwards.
          </div>
        </div>

        <p className="muted" style={{ marginTop: 10 }}>
          Good to know: if a customer replies again while a draft waits, the old draft is marked{" "}
          <i>superseded</i> automatically — only ever act on pending cards. And the private notes
          you see on tickets in Freshdesk are Jetta&apos;s internal work log; drafts only exist
          here, never on the ticket.
        </p>
      </section>

      <section className="card">
        <h2>📈 Evals — how Jetta learns</h2>
        <p>
          Every decision you make in Drafts is recorded automatically: approve as-is = good,
          edited = partial, discard = bad, plus your tags and notes. From there:
        </p>
        <div className="step">
          <div className="tool">Feedback → rules → better replies</div>
          <div className="io">
            &quot;Distill now&quot; turns accumulated feedback into short candidate rules like{" "}
            <i>&quot;Don&apos;t offer refunds proactively.&quot;</i> Candidates do nothing until a
            human approves them here — once approved, the rule is injected into every future reply
            Jetta writes. A rule that stops being helpful can be <b>retired</b> at any time.
          </div>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          You don&apos;t need to manage this tab day-to-day. Just know your tags and notes end up
          here — which is why honest reasons matter more than fast clicks.
        </p>
      </section>

      <section className="card">
        <h2>🖥 Console — status &amp; ticket tester</h2>
        <p>
          The home tab shows system status — which model is answering, whether integrations are{" "}
          <span className="badge live">LIVE</span> or <span className="badge stub">STUB</span>,
          and the reply mode (DRAFT = everything held for approval).
        </p>
        <p style={{ marginTop: 8 }}>
          The <b>ticket tester</b> re-runs any ticket through Jetta. With <b>Dry run</b> on
          (default) it&apos;s a safe preview — you see the reply and every tool call Jetta made,
          but nothing is written anywhere. Use it to understand an odd draft (&quot;why did it say
          that?&quot;) or to check behavior after a KB fix.
        </p>
      </section>

      <section className="card">
        <h2>📚 Knowledge Base — Jetta&apos;s memory for product facts</h2>
        <p>
          Articles move through a lifecycle: <Chip cls="draft">draft</Chip> →{" "}
          <Chip cls="in_review">in_review</Chip> → <Chip cls="published">published</Chip> →{" "}
          <Chip cls="archived">archived</Chip>. <b>Only published articles are searchable by
          Jetta</b> — a fix isn&apos;t live until it&apos;s published.
        </p>
        <p style={{ marginTop: 8 }}>
          If Jetta keeps getting a product fact wrong, the right fix is usually a KB article (edit
          or create → review → publish), not a discard note — facts belong in the KB, behavioral
          rules belong in Evals. The KB also syncs daily from our websites, so most content
          maintains itself.
        </p>
      </section>

      <section className="card">
        <h2>📊 Insights — how we&apos;re doing</h2>
        <p>
          Outcome counts (handled, drafted, escalated), knowledge-gap signals, and the
          model-quality table live here. The numbers come from the same decisions you make in
          Drafts — approval and edit rates per model are how we judge whether the current model is
          holding up. The <b>Event log</b> at the bottom records every system event — runs, skips,
          decisions, logins — for audit and analysis.
        </p>
      </section>

      <section className="card">
        <h2>Ground rules</h2>
        <div className="warn">
          <b>Never approve on autopilot.</b> You are the safety net — check facts, links, and
          account details before sending. If the ticket is closed or the customer was already
          answered, discard. If something looks broken (wrong customer data, weird model output,
          stuck queue), ping Suraj rather than working around it.
        </div>
      </section>
    </>
  );
}
