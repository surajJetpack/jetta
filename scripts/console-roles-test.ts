/**
 * Who may call each console API route — checked against the routes themselves,
 * without a network or a model.
 *
 *   npx tsx scripts/console-roles-test.ts
 *
 * lib/roles.ts says the permission lives in the endpoint, not in a hidden
 * button. Nothing checked that it did: archiving an article was admin-only in
 * one route while three others deleted the same article for anyone signed in,
 * and "wipe every chat" and "run Jetta live on a ticket" were open to every
 * login. About fifteen route headers said "admin-gated" and meant "any login".
 *
 * So the table below is the answer, per route and method, and this script
 * holds the routes to it three ways:
 *   1. every route file under app/api/admin must be in the table, method for
 *      method — a new route cannot ship without someone deciding who may call it;
 *   2. with no session, every method answers 401;
 *   3. signed in as a general user, every "admin" method answers 403 — before
 *      doing anything, which is why it is safe to call them here.
 * "login" methods are not called as a general user: they would do their job.
 * The conditional ones (admin for some inputs) are exercised case by case.
 */
export {};

import fs from "node:fs";
import path from "node:path";

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
process.env.CONSOLE_USERS = "boss:pw-boss,agent:pw-agent";
process.env.CONSOLE_ADMINS = "boss";
process.env.SESSION_SECRET = "roles-test-secret-do-not-use-in-prod";
for (const v of [
  "ADMIN_SECRET",
  "CONSOLE_ASSISTANT_USERS",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_URL",
  "UPSTASH_VECTOR_REST_URL",
  "UPSTASH_VECTOR_REST_TOKEN",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  delete process.env[v];
}

type Need = "login" | "admin" | "assistant" | "conditional";

/** route (under app/api/admin) → method → who may call it. */
const ROLES: Record<string, Record<string, Need>> = {
  "activity": { GET: "admin", POST: "admin" },
  "assistant/session": { POST: "assistant" },
  "assistant/tool": { POST: "assistant" },
  "attention": { GET: "login" },
  "chat-settings": { GET: "login", POST: "admin" },
  // DELETE wipes every conversation and attachment.
  "chats": { GET: "login", POST: "login", DELETE: "admin" },
  "daily": { GET: "login", POST: "login" },
  "data-version": { GET: "login" },
  "dev-board": { GET: "admin", POST: "admin" },
  "dev-board/insight": { GET: "admin" },
  "dev-board/kb": { POST: "admin" },
  "drafts": { GET: "login", POST: "login" },
  "error-watch": { GET: "admin", POST: "admin" },
  "error-watch/insight": { GET: "admin" },
  "evals": { GET: "login" },
  "evals/distill": { POST: "login" },
  "evals/mine-human-replies": { POST: "login" },
  // Sign-in attempts with IPs, and assistant tool arguments.
  "events": { GET: "admin" },
  "kb": { GET: "login", POST: "login", PUT: "login", DELETE: "conditional" }, // admin unless a draft
  "kb/audit": { GET: "login" },
  "kb/bulk": { POST: "conditional" }, // admin to archive, or to delete anything live
  "kb/drafts": { GET: "login", POST: "login" }, // reject only ever deletes a draft
  "kb/freshdesk": { GET: "login", PUT: "login", POST: "login" },
  "kb/search": { GET: "login" },
  "kb/state": { POST: "conditional" }, // admin to archive
  "kb/versions": { GET: "login", POST: "login" },
  "learnings": { GET: "login", POST: "admin" },
  "logs": { GET: "login" },
  "monetization": { GET: "login", POST: "login" },
  "performance": { GET: "admin", POST: "admin" },
  "performance/insight": { GET: "admin" },
  "run": { POST: "conditional" }, // admin for a live run
  "self-review": { GET: "admin", POST: "admin" },
  "stats": { GET: "login" },
  "support-health": { GET: "login", POST: "login" },
  "support-health/insight": { GET: "login" },
  "today": { GET: "login" },
  "today/insight": { GET: "login" },
};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  if (!ok || process.argv.includes("--verbose")) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
  }
}
const section = (name: string) => console.log(`\n── ${name} ──`);

const ROOT = path.join(__dirname, "..", "app", "api", "admin");
function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : [],
  );
}

type Handler = (req: unknown) => Promise<Response>;

