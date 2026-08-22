/**
 * The GetSign profile's contract, pinned.
 *
 * The whole design is an ASYMMETRY that is easy to break by accident: GetSign's
 * surface is narrowed to GetSign + shared articles, and the portfolio bot is
 * narrowed by nothing at all — it keeps answering GetSign questions exactly as
 * it did before any of this existed. A change that "tidies up" the empty scope
 * list into an explicit three-brand list, or that lets an LLM-guessed product
 * select the narrow profile, would pass every other check in the repo.
 *
 *   npx tsx scripts/getsign-profile-test.ts
 *
 * Runs fully offline: STUB_MODE seeds the in-memory KB from the GetSign corpus,
 * so the retrieval assertions need no Redis, no vector index, and no API keys.
 */
export {};

import { readFileSync } from "node:fs";

process.env.STUB_MODE = "true";
process.env.JETTA_KB_SCOPE = "true";
process.env.JETTACHAT_ALLOWED_ORIGINS = "https://getsign.io,https://jetpackapps.io";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  const { profileFor, profileForOrigin, profileForRequest, GETSIGN_PROFILE, MAIN_PROFILE } =
    await import("../lib/profiles");
  const { searchPublishedKb, deriveScope, scopeOf } = await import("../lib/kb-store");
  const { publicSettings, defaultSettings, overrideCount } = await import("../lib/chat-settings");
  const { buildSystemPrompt } = await import("../lib/system-prompt");

  // ── Profile selection ──────────────────────────────────────────────
  check(
    "cf_product=getsign selects the GetSign profile",
    profileFor("getsign", "ground-truth").key === "getsign",
  );
  check(
    "GUESSED getsign keeps the full corpus",
    profileFor("getsign", "inferred").key === "main",
    "an LLM guess must never narrow retrieval",
  );
  check("jetpackapps selects the main profile", profileFor("jetpackapps", "ground-truth").key === "main");
  check("unknown selects the main profile", profileFor("unknown", "ground-truth").key === "main");
  check("getsign.io origin selects the GetSign profile", profileForOrigin("https://getsign.io").key === "getsign");
  check("another origin does not", profileForOrigin("https://jetpackapps.io").key === "main");
  check("no origin does not", profileForOrigin(null).key === "main");

  /*
   * Subdomains. The regression that started this: the widget was installed on
   * staging.getsign.io, the configured origin list named only the apex and
   * www, and so the loader called the visitor GetSign while the server called
   * them Jetpack Apps. Everything configured on the GetSign skin page stopped
   * at the door.
   */
  check(
    "a subdomain of the brand's site is the brand",
    profileForOrigin("https://staging.getsign.io").key === "getsign",
    "this is the case that shipped broken",
  );
  check("so is a deeper one", profileForOrigin("https://a.b.getsign.io").key === "getsign");
  check("a trailing slash does not defeat it", profileForOrigin("https://staging.getsign.io/").key === "getsign");
  check(
    "a lookalike suffix is NOT the brand",
    profileForOrigin("https://notgetsign.io").key === "main",
    "endsWith without the dot would match this",
  );
  check("and neither is a domain that merely contains it", profileForOrigin("https://getsign.io.evil.com").key === "main");
  check(
    "http is refused even on the right host",
    profileForOrigin("http://getsign.io").key === "main",
    "a brand identity is not handed out over plaintext",
  );
  check("garbage is not an origin", profileForOrigin("not-a-url").key === "main");

  // ── One resolver, both public routes ───────────────────────────────
  check(
    "an explicit product wins over the origin",
    profileForRequest("getsign", "https://jetpackapps.io").key === "getsign",
  );
  check(
    "no product falls back to the origin",
    profileForRequest(null, "https://staging.getsign.io").key === "getsign",
  );
  check(
    "an unknown product does not select GetSign by itself",
    profileForRequest("trackmy", "https://jetpackapps.io").key === "main",
  );

  // The asymmetry itself.
  check(
    "GetSign profile is scoped to getsign + shared",
    JSON.stringify(GETSIGN_PROFILE.kbScopes) === JSON.stringify(["getsign", "shared"]),
  );
  check(
    "main profile is scoped to NOTHING (unfiltered)",
    MAIN_PROFILE.kbScopes.length === 0,
    "an explicit all-brands list would silently drop untagged articles",
  );

  // ── Scope derivation ───────────────────────────────────────────────
  check("crawled getsign.io → getsign", deriveScope("seed-getsign", "getsign.io") === "getsign");
  check("crawled jetpackapps.io → jetpackapps", deriveScope("seed-jetpackapps", "jetpackapps.io") === "jetpackapps");
  check("a manual article → shared", deriveScope("manual", "managed") === "shared");
  check(
    "an untagged article still resolves",
    scopeOf({ product: undefined, origin: "seed-getsign", source: "getsign.io" }) === "getsign",
  );
  check(
    "an explicit tag wins over derivation",
    scopeOf({ product: "shared", origin: "seed-getsign", source: "getsign.io" }) === "shared",
  );

  // ── Retrieval ──────────────────────────────────────────────────────
  // The seeded corpus is GetSign's, so a GetSign-scoped search must still find
  // things and an all-but-GetSign search must find none of them.
  const unscoped = await searchPublishedKb("signature template", 5);
  const asGetsign = await searchPublishedKb("signature template", 5, GETSIGN_PROFILE.kbScopes);
  const asOther = await searchPublishedKb("signature template", 5, ["jetpackapps"]);
  check("unscoped search finds the GetSign corpus", unscoped.length > 0, `${unscoped.length} hits`);
  check("GetSign scope keeps its own articles", asGetsign.length === unscoped.length, `${asGetsign.length} hits`);
  check(
    "a jetpackapps-only scope cannot see them",
    asOther.length === 0,
    `${asOther.length} GetSign articles leaked into a jetpackapps-scoped search`,
  );

  // ── Widget skin ────────────────────────────────────────────────────
  const settings = {
    ...defaultSettings(),
    title: "Jetta",
    subtitle: "Jetpack Apps support",
    requireIdentity: true,
    autoOpenSeconds: 20,
    profiles: { getsign: { title: "GetSign", subtitle: "" } },
  };
  check("default surface keeps the base skin", publicSettings(settings).title === "Jetta");
  check("GetSign surface takes the override", publicSettings(settings, "getsign").title === "GetSign");
  check(
    "an empty override inherits rather than blanking",
    publicSettings(settings, "getsign").subtitle === "Jetpack Apps support",
  );
  check("an override count reflects what is actually set", overrideCount(settings, "getsign") === 1);
  check("a brand with no overlay counts zero", overrideCount(defaultSettings(), "getsign") === 0);

  // The two settings a brand is most likely to want OFF are the two a falsy
  // check would silently refuse to store. Pin both directions.
  const offs = {
    ...settings,
    profiles: { getsign: { requireIdentity: false, autoOpenSeconds: 0 } },
  };
  check(
    "requireIdentity: false overrides rather than inheriting true",
    publicSettings(offs, "getsign").requireIdentity === false,
  );
  check(
    "autoOpenSeconds: 0 overrides rather than inheriting 20",
    publicSettings(offs, "getsign").autoOpenSeconds === 0,
  );
  check(
    "the default surface is untouched by either",
    publicSettings(offs).requireIdentity === true && publicSettings(offs).autoOpenSeconds === 20,
  );
  check("false and 0 both count as overrides", overrideCount(offs, "getsign") === 2);

  // The session route ENFORCES the identity gate; the widget draws it from the
  // config route. Both must resolve through the same brand profile, or a
  // GetSign visitor is shown no form and then refused by the server.
  //
  // Checked against the route's source rather than by calling it: the overlay
  // only exists once settings have been SAVED, and saving is a no-op without
  // KV — so an in-process call would pass on defaults whichever value the
  // route read. A source check has no such blind spot, and this is exactly the
  // regression an innocent "simplify" would reintroduce.
  // The session route no longer gates on identity at all (anonymous starts
  // are allowed; Jetta collects identity in-chat). The per-brand resolution
  // moved to buildContext, which must go through the conversation's own brand
  // — not the global value — when deciding whether she has to ask.
  const routeSrc = readFileSync(new URL("../app/api/chat/session/route.ts", import.meta.url), "utf8");
  check(
    "the session route no longer refuses anonymous starts",
    !routeSrc.includes("name_and_email_required"),
    "anonymous sessions must be accepted; identity is collected in-chat",
  );
  const contextSrc = readFileSync(new URL("../lib/context.ts", import.meta.url), "utf8");
  check(
    "needsIdentity resolves through the conversation's brand",
    /publicSettings\(chatSettings, chatBrandKey\(chatConv\)\)\.requireIdentity/.test(contextSrc),
    "it must not read the global requireIdentity directly",
  );
  const configSrc = readFileSync(new URL("../app/api/chat/config/route.ts", import.meta.url), "utf8");
  /*
   * Both public routes must resolve the profile through the SAME helper. They
   * used to spell the rule out separately, and drifted: config honoured
   * ?product= and session did not, so a brand that turned the identity gate
   * off got a widget that hid the form and a server that then refused the
   * session for not filling it in. Pinned as source checks because the drift
   * is invisible to any test that exercises one route at a time.
   */
  for (const [name, src] of [
    ["session", routeSrc],
    ["config", configSrc],
  ] as const) {
    check(
      `the ${name} route resolves its profile through profileForRequest`,
      /profileForRequest\(\s*req\.nextUrl\.searchParams\.get\("product"\),\s*req\.headers\.get\("origin"\),?\s*\)/.test(src),
      "both routes must answer 'which brand?' the same way",
    );
  }

  // And the widget has to actually SEND the product on the session call, or
  // the route's new parameter is a door nobody knocks on.
  const frameSrc2 = readFileSync(new URL("../app/chat/page.tsx", import.meta.url), "utf8");
  check(
    "the widget sends its brand on the session request",
    /\/api\/chat\/session\$\{brandProduct \? `\?product=\$\{brandProduct\}` : ""\}/.test(frameSrc2),
  );

  // ── Prompt identity ────────────────────────────────────────────────
  const ctx = {
    channel: "jettachat" as const,
    ticket: null,
    account: null,
    relatedDevItems: [],
    appProduct: "getsign" as const,
  };
  const getsignPrompt = await buildSystemPrompt({
    ...ctx,
    product: "getsign",
    productSource: "ground-truth",
  });
  const mainPrompt = await buildSystemPrompt({ ...ctx, product: "jetpackapps" });
  check("GetSign prompt is GetSign-only", getsignPrompt.includes("here for GetSign only"));
  check("GetSign prompt names the brand in context", getsignPrompt.includes("Brand: GetSign"));
  check(
    "portfolio prompt is unchanged",
    mainPrompt.includes("primary support agent for Jetpack Apps") && !mainPrompt.includes("here for GetSign only"),
  );
  check(
    "portfolio prompt still covers GetSign",
    mainPrompt.includes("GetSign (getsign.io"),
    "the main bot answers for every app, GetSign included",
  );

  console.log(failures ? `\n${failures} failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
