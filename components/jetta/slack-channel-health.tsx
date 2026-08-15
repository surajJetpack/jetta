import { CheckCircle2, AlertTriangle } from "lucide-react";
import { checkChannels } from "@/lib/tools/slack";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Where Jetta's Slack notifications go, and whether she can actually post
 * there.
 *
 * Worth a panel rather than a log line because the failure is invisible from
 * the outside: a channel that exists but has no Jetta in it accepts nothing,
 * and the first symptom is a visitor waiting for a person who was announced
 * to an empty room. The runtime fallback keeps that from being silent, but
 * "it went to the wrong channel with a warning" is a worse outcome than
 * noticing here first.
 *
 * A server component: the check needs the bot token, which never goes near a
 * browser.
 */
export default async function SlackChannelHealth() {
  const checks = await checkChannels();

  const LABELS: Record<string, string> = {
    SLACK_ESCALATION_CHANNEL: "Dev escalations",
    SLACK_CHAT_CHANNEL: "Visitor waiting for a person",
    SLACK_OPS_CHANNEL: "Approvals + daily KB report",
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack channels</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {checks.map((c) => (
          <div key={c.setting} className="flex items-start gap-2.5 text-sm">
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            )}
            <div className="min-w-0">
              <p className="font-medium">
                {LABELS[c.setting] ?? c.setting}
                {c.name && <span className="ml-1.5 font-normal text-muted-foreground">#{c.name}</span>}
              </p>
              {c.problem ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-500">{c.problem}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">Jetta is in this channel and can post.</p>
              )}
            </div>
          </div>
        ))}
        <p className="border-t pt-2.5 text-[11px] text-muted-foreground">
          These are environment variables, not console settings — a channel is a security boundary as
          much as a preference, so changing one is a deploy rather than a form.
        </p>
      </CardContent>
    </Card>
  );
}
