"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Md } from "./markdown";
import type { Article, Category, Usage } from "./kb-list";

interface Version {
  version: number;
  title: string;
  body: string;
  editedBy: string;
  at: number;
}
interface AuditEvent {
  at: number;
  actor: string;
  action: string;
  fromState?: string;
  toState?: string;
  version?: number;
  detail?: string;
}
interface FdFolder {
  id: string;
  name: string;
  categoryName: string;
}

/** Legal lifecycle moves — mirrors TRANSITIONS in lib/kb-store.ts. */
const NEXT_STATES: Record<string, string[]> = {
  draft: ["in_review", "published"],
  in_review: ["draft", "published"],
  published: ["archived"],
  archived: ["draft"],
};

const fmt = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") : "—");
const fmtDay = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");

export default function KbArticle({ adminKey, id }: { adminKey: string; id?: string }) {
  const hdr = useMemo(() => ({ "x-admin-secret": adminKey }), [adminKey]);
  const router = useRouter();
  const isNew = !id;

  const [article, setArticle] = useState<Article | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [missing, setMissing] = useState(false);

  // Edit buffer
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [keywords, setKeywords] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // Freshdesk publishing
  const [fdFolders, setFdFolders] = useState<FdFolder[] | null>(null);
  const [fdFolderPick, setFdFolderPick] = useState("");

  const applyArticle = useCallback((a: Article) => {
    setArticle(a);
    setTitle(a.title);
    setUrl(a.url);
    setBody(a.body);
    setKeywords(a.keywords.join(", "));
    setCategory(a.category);
    setTags(a.tags.join(", "));
    setReviewBy(fmtDay(a.reviewBy));
  }, []);

  const load = useCallback(async () => {
    if (!id) {
      const r = await fetch("/api/admin/kb", { cache: "no-store", headers: hdr }).then((x) => x.json());
      setCategories(r.categories ?? []);
      return;
    }
    const r = await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { cache: "no-store", headers: hdr });
    if (r.status === 404) {
      setMissing(true);
      return;
    }
    const j = await r.json();
    applyArticle(j.article);
    setCategories(j.categories ?? []);
    setUsage(j.usage ?? null);
    const [v, a] = await Promise.all([
      fetch(`/api/admin/kb/versions?id=${encodeURIComponent(id)}`, { cache: "no-store", headers: hdr }).then((x) => x.json()),
      fetch(`/api/admin/kb/audit?id=${encodeURIComponent(id)}`, { cache: "no-store", headers: hdr }).then((x) => x.json()),
    ]);
    setVersions(v.versions ?? []);
    setAudit(a.events ?? []);
  }, [id, hdr, applyArticle]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  const aq = adminKey ? `key=${encodeURIComponent(adminKey)}` : "";

  async function save() {
    setBusy(true);
    setNotice("");
    const payload = {
      id: article?.id,
      title,
      url,
      body,
      keywords: keywords.split(",").map((s) => s.trim()).filter(Boolean),
      category,
      tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
      reviewBy: reviewBy ? Math.floor(new Date(reviewBy).getTime() / 1000) : undefined,
      ...(isNew ? { state: "draft" } : {}),
    };
    const r = await fetch("/api/admin/kb", {
      method: article ? "PUT" : "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) {
      setNotice(`Error: ${r.error}`);
      return;
    }
    if (isNew && r.article?.id) {
      router.replace(`/kb/article?${aq}&id=${encodeURIComponent(r.article.id)}`);
      return;
    }
    setNotice(
      r.duplicates?.length
        ? `Saved v${r.article.version}. Possible duplicates: ${r.duplicates.map((d: { title: string }) => d.title).join(" · ")}`
        : `Saved v${r.article.version}.`,
    );
    load();
  }

  async function transition(to: string) {
    setBusy(true);
    const r = await fetch("/api/admin/kb/state", {
      method: "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id, to }),
    }).then((x) => x.json());
    setBusy(false);
    setNotice(r.error ? `Error: ${r.error}` : `Now ${to.replace("_", " ")}.`);
    load();
  }

  async function restore(version: number) {
    if (!confirm(`Restore the content of v${version}? (saved as a new version)`)) return;
    setBusy(true);
    const r = await fetch("/api/admin/kb/versions", {
      method: "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id, version }),
    }).then((x) => x.json());
    setBusy(false);
    setNotice(r.error ? `Error: ${r.error}` : `Restored v${version} as v${r.article.version}.`);
    load();
  }

  async function loadFdFolders() {
    const r = await fetch("/api/admin/kb/freshdesk", { cache: "no-store", headers: hdr }).then((x) => x.json());
    setFdFolders(r.folders ?? []);
    const mapped = (r.categories ?? []).find((c: Category) => c.slug === article?.category)?.fdFolderId;
    if (mapped) setFdFolderPick(mapped);
  }

  async function pushToFreshdesk() {
    setBusy(true);
    setNotice("");
    // Persist the folder mapping first if the reviewer picked one here.
    if (fdFolderPick && article?.category) {
      await fetch("/api/admin/kb/freshdesk", {
        method: "PUT",
        headers: { ...hdr, "Content-Type": "application/json" },
        body: JSON.stringify({ slug: article.category, fdFolderId: fdFolderPick }),
      });
    }
    const r = await fetch("/api/admin/kb/freshdesk", {
      method: "POST",
      headers: { ...hdr, "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id }),
    }).then((x) => x.json());
    setBusy(false);
    setNotice(r.error ? `Error: ${r.error}` : `Pushed to Freshdesk (v${r.freshdesk?.syncedVersion}) — ${r.url}`);
    load();
  }

  async function remove() {
    if (!confirm("Delete this article? This also removes it from the vector index.")) return;
    await fetch(`/api/admin/kb?id=${encodeURIComponent(article!.id)}`, { method: "DELETE", headers: hdr });
    router.push(`/kb?${aq}`);
  }

  if (missing) {
    return (
      <section className="card">
        <h2>Article not found</h2>
        <p className="muted">
          It may have been deleted. <Link href={`/kb?${aq}`}>Back to the list</Link>.
        </p>
      </section>
    );
  }

  const dirty =
    !!article &&
    (title !== article.title ||
      url !== article.url ||
      body !== article.body ||
      keywords !== article.keywords.join(", ") ||
      category !== article.category ||
      tags !== article.tags.join(", ") ||
      reviewBy !== fmtDay(article.reviewBy));

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>
          {isNew ? "New article" : article ? article.title : "Loading…"}{" "}
          {article && <span className={`state ${article.state}`}>{article.state.replace("_", " ")}</span>}
        </span>
        <Link href={`/kb?${aq}`} className="muted" style={{ fontSize: 13 }}>← all articles</Link>
      </h2>

      <div className="kb-toolbar">
        <input type="text" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flexBasis: "100%" }} />
        <input type="text" placeholder="Public citation URL (empty = internal)" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flexBasis: "100%" }} />
        <input type="text" placeholder="keywords, comma, separated" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">uncategorized</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>{c.name}</option>
          ))}
        </select>
        <input type="text" placeholder="tags, comma, separated" value={tags} onChange={(e) => setTags(e.target.value)} style={{ maxWidth: 220 }} />
        <label className="toggle" title="Review-by date — the article is flagged stale after this">
          review by
          <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)}
            style={{ background: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8, padding: "6px 9px" }} />
        </label>
      </div>

      <div className="kb-split">
        <textarea placeholder="Article body (markdown)…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "4px 14px", background: "var(--panel-2)", overflowY: "auto", maxHeight: 500 }}>
          {body ? <Md>{body}</Md> : <p className="muted">Live preview…</p>}
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={save} disabled={busy || !title || !body || (!isNew && !dirty)}>
          {busy ? "Saving…" : isNew ? "Create draft" : dirty ? `Save (v${(article?.version ?? 0) + 1})` : "Saved"}
        </button>
        {article &&
          NEXT_STATES[article.state]?.map((s) => (
            <button key={s} onClick={() => transition(s)} disabled={busy || dirty} title={dirty ? "Save your edits first" : undefined}
              style={{ background: "var(--panel-2)", color: "var(--accent)" }}>
              → {s.replace("_", " ")}
            </button>
          ))}
        {article && (
          <button onClick={remove} disabled={busy} style={{ background: "var(--panel-2)", color: "var(--danger)" }}>
            Delete
          </button>
        )}
      </div>
      {notice && <div className={notice.startsWith("Error") ? "warn" : "muted"} style={{ marginTop: 10 }}>{notice}</div>}

      {article && (
        <div className="grid" style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          <div>
            <div className="steplabel">Details</div>
            <div className="kb-meta">
              <div><span className="k">id</span><code style={{ fontSize: 12 }}>{article.id}</code></div>
              <div><span className="k">origin / source</span>{article.origin} · {article.source || "—"}</div>
              <div><span className="k">created</span>{fmt(article.createdAt)} by {article.createdBy}</div>
              <div><span className="k">last update</span>{fmt(article.updatedAt)} by {article.updatedBy}</div>
              <div><span className="k">usage (retrieval hits)</span>{usage ? `${usage.total} all-time · ${usage.month} this month · last ${usage.lastHit ? fmt(usage.lastHit) : "never"}` : "none recorded"}</div>
              {article.state === "published" && (
                <div>
                  <span className="k">freshdesk help center</span>
                  {article.freshdesk ? (
                    <div style={{ marginBottom: 6 }}>
                      synced v{article.freshdesk.syncedVersion} on {fmt(article.freshdesk.syncedAt)}
                      {article.freshdesk.syncedVersion < article.version && (
                        <span className="state stale" style={{ marginLeft: 6 }}>outdated</span>
                      )}
                    </div>
                  ) : (
                    <div className="muted" style={{ marginBottom: 6 }}>not published to the help center</div>
                  )}
                  {fdFolders === null ? (
                    <button onClick={loadFdFolders} disabled={busy} style={{ padding: "3px 10px", fontSize: 12 }}>
                      {article.freshdesk ? "Push update…" : "Publish to Freshdesk…"}
                    </button>
                  ) : (
                    <div className="row">
                      <select value={fdFolderPick} onChange={(e) => setFdFolderPick(e.target.value)}
                        style={{ background: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8, padding: "5px 8px", fontSize: 12 }}>
                        <option value="">pick a folder…</option>
                        {fdFolders.map((fo) => (
                          <option key={fo.id} value={fo.id}>{fo.categoryName} / {fo.name}</option>
                        ))}
                      </select>
                      <button onClick={pushToFreshdesk} disabled={busy || (!fdFolderPick && !article.freshdesk)}
                        style={{ padding: "3px 10px", fontSize: 12 }}>
                        Push
                      </button>
                    </div>
                  )}
                </div>
              )}
              {(article.duplicates?.length ?? 0) > 0 && (
                <div>
                  <span className="k">possible duplicates</span>
                  {article.duplicates!.map((d) => (
                    <div key={d.id}>
                      <Link href={`/kb/article?${aq}&id=${encodeURIComponent(d.id)}`}>{d.title}</Link>{" "}
                      <span className="muted">({d.score})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="steplabel">Versions ({versions.length})</div>
            {versions.map((v) => (
              <div className="kb-row" key={v.version} style={{ padding: "6px 4px" }}>
                <span className="n">v{v.version}</span>
                <span className="t" title={v.title}>{v.title}</span>
                <span className="n">{fmt(v.at).slice(0, 10)}</span>
                {v.version !== article.version && (
                  <button onClick={() => restore(v.version)} disabled={busy} style={{ padding: "2px 9px", fontSize: 11 }}>restore</button>
                )}
              </div>
            ))}
          </div>

          <div>
            <div className="steplabel">Audit trail</div>
            {audit.slice(0, 12).map((e, i) => (
              <div className="io" key={i} style={{ padding: "3px 0" }}>
                {fmt(e.at)} · <b>{e.action}</b>
                {e.fromState ? ` ${e.fromState}→${e.toState}` : ""}
                {e.version ? ` v${e.version}` : ""} · {e.actor}
                {e.detail ? <span className="muted"> — {e.detail}</span> : null}
              </div>
            ))}
            {audit.length === 0 && <p className="muted">No events.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
