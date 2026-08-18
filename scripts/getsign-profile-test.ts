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

process.env.STUB_MODE = "true";
process.env.JETTA_KB_SCOPE = "true";
process.env.JETTACHAT_ALLOWED_ORIGINS = "https://getsign.io,https://jetpackapps.io";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  const { profileFor, profileForOrigin, GETSIGN_PROFILE, MAIN_PROFILE } = await import("../lib/profiles");
  const { searchPublishedKb, deriveScope, scopeOf } = await import("../lib/kb-store");
  const { publicSettings, defaultSettings } = await import("../lib/chat-settings");
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
    profiles: { getsign: { title: "GetSign", subtitle: "" } },
  };
  check("default surface keeps the base skin", publicSettings(settings).title === "Jetta");
  check("GetSign surface takes the override", publicSettings(settings, "getsign").title === "GetSign");
  check(
    "an empty override inherits rather than blanking",
    publicSettings(settings, "getsign").subtitle === "Jetpack Apps support",
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
