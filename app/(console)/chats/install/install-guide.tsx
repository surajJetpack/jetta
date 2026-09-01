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

  // Identity should arrive WITH the first session, and the monday SDK resolves
  // asynchronously — so who the visitor is is fetched first and the loader is
  // injected after. Setting JettaChatConfig later races the visitor: if they
  // open the chat first, Jetta asks them in the conversation for a name and
  // email the SDK already knew.
  //
  // It comes from monday.api(), NOT from monday.get("context"). The context
  // object carries IDS ONLY — `user.id` and `account.id` — with no name, no
  // email and no account slug anywhere in it. Reading them from there yields
  // undefined and the session starts anonymous, so a logged-in user gets asked
  // who they are — the question this snippet exists to skip. monday.api()
  // needs no token on the client (it uses the logged-in user's own
  // credentials), but it does need the app to hold the `me:read` scope.
  const mondaySnippet = `<script>
  monday
    .api("query { me { id name email } account { id slug } }")
    .then(function (res) {
      var me = res.data.me;
      var account = res.data.account;
      window.JettaChatConfig = {
        surface: "monday",
        visitor: {
          name: me.name,
          email: me.email,
          mondayAccountSlug: account.slug,
          mondayAccountId: String(account.id),
          mondayUserId: String(me.id),
          app: "getsign"            // the app this view belongs to
        }
      };
      var s = document.createElement("script");
      s.src = "${baseUrl}/jettachat.js";
      s.defer = true;
      document.body.appendChild(s);
    });
</script>`;

  // The same thing for an app that imports the SDK instead of loading it from a
  // CDN — which is how ours are actually built. There is no global `monday` in
  // a bundled app, so the snippet above throws `monday is not defined` and the
  // widget never appears; the SSR-shaped fix (put it in index.html) is the one
  // that cannot work here.
  //
  // The guard is not defensive padding. React re-invokes effects in
  // development, and mounting twice appends two loaders — two launchers, two
  // sessions, and a visitor who cannot tell which one anybody is reading.
  const mondayModuleSnippet = `import mondaySdk from "monday-sdk-js";

const monday = mondaySdk();

export async function mountJettaChat() {
  if (window.__jettaChatMounted) return;
  window.__jettaChatMounted = true;

  const res = await monday.api("query { me { id name email } account { id slug } }");
  const { me, account } = res.data;

  window.JettaChatConfig = {
    // Also lifts the launcher 88px off the bottom, clear of monday's AI
    // sidekick — pass launcher.offsetY to put it somewhere else.
    surface: "monday",
    // Bottom-right belongs to monday inside an app view.
    launcher: { position: "left" },
    visitor: {
      name: me.name,
      email: me.email,
      mondayAccountSlug: account.slug,
      mondayAccountId: String(account.id),
      mondayUserId: String(me.id),
      app: "getsign",
    },
  };

  const s = document.createElement("script");
  s.src = "${baseUrl}/jettachat.js";
  s.defer = true;
  document.body.appendChild(s);
}`;

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
          <Step n={4} title="Name the app the page belongs to">
            <Snippet code={getsignTag} />
            <p className="text-[11px] text-muted-foreground">
              <code>data-app</code> is how a chat gets attributed, and it is the only source that
              cannot be wrong — without it the app is inferred from what the visitor asks about,
              which reads a billing question as no app at all. It also drives the per-app filter in{" "}
              <b>Chats</b>. Use the app&apos;s key:{" "}
              <code>getsign</code>, <code>vlookup</code>, <code>trackmy</code>, <code>extract</code>,{" "}
              <code>jobflows</code>, <code>smartcolumns</code>, <code>jetscan</code>,{" "}
              <code>pivotreports</code>, <code>triggerly</code>.
            </p>
            <p className="text-[11px] text-muted-foreground">
              <code>data-app=&quot;getsign&quot;</code> does one thing more: it switches the widget to
              the GetSign skin from <b>Settings → What the visitor sees → GetSign</b> and scopes
              answers to the GetSign knowledge base — the other apps&apos; articles are not
              retrievable there. A page served from getsign.io gets that even without the attribute;
              set it anyway, so the behaviour is readable from the snippet rather than inferred from
              the domain.
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
          <p className="text-sm text-muted-foreground">
            That version needs a global <code>monday</code>, which only exists if the view loads the SDK from
            a CDN. Ours import it, so use this instead — same handover, called once after the view mounts.
          </p>
          <Snippet code={mondayModuleSnippet} />
          <p className="text-[11px] text-muted-foreground">
            The app needs the <code>me:read</code> scope, or the query comes back without a name and email —
            and Jetta then asks the visitor in the chat for details monday already knows. Set{" "}
            <code>app</code> to whichever product the view belongs to so tickets are attributed correctly.
          </p>
          <p className="text-[11px] text-muted-foreground">
            <b>The corner is already monday&apos;s.</b> Their AI sidekick is a floating circle in the same
            spot at the same size, so <code>surface: &quot;monday&quot;</code> now anchors the launcher{" "}
            <code>88px</code> up by default — a launcher height plus a gap above it — and stacks rather than
            sits beside it, so it clears either corner. Pass your own{" "}
            <code>launcher: {"{ position: \"left\", offsetY: 88 }"}</code> to override: it outranks the side
            set in Settings, which is per brand and would move the website too. z-index is no help — the
            widget is in an iframe, so it can never stack above monday&apos;s own floating buttons.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Two origins go on the allowed list, not one: the host your app view is served from{" "}
            <em>and</em> <code>https://*.monday.com</code>. The browser checks the framing rule against every
            ancestor of the chat, and inside monday your view is itself in a frame — list only your own host and
            the launcher opens onto nothing.
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
            <p className="font-medium">Jetta asks monday users for their name in the chat</p>
            <p className="text-muted-foreground">
              Identity never reached the session, so she collects it herself — correct behavior, wrong
              surface. Either <code>JettaChatConfig</code> wasn&apos;t set before the loader ran — fetch who
              the visitor is first and inject the script afterwards, as in the snippet above — or the name and
              email came back empty. Log the query result: <code>monday.get(&quot;context&quot;)</code> never
              carries a name, an email or an account slug, and <code>monday.api()</code> returns them only with
              the <code>me:read</code> scope granted.
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
