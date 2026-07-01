"use client";

import { useEffect, useState } from "react";

interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
}
interface RunResult {
  ticket?: { id: string; subject: string; status: string; requester: string | null; product: string };
  model?: string;
  dryRun?: boolean;
  blockedByAllowlist?: boolean;
  durationMs?: number;
  resolutionSent?: boolean;
  reply?: string;
  trace?: TraceEntry[];
  error?: string;
  message?: string;
}

/**
 * Module-scoped cache of the last run. The tabs are separate routes, so
 * navigating away unmounts this component and drops its React state. This
 * variable lives in the JS module (which persists across client-side tab
 * navigation), so the execution data is restored when the user returns to the
 * Console tab. It is only ever written from a client effect — never on the
 * server — so it cannot leak between SSR requests.
 */
let cache: { ticketId: string; dryRun: boolean; res: RunResult | null } | null = null;

export default function TicketTester({ freshdeskLive, adminKey }: { freshdeskLive: boolean; adminKey: string }) {
  const [ticketId, setTicketId] = useState(() => cache?.ticketId ?? "");
  const [dryRun, setDryRun] = useState(() => cache?.dryRun ?? true);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<RunResult | null>(() => cache?.res ?? null);

  // Persist the current run to the module cache so it survives tab navigation.
  useEffect(() => {
    cache = { ticketId, dryRun, res };
  }, [ticketId, dryRun, res]);

  async function run() {
    if (!ticketId.trim()) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-secret": adminKey },
        body: JSON.stringify({ ticketId: ticketId.trim(), dryRun }),
      });
      setRes((await r.json()) as RunResult);
    } catch (e) {
      setRes({ error: "request failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  const willPost = !dryRun && freshdeskLive;

  return (
    <div className="card">
      <h2>Run a ticket through Jetta</h2>
      <div className="row">
        <input
          type="text"
          placeholder="Freshdesk ticket ID (e.g. 13599)"
          value={ticketId}
          onChange={(e) => setTicketId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <label className="toggle">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (preview, no posting)
        </label>
        <button onClick={run} disabled={loading || !ticketId.trim()}>
          {loading ? <span className="spin" /> : null}
          {loading ? "Running…" : "Run"}
        </button>
      </div>

      {willPost && (
        <div className="warn">
          ⚠ Dry run is OFF and Freshdesk is live — running will post a real reply to the ticket.
        </div>
      )}

      {res && (
        <div className="result">
          {res.error ? (
            <p className="err">
              {res.error}
              {res.message ? `: ${res.message}` : ""}
            </p>
          ) : (
            <>
              <div className="tsum">
                <span>
                  <b>#{res.ticket?.id}</b> {res.ticket?.subject}
                </span>
                <span>
                  product <b>{res.ticket?.product}</b>
                </span>
                <span>
                  model <b>{res.model}</b>
                </span>
                <span>{res.dryRun ? "🔒 dry run" : "🟢 live"}</span>
                {res.blockedByAllowlist ? <span style={{ color: "var(--warn)" }}>⚠ not on allowlist → forced dry-run</span> : null}
                {res.resolutionSent ? <span><b>resolution sent</b> → follow-up scheduled</span> : null}
                <span>{res.durationMs}ms</span>
              </div>

              {res.reply ? (
                <>
                  <div className="steplabel">Final reply</div>
                  <div className="reply">{res.reply}</div>
                </>
              ) : null}

              <div className="steplabel">
                Tool trace ({res.trace?.length ?? 0} call{res.trace?.length === 1 ? "" : "s"})
              </div>
              {res.trace?.length ? (
                res.trace.map((t, i) => (
                  <div className="step" key={i}>
                    <div className="tool">
                      {i + 1}. {t.tool}
                    </div>
                    <div className="io">→ {JSON.stringify(t.input)}</div>
                    <div className="io out">{t.result}</div>
                  </div>
                ))
              ) : (
                <p className="muted">No tools were called.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
