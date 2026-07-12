"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtAgo, fmtExact, useNow } from "@/lib/format";

interface ReplyEvaluation {
  id: string;
  ticketId: string;
  subject?: string;
  channel: "freshdesk" | "freshchat";
  product: string;
  model?: string;
  decidedBy: string;
  at: number;
  action: "approve" | "discard";
  rating: "good" | "partial" | "bad";
  tags: string[];
  note?: string;
  suggestedReply: string;
  finalBody?: string;
  distilled?: boolean;
  learningIds?: string[];
}

interface EvalStats {
  windowDays: number;
  total: number;
  byRating: { good: number; partial: number; bad: number };
  editRate: number;
  discardRate: number;
  tagCounts: Record<string, number>;
  byProduct: Record<string, { good: number; partial: number; bad: number }>;
}

interface Learning {
  id: string;
  text: string;
  category: string;
  product: "getsign" | "jetpackapps" | "all";
  state: "candidate" | "approved" | "rejected" | "retired";
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  sourceEvalIds: string[];
  reinforcedCount: number;
  supersedes?: string;
  rationale?: string;
}

const RATING_ICON = { good: "👍", partial: "✏️", bad: "👎" } as const;

function CandidateCard({ learning, onDecide }: { learning: Learning; onDecide: () => void }) {
  const [text, setText] = useState(learning.text);
  const [busy, setBusy] = useState(false);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    const r = await fetch("/api/admin/learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: learning.id, action, ...(action === "approve" ? { text } : {}) }),
    });
    setBusy(false);
    if (r.status === 409) alert("This learning was already decided — refreshing.");
    else if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed: ${j?.error ?? r.statusText}`);
    }
    onDecide();
  }

  return (
    <div className="step">
      <div className="io" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="state draft">{learning.category}</span>
        <span className="state in_review">{learning.product}</span>
        {learning.supersedes && <span className="state stale">revises an approved learning</span>}
        <span className="muted" style={{ fontSize: 12 }}>
          from {learning.sourceEvalIds.length} evaluation{learning.sourceEvalIds.length === 1 ? "" : "s"}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={300}
        style={{ width: "100%", marginTop: 8, boxSizing: "border-box", fontFamily: "inherit", fontSize: 14 }}
      />
      {learning.rationale && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>Why: {learning.rationale}</p>
      )}
      <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
        <button disabled={busy || !text.trim()} onClick={() => decide("approve")}>
          {busy ? "Working…" : `Approve${text.trim() !== learning.text ? " (edited)" : ""}`}
        </button>
        <button
          disabled={busy}
          onClick={() => decide("reject")}
          style={{ background: "var(--panel-2)", color: "var(--danger)" }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export default function EvalsPanel({ freshdeskDomain }: { freshdeskDomain: string }) {
  const now = useNow();
  const [evals, setEvals] = useState<ReplyEvaluation[] | null>(null);
  const [stats, setStats] = useState<EvalStats | null>(null);
  const [learnings, setLearnings] = useState<Learning[] | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [distillMsg, setDistillMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const [e, l] = await Promise.all([
      fetch("/api/admin/evals", { cache: "no-store" }).then((x) => x.json()),
      fetch("/api/admin/learnings", { cache: "no-store" }).then((x) => x.json()),
    ]);
    setEvals(e.evaluations ?? []);
    setStats(e.stats ?? null);
    setLearnings(l.learnings ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  async function retire(id: string) {
    if (!confirm("Retire this learning? It stops being injected into new replies.")) return;
    const r = await fetch("/api/admin/learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "retire" }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed: ${j?.error ?? r.statusText}`);
    }
    load();
  }

  async function distillNow() {
    setDistilling(true);
    setDistillMsg(null);
    const r = await fetch("/api/admin/evals/distill", { method: "POST" });
    const j = (await r.json().catch(() => null)) as
      | { created?: number; reinforced?: number; revised?: number; consumed?: number; error?: string }
      | null;
    setDistilling(false);
    if (!r.ok) setDistillMsg(`Distill failed: ${j?.error ?? r.statusText}`);
    else
      setDistillMsg(
        `Distilled ${j?.consumed ?? 0} evaluations → ${j?.created ?? 0} new, ${j?.reinforced ?? 0} reinforced, ${j?.revised ?? 0} revisions.`,
      );
    load();
  }

  const candidates = learnings?.filter((l) => l.state === "candidate") ?? [];
  const approved = learnings?.filter((l) => l.state === "approved") ?? [];
  const undistilled = evals?.filter((e) => !e.distilled).length ?? 0;

  return (
    <>
      <section className="card">
        <h2>Draft quality {stats ? `(last ${stats.windowDays} days)` : ""}</h2>
        {stats === null && <p className="muted">Loading…</p>}
        {stats && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "baseline" }}>
            <span><b>{stats.total}</b> <span className="muted">decisions</span></span>
            <span>👍 <b>{stats.byRating.good}</b> <span className="muted">sent as-is</span></span>
            <span>✏️ <b>{stats.byRating.partial}</b> <span className="muted">edited ({Math.round(stats.editRate * 100)}%)</span></span>
            <span>👎 <b>{stats.byRating.bad}</b> <span className="muted">discarded ({Math.round(stats.discardRate * 100)}%)</span></span>
          </div>
        )}
        {stats && Object.keys(stats.tagCounts).length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {Object.entries(stats.tagCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([tag, n]) => (
                <span key={tag} className="state draft">{tag} ×{n}</span>
              ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Candidate learnings {learnings ? `(${candidates.length})` : ""}</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          Distilled from your feedback — nothing changes Jetta&apos;s behavior until you approve it here.
        </p>
        <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
          <button disabled={distilling || undistilled === 0} onClick={distillNow}>
            {distilling ? "Distilling…" : `Distill now (${undistilled} pending)`}
          </button>
          {distillMsg && <span className="muted" style={{ fontSize: 13 }}>{distillMsg}</span>}
        </div>
        {candidates.map((l) => (
          <CandidateCard key={l.id} learning={l} onDecide={load} />
        ))}
        {learnings !== null && candidates.length === 0 && (
          <p className="muted">No candidates waiting for review.</p>
        )}
      </section>

      <section className="card">
        <h2>Approved learnings {learnings ? `(${approved.length})` : ""}</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          Injected into every reply&apos;s system prompt (strongest first, capped at 20 per product).
        </p>
        {approved
          .sort((a, b) => b.reinforcedCount - a.reinforcedCount || b.updatedAt - a.updatedAt)
          .map((l) => (
            <div className="step" key={l.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 14 }}>{l.text}</span>
                <button
                  onClick={() => retire(l.id)}
                  style={{ background: "var(--panel-2)", color: "var(--danger)", flexShrink: 0 }}
                >
                  Retire
                </button>
              </div>
              <div className="io" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className="state published">{l.product}</span>
                <span className="state draft">{l.category}</span>
                {l.reinforcedCount > 0 && <span className="state in_review">reinforced ×{l.reinforcedCount}</span>}
                <span className="muted" style={{ fontSize: 12 }} title={fmtExact(l.updatedAt)}>
                  updated {fmtAgo(l.updatedAt, now)}
                </span>
              </div>
            </div>
          ))}
        {learnings !== null && approved.length === 0 && <p className="muted">No approved learnings yet.</p>}
      </section>

      {evals !== null && evals.length > 0 && (
        <section className="card">
          <h2 style={{ cursor: "pointer" }} onClick={() => setShowHistory(!showHistory)}>
            Evaluation history ({evals.length}) {showHistory ? "▾" : "▸"}
          </h2>
          {showHistory &&
            evals.slice(0, 50).map((e) => (
              <div className="step" key={e.id}>
                <div className="tool" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>
                    {RATING_ICON[e.rating]} {e.subject ?? `Ticket #${e.ticketId}`}
                  </span>
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    {e.product} · {e.decidedBy} ·{" "}
                    <span title={fmtExact(e.at)}>{fmtAgo(e.at, now)}</span>
                  </span>
                </div>
                <div className="io" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <a href={`https://${freshdeskDomain}/a/tickets/${e.ticketId}`} target="_blank" rel="noreferrer">
                    #{e.ticketId} ↗
                  </a>
                  {e.tags.map((t) => (
                    <span key={t} className="state draft">{t}</span>
                  ))}
                  {e.rating === "partial" && <span className="state in_review">edited before send</span>}
                  {e.distilled && <span className="state published">distilled</span>}
                </div>
                {e.note && <div className="io out">{e.note}</div>}
              </div>
            ))}
        </section>
      )}
    </>
  );
}
