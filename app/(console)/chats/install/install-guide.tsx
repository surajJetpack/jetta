"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, PlugZap, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { StatusChip } from "@/components/jetta/status-chip";

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2 right-2"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

export default function InstallGuide({ baseUrl }: { baseUrl: string }) {
  const [origins, setOrigins] = useState<string[]>([]);
  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch("/api/admin/chat-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { settings: { allowedOrigins: string[] } }) => setOrigins(d.settings.allowedOrigins ?? []))
      .catch(() => {});
  }, []);

  // The check that saves the most time: paste the site's address and find out
  // here whether it is allowed, instead of loading the site and seeing nothing.
  const check = useCallback(() => {
    setChecking(true);
    setResult(null);
    let origin = "";
    try {
      origin = new URL(probe.trim().startsWith("http") ? probe.trim() : `https://${probe.trim()}`).origin;
    } catch {
      setResult({ ok: false, message: "That doesn't look like a web address." });
      setChecking(false);
      return;
    }
    // The allowlist check is done here against the saved list; the request is
    // only asking whether the channel is switched on at all.
    fetch(`/api/chat/config`)
      .then((r) => r.json())
      .then((cfg: { enabled: boolean }) => {
        const allowed = origins.includes(origin);
        if (!cfg.enabled) {
          setResult({ ok: false, message: "The chat is currently switched off, so nothing will load anywhere." });
        } else if (!allowed) {
          setResult({
            ok: false,
            message: `${origin} is not on the allowed list — the widget will load but every request from it will be refused. Add it in Settings.`,
          });
        } else {
          setResult({ ok: true, message: `${origin} is allowed and the chat is on. The snippet below will work.` });
        }
      })
      .catch((e) => setResult({ ok: false, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => setChecking(false));
  }, [probe, origins]);

  // The loader reads its own host from script.src, so there is nothing else to
  // configure — an extra attribute here would be a lie the widget ignores.
  const scriptTag = `<script src="${baseUrl}/jettachat.js" data-surface="wordpress" defer></script>`;
  const getsignTag = `<script src="${baseUrl}/jettachat.js" data-surface="wordpress" data-app="getsign" defer></script>`;

  // Identity must exist BEFORE the first session is created, and the monday SDK
  // resolves asynchronously — so the context is fetched first and the loader is
  // injected after. Calling identify() later races the visitor: if they open the
  // chat first, they get asked for a name the SDK already knew.
  const mondaySnippet = `<script>
  monday.get("context").then(function (res) {
    window.JettaChatConfig = {
      surface: "monday",
      visitor: {
        name: res.data.user.name,
        email: res.data.user.email,
        mondayAccountSlug: res.data.account.slug,
        mondayAccountId: String(res.data.account.id),
        mondayUserId: String(res.data.user.id),
        app: "vlookup"            // the app this view belongs to
      }
    };
    var s = document.createElement("script");
    s.src = "${baseUrl}/jettachat.js";
    s.defer = true;
    document.body.appendChild(s);
  });
</script>`;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="size-4 text-primary" /> Check a site first
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste the address of the site you&apos;re adding the chat to. This tells you now whether it will
            work, rather than after you&apos;ve edited the theme and found an empty corner of the page.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={probe}
              placeholder="jetpackapps.io"
              onChange={(e) => setProbe(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && check()}
              className="max-w-xs"
            />
            <Button onClick={check} disabled={checking || !probe.trim()}>
              {checking ? "Checking…" : "Check"}
            </Button>
          </div>
          {result && (
            <Alert variant={result.ok ? "default" : "destructive"}>
              {result.ok ? <Check /> : <TriangleAlert />}
              <AlertTitle>{result.message}</AlertTitle>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">Currently allowed:</span>
            {origins.length ? (
              origins.map((o) => (
                <StatusChip key={o} tone="published">
                  {o}
                </StatusChip>
              ))
            ) : (
              <StatusChip tone="draft">nothing yet — the chat can only run on this domain</StatusChip>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>On a website (WordPress, or any HTML page)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Step n={1} title="Allow the site">
            <p className="text-sm text-muted-foreground">
              Add its address to <b>Sites allowed to embed the chat</b> in Settings. Until you do, the widget
              loads but every request from it is refused — that&apos;s the protection stopping anyone else from
              putting your chat on their site.
            </p>
          </Step>
          <Step n={2} title="Paste this before </body>">
            <Snippet code={scriptTag} />
            <p className="text-[11px] text-muted-foreground">
              In WordPress: Appearance → Theme File Editor → footer.php, or any &quot;custom scripts&quot;
              plugin. Nothing else is needed — the launcher, the panel and the styling all come from here.
            </p>
          </Step>
          <Step n={3} title="Load the page and look bottom-right">
            <p className="text-sm text-muted-foreground">
              The launcher appears within a second. Send yourself a test message and it&apos;ll show up under{" "}
              <b>Chats</b> in this console.
            </p>
          </Step>
          <Step n={4} title="On getsign.io, name the app">
            <Snippet code={getsignTag} />
            <p className="text-[11px] text-muted-foreground">
              <code>data-app=&quot;getsign&quot;</code> switches the widget to the GetSign skin from{" "}
              <b>Settings → What the visitor sees → GetSign</b>, and scopes answers to the GetSign
              knowledge base — the other apps&apos; articles are not retrievable there. A page served
              from getsign.io gets this even without the attribute; set it anyway, so the behaviour
              is readable from the snippet rather than inferred from the domain.
            </p>
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inside a monday app view</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Same script, plus one call that hands over who the visitor is. The monday SDK already knows, so
            they&apos;re never asked — and Jetta can look up their account, plan and boards from the first message.
          </p>
          <Snippet code={mondaySnippet} />
          <p className="text-[11px] text-muted-foreground">
            Add <code>https://*.monday.com</code> (or the specific app-view host) to the allowed list, and set{" "}
            <code>app</code> to whichever product the view belongs to so tickets are attributed correctly.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When it doesn&apos;t work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="font-medium">Nothing appears at all</p>
            <p className="text-muted-foreground">
              The script didn&apos;t load. Check the page source for the tag, and that the chat is switched on in
              Settings — when it&apos;s off, the widget stays hidden rather than showing a launcher that fails.
            </p>
          </div>
          <div>
            <p className="font-medium">The launcher shows but the chat won&apos;t start</p>
            <p className="text-muted-foreground">
              Almost always the allowed list. Run the check at the top of this page with that exact address —
              <code>https://www.site.com</code> and <code>https://site.com</code> are different origins, and both
              need to be listed if you use both.
            </p>
          </div>
          <div>
            <p className="font-medium">It asks monday users for their name</p>
            <p className="text-muted-foreground">
              <code>JettaChatConfig</code> wasn&apos;t set before the loader ran. Fetch the monday context first
              and inject the script afterwards, as in the snippet above — set it later and you race the visitor.
            </p>
          </div>
          <div>
            <p className="font-medium">Everything looks right and it still fails</p>
            <p className="text-muted-foreground">
              Open <b>Insights → Event log</b> and filter to <code>chat</code>. Every refused request is recorded
              there with the reason.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
