"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtAgo, fmtExact, useNow } from "@/lib/format";

interface OpsEvent {
  id: string;
  at: number; // unix ms
  level: "info" | "warn" | "error";
  event: string;
  source: string;
  ticketId?: string;
  actor?: string;
  data?: Record<string, unknown>;
}

const LEVEL_ICON = { info: "ℹ️", warn: "⚠️", error: "🛑" } as const;
const SOURCES = ["webhook", "freshchat", "console", "cron", "slack", "auth", "app"];

export default function EventsLog() {
  const now = useNow();
  const [events, setEvents] = useState<OpsEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [prefix, setPrefix] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "300" });
    if (level) params.set("level", level);
    if (source) params.set("source", source);
    if (prefix.trim()) params.set("event", prefix.trim());
    const r = await fetch(`/api/admin/events?${params}`, { cache: "no-store" }).then((x) => x.json());
    setEvents(r.events ?? []);
  }, [level, source, prefix]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [open, load]);

  return (
    <section className="card">
      <h2 style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        Event log {events ? `(${events.length})` : ""} {open ? "▾" : "▸"}
      </h2>
      {open && (
        <>
          <p className="muted" style={{ marginBottom: 10 }}>
            Every system event — webhook receipts and skips, runs, draft decisions, learnings,
            logins, cron and Slack activity — durable and machine-readable.{" "}
            <a href="/api/admin/events?format=ndjson&limit=1000">Download NDJSON</a> for analysis.
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            {["", "info", "warn", "error"].map((l) => (
              <button
                key={l || "all"}
                type="button"
                onClick={() => setLevel(l)}
                className={`state ${level === l ? "published" : "draft"}`}
                style={{ cursor: "pointer", border: level === l ? "1px solid var(--accent)" : "1px solid transparent" }}
              >
                {l || "all levels"}
              </button>
            ))}
            <span style={{ width: 8 }} />
            {["", ...SOURCES].map((s) => (
              <button
                key={s || "all"}
                type="button"
                onClick={() => setSource(s)}
                className={`state ${source === s ? "published" : "draft"}`}
                style={{ cursor: "pointer", border: source === s ? "1px solid var(--accent)" : "1px solid transparent" }}
              >
                {s || "all sources"}
              </button>
            ))}
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="event prefix, e.g. webhook."
              style={{ fontFamily: "inherit", fontSize: 13, minWidth: 180 }}
            />
            <button type="button" onClick={load}>Refresh</button>
          </div>

          {events === null && <p className="muted">Loading…</p>}
          {events !== null && events.length === 0 && <p className="muted">No events match.</p>}
          {events?.map((e) => (
            <div className="step" key={e.id}>
              <div
                className="tool"
                style={{ display: "flex", justifyContent: "space-between", cursor: "pointer", gap: 10 }}
                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
              >
                <span>
                  {LEVEL_ICON[e.level]} {e.event}
                  {e.ticketId ? <span className="muted" style={{ fontWeight: 400 }}> · #{e.ticketId}</span> : null}
                </span>
                <span className="muted" style={{ fontWeight: 400, fontSize: 12, flexShrink: 0 }}>
                  {e.source}
                  {e.actor ? ` · ${e.actor}` : ""} ·{" "}
                  <span title={fmtExact(Math.floor(e.at / 1000))}>{fmtAgo(Math.floor(e.at / 1000), now)}</span>
                </span>
              </div>
              {expanded === e.id && (
                <pre className="io" style={{ overflowX: "auto", fontSize: 12, marginTop: 6 }}>
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
