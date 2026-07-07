"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { diffWords } from "diff";
import { Md } from "./markdown";
import type { Article } from "./kb-list";

interface Hit { id: string; title: string; url: string; body: string; source: string; score?: number }

/** Word-level diff: draft body vs the nearest existing article's body. */
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => diffWords(oldText, newText), [oldText, newText]);
  return (
    <div className="diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "add" : p.removed ? "del" : undefined}>
          {p.value}
        </span>
      ))}
    </div>
  );
}

function DraftCard({ draft, adminKey, onDecide }: { draft: Article; adminKey: string; onDecide: () => void }) {
  const hdr = useMemo(() => ({ "x-admin-secret": adminKey }), [adminKey]);
  const [open, setOpen] = useState(false);
  const [similar, setSimilar] = useState<Hit | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const aq = adminKey ? `key=${encodeURIComponent(adminKey)}` : "";

  // On expand, find the nearest existing article so the reviewer sees overlap.
  useEffect(() => {
    if (!open || similar) return;
    (async () => {
      const r = await fetch(`/api/admin/kb/search?q=${encodeURIComponent(draft.title)}&rerank=0`, { cache: "no-store", headers: hdr })
        .then((x) => x.json())
        .catch(() => null);
      const hit = (r?.hits ?? []).find((h: Hit) => h.id !== draft.id);
      setSimilar(hit ?? null);
    })();
  }, [open, similar, draft.id, draft.title, hdr]);

  async function decide(action: "approve" | "reject") {
    if (action === "reject" && !confirm("Reject and delete this draft?")) return;
    setBusy(true);
    await fetch("/api/admin/kb/drafts", {
      method: "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ id: draft.id, action }),
    });
    setBusy(false);
    onDecide();
  }

  const dup = draft.duplicates?.[0];

  return (
    <div className="step">
      <div className="tool" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <span>📝 {draft.title}</span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {draft.origin} · {draft.createdBy} {dup && <span className="state stale" style={{ marginLeft: 6 }}>dup? {dup.title.slice(0, 40)}</span>} {open ? "▾" : "▸"}
        </span>
      </div>

      {!open && <div className="io out">{draft.body.slice(0, 200)}…</div>}

      {open && (
        <>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "2px 12px", margin: "8px 0", background: "var(--panel)" }}>
            <Md>{draft.body}</Md>
          </div>
          {draft.keywords.length > 0 && <div className="io">keywords: {draft.keywords.join(", ")}</div>}

          {similar && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Closest existing article:{" "}
                <Link href={`/kb/article?${aq}&id=${encodeURIComponent(similar.id)}`}>{similar.title}</Link>
                {similar.score !== undefined && ` (${similar.score.toFixed(3)})`} ·{" "}
                <a onClick={(e) => { e.preventDefault(); setShowDiff(!showDiff); }} href="#" style={{ cursor: "pointer" }}>
                  {showDiff ? "hide diff" : "show diff"}
                </a>
              </div>
              {showDiff && <DiffView oldText={similar.body} newText={draft.body} />}
            </div>
          )}

          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={busy} onClick={() => decide("approve")}>Approve → publish</button>
            <Link href={`/kb/article?${aq}&id=${encodeURIComponent(draft.id)}`}>
              <button style={{ background: "var(--panel-2)", color: "var(--accent)" }}>Edit first</button>
            </Link>
            <button disabled={busy} onClick={() => decide("reject")} style={{ background: "var(--panel-2)", color: "var(--danger)" }}>
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function KbReview({ adminKey }: { adminKey: string }) {
  const hdr = useMemo(() => ({ "x-admin-secret": adminKey }), [adminKey]);
  const [drafts, setDrafts] = useState<Article[] | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/kb/drafts", { cache: "no-store", headers: hdr }).then((x) => x.json());
    setDrafts(r.drafts ?? []);
  }, [hdr]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  return (
    <section className="card">
      <h2>Review queue {drafts ? `(${drafts.length})` : ""}</h2>
      <p className="muted" style={{ marginBottom: 14 }}>
        Drafts from the Knowledge Loop (Slack escalations) and Freshdesk mining. Nothing reaches the
        agent until a human approves it — approving publishes the article and embeds it for retrieval.
      </p>
      {drafts?.map((d) => <DraftCard key={d.id} draft={d} adminKey={adminKey} onDecide={load} />)}
      {drafts?.length === 0 && <p className="muted">Queue is empty. 🎉</p>}
    </section>
  );
}
