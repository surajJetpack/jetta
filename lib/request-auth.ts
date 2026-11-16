/**
 * Shared-secret checks for the routes machines call: Vercel Cron, the
 * Freshdesk and Freshchat webhooks, Slack.
 *
 * One rule, in one place: A MISSING SECRET IS A REFUSAL. Each route used to
 * carry its own copy of the check, and they disagreed — ten crons refused when
 * CRON_SECRET was unset, four let anyone in, one decided by NODE_ENV; the
 * webhooks, Slack and Freshchat all allowed an unset secret "for local stub
 * testing". The four open crons included the two that start agent runs and
 * post on monday. A deployment that came up without a variable (a new preview
 * environment, a renamed secret) was therefore open to the internet, silently.
 *
 * The one allowance left is a developer's own machine: when this is not a
 * deployment at all, a webhook with no secret configured is accepted, so the
 * stub flow still works with an empty .env. Crons get no such allowance — they
 * already refused locally in ten of fifteen routes, and a cron is never
 * something a browser needs to hit.
 *
 * No imports from the rest of lib: this is loaded by every route above.
 */
import crypto from "node:crypto";

/** Running as a deployment (Vercel sets VERCEL_ENV), or as a production build. */
export function isDeployed(): boolean {
  return !!process.env.VERCEL_ENV || !!process.env.VERCEL || process.env.NODE_ENV === "production";
}

/** Constant-time string compare. Hashing first makes the lengths equal. */
export function secretsMatch(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Is `provided` the configured shared secret?
 * No secret configured → refused when deployed, accepted on a developer's machine.
 */
export function sharedSecretOk(provided: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret) return !isDeployed();
  return !!provided && secretsMatch(provided, secret);
}

/**
 * May a request with NO secret configured through? Only off a deployment. For
 * checks that are more than a compare (Slack's signed body, Freshchat's RSA
 * signature) and so cannot use `sharedSecretOk`.
 */
export function allowUnconfigured(): boolean {
  return !isDeployed();
}

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. No secret, no entry
 * — anywhere, including locally.
 */
export function cronAuthorized(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && secretsMatch(header.slice(7), secret);
}
