"use client";

import { useEffect, useState, useCallback } from "react";

interface Gap { ticketId: string; subject: string; reason: string; at: number; url: string }
interface Stats {
  outcomes: { total: number; resolved: number; escalated: number; reopened: number; closed: number; deflectionRate: number | null };
  gaps: Gap[];
  gapKeywords: { term: string; count: number }[];
  toolUsage: { tool: string; count: number }[];
  approvedArticles: { title: string; approvedBy: string; at: number }[];
}

export default function AnalyticsPanel() {
  const [s, setS] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/stats", { cache: "no-store" });
      setS((await r.json()) as Stats);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const o = s?.outcomes;
  const pct = o?.deflectionRate != null ? `${Math.round(o.deflectionRate * 100)}%` : "—";

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Learning &amp; gap analytics</span>
        <button onClick={load} disabled={loading} style={{ padding: "5px 12px", fontSize: 12 }}>
          {loading ? <span className="spin" /> : "↻"} Refresh
        </button>
      </h2>

      {err && <p className="err">{err}</p>}

      {o && (
        <>
          <div className="grid" style={{ marginBottom: 18 }}>
            <div className="stat"><div className="k">Runs logged</div><div className="v">{o.total}</div></div>
            <div className="stat"><div className="k">Deflection rate</div><div className="v">{pct}</div></div>
            <div className="stat"><div className="k">Escalated</div><div className="v">{o.escalated}</div></div>
            <div className="stat"><div className="k">Reopened</div><div className="v">{o.reopened}</div></div>
            <div className="stat"><div className="k">Auto-closed</div><div className="v">{o.closed}</div></div>
            <div className="stat"><div className="k">KB articles learned</div><div className="v">{s.approvedArticles.length}</div></div>
          </div>

          <div className="steplabel">Knowledge gaps — document these next ({s.gaps.length})</div>
          {s.gaps.length ? (
            s.gaps.slice(0, 12).map((g) => (
              <div className="step" key={g.ticketId}>
                <div className="tool" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={`badge ${g.reason === "reopened" ? "stub" : "live"}`}>{g.reason}</span>
                  <a href={g.url} target="_blank" rel="noreferrer">#{g.ticketId}</a>
                </div>
                <div className="io out">{g.subject}</div>
              </div>
            ))
          ) : (
            <p className="muted">No escalations or reopens logged yet — Jetta is closing everything herself, or there's no traffic.</p>
          )}

          {s.gapKeywords.length > 0 && (
            <>
              <div className="steplabel" style={{ marginTop: 16 }}>Recurring gap themes</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {s.gapKeywords.map((k) => (
                  <span key={k.term} className="badge stub">{k.term} · {k.count}</span>
                ))}
              </div>
            </>
          )}

          <div className="steplabel" style={{ marginTop: 18 }}>Learned via the Knowledge Loop ({s.approvedArticles.length})</div>
          {s.approvedArticles.length ? (
            s.approvedArticles.slice(0, 10).map((a, i) => (
              <div className="step" key={i}>
                <div className="io out">📘 {a.title}</div>
                <div className="io">approved by {a.approvedBy}</div>
              </div>
            ))
          ) : (
            <p className="muted">No articles approved yet. When a dev resolves an escalation in Slack, run <code>@Jetta draft kb</code> → <code>@Jetta publish kb</code>.</p>
          )}

          {s.toolUsage.length > 0 && (
            <>
              <div className="steplabel" style={{ marginTop: 18 }}>Tool usage</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {s.toolUsage.map((t) => (
                  <span key={t.tool} className="badge live" style={{ fontFamily: "var(--mono)" }}>{t.tool} · {t.count}</span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
