import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { gate } from "@/lib/console-auth";
import {
  channelRows,
  capabilityRows,
  rolloutRows,
  reasoningRows,
  ENDPOINTS,
  CRONS,
} from "@/lib/system-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StatusRows } from "@/components/jetta/signal";
import SlackChannelHealth from "@/components/jetta/slack-channel-health";
import TicketTester from "./ticket-tester";

export const dynamic = "force-dynamic";

/**
 * System — what Jetta can currently do, and to whom.
 *
 * Ordered by blast radius rather than by integration: the first card is the
 * one that decides whether anything Jetta does reaches a customer or a real
 * account, and the second is who can reach her. The old version of this page
 * led with five LIVE/STUB badges, which told you an integration was connected
 * without telling you whether it could write.
 */
export default async function SystemPage() {
  const { locked, isAdmin } = await gate();
  if (locked) redirect("/login?next=%2Fsystem");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>What Jetta can change</CardTitle>
          <CardDescription>
            Each of these is a separate opt-in, independent of whether the integration is connected.
            An integration can be fully live and still unable to write anything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusRows rows={capabilityRows()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>How customers and colleagues reach Jetta.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusRows rows={channelRows()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Which tickets Jetta touches</CardTitle>
          <CardDescription>
            These decide whether a run happens at all. A ticket filtered out here produces no
            suggestion, no note and no event — from the outside, indistinguishable from Jetta
            ignoring it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusRows rows={rolloutRows()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reasoning &amp; retrieval</CardTitle>
          <CardDescription>Which models answer, and how the knowledge base is searched.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusRows rows={reasoningRows()} />
        </CardContent>
      </Card>

      {/* Needs the bot token and a Slack round-trip, so it stays off a general
          user's page load — they have no way to act on the answer anyway. */}
      {isAdmin && <SlackChannelHealth />}

      <TicketTester freshdeskLive={config.freshdesk.live} freshchatLive={config.freshchat.live} />

      <Card>
        <CardHeader>
          <CardTitle>Entrypoints</CardTitle>
          <CardDescription>Everything that can start a run.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            {ENDPOINTS.map((e, i) => (
              <div key={e.path}>
                {i > 0 && <Separator className="my-2" />}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.path}</code>
                  <span className="text-muted-foreground">{e.detail}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t pt-3">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Scheduled
            </p>
            {CRONS.map((c, i) => (
              <div key={c.path}>
                {i > 0 && <Separator className="my-2" />}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{c.path}</code>
                  <span className="font-mono text-xs text-foreground">{c.schedule}</span>
                  <span className="text-muted-foreground">{c.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
