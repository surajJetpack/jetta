import { config } from "@/lib/config";
import { modelLabel } from "@/lib/llm";
import { gate } from "@/lib/console-auth";
import { Nav, Locked } from "./nav";
import TicketTester from "./ticket-tester";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { locked, adminKey } = await gate(searchParams);
  if (locked) return <Locked />;

  const integrations: { name: string; live: boolean; note?: string }[] = [
    { name: "Freshdesk", live: config.freshdesk.live, note: config.freshdesk.domain },
    { name: "FastSpring", live: config.fastspring.live },
    { name: "monday.com", live: config.monday.live },
    { name: "Slack", live: config.slack.live },
  ];

  return (
    <div className="wrap">
      <Nav current="console" adminKey={adminKey} />

      <section className="card">
        <h2>System status</h2>
        <div className="grid">
          <div className="stat">
            <div className="k">Reasoning model</div>
            <div className="v">{modelLabel()}</div>
          </div>
          <div className="stat">
            <div className="k">Global mode</div>
            <div className="v">{config.stubMode ? "STUB" : "LIVE"}</div>
          </div>
          {integrations.map((i) => (
            <div className="stat" key={i.name}>
              <div className="k">{i.name}</div>
              <div className="v">
                <span className={`badge ${i.live ? "live" : "stub"}`}>{i.live ? "live" : "stub"}</span>
                {i.note ? <span style={{ marginLeft: 8, color: "var(--muted)", fontSize: 12 }}>{i.note}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <TicketTester freshdeskLive={config.freshdesk.live} adminKey={adminKey} />

      <section className="card endpoints">
        <h2>Endpoints</h2>
        <ul>
          <li><code>POST /api/webhook</code> — Freshdesk / Freshchat events (production entrypoint)</li>
          <li><code>POST /api/slack</code> — Slack admin commands (@Jetta …)</li>
          <li><code>GET /api/cron/followup</code> — daily 24h follow-up checker</li>
          <li><code>POST /api/admin/run</code> — this console&apos;s ticket runner (admin-gated)</li>
        </ul>
      </section>
    </div>
  );
}