async function main() {
  const { NextRequest } = await import("next/server");
  const { createSession, SESSION_COOKIE } = await import("../lib/console-auth");
  const cookies = { boss: createSession("boss"), agent: createSession("agent") };

  const request = (who: "boss" | "agent" | null, method: string, url: string, body?: unknown) =>
    new NextRequest(`https://jetta.test${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(who ? { cookie: `${SESSION_COOKIE}=${cookies[who]}` } : {}),
      },
      ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });

  section("Every route is in the table, and the table matches the routes");
  const found = new Map<string, Record<string, Handler>>();
  for (const file of routeFiles(ROOT)) {
    const key = path.relative(ROOT, path.dirname(file)).split(path.sep).join("/");
    const mod = (await import(file)) as Record<string, unknown>;
    const methods = Object.fromEntries(
      Object.entries(mod).filter(([k, v]) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k) && typeof v === "function"),
    ) as Record<string, Handler>;
    found.set(key, methods);
    const want = ROLES[key];
    check(`/api/admin/${key} is in the table`, !!want, "add it to ROLES and decide who may call it");
    if (!want) continue;
    check(
      `/api/admin/${key} methods match`,
      Object.keys(methods).sort().join() === Object.keys(want).sort().join(),
      `route exports ${Object.keys(methods).sort().join()}, table has ${Object.keys(want).sort().join()}`,
    );
  }
  for (const key of Object.keys(ROLES)) check(`table entry ${key} still has a route`, found.has(key));
  console.log(`  ${found.size} routes, ${[...found.values()].reduce((n, m) => n + Object.keys(m).length, 0)} methods`);

  section("No session → 401, everywhere");
  for (const [key, methods] of found) {
    for (const [method, handler] of Object.entries(methods)) {
      const res = await handler(request(null, method, `/api/admin/${key}`, {}));
      check(`${method} /api/admin/${key}`, res.status === 401, `got ${res.status}`);
    }
  }

  section("General user → 403 on every admin-only method");
  let adminOnly = 0;
  for (const [key, methods] of found) {
    for (const [method, handler] of Object.entries(methods)) {
      const need = ROLES[key]?.[method];
      if (need !== "admin" && need !== "assistant") continue;
      adminOnly++;
      // The wipe is given its real confirmation, so a pass means the role
      // check refused it, not the missing parameter.
      const url = key === "chats" && method === "DELETE" ? "/api/admin/chats?confirm=everything" : `/api/admin/${key}`;
      const res = await handler(request("agent", method, url, {}));
      check(`${method} /api/admin/${key}`, res.status === 403, `got ${res.status}`);
    }
  }
  console.log(`  ${adminOnly} admin-only methods`);

  section("Knowledge base: deleting something live is admin's");
  const kb = await import("../lib/kb-store");
  const make = async (title: string, state: "draft" | "published" | "archived") => {
    const a = await kb.createArticle({ title, body: `${title} body, long enough to be an article.`, origin: "manual", state: "draft", createdBy: "test" } as never, { checkDuplicates: false });
    if (state !== "draft") await kb.transitionState(a.id, "published", "test");
    if (state === "archived") await kb.transitionState(a.id, "archived", "test");
    return a.id;
  };
  const exists = async (id: string) => !!(await kb.getArticle(id));
  const drafts = found.get("kb/drafts")!;
  const bulk = found.get("kb/bulk")!;
  const kbRoute = found.get("kb")!;
  const state = found.get("kb/state")!;

  const live1 = await make("Live one", "published");
  let res = await drafts.POST(request("agent", "POST", "/api/admin/kb/drafts", { id: live1, action: "reject" }));
  check("\"reject\" on a published article is refused, for anyone", res.status === 409 && (await exists(live1)), `got ${res.status}`);
  res = await drafts.POST(request("boss", "POST", "/api/admin/kb/drafts", { id: live1, action: "reject" }));
  check("…an admin included: the queue only deletes drafts", res.status === 409 && (await exists(live1)), `got ${res.status}`);
  const draft1 = await make("Draft one", "draft");
  res = await drafts.POST(request("agent", "POST", "/api/admin/kb/drafts", { id: draft1, action: "reject" }));
  check("a general user can reject a draft", res.status === 200 && !(await exists(draft1)), `got ${res.status}`);

  res = await kbRoute.DELETE(request("agent", "DELETE", `/api/admin/kb?id=${live1}`));
  check("DELETE of a published article: general user gets 403", res.status === 403 && (await exists(live1)), `got ${res.status}`);
  const arch1 = await make("Archived one", "archived");
  res = await kbRoute.DELETE(request("agent", "DELETE", `/api/admin/kb?id=${arch1}`));
  check("DELETE of an archived article: general user gets 403", res.status === 403 && (await exists(arch1)), `got ${res.status}`);
  const draft2 = await make("Draft two", "draft");
  res = await kbRoute.DELETE(request("agent", "DELETE", `/api/admin/kb?id=${draft2}`));
  check("DELETE of a draft: general user may", res.status === 200 && !(await exists(draft2)), `got ${res.status}`);
  res = await kbRoute.DELETE(request("boss", "DELETE", `/api/admin/kb?id=${arch1}`));
  check("DELETE of an archived article: admin may", res.status === 200 && !(await exists(arch1)), `got ${res.status}`);

  res = await bulk.POST(request("agent", "POST", "/api/admin/kb/bulk", { ids: [live1], action: "archive" }));
  check("bulk archive: general user gets 403", res.status === 403 && (await kb.getArticle(live1))?.state === "published", `got ${res.status}`);
  res = await state.POST(request("agent", "POST", "/api/admin/kb/state", { id: live1, to: "archived" }));
  check("single archive: general user gets 403 (unchanged)", res.status === 403, `got ${res.status}`);
  const draft3 = await make("Draft three", "draft");
  res = await bulk.POST(request("agent", "POST", "/api/admin/kb/bulk", { ids: [live1, draft3], action: "delete" }));
  const bulkBody = (await res.json()) as { ok: number; failed: { id: string; error: string }[] };
  check(
    "bulk delete as a general user removes the draft and keeps the live article",
    bulkBody.ok === 1 && bulkBody.failed.length === 1 && bulkBody.failed[0].id === live1 && (await exists(live1)) && !(await exists(draft3)),
    JSON.stringify(bulkBody),
  );
  res = await bulk.POST(request("boss", "POST", "/api/admin/kb/bulk", { ids: [live1], action: "delete" }));
  check("bulk delete as admin removes a live article", ((await res.json()) as { ok: number }).ok === 1 && !(await exists(live1)));

  section("Running Jetta live on a ticket is admin's");
  const run = found.get("run")!;
  res = await run.POST(request("agent", "POST", "/api/admin/run", { ticketId: "123", dryRun: false }));
  check("live run: general user gets 403", res.status === 403, `got ${res.status}`);
  res = await run.POST(request("agent", "POST", "/api/admin/run", { ticketId: "", dryRun: true }));
  check("a preview is not refused for its role (400 for the empty ticket id)", res.status === 400, `got ${res.status}`);
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
