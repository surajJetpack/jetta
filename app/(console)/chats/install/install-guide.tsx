"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, PlugZap, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { StatusChip } from "@/components/jetta/status-chip";
import { APP_NAMES } from "@/lib/types";

/** The app keys an embed may name — APP_NAMES minus the catch-all. */
const APP_KEYS = Object.keys(APP_NAMES).filter((k) => k !== "unknown");

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
    // On this surface the launcher defaults to the BOTTOM-LEFT corner —
    // bottom-right belongs to monday's AI sidekick inside an app view. Pass
    // launcher: { position, offsetX, offsetY } only to put it somewhere else;
    // a launcher sent back to the right is lifted 88px above the sidekick.
    surface: "monday",
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

  /*
   * A "Chat with us" PAGE — one page that serves every app.
   *
   * The widget's normal job is to sit in the corner of a page someone came to
   * for another reason. This is the opposite: the page has no other job, so it
   * opens straight into the conversation, and every app links to it with its
   * own `?app=`.
   *
   * A CONTAINER, not `inline: true`. Filling the window means
   * `position:fixed;inset:0`, which covers the site's own header and nav — on
   * a WordPress page inside a theme that reads as the site having broken. A
   * selector keeps the chat in the page's flow, and a selector matching
   * nothing falls back to the corner launcher, so a stripped-out div costs the
   * page its layout and never its chat.
   *
   * The app key is checked against the list rather than passed through: the
   * URL is public and hand-editable, and an unrecognised value would otherwise
   * be stamped on the conversation and carried into the per-app reports.
   */
  const chatPageSnippet = `<!-- In the page content — a Custom HTML block -->
<div id="jetta-chat" style="height:70vh;min-height:520px;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden"></div>

<script>
  (function () {
    // Only our own app keys are accepted. Anything else is ignored rather than
    // tagged onto the conversation and carried into the reports.
    var APPS = ${JSON.stringify(APP_KEYS)};
    var app = new URLSearchParams(location.search).get("app");
    window.JettaChatConfig = {
      surface: "wordpress",
      inline: "#jetta-chat",
      visitor: { app: APPS.indexOf(app) !== -1 ? app : undefined }
    };
  })();
</script>
<script src="${baseUrl}/jettachat.js" defer></script>`;

  const chatPageLink = `https://YOUR-SITE.com/chat-with-us/?app=vlookup`;

  /*
   * The same page, plus a signed monday session token.
   *
   * The token is the difference between "they say they are on acme.monday.com"
   * and monday saying it. Jetta ACTS on the monday account slug, raising trial
   * and discount requests against it without asking, and every query parameter
   * on a public URL was typed by whoever holds the link. So with a token the
   * slug, the account id and which app they came from are read out of the
   * signed claims instead. Name and email ride along as hints, exactly as good
   * as something typed into the chat, which is what they would otherwise be.
   */
  const chatPageTokenSnippet = `<script>
  (function () {
    var q = new URLSearchParams(location.search);
    var APPS = ${JSON.stringify(APP_KEYS)};
    var app = q.get("app");
    window.JettaChatConfig = {
      surface: "wordpress",
      inline: "#jetta-chat",
      visitor: {
        app: APPS.indexOf(app) !== -1 ? app : undefined,
        mondaySessionToken: q.get("token") || undefined,  // proves the account
        name: q.get("name") || undefined,   // hints; Jetta asks if absent
        email: q.get("email") || undefined
      }
    };
    // Take the token back out of the address bar, so it is not in history,
    // in a referrer, or in whatever analytics the theme loads.
    history.replaceState(null, "", location.pathname + (app ? "?app=" + encodeURIComponent(app) : ""));
  })();
</script>
<script src="${baseUrl}/jettachat.js" defer></script>`;

  const supportButtonSnippet = `import mondaySdk from "monday-sdk-js";

const monday = mondaySdk();
const CHAT_PAGE = "https://YOUR-SITE.com/chat-with-us/";

/** Wire this to the "Chat with us" button in your app view. */
export async function openSupport() {
  // Signed by monday with your app's client secret, and short-lived — Jetta
  // verifies it server-side, so the account cannot be faked by editing the URL.
  const session = await monday.get("sessionToken");
  // Name and email are a courtesy: they save Jetta asking. They prove nothing.
  const me = await monday.api("query { me { name email } }");

  const url = new URL(CHAT_PAGE);
  url.searchParams.set("app", "vlookup");
  url.searchParams.set("token", session.data);
  if (me.data?.me?.name) url.searchParams.set("name", me.data.me.name);
  if (me.data?.me?.email) url.searchParams.set("email", me.data.me.email);

  window.open(url.toString(), "_blank", "noopener");
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
          <CardTitle>A &quot;Chat with us&quot; page</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            One page, every app. A <b>Chat with us</b> button in a monday app view links to it with{" "}
            <code>?app=</code> naming the app, so someone arriving from inside VLOOKUP is attributed to
            VLOOKUP without being asked — and the same page works as the site&apos;s own support page.
            It keeps the conversation across a refresh, because the session is stored on that domain.
          </p>
          <Step n={1} title="Make the page, and allow it">
            <p className="text-sm text-muted-foreground">
              Any page will do — the chat fills the block you give it. Add its address to{" "}
              <b>Sites allowed to embed the chat</b> in Settings, the same as any other embed.
            </p>
          </Step>
          <Step n={2} title="Paste this into the page content">
            <Snippet code={chatPageSnippet} />
            <p className="text-[11px] text-muted-foreground">
              No launcher, no badge, always open — on a page whose only job is the chat, a bubble is
              furniture in front of the one thing there. Adjust the <code>height</code> to taste.
            </p>
            <p className="text-[11px] text-muted-foreground">
              <b>Use the container, not <code>inline: true</code>.</b> Filling the window means covering
              the site&apos;s own header and nav, which reads as the site having broken. If the page also
              carries the site-wide script from above, that&apos;s fine: the loader refuses to run twice
              and this one goes first. If it carries a <em>different</em> chat widget, delete that script
              — two widgets is two conversations, and the visitor cannot tell which one anybody is
              reading.
            </p>
          </Step>
          <Step n={3} title="Point each app at it">
            <Snippet code={chatPageLink} />
            <p className="text-[11px] text-muted-foreground">
              Swap the page address for yours and the <code>app</code> value per app. Spell the key
              exactly — anything unrecognised is dropped and the chat runs unattributed, which costs you
              the per-app filter in <b>Chats</b> and the app breakdown on <b>Today</b>.
            </p>
            <div className="grid gap-x-6 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2">
              {APP_KEYS.map((k) => (
                <div key={k} className="flex items-baseline justify-between gap-2 border-b border-dashed py-0.5">
                  <span>{APP_NAMES[k]}</span>
                  <code>{k}</code>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              <code>getsign</code> also switches the page to the GetSign skin and scopes answers to the
              GetSign knowledge base — the other apps&apos; articles are not retrievable under it.
            </p>
          </Step>

          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">Optional: let Jetta act on the monday account</p>
            <p className="text-sm text-muted-foreground">
              With the link above, Jetta knows which app the visitor came from but not <em>who</em> they
              are — she asks for a name and email in the chat, and confirms the account before raising
              anything against it. Hand over monday&apos;s signed session token and she stops asking.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Use this version of the page snippet instead — same page, same container, it just reads the
              extra parameters:
            </p>
            <Snippet code={chatPageTokenSnippet} />
            <p className="text-[11px] text-muted-foreground">
              And open it from the app view like this, rather than as a plain link:
            </p>
            <Snippet code={supportButtonSnippet} />
            <p className="text-[11px] text-muted-foreground">
              <code>monday.api</code> needs the <code>me:read</code> scope, the same one the in-view embed
              uses. Then set <code>MONDAY_CLIENT_SECRET_VLOOKUP</code> — and the same for every other app
              whose button you wire up — from that app&apos;s monday developer page. Without the secret the
              token cannot be checked and nothing breaks: the chat simply starts anonymous again, with no
              account attached.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Why a token rather than just putting the account slug in the link: Jetta uses that slug to
              raise trial and discount requests <em>without asking</em>. On a link anyone can edit, that
              would let one customer ask for a discount on another&apos;s account. A verified token is
              monday saying who this is; an unverified slug is shown to her as a claim, with an
              instruction to confirm it before acting.
            </p>
          </div>
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
            <b>The bottom-right corner is already monday&apos;s.</b> Their AI sidekick is a floating circle
            there at the same size, so <code>surface: &quot;monday&quot;</code> anchors the launcher{" "}
            <b>bottom-left</b> by default, flush with the usual <code>20px</code> edge. A launcher sent back
            to the right — by a <code>launcher: {"{ position: \"right\" }"}</code> override or the side set in
            Settings — is lifted <code>88px</code> to stack above the sidekick instead of under it. The embed
            override outranks Settings, which is per brand and would move the website too. z-index is no
            help — the widget is in an iframe, so it can never stack above monday&apos;s own floating buttons.
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
            <p className="font-medium">The &quot;Chat with us&quot; page shows a launcher instead of the chat</p>
            <p className="text-muted-foreground">
              The selector matched nothing, so it fell back to the corner widget rather than leaving the
              page empty. The <code>&lt;div id=&quot;jetta-chat&quot;&gt;</code> is missing — some editors
              strip an empty div on save. Give it a non-breaking space, or use a block that preserves raw
              HTML.
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
