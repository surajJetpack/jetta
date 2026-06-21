"use client";

import { useEffect, useState, useCallback } from "react";

interface RunLog {
  id: string;
  at: number;
  source: string;
  ticketId: string;
  subject?: string;
  product: string;
  model: string;
  dryRun: boolean;
  blockedByAllowlist: boolean;
  replied: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  reply: string;
  kbHits: { title: string; source: string; score?: number }[];
  trace: { tool: string; input: unknown; result: string }[];
  error?: string;
}

function ago(at: number) {
  const s = Math.floor(Date.now() / 1000) - at;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ActivityLog({ adminKey }: { adminKey: string }) {
  const [logs, setLogs] = useState<RunLog[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/logs", { cache: "no-store", headers: { "x-admin-secret": adminKey } });
      const d = await r.json();
      setLogs(d.logs ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [adminKey]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="card">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Activity log (detailed runs)</span>
        <button onClick={load} disabled={loading} style={{ padding: "5px 12px", fontSize: 12 }}>
          {loading ? <span className="spin" /> : "↻"} Refresh
        </button>
      </h2>
      {err && <p className="err">{err}</p>}
      {logs && logs.length === 0 && <p className="muted">No runs logged yet. Run a ticket above and it'll appear here.</p>}

      {logs?.map((l) => (
        <div className="step" key={l.id}>
          <div
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}
            onClick={() => setOpen(open === l.id ? null : l.id)}
          >
            <span className="tool" style={{ margin: 0 }}>#{l.ticketId}</span>
            <span className="badge live" style={{ fontFamily: "var(--sans)" }}>{l.source}</span>
            {l.dryRun ? <span className="badge stub">dry-run</span> : <span className="badge live">live</span>}
            {l.blockedByAllowlist ? <span className="badge stub">not-allowlisted</span> : null}
            {l.escalated ? <span className="badge stub">escalated</span> : null}
            {l.resolutionSent ? <span className="badge live">resolved</span> : null}
            {l.error ? <span className="badge stub" style={{ color: "var(--bad)" }}>error</span> : null}
            <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
              {l.durationMs}ms · {ago(l.at)}
            </span>
          </div>
          <div className="io" style={{ marginTop: 4 }}>{l.subject ?? "(no subject)"}</div>

          {open === l.id && (
            <div style={{ marginTop: 10 }}>
              <div className="io">
                model {l.model}
                {l.usage?.totalTokens != null ? ` · ${l.usage.totalTokens} tokens` : ""}
              </div>
              {l.error && <div className="err" style={{ marginTop: 6 }}>error: {l.error}</div>}

              <div className="steplabel" style={{ marginTop: 10 }}>KB hits ({l.kbHits.length})</div>
              {l.kbHits.length ? l.kbHits.map((h, i) => (
                <div className="io" key={i}>
                  {h.score != null ? `${h.score.toFixed(3)} ` : ""}{h.title} [{h.source}]
                </div>
              )) : <div className="muted">none</div>}

              <div className="steplabel" style={{ marginTop: 10 }}>Tool trace ({l.trace.length})</div>
              {l.trace.map((t, i) => (
                <div className="io" key={i} style={{ marginTop: 4 }}>
                  <span style={{ color: "var(--accent)" }}>{i + 1}. {t.tool}</span> → {JSON.stringify(t.input).slice(0, 120)}
                  <div className="io out">{t.result.slice(0, 240)}</div>
                </div>
              ))}

              {l.reply && (
                <>
                  <div className="steplabel" style={{ marginTop: 10 }}>Reply</div>
                  <div className="reply">{l.reply}</div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
