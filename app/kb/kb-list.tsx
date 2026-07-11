"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDuration } from "@/lib/format";
import Link from "next/link";

export interface Article {
  id: string;
  title: string;
  url: string;
  body: string;
  keywords: string[];
  category: string;
  tags: string[];
  state: "draft" | "in_review" | "published" | "archived";
  version: number;
  origin: string;
  source: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  reviewBy?: number;
  duplicates?: { id: string; title: string; score: number }[];
  freshdesk?: { articleId: string; folderId: string; syncedAt: number; syncedVersion: number };
}
export interface Category { slug: string; name: string; fdFolderId?: string }
export interface Usage { total: number; month: number; lastHit: number }
interface Hit { id: string; title: string; url: string; source: string; score?: number }

// Filter/sort state survives tab navigation (module cache) and reloads
// (sessionStorage) — same pattern as ticket-tester.tsx.
type ListState = { q: string; state: string; category: string; origin: string; sort: string; stale: boolean };
const DEFAULTS: ListState = { q: "", state: "", category: "", origin: "", sort: "updated", stale: false };
const STORAGE_KEY = "jetta:kbList";
let cache: ListState | null = null;

function readStorage(): ListState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ListState) : null;
  } catch {
    return null;
  }
}

const fmtDate = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "—");

export default function KbList() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  const [byState, setByState] = useState<Record<string, number>>({});
  const [f, setF] = useState<ListState>(() => cache ?? DEFAULTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // Retrieval tester
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searchMeta, setSearchMeta] = useState("");

  useEffect(() => {
    if (cache) return;
    const saved = readStorage();
    if (!saved) return;
    cache = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time rehydration from storage on mount
    setF(saved);
  }, []);
  useEffect(() => {
    cache = f;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(f));
    } catch {
      /* module cache still covers tab nav */
    }
  }, [f]);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/kb", { cache: "no-store" }).then((x) => x.json());
    setArticles(r.articles ?? []);
    setCategories(r.categories ?? []);
    setUsage(r.usage ?? {});
    setStaleIds(new Set(r.stale ?? []));
    setByState(r.byState ?? {});
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = f.q.toLowerCase();
    let out = articles.filter(
      (a) =>
        (!f.state || a.state === f.state) &&
        (!f.category || a.category === f.category) &&
        (!f.origin || a.origin === f.origin) &&
        (!f.stale || staleIds.has(a.id)) &&
        (!needle ||
          a.title.toLowerCase().includes(needle) ||
          a.body.toLowerCase().includes(needle) ||
          a.keywords.some((k) => k.toLowerCase().includes(needle))),
    );
    out = [...out].sort((x, y) => {
      switch (f.sort) {
        case "title":
          return x.title.localeCompare(y.title);
        case "usage":
          return (usage[y.id]?.total ?? 0) - (usage[x.id]?.total ?? 0);
        case "stale":
          return (x.reviewBy ?? Infinity) - (y.reviewBy ?? Infinity);
        default:
          return y.updatedAt - x.updatedAt;
      }
    });
    return out;
  }, [articles, f, staleIds, usage]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function bulk(action: "publish" | "archive" | "delete" | "reingest") {
    if (!selected.size) return;
    if (action === "delete" && !confirm(`Delete ${selected.size} article(s)? This also removes them from the vector index.`)) return;
    setBusy(true);
    const r = await fetch("/api/admin/kb/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected], action }),
    }).then((x) => x.json());
    setBusy(false);
    setNotice(r.error ?? `${action}: ${r.ok ?? 0} ok${r.failed?.length ? `, ${r.failed.length} failed (${r.failed.map((e: { error: string }) => e.error).join("; ")})` : ""}`);
    setSelected(new Set());
    load();
  }

  async function testSearch() {
    if (!q.trim()) return;
    const r = await fetch(`/api/admin/kb/search?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" }).then((x) => x.json());
    setHits(r.hits ?? []);
    setSearchMeta(
      r.vectorEnabled
        ? `vector ${fmtDuration(r.timings?.retrievalMs)}${r.reranked ? ` + rerank ${fmtDuration(r.timings?.rerankMs)}` : " (rerank off)"}`
        : "keyword fallback (vector store not configured)",
    );
  }

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>
          Articles ({articles.length}) ·{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            {(["published", "draft", "in_review", "archived"] as const).map((s) => `${byState[s] ?? 0} ${s.replace("_", " ")}`).join(" · ")}
          </span>
        </span>
        <span className="row">
          <Link href="/kb/article">
            <button style={{ padding: "5px 12px", fontSize: 12 }}>+ New article</button>
          </Link>
          <button onClick={load} style={{ padding: "5px 12px", fontSize: 12 }}>↻</button>
        </span>
      </h2>

      {/* Retrieval tester — the exact pipeline the agent runs */}
      <div className="steplabel">Test retrieval (what Jetta finds)</div>
      <div className="row" style={{ marginBottom: 4 }}>
        <input type="text" placeholder="e.g. my mappings disappear" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && testSearch()} />
        <button onClick={testSearch}>Search</button>
      </div>
      {searchMeta && <div className="muted" style={{ marginBottom: 6 }}>{searchMeta}</div>}
      {hits &&
        (hits.length ? (
          hits.map((h, i) => (
            <div className="io" key={i}>
              {h.score !== undefined ? h.score.toFixed(3) : "kw"}{" "}
              <Link href={`/kb/article?id=${encodeURIComponent(h.id)}`}>{h.title}</Link>{" "}
              <span className="muted">[{h.source}]</span>
            </div>
          ))
        ) : (
          <p className="muted">No hits.</p>
        ))}

      {/* Filters */}
      <div className="kb-toolbar" style={{ marginTop: 18 }}>
        <input type="text" placeholder="filter articles…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
          <option value="">all states</option>
          <option value="draft">draft</option>
          <option value="in_review">in review</option>
          <option value="published">published</option>
          <option value="archived">archived</option>
        </select>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">all categories</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>{c.name}</option>
          ))}
        </select>
        <select value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}>
          <option value="">all origins</option>
          <option value="manual">manual</option>
          <option value="knowledge-loop">knowledge-loop</option>
          <option value="fd-mined">fd-mined</option>
          <option value="seed-getsign">seed-getsign</option>
        </select>
        <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
          <option value="updated">newest first</option>
          <option value="title">by title</option>
          <option value="usage">most used</option>
          <option value="stale">stalest first</option>
        </select>
        <label className="toggle">
          <input type="checkbox" checked={f.stale} onChange={(e) => setF({ ...f, stale: e.target.checked })} /> stale only ({staleIds.size})
        </label>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="muted">{selected.size} selected</span>
          <button disabled={busy} onClick={() => bulk("publish")} style={{ padding: "5px 12px", fontSize: 12 }}>Publish</button>
          <button disabled={busy} onClick={() => bulk("archive")} style={{ padding: "5px 12px", fontSize: 12 }}>Archive</button>
          <button disabled={busy} onClick={() => bulk("reingest")} style={{ padding: "5px 12px", fontSize: 12 }}>Re-ingest</button>
          <button disabled={busy} onClick={() => bulk("delete")} style={{ padding: "5px 12px", fontSize: 12, background: "var(--panel-2)", color: "var(--danger)" }}>Delete</button>
          <button disabled={busy} onClick={() => setSelected(new Set())} style={{ padding: "5px 12px", fontSize: 12, background: "var(--panel-2)", color: "var(--muted)" }}>Clear</button>
        </div>
      )}
      {notice && <div className="muted" style={{ marginBottom: 8 }}>{notice}</div>}

      {/* Rows */}
      {shown.map((a) => (
        <div className="kb-row" key={a.id}>
          <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
          <span className={`state ${a.state}`}>{a.state.replace("_", " ")}</span>
          <span className="t">
            <Link href={`/kb/article?id=${encodeURIComponent(a.id)}`}>{a.title}</Link>
            {staleIds.has(a.id) && <span className="state stale" style={{ marginLeft: 8 }}>stale</span>}
            {(a.duplicates?.length ?? 0) > 0 && <span className="state stale" style={{ marginLeft: 8 }} title={a.duplicates!.map((d) => d.title).join("\n")}>dup?</span>}
          </span>
          <span className="n" title="retrieval hits — all time / this month">{usage[a.id]?.total ?? 0}/{usage[a.id]?.month ?? 0}</span>
          <span className="n" title={`v${a.version} · updated ${fmtDate(a.updatedAt)}`}>v{a.version}</span>
          <span className="n">{fmtDate(a.updatedAt)}</span>
        </div>
      ))}
      {shown.length === 0 && <p className="muted">No articles match the filters.</p>}
    </section>
  );
}
