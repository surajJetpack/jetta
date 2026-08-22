/**
 * Brand profiles — how one Jetta serves two brands without becoming two bots.
 *
 * A profile bundles the things that should differ between GetSign's own
 * surface and the Jetpack Apps portfolio: which brand Jetta introduces herself
 * as, and which slice of the knowledge base she may retrieve from. Everything
 * else — the agent loop, the tools, the learning loop, the draft review, the
 * analytics — is deliberately shared.
 *
 * THE TWO PROFILES ARE ASYMMETRIC, and that is the whole design:
 *
 *   getsign  — GetSign identity, and a HARD KB filter to GetSign + shared
 *              articles. A visitor on getsign.io asking about parcel tracking
 *              gets "that's a different app", not a TrackMy answer.
 *   main     — unchanged portfolio identity, and NO filter at all. The main
 *              bot keeps answering GetSign questions exactly as it does today.
 *
 * So only one profile narrows anything. That asymmetry is why this is safe to
 * roll out: the main bot's retrieval path is a no-op under `kbScopes: []`.
 *
 * The persona TEXT lives in system-prompt.ts, keyed by `Profile.key` — prompt
 * wording is versioned in one file on purpose, and this module is registry
 * data, not copy.
 */
import { config } from "./config";
import { originAllowed } from "./chat-settings";
import type { Product, ProductSource } from "./types";

export type { ProductSource };

/**
 * Which brand a KB article belongs to. "shared" is the default for anything
 * not obviously one brand's (billing, VAT, refunds, account questions, and
 * every manual or knowledge-loop article) and is visible to BOTH profiles —
 * so mis-tagging costs an article some precision, never its reachability.
 */
export type KbScope = "getsign" | "jetpackapps" | "shared";

export type ProfileKey = "getsign" | "main";

export interface Profile {
  key: ProfileKey;
  /** How Jetta names the thing she supports, in prose. */
  brand: string;
  site: string;
  /** Allowed article scopes. EMPTY MEANS UNFILTERED — the whole index. */
  kbScopes: KbScope[];
  /** Origins that select this profile for a chat visitor. */
  origins: string[];
}

export const GETSIGN_PROFILE: Profile = {
  key: "getsign",
  brand: "GetSign",
  site: "getsign.io",
  kbScopes: ["getsign", "shared"],
  origins: config.getsignOrigins,
};

export const MAIN_PROFILE: Profile = {
  key: "main",
  brand: "Jetpack Apps",
  site: "jetpackapps.io",
  // Not ["getsign","jetpackapps","shared"]: an empty list means "no filter",
  // which also covers articles that predate tagging or were never tagged. A
  // list that happens to name every scope would silently drop those.
  kbScopes: [],
  origins: [],
};

/**
 * The narrow profile activates on ground truth ONLY (see `ProductSource` in
 * types.ts) — a product that came from the keyword heuristic or the LLM triage
 * keeps the full corpus, because a mis-attributed ticket should lose branding,
 * never lose the article that answers it.
 */
export function profileFor(product: Product, source: ProductSource = "inferred"): Profile {
  return product === "getsign" && source === "ground-truth" ? GETSIGN_PROFILE : MAIN_PROFILE;
}

/**
 * Does this origin belong to the brand?
 *
 * Two ways to qualify, and BOTH are needed.
 *
 *   1. The configured list (JETTA_GETSIGN_ORIGINS). A brand may be served from
 *      a domain that has nothing to do with `site` — a campaign landing page, a
 *      partner's host — and only a human can say so.
 *   2. `site` itself, or any subdomain of it. This is the half that was
 *      missing, and it cost us: the widget was installed on staging.getsign.io
 *      while the configured list named only the apex and www, so the loader
 *      called the visitor GetSign (its hostname regex has always matched
 *      subdomains) and the server called them Jetpack Apps. One question, two
 *      answers, and the disagreement was invisible until a setting depended on
 *      it.
 *
 * Widening this is safe in the direction that matters: a GetSign visitor gets
 * a NARROWER knowledge base, never a wider one (see `kbScopes` above), and who
 * may embed the chat at all is a separate list enforced by lib/chat-http.ts.
 * The worst case of a false positive here is a visitor being told about the
 * wrong sibling app; the worst case of a false negative is what we just had.
 */
