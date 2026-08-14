/**
 * JettaChat settings — the knobs that can be turned without a deploy.
 *
 * Precedence is stored value → env var → built-in default. That ordering is
 * what makes this safe to add to a channel already carrying live traffic:
 * nothing changes until someone deliberately overrides a field, and the env
 * vars keep working as they always did.
 *
 * TWO THINGS STAY OUT OF HERE ON PURPOSE.
 *
 *   JETTACHAT_SECRET — the HMAC key behind every visitor's conversation token.
 *   A console that can display or rotate it is a liability, and rotating it
 *   would silently invalidate every live visitor's session.
 *
 *   JETTACHAT_LIVE — the master kill switch. `enabled` below is a soft switch
 *   ANDed with it, so a console mistake can turn the channel off but never on.
 *
 * The public/private split is enforced by `publicSettings()` rather than by
 * convention: the widget needs the copy and colours before a conversation
 * exists, so that subset is served unauthenticated. Anything not named there
 * — origins, limits, retention — never leaves the server.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { logOpsEvent } from "./events";

const KEY = "jetta:chat:settings";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

export interface ChatSettings {
  // ── public: the widget reads these before any conversation exists ──
  title: string;
  subtitle: string;
  greeting: string;
  placeholder: string;
  accentColor: string;
  launcherLabel: string;
  launcherPosition: "left" | "right";
  /**
   * Bot avatar, as a data URI. Stored inline rather than in blob storage: an
   * avatar is a few kB, this document is already read on every chat request,
   * and it avoids standing up a bucket for one image. Capped on save so it
   * cannot grow into something that belongs in a CDN.
   */
  avatarUrl?: string;
  /** Ask for name and email before the first message. */
  requireIdentity: boolean;

  // ── private: server-side only ──
  /** Soft kill switch. ANDed with JETTACHAT_LIVE — can disable, never enable. */
  enabled: boolean;
  /** Origins allowed to embed the widget. Empty means same-origin only. */
  allowedOrigins: string[];
  /** Wait this long after the newest message so a three-part thought gets one answer. */
  debounceSeconds: number;
  rateLimitPerHour: number;
  retentionDays: number;
  /** Whether Jetta may hand a live conversation to a person at all. */
  handoffEnabled: boolean;
  /** How long a visitor waits before Jetta takes the conversation back. */
  handoffTimeoutMinutes: number;
  /** Slack channel for "a visitor wants a human". Falls back to the escalation channel. */
  handoffChannel?: string;

  updatedAt?: number;
  updatedBy?: string;
}

/** Exactly the fields the unauthenticated widget endpoint may return. */
const PUBLIC_FIELDS = [
  "title",
  "subtitle",
  "greeting",
  "placeholder",
  "accentColor",
  "launcherLabel",
  "launcherPosition",
  "avatarUrl",
  "requireIdentity",
] as const;

export type PublicChatSettings = Pick<ChatSettings, (typeof PUBLIC_FIELDS)[number]>;

/**
 * Does this origin match an allowlist entry?
 *
 * Exact match, plus one wildcard form: `https://*.monday.com` matches any
 * single-level subdomain. monday app views are served from hosts we do not
 * control the naming of, so without this the only workable answer is listing
 * them one by one and discovering each miss as a silently broken widget.
 *
 * Deliberately narrow: the wildcard must be the leading label and at least two
 * labels must follow, so `https://*.com` can never be entered as a rule that
 * lets the whole internet embed the chat.
 */
export function originAllowed(origin: string, allowed: string[]): boolean {
  if (allowed.includes(origin)) return true;
  let host: string;
  let scheme: string;
  try {
    const u = new URL(origin);
    host = u.hostname.toLowerCase();
    scheme = u.protocol;
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    const m = /^(https?:)\/\/\*\.(.+)$/i.exec(entry.trim());
    if (!m) return false;
    const [, entryScheme, base] = m;
    if (entryScheme.toLowerCase() !== scheme) return false;
    const suffix = base.toLowerCase();
    if (suffix.split(".").length < 2) return false; // never "*.com"
    return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
  });
}

export function publicSettings(s: ChatSettings): PublicChatSettings {
  return Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, s[k]])) as PublicChatSettings;
}

