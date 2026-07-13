import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { modelLabel } from "@/lib/llm";
import { gate } from "@/lib/console-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LiveBadge } from "@/components/jetta/live-badge";
import { Nav } from "./nav";
import TicketTester from "./ticket-tester";

export const dynamic = "force-dynamic";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold">{children}</div>
    </div>
  );
}

const ENDPOINTS = [
  ["POST /api/webhook", "Freshdesk events (production entrypoint)"],
  ["POST /api/webhook/freshchat", "Freshchat conversation events (Freddy hand-off)"],
  ["POST /api/slack", "Slack admin commands (@Jetta …)"],
  ["GET /api/cron/followup", "daily 24h follow-up checker"],
  ["POST /api/admin/run", "this console's ticket runner (admin-gated)"],
] as const;

export default async function Home() {
  const { locked, user } = await gate();
  if (locked) redirect("/login?next=%2F");

  const integrations: { name: string; live: boolean; note?: string }[] = [
    { name: "Freshdesk", live: config.freshdesk.live, note: config.freshdesk.domain },
    { name: "Freshchat", live: config.freshchat.live },
    { name: "FastSpring", live: config.fastspring.live },
    { name: "monday.com", live: config.monday.live },
    { name: "Slack", live: config.slack.live },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="console" user={user} />

      <Card>
        <CardHeader>
          <CardTitle>System status</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Reasoning model">
            <span className="truncate">{modelLabel()}</span>
          </Stat>
          <Stat label="Global mode">
            <LiveBadge live={!config.stubMode} />
          </Stat>
          <Stat label="Reply mode">{config.replyMode === "draft" ? "DRAFT" : "AUTO"}</Stat>
          {integrations.map((i) => (
            <Stat key={i.name} label={i.name}>
              <LiveBadge live={i.live} />
              {i.note && <span className="truncate text-xs font-normal text-muted-foreground">{i.note}</span>}
            </Stat>
          ))}
        </CardContent>
      </Card>

      <TicketTester freshdeskLive={config.freshdesk.live} freshchatLive={config.freshchat.live} />

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
        </CardHeader>
        <CardContent>
          {ENDPOINTS.map(([path, desc], i) => (
            <div key={path}>
              {i > 0 && <Separator className="my-2" />}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{path}</code>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
