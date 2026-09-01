/**
 * Verify a monday session token — the JWT a monday app view can hand out with
 * `monday.get("sessionToken")`.
 *
 * WHY THIS EXISTS. A support page opened from a button inside a monday app is
 * a public URL, so anything it carries in its query string is typed by whoever
 * is holding it. That is fine for a name and an email, which are already no
 * better than what someone types into the chat — and not fine for the monday
 * account slug, which the system prompt tells Jetta to act on:
 *
 *   "monday account: acme (…use it directly for trial/discount requests…)"
 *
 * Unsigned, that sentence lets a visitor name somebody else's account and have
 * Jetta raise a discount request against it. Signed, it is monday itself
 * saying who this is.
 *
 * WHAT IT PROVES. The token is signed by monday with the app's own client
 * secret, and its `dat` claim carries `account_id`, `user_id`, `slug` and
 * `app_id`. So a verified token settles the account AND which app the visitor
 * came from — the two things a URL cannot be trusted for. It does NOT carry a
 * name or an email; those stay hints, and Jetta still asks.
 *
 * Verified here rather than with a library: this is one HMAC and three field
 * reads, and `jsonwebtoken` is not a dependency of this project.
 *
 * Docs: https://developer.monday.com/apps/docs/mondayget
 */
import crypto from "node:crypto";
import { config } from "./config";
import { APP_NAMES, type AppProduct } from "./types";

/** What monday tells us about the visitor, once the signature checks out. */
export interface MondaySessionClaims {
  /** Which app's secret verified the token — attribution we did not have to guess. */
  app: AppProduct;
  accountId?: string;
  accountSlug?: string;
  userId?: string;
}

interface TokenPayload {
  exp?: number;
  dat?: {
    account_id?: number | string;
    user_id?: number | string;
    slug?: string;
    app_id?: number | string;
  };
}

function b64urlToBuffer(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Constant-time compare of two signatures. Length is checked first because
 * `timingSafeEqual` throws on a mismatch rather than returning false.
 */
function signatureMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Verify `token` against every monday app whose client secret is configured.
 *
 * Returns null for anything that does not check out — a bad signature, an
 * expired token, an app we hold no secret for, or plain rubbish. Callers treat
 * null as "no verified identity" and carry on anonymously; a support page must
 * still open for someone whose token has aged out while they read the docs.
 */
export function verifyMondaySessionToken(token: string | undefined | null): MondaySessionClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  // Reject anything but HS256 before touching the payload — "none" is the
  // classic JWT forgery, and it is refused here rather than by omission.
  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8")) as { alg?: string };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const signed = `${parts[0]}.${parts[1]}`;
  const provided = b64urlToBuffer(parts[2]);

  for (const [app, secret] of Object.entries(config.monday.appClientSecrets)) {
    if (!secret) continue;
    const expected = crypto.createHmac("sha256", secret).update(signed).digest();
    if (!signatureMatches(expected, provided)) continue;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(b64urlToBuffer(parts[1]).toString("utf8")) as TokenPayload;
    } catch {
      return null;
    }
    // monday's tokens are short-lived by design. An expired one is not an
    // attack, it is someone who left the tab open — so it fails closed and
    // silently, the same as no token at all.
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;

    const dat = payload.dat ?? {};
    return {
      app: app as AppProduct,
      accountId: dat.account_id != null ? String(dat.account_id) : undefined,
      accountSlug: typeof dat.slug === "string" && dat.slug ? dat.slug : undefined,
      userId: dat.user_id != null ? String(dat.user_id) : undefined,
    };
  }
  return null;
}

/** Apps a session token can currently be verified for — for /system and the docs. */
export function appsWithSessionSecrets(): string[] {
  return Object.entries(config.monday.appClientSecrets)
    .filter(([, secret]) => !!secret)
    .map(([app]) => APP_NAMES[app] ?? app);
}
