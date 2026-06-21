"use client";

import { useCallback, useEffect, useState } from "react";

interface Article { id?: string; title: string; url: string; body: string; keywords: string[]; source?: string; origin?: string }
interface Draft { id: string; title: string; body: string; keywords: string[]; createdBy: string; at: number }
interface Hit { title: string; url: string; source: string; score: number }

export default function KbManager({ adminKey }: { adminKey: string }) {
  const hdr = { "x-admin-secret": adminKey };
  const [curated, setCurated] = useState<Article[]>([]);
  const [managed, setManaged] = useState<Article[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [edit, setEdit] = useState<Article | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [kb, dr] = await Promise.all([
      fetch("/api/admin/kb", { cache: "no-store", headers: hdr }).then((r) => r.json()),
      fetch("/api/admin/kb/drafts", { cache: "no-store", headers: hdr }).then((r) => r.json()),
    ]);
    setCurated(kb.curated ?? []);
    setManaged(kb.managed ?? []);
    setDrafts(dr.drafts ?? []);
  }, [adminKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  async function save(a: Article) {
    setBusy(true);
    const method = a.id ? "PUT" : "POST";
    await fetch("/api/admin/kb", {
      method,
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, title: a.title, url: a.url, body: a.body, keywords: a.keywords }),
    });
    setEdit(null); setBusy(false); load();
  }
  async function del(id: string) {
    if (!confirm("Delete this article from the KB?")) return;
    await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: hdr });
    load();
  }
  async function decideDraft(id: string, action: "approve" | "reject") {
    await fetch("/api/admin/kb/drafts", {
      method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ id, action }),
    });
    load();
  }
  async function testSearch() {
    if (!q.trim()) return;
    const r = await fetch(`/api/admin/kb/search?q=${encodeURIComponent(q.trim())}`, { cache: "no-store", headers: hdr });
    setHits((await r.json()).hits ?? []);
  }

  const f = filter.toLowerCase();
  const fc = curated.filter((a) => !f || a.title.toLowerCase().includes(f) || a.body.toLowerCase().includes(f));
  const fm = managed.filter((a) => !f || a.title.toLowerCase().includes(f) || a.body.toLowerCase().includes(f));

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Knowledge base ({curated.length} curated · {managed.length} managed)</span>
        <button onClick={load} style={{ padding: "5px 12px", fontSize: 12 }}>↻</button>
      </h2>

      {/* Test retrieval */}
      <div className="steplabel">Test retrieval (what Jetta finds)</div>
      <div className="row">
        <input type="text" placeholder="e.g. my mappings disappear" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && testSearch()} />
        <button onClick={testSearch}>Search</button>
      </div>
      {hits && (hits.length ? hits.map((h, i) => (
        <div className="io" key={i}>{h.score.toFixed(3)} {h.title} <span className="muted">[{h.source}]</span></div>
      )) : <p className="muted">No hits.</p>)}

      {/* Approval queue */}
      {drafts.length > 0 && (
        <>
          <div className="steplabel" style={{ marginTop: 18 }}>Pending drafts to review ({drafts.length})</div>
          {drafts.map((d) => (
            <div className="step" key={d.id}>
              <div className="tool">📝 {d.title}</div>
              <div className="io out">{d.body.slice(0, 240)}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => decideDraft(d.id, "approve")}>Approve → KB</button>
                <button onClick={() => decideDraft(d.id, "reject")} style={{ background: "var(--panel2)", color: "var(--muted)" }}>Reject</button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Managed articles */}
      <div className="steplabel" style={{ marginTop: 18, display: "flex", justifyContent: "space-between" }}>
        <span>Managed articles — editable ({managed.length})</span>
        <button onClick={() => setEdit({ title: "", url: "", body: "", keywords: [] })} style={{ padding: "3px 10px", fontSize: 12 }}>+ Add</button>
      </div>
      <input type="text" placeholder="filter all articles…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />

      {edit && (
        <div className="step" style={{ borderColor: "var(--accent)" }}>
          <input type="text" placeholder="Title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} style={{ width: "100%", marginBottom: 6 }} />
          <textarea placeholder="Body" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })}
            style={{ width: "100%", minHeight: 120, background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 9, padding: 11, fontFamily: "var(--sans)", fontSize: 14 }} />
          <input type="text" placeholder="keywords, comma, separated" value={edit.keywords.join(", ")}
            onChange={(e) => setEdit({ ...edit, keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} style={{ width: "100%", margin: "6px 0" }} />
          <div className="row">
            <button onClick={() => save(edit)} disabled={busy || !edit.title || !edit.body}>{busy ? "Saving…" : "Save"}</button>
            <button onClick={() => setEdit(null)} style={{ background: "var(--panel2)", color: "var(--muted)" }}>Cancel</button>
          </div>
        </div>
      )}

      {fm.map((a) => (
        <div className="step" key={a.id}>
          <div className="tool" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{a.title}</span>
            <span>
              <button onClick={() => setEdit(a)} style={{ padding: "2px 9px", fontSize: 12, marginRight: 6 }}>Edit</button>
              <button onClick={() => a.id && del(a.id)} style={{ padding: "2px 9px", fontSize: 12, background: "var(--panel2)", color: "var(--danger)" }}>Delete</button>
            </span>
          </div>
          <div className="io out">{a.body.slice(0, 200)}</div>
          {a.origin ? <div className="io muted">origin: {a.origin}</div> : null}
        </div>
      ))}
      {fm.length === 0 && <p className="muted">No managed articles yet. Add one, or approve a Knowledge-Loop draft.</p>}

      {/* Curated (read-only) */}
      <div className="steplabel" style={{ marginTop: 18 }}>Curated GetSign articles — read-only / git ({fc.length})</div>
      {fc.slice(0, 50).map((a, i) => (
        <div className="io" key={i} style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
          {a.title} {a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="muted">↗</a> : null}
        </div>
      ))}
    </section>
  );
}
