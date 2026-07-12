"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtAgo, fmtExact, useNow } from "@/lib/format";

const EVAL_TAGS = [
  "product-knowledge-gap",
  "account-context",
  "authority",
  "judgment-call",
  "tone",
  "conciseness",
  "wrong-action",
  "policy",
  "other",
] as const;

function TagPicker({
  selected,
  onToggle,
  disabled,
}: {
  selected: string[];
  onToggle: (tag: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {EVAL_TAGS.map((t) => {
        const on = selected.includes(t);
        return (
          <button
            key={t}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(t)}
            className={`state ${on ? "published" : "draft"}`}
            style={{ cursor: "pointer", border: on ? "1px solid var(--accent)" : "1px solid transparent" }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

interface ReplyDraft {
  id: string;
  ticketId: string;
  subject?: string;
  channel: "freshdesk" | "freshchat";
  product: string;
  suggestedReply: string;
  wantsClose: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  createdAt: number;
  state: "pending" | "approved" | "discarded" | "superseded";
  decidedAt?: number;
  decidedBy?: string;
  editedBody?: string;
  error?: string;
}

function PendingCard({
  draft,
  freshdeskDomain,
  onDecide,
}: {
  draft: ReplyDraft;
  freshdeskDomain: string;
  onDecide: () => void;
}) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(draft.suggestedReply);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const edited = body.trim() !== draft.suggestedReply;

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function decide(action: "approve" | "discard") {
    if (action === "approve") {
      const prompt = `Send this reply to the customer on ticket #${draft.ticketId}?${edited ? " (edited)" : ""}${draft.wantsClose ? "\nThe ticket will also be marked resolved." : ""}`;
      if (!confirm(prompt)) return;
    }
    setBusy(true);
    const r = await fetch("/api/admin/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: draft.id,
        action,
        ...(action === "approve" && edited ? { body } : {}),
        ...(tags.length ? { tags } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    });
    setBusy(false);
    if (r.status === 409) {
      alert("This draft was already decided or superseded by a newer one — refreshing.");
    } else if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed: ${j?.error ?? r.statusText}`);
    }
    onDecide();
  }

  return (
    <div className="step">
      <div
        className="tool"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        onClick={() => setOpen(!open)}
      >
        <span>
          ✉️ {draft.subject ?? `Ticket #${draft.ticketId}`}
        </span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {draft.product} · {draft.channel} ·{" "}
          <span title={fmtExact(draft.createdAt)}>{fmtAgo(draft.createdAt, now)}</span> {open ? "▾" : "▸"}
        </span>
      </div>

      <div className="io" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <a href={`https://${freshdeskDomain}/a/tickets/${draft.ticketId}`} target="_blank" rel="noreferrer">
          #{draft.ticketId} ↗
        </a>
        {draft.wantsClose && <span className="state stale">will resolve ticket</span>}
        {draft.resolutionSent && <span className="state published">schedules 24h follow-up</span>}
        {draft.escalated && <span className="state draft">escalated to dev team</span>}
        {draft.error && <span className="state stale">last send failed: {draft.error.slice(0, 80)}</span>}
      </div>

      {!open && <div className="io out">{draft.suggestedReply.slice(0, 200)}…</div>}

      {open && (
        <>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(18, Math.max(6, body.split("\n").length + 2))}
            style={{ width: "100%", marginTop: 8, boxSizing: "border-box", fontFamily: "inherit", fontSize: 14 }}
          />
          {!discarding && (
            <>
              <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
                <button disabled={busy || !body.trim()} onClick={() => decide("approve")}>
                  {busy ? "Working…" : `Approve & send${edited ? " (edited)" : ""}`}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setDiscarding(true)}
                  style={{ background: "var(--panel-2)", color: "var(--danger)" }}
                >
                  Discard…
                </button>
                {edited && (
                  <a href="#" onClick={(e) => { e.preventDefault(); setBody(draft.suggestedReply); }}>
                    reset edits
                  </a>
                )}
                <a
                  href="#"
                  className="muted"
                  onClick={(e) => { e.preventDefault(); setFeedbackOpen(!feedbackOpen); }}
                >
                  {feedbackOpen ? "hide feedback" : "add feedback"}
                </a>
              </div>
              {feedbackOpen && (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  <TagPicker selected={tags} onToggle={toggleTag} disabled={busy} />
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note for the learning loop (why was this edited / what to do differently)"
                    style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13 }}
                  />
                </div>
              )}
            </>
          )}

          {discarding && (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <p className="muted" style={{ margin: 0 }}>
                Why is this draft being discarded? Pick at least one reason — it teaches Jetta.
              </p>
              <TagPicker selected={tags} onToggle={toggleTag} disabled={busy} />
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note (what should the reply have done instead?)"
                style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13 }}
              />
              <div className="row" style={{ alignItems: "center" }}>
                <button
                  disabled={busy || tags.length === 0}
                  onClick={() => decide("discard")}
                  style={{ background: "var(--panel-2)", color: "var(--danger)" }}
                >
                  {busy ? "Working…" : "Confirm discard"}
                </button>
                <a href="#" onClick={(e) => { e.preventDefault(); setDiscarding(false); }}>
                  cancel
                </a>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function DraftsQueue({
  replyMode,
  freshdeskDomain,
}: {
  replyMode: "auto" | "draft";
  freshdeskDomain: string;
}) {
  const now = useNow();
  const [drafts, setDrafts] = useState<ReplyDraft[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/drafts", { cache: "no-store" }).then((x) => x.json());
    setDrafts(r.drafts ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  const pending = drafts?.filter((d) => d.state === "pending") ?? [];
  const decided = drafts?.filter((d) => d.state !== "pending") ?? [];

  return (
    <>
      <section className="card">
        <h2>Reply drafts {drafts ? `(${pending.length} pending)` : ""}</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          Jetta proposes, you approve. Every webhook ticket gets a suggested reply here (and as a
          private note on the ticket) — nothing reaches the customer until it&apos;s approved.
          {replyMode === "auto" && (
            <b> ⚠ Reply mode is currently AUTO — new webhook runs reply directly and won&apos;t land here.</b>
          )}
        </p>
        {drafts === null && <p className="muted">Loading…</p>}
        {pending.map((d) => (
          <PendingCard key={d.id} draft={d} freshdeskDomain={freshdeskDomain} onDecide={load} />
        ))}
        {drafts !== null && pending.length === 0 && <p className="muted">Queue is empty. 🎉</p>}
      </section>

      {decided.length > 0 && (
        <section className="card">
          <h2 style={{ cursor: "pointer" }} onClick={() => setShowDecided(!showDecided)}>
            Recently decided ({decided.length}) {showDecided ? "▾" : "▸"}
          </h2>
          {showDecided &&
            decided.slice(0, 30).map((d) => (
              <div className="step" key={d.id}>
                <div className="tool" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>
                    {d.state === "approved" ? "✅" : d.state === "discarded" ? "🗑" : "↩️"}{" "}
                    {d.subject ?? `Ticket #${d.ticketId}`}
                  </span>
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    {d.state}
                    {d.decidedBy ? ` by ${d.decidedBy}` : ""}
                    {d.editedBody ? " · edited" : ""} ·{" "}
                    <span title={fmtExact(d.decidedAt ?? d.createdAt)}>{fmtAgo(d.decidedAt ?? d.createdAt, now)}</span>
                  </span>
                </div>
                <div className="io out">{(d.editedBody ?? d.suggestedReply).slice(0, 160)}…</div>
              </div>
            ))}
        </section>
      )}
    </>
  );
}
