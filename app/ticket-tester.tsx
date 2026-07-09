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
 * The tabs are separate routes, so navigating away unmounts this component and
 * drops its React state. We persist the last run so it is restored on return:
 *   - a module-scoped `cache` covers client-side tab navigation, and
 *   - `sessionStorage` additionally covers a full page reload / cold module.
 * Both are client-only, so nothing leaks between SSR requests.
 */
type Channel = "freshdesk" | "freshchat";
type RunState = { ticketId: string; dryRun: boolean; channel?: Channel; res: RunResult | null };
const STORAGE_KEY = "jetta:lastRun";
let cache: RunState | null = null;

function readStorage(): RunState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RunState) : null;
  } catch {
    return null;
  }
}

export default function TicketTester({
  freshdeskLive,
  freshchatLive,
}: {
  freshdeskLive: boolean;
  freshchatLive: boolean;
}) {
  // Initialise from defaults so the first client render matches the server (no
  // hydration mismatch); persisted state is loaded in the mount effect below.
  const [ticketId, setTicketId] = useState(() => cache?.ticketId ?? "");
  const [dryRun, setDryRun] = useState(() => cache?.dryRun ?? true);
  const [channel, setChannel] = useState<Channel>(() => cache?.channel ?? "freshdesk");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<RunResult | null>(() => cache?.res ?? null);

  // On mount, if the in-memory cache was empty (e.g. after a full page reload
  // that re-evaluated this module), rehydrate from sessionStorage.
  useEffect(() => {
    if (cache) return;
    const saved = readStorage();
    if (!saved) return;
    cache = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time rehydration from storage on mount
    setTicketId(saved.ticketId ?? "");
    setDryRun(saved.dryRun ?? true);
    setChannel(saved.channel ?? "freshdesk");
    setRes(saved.res ?? null);
  }, []);

  // Persist the current run to both the module cache (survives tab navigation)
  // and sessionStorage (survives a reload).
  useEffect(() => {
    cache = { ticketId, dryRun, channel, res };
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
      } catch {
        /* storage full or unavailable — module cache still covers tab nav */
      }
    }
  }, [ticketId, dryRun, channel, res]);

  async function run() {
    if (!ticketId.trim()) return;
    setLoading(true);
    setRes(null);
    try {
      const r = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticketId.trim(), dryRun, channel }),
      });
      setRes((await r.json()) as RunResult);
    } catch (e) {
      setRes({ error: "request failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  const willPost = !dryRun && (channel === "freshchat" ? freshchatLive : freshdeskLive);

  return (
    <div className="card">
      <h2>Run a ticket through Jetta</h2>
      <div className="row">
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
          <option value="freshdesk">Freshdesk</option>
          <option value="freshchat">Freshchat</option>
        </select>
        <input
          type="text"
          placeholder={channel === "freshchat" ? "Freshchat conversation ID" : "Freshdesk ticket ID (e.g. 13599)"}
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
          ⚠ Dry run is OFF and {channel === "freshchat" ? "Freshchat" : "Freshdesk"} is live — running will post a real
          reply to the {channel === "freshchat" ? "conversation" : "ticket"}.
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