/** Env and built-in defaults — the floor everything else is layered onto. */
export function defaultSettings(): ChatSettings {
  return {
    title: "Jetta",
    subtitle: "Jetpack Apps support",
    greeting: "Hi! Ask me anything about your apps, your account, or a problem you're hitting.",
    placeholder: "Type your message…",
    accentColor: "#171717",
    launcherLabel: "Chat with us",
    launcherPosition: "right",
    avatarUrl: undefined,
    requireIdentity: true,

    enabled: true,
    allowedOrigins: config.jettachat.allowedOrigins,
    debounceSeconds: config.jettachat.debounceSeconds,
    rateLimitPerHour: config.jettachat.rateLimitPerHour,
    retentionDays: config.jettachat.retentionDays,
    handoffEnabled: true,
    handoffTimeoutMinutes: 3,
    handoffChannel: undefined,
  };
}

// Read on every public chat request, so it is cached — but briefly, because a
// setting nobody can see take effect is a setting nobody trusts. A write busts
// this process's copy; other serverless instances catch up within the TTL.
const CACHE_MS = 30_000;
let cache: { at: number; value: ChatSettings } | null = null;

export async function getChatSettings(): Promise<ChatSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const defaults = defaultSettings();
  let stored: Partial<ChatSettings> | null = null;
  try {
    const r = client();
    stored = r ? await r.get<Partial<ChatSettings>>(KEY) : null;
  } catch {
    stored = null; // a store blip must never take the widget down
  }
  const value: ChatSettings = { ...defaults, ...(stored ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the cached copy — used after a write, and by tests. */
export function clearSettingsCache(): void {
  cache = null;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** ~100 kB of base64. A 96px avatar is a few kB; this is a ceiling, not a target. */
const AVATAR_MAX_CHARS = 140_000;

/**
 * Validate and persist a patch. Returns the merged result.
 *
 * Numbers are clamped rather than rejected: a typo'd retention of 100000 days
 * should become the maximum, not a 400 that loses the rest of the form. Origins
 * are normalised to scheme+host so "https://site.com/" and "https://site.com"
 * cannot both be in the list and confuse a CORS comparison.
 */
export async function saveChatSettings(
  patch: Partial<ChatSettings>,
  actor: string,
): Promise<ChatSettings> {
  const current = await getChatSettings();
  const next: ChatSettings = { ...current, ...patch };

  const clamp = (n: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

  next.debounceSeconds = clamp(Number(next.debounceSeconds), 0, 60, current.debounceSeconds);
  next.rateLimitPerHour = clamp(Number(next.rateLimitPerHour), 1, 10_000, current.rateLimitPerHour);
  next.retentionDays = clamp(Number(next.retentionDays), 1, 3650, current.retentionDays);
  next.handoffTimeoutMinutes = clamp(Number(next.handoffTimeoutMinutes), 1, 120, current.handoffTimeoutMinutes);
  if (!HEX.test(next.accentColor)) next.accentColor = current.accentColor;
  if (next.launcherPosition !== "left" && next.launcherPosition !== "right") {
    next.launcherPosition = current.launcherPosition;
  }
  next.allowedOrigins = [
    ...new Set(
      (next.allowedOrigins ?? [])
        .map((o) => String(o).trim())
        .filter(Boolean)
        .map((o) => {
          // Wildcard entries are kept verbatim: URL() does not round-trip a "*"
          // hostname, and normalising it would quietly destroy the rule.
          if (/^https?:\/\/\*\./i.test(o)) return o.replace(/\/$/, "").toLowerCase();
          try {
            return new URL(o).origin;
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ];
  for (const k of ["title", "subtitle", "greeting", "placeholder", "launcherLabel"] as const) {
    next[k] = String(next[k] ?? "").slice(0, 400);
  }

  // Avatar: an inline image or nothing. A remote URL is refused rather than
  // stored, because the widget renders on customer sites and a third-party
  // image request from there is both a privacy leak and someone else's uptime.
  const avatar = next.avatarUrl?.trim();
  if (!avatar) {
    next.avatarUrl = undefined;
  } else if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(avatar) || avatar.length > AVATAR_MAX_CHARS) {
    next.avatarUrl = current.avatarUrl;
  }

  next.updatedAt = Date.now();
  next.updatedBy = actor;

  const r = client();
  if (r) await r.set(KEY, next);
  clearSettingsCache();

  // Origins decide who may embed the chat, so a change to them is a security
  // event and belongs in the audit trail with names attached.
  const originsChanged =
    JSON.stringify(current.allowedOrigins) !== JSON.stringify(next.allowedOrigins);
  await logOpsEvent({
    level: originsChanged ? "warn" : "info",
    event: "chat.settings_updated",
    source: "console",
    actor,
    data: {
      changed: Object.keys(patch),
      ...(originsChanged ? { originsBefore: current.allowedOrigins, originsAfter: next.allowedOrigins } : {}),
    },
  });

  return next;
}
