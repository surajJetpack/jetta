"use client";

import { useState } from "react";

interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
}
interface RunResult {
  ticket?: { id: string; subject: string; status: string; requester: string | null; product: string };
  model?: string;
  dryRun?: boolean;
  durationMs?: number;
  resolutionSent?: boolean;
  reply?: string;
  trace?: TraceEntry[];
  error?: string;
  message?: string;
}

export default function TicketTester({ freshdeskLive }: { freshdeskLive: boolean }) {
  const [ticketId, setTicketId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<RunResult | null>(null);

  async function run() {
    if (!ticketId.trim()) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
