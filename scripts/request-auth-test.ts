/**
 * Does every machine-facing route refuse when its secret is missing?
 *
 *   npx tsx scripts/request-auth-test.ts
 *
 * No network, no model. A request that is refused returns before doing any
 * work, so it is safe to send one to every cron and webhook here; nothing is
 * ever sent that should be let through.
 *
 * The failure this guards against is silent by nature: a deployment comes up
 * without a variable, the route's own check says "no secret configured, so
 * allow", and a URL that starts agent runs or posts on monday is open to
 * anyone who guesses it. Four crons, both Freshdesk webhooks, Slack and the
 * retired Freshchat webhook each did that.
 */
export {};

import fs from "node:fs";
import path from "node:path";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
for (const v of [
  "CRON_SECRET",
  "WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "FRESHCHAT_WEBHOOK_PUBLIC_KEY",
  "CONSOLE_USERS",
  "CONSOLE_USERS_EXTRA",
  "ADMIN_SECRET",
  "SESSION_SECRET",
  "VERCEL",
  "VERCEL_ENV",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_URL",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  delete process.env[v];
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  if (!ok || process.argv.includes("--verbose")) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
  }
}
const section = (name: string) => console.log(`\n── ${name} ──`);

/** Run `fn` as if on a Vercel deployment, then put the environment back. */
async function deployed<T>(fn: () => Promise<T> | T): Promise<T> {
  process.env.VERCEL_ENV = "preview";
  try {
    return await fn();
  } finally {
    delete process.env.VERCEL_ENV;
  }
}

type Handler = (req: unknown) => Promise<Response>;

async function main() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../lib/request-auth");
  const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new NextRequest(`https://jetta.test${url}`, init);

  section("The rule itself");
  check("off a deployment, a webhook with no secret configured is accepted", auth.sharedSecretOk(null, undefined));
  check("on a deployment, it is refused", await deployed(() => !auth.sharedSecretOk(null, undefined)));
  check("…whatever the caller sends", await deployed(() => !auth.sharedSecretOk("anything", "")));
  check("VERCEL=1 and NODE_ENV=production count as deployed too", (() => {
    process.env.VERCEL = "1";
    const a = auth.isDeployed();
    delete process.env.VERCEL;
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const b = auth.isDeployed();
    if (prev === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prev;
    return a && b && !auth.isDeployed();
  })());
  check("with a secret, the right value passes", auth.sharedSecretOk("s3cret", "s3cret"));
  check("…a wrong, empty or missing one does not", !auth.sharedSecretOk("s3creT", "s3cret") && !auth.sharedSecretOk("", "s3cret") && !auth.sharedSecretOk(null, "s3cret"));
  check("…and a prefix of it does not", !auth.sharedSecretOk("s3cre", "s3cret"));

  section("Every cron refuses without CRON_SECRET, locally and deployed");
  const cronRoot = path.join(__dirname, "..", "app", "api", "cron");
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")) as { crons: { path: string }[] };
  const crons = fs.readdirSync(cronRoot).filter((d) => fs.existsSync(path.join(cronRoot, d, "route.ts")));
  check(
    "every cron in vercel.json has a route, and every route is scheduled",
    vercel.crons.map((c) => c.path.replace("/api/cron/", "")).sort().join() === [...crons].sort().join(),
    `vercel.json: ${vercel.crons.length}, routes: ${crons.length}`,
  );
  const handlers = new Map<string, Handler>();
  for (const name of crons) {
    const src = fs.readFileSync(path.join(cronRoot, name, "route.ts"), "utf8");
    check(`${name} uses the shared check`, /cronAuthorized\(req\)/.test(src) && !/function authorized\(/.test(src) && !/process\.env\.CRON_SECRET/.test(src));
    handlers.set(name, ((await import(path.join(cronRoot, name, "route.ts"))) as { GET: Handler }).GET);
  }
  for (const [name, GET] of handlers) {
    const local = await GET(req(`/api/cron/${name}`));
    check(`${name}: no secret configured, local → 401`, local.status === 401, `got ${local.status}`);
    const onVercel = await deployed(() => GET(req(`/api/cron/${name}`, { headers: { authorization: "Bearer " } })));
    check(`${name}: no secret configured, deployed → 401`, onVercel.status === 401, `got ${onVercel.status}`);
  }
  process.env.CRON_SECRET = "cron-test-secret";
  for (const [name, GET] of handlers) {
    const wrong = await GET(req(`/api/cron/${name}`, { headers: { authorization: "Bearer cron-test-secreT" } }));
    const bare = await GET(req(`/api/cron/${name}`, { headers: { authorization: "cron-test-secret" } }));
    const none = await GET(req(`/api/cron/${name}`));
    check(`${name}: wrong, unprefixed or absent bearer → 401`, wrong.status === 401 && bare.status === 401 && none.status === 401, `${wrong.status} ${bare.status} ${none.status}`);
  }
  check("the right bearer is accepted by the check", auth.cronAuthorized(req("/x", { headers: { authorization: "Bearer cron-test-secret" } })));
  delete process.env.CRON_SECRET;
  console.log(`  ${handlers.size} cron routes`);

  section("Webhooks, Slack and Freshchat refuse an unconfigured deployment");
  const post = (url: string, headers: Record<string, string> = {}) =>
    req(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ticket_id: "1" }) });
  const webhook = (await import("../app/api/webhook/route")) as unknown as { POST: Handler };
  const agentReply = (await import("../app/api/webhook/agent-reply/route")) as unknown as { POST: Handler };
  const slack = (await import("../app/api/slack/route")) as unknown as { POST: Handler };
  const freshchat = (await import("../app/api/webhook/freshchat/route")) as unknown as { POST: Handler };
  for (const [name, route, url] of [
    ["Freshdesk webhook", webhook, "/api/webhook"],
    ["agent-reply webhook", agentReply, "/api/webhook/agent-reply"],
    ["Slack", slack, "/api/slack"],
    ["Freshchat webhook", freshchat, "/api/webhook/freshchat"],
  ] as const) {
    const res = await deployed(() => route.POST(post(url, { "x-jetta-secret": "guess", "x-slack-signature": "v0=guess", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-freshchat-signature": "guess" })));
    check(`${name}: no secret configured, deployed → 401`, res.status === 401, `got ${res.status}`);
  }

  section("The console is not open on a deployment with nobody configured");
  const { adminActor } = await import("../lib/auth");
  check("locally, nobody configured → dev-open, as before", adminActor(req("/api/admin/stats") as never) === "dev");
  check("deployed, nobody configured → no access", await deployed(() => adminActor(req("/api/admin/stats") as never) === null));
  const stats = (await import("../app/api/admin/stats/route")) as unknown as { GET: Handler };
  const res = await deployed(() => stats.GET(req("/api/admin/stats")));
  check("…and an admin route answers 401", res.status === 401, `got ${res.status}`);
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
