"use client";

import { useEffect, useState, useCallback } from "react";

interface Gap { ticketId: string; subject: string; reason: string; at: number; url: string }
interface ModelStat {
  model: string;
  drafts: number;
  approved: number;
  edited: number;
  discarded: number;
  runs: number;
  escalated: number;
  reopened: number;
  approvalRate: number | null;
  editRate: number | null;
  tokens: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    avgTokensPerRun: number;
    estCostUsd: number | null;
  } | null;
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
interface Stats {
  outcomes: { total: number; resolved: number; escalated: number; reopened: number; closed: number; deflectionRate: number | null };
  gaps: Gap[];
  gapKeywords: { term: string; count: number }[];
  toolUsage: { tool: string; count: number }[];
  approvedArticles: { title: string; approvedBy: string; at: number }[];
  models?: ModelStat[];
}

export default function AnalyticsPanel() {
  const [s, setS] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // State updates live in promise callbacks (not the function body) so the
  // mount effect satisfies react-hooks/set-state-in-effect; initial
  // loading=true covers the first fetch.
  const load = useCallback(() => {
    fetch("/api/admin/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setS(d as Stats);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    void load();
  };

  const o = s?.outcomes;
  const pct = o?.deflectionRate != null ? `${Math.round(o.deflectionRate * 100)}%` : "—";

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Learning &amp; gap analytics</span>
        <button onClick={refresh} disabled={loading} style={{ padding: "5px 12px", fontSize: 12 }}>
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
            <p className="muted">No escalations or reopens logged yet — Jetta is closing everything herself, or there&apos;s no traffic.</p>
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

          {(s.models?.length ?? 0) > 0 && (
            <>
              <div className="steplabel" style={{ marginTop: 18 }}>
                Model quality — evidence for tiered routing
              </div>
              {s.models!.map((m) => (
                <div className="step" key={m.model}>
                  <div className="tool" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>{m.model}</span>
                    <span className="badge live">{m.runs} runs</span>
                    {m.drafts > 0 && (
                      <span className={`badge ${m.approvalRate != null && m.approvalRate < 0.8 ? "stub" : "live"}`}>
                        {m.approvalRate != null ? `${Math.round(m.approvalRate * 100)}% approved` : "no decisions yet"}
                      </span>
                    )}
                  </div>
                  <div className="io out">
                    drafts {m.drafts} · approved {m.approved}
                    {m.edited > 0 ? ` (${m.edited} edited)` : ""} · discarded {m.discarded} · escalated {m.escalated} · reopened {m.reopened}
                  </div>
                  {m.tokens && (
                    <div className="io">
                      tokens: {fmtTokens(m.tokens.inputTokens)} in · {fmtTokens(m.tokens.outputTokens)} out
                      {" "}· avg {fmtTokens(m.tokens.avgTokensPerRun)}/run
                      {m.tokens.estCostUsd != null ? ` · ~$${m.tokens.estCostUsd.toFixed(m.tokens.estCostUsd < 0.1 ? 4 : 2)} total` : ""}
                    </div>
                  )}
                </div>
              ))}
            </>
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