function originIsBrand(origin: string, profile: Profile): boolean {
  const clean = origin.replace(/\/$/, "");
  if (originAllowed(clean, profile.origins)) return true;
  let host: string;
  let scheme: string;
  try {
    const u = new URL(clean);
    host = u.hostname.toLowerCase();
    scheme = u.protocol;
  } catch {
    return false;
  }
  // https only. A brand's own site is served over TLS, and an http origin
  // claiming to be one is not something to hand a brand identity to.
  if (scheme !== "https:") return false;
  const site = profile.site.toLowerCase();
  return host === site || host.endsWith(`.${site}`);
}

/** The profile a chat visitor gets, from the page the widget is embedded on. */
export function profileForOrigin(origin: string | null | undefined): Profile {
  if (!origin) return MAIN_PROFILE;
  return originIsBrand(origin, GETSIGN_PROFILE) ? GETSIGN_PROFILE : MAIN_PROFILE;
}

/**
 * Which brand skin a stored chat conversation was seen under. The console
 * needs this to show the same Jetta avatar the visitor saw. Same precedence
 * as `profileForRequest`: the ground-truth app signal wins, then the
 * embedding page's origin — computed server-side because origin matching
 * reads env config, so API/page responses annotate conversations with it
 * rather than the client re-deriving (and drifting from) the rule.
 */
export function chatBrandKey(c: { pageUrl?: string; visitor?: { app?: string } }): ProfileKey {
  if (c.visitor?.app === "getsign") return "getsign";
  try {
    return profileForOrigin(c.pageUrl ? new URL(c.pageUrl).origin : null).key;
  } catch {
    return MAIN_PROFILE.key;
  }
}

/**
 * The profile for a widget request — the ONE place that answers it.
 *
 * An explicit `?product=` wins, then the embedding origin. Both public chat
 * routes go through here rather than each spelling the rule out, because when
 * they spelled it out separately they disagreed: /api/chat/config honoured the
 * parameter and /api/chat/session did not, so a brand that turned the identity
 * gate off got a widget that hid the form and a server that then refused the
 * session for not filling it in.
 *
 * The parameter grants nothing — it only ever picks a skin and NARROWS the
 * knowledge base — so taking it from the query string is safe.
 */
export function profileForRequest(
  product: string | null | undefined,
  origin: string | null | undefined,
): Profile {
  return product === "getsign" ? GETSIGN_PROFILE : profileForOrigin(origin);
}

/**
 * Reporting filter: does this record belong to the named brand?
 *
 * EXCLUSIVE, unlike retrieval scope — and deliberately so. Retrieval asks
 * "what may this Jetta read?", where sharing an article with both brands is
 * the safe answer. A dashboard asks "which brand is having a bad week?", and a
 * GetSign spike hidden inside a Jetpack Apps bar answers nobody.
 *
 * Records attributed to neither ("unknown" — pure billing, legal, an empty
 * ticket) fall out of both filters rather than being assigned to one.
 */
export function matchesBrand(
  rec: { product?: string | null; app?: string | null },
  brand: "getsign" | "jetpackapps",
): boolean {
  const app = rec.app ?? "";
  if (brand === "getsign") return rec.product === "getsign" || app === "getsign";
  if (rec.product === "getsign" || app === "getsign") return false;
  return rec.product === "jetpackapps" || (!!app && app !== "unknown");
}

/** Profile by its own key — for the settings overlay and the console. */
export function profileByKey(key: string | null | undefined): Profile {
  return key === "getsign" ? GETSIGN_PROFILE : MAIN_PROFILE;
}
