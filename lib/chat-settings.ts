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
   * What the closed button shows: the speech bubble, or the avatar.
   *
   * Two decisions used to be one. The avatar is Jetta's face inside the
   * conversation; the launcher is a button on someone else's page, and a logo
   * squeezed into a 56px circle in the corner of a marketing site reads as an
   * advert rather than as "talk to us". Defaults to the bubble, so setting an
   * avatar no longer changes what the launcher is.
   */
  launcherIcon: "bubble" | "avatar";
  /**
   * Bot avatar, as a data URI. Stored inline rather than in blob storage: an
   * avatar is a few kB, this document is already read on every chat request,
   * and it avoids standing up a bucket for one image. Capped on save so it
   * cannot grow into something that belongs in a CDN.
   */
  avatarUrl?: string;
  /** Ask for name and email before the first message. */
  requireIdentity: boolean;
  /**
   * Open the chat by itself this many seconds after the page loads. 0 is off.
   *
   * Public because the widget decides locally — the alternative is the loader
   * fetching settings on every page view of a marketing site, and the config
   * response carries the avatar, so that is a ~120 kB request per page view to
   * answer one number.
   */
  autoOpenSeconds: number;
  /**
   * Whether visitors may attach files. Public because the widget has to know
   * whether to show the paperclip — and a button that uploads into a disabled
   * endpoint is worse than no button.
   */
  attachmentsEnabled: boolean;
  /** Largest single file, in MB. Public for the same reason: reject before uploading. */
  maxAttachmentMb: number;

  // ── private: server-side only ──
  /** Soft kill switch. ANDed with JETTACHAT_LIVE — can disable, never enable. */
  enabled: boolean;
  /** Origins allowed to embed the widget. Empty means same-origin only. */
  allowedOrigins: string[];
  /** Wait this long after the newest message so a three-part thought gets one answer. */
  debounceSeconds: number;
  rateLimitPerHour: number;
  /**
   * Hourly upload budget per IP — separate from, and far below, the message
   * limit. Each upload costs storage plus a vision call, so this is the knob
   * that bounds what an anonymous endpoint can spend.
   */
  uploadsPerHour: number;
  /** Total files one conversation may ever upload, sent or abandoned. */
  uploadsPerConversation: number;
  retentionDays: number;
  /** Whether Jetta may hand a live conversation to a person at all. */
  handoffEnabled: boolean;
  /** How long a visitor waits before Jetta takes the conversation back. */
  handoffTimeoutMinutes: number;
  /** Slack channel for "a visitor wants a human". Falls back to the escalation channel. */
  handoffChannel?: string;

  /**
   * Per-brand presentation overrides, keyed by brand profile (lib/profiles.ts).
   * A GetSign visitor should not be greeted by "Jetpack Apps support".
   *
   * COSMETIC FIELDS ONLY, by construction — `OVERLAY_FIELDS` below is the
   * whole surface. Origins, rate limits, retention, identity and handoff stay
   * global on purpose: one channel, one security and spend surface, however
   * many brands are painted on top of it.
   *
   * An absent or empty override falls back to the base value, so clearing a
   * field in the console reverts it rather than blanking the widget.
   */
  profiles?: Partial<Record<"getsign", ChatProfileOverlay>>;

  updatedAt?: number;
  updatedBy?: string;
}

/** The only fields a brand profile may override. */
const OVERLAY_FIELDS = [
  "title",
  "subtitle",
  "greeting",
  "placeholder",
  "accentColor",
  "launcherLabel",
  "launcherPosition",
  "launcherIcon",
  "avatarUrl",
  // Not cosmetic, but genuinely per-surface: getsign.io is a marketing site
  // and the GetSign app view is a logged-in workspace, so "open by itself
  // after N seconds" and "ask for a name and email first" should not be forced
  // to agree across them.
  "requireIdentity",
  "autoOpenSeconds",
] as const;

export type ChatProfileOverlay = Partial<Pick<ChatSettings, (typeof OVERLAY_FIELDS)[number]>>;

/** Exactly the fields the unauthenticated widget endpoint may return. */
const PUBLIC_FIELDS = [
  "title",
  "subtitle",
  "greeting",
  "placeholder",
  "accentColor",
  "launcherLabel",
  "launcherPosition",
  "launcherIcon",
  "avatarUrl",
  "requireIdentity",
  "autoOpenSeconds",
  "attachmentsEnabled",
  "maxAttachmentMb",
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

/**
 * The widget-visible subset, optionally painted with a brand profile's
 * overrides. `profileKey` is a plain string rather than a Profile: this module
 * is imported BY lib/profiles.ts, so it must not import back.
 */
export function publicSettings(s: ChatSettings, profileKey?: string): PublicChatSettings {
  const base = Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, s[k]])) as PublicChatSettings;
  const overlay = profileKey === "getsign" ? s.profiles?.getsign : undefined;
  if (!overlay) return base;
  for (const k of OVERLAY_FIELDS) {
    const v = overlay[k];
    // Absent means "not overridden" — see the note on `profiles` above.
    //
    // ONLY absent. `false` and `0` are answers, not blanks: "don't ask for an
    // email" and "never open by itself" are exactly the settings a brand is
    // most likely to want to differ on, and a falsy check here would make them
    // the two settings it cannot express.
    if (v === undefined || v === null || v === "") continue;
    (base as Record<string, unknown>)[k] = v;
  }
  return base;
}

/**
 * How many fields this brand overrides — for the "GetSign — 3 overrides" row
 * on the settings page. One definition, so the badge and the form can never
 * disagree about what counts as set.
 */
export function overrideCount(s: ChatSettings, profileKey: string): number {
  const overlay = profileKey === "getsign" ? s.profiles?.getsign : undefined;
  if (!overlay) return 0;
  return OVERLAY_FIELDS.filter((k) => {
    const v = overlay[k];
    return v !== undefined && v !== null && v !== "";
  }).length;
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
    launcherIcon: "bubble",
    avatarUrl: undefined,
    requireIdentity: true,
    // Off by default. A chat window that opens itself is an interruption, and
    // it should be a decision someone made rather than something that arrived
    // with a deploy.
    autoOpenSeconds: 0,
    attachmentsEnabled: true,
    maxAttachmentMb: config.jettachat.maxAttachmentMb,

    enabled: true,
    allowedOrigins: config.jettachat.allowedOrigins,
    debounceSeconds: config.jettachat.debounceSeconds,
    rateLimitPerHour: config.jettachat.rateLimitPerHour,
    uploadsPerHour: config.jettachat.uploadsPerHour,
    uploadsPerConversation: config.jettachat.uploadsPerConversation,
    retentionDays: config.jettachat.retentionDays,
    handoffEnabled: true,
    /**
     * How long a visitor waits for a colleague before the conversation comes
     * back to Jetta.
     *
     * One minute, not three. This is time the visitor spends watching a chat
     * window where nothing happens — Jetta is silent from the moment a person
     * is asked for — so it should be set by how long that is bearable, not by
     * how long a colleague might plausibly take. If nobody has picked it up
     * within a minute, an answer from Jetta beats a longer wait for a maybe.
     */
    handoffTimeoutMinutes: 1,
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
  // Ceilings kept deliberately low. These are the two numbers standing between
  // a public endpoint and an unbounded storage-plus-LLM bill, and there is no
  // legitimate reason to raise either into the hundreds.
  // Floor of 0 (off). No ceiling worth arguing about — 5 minutes in, nobody is
  // still reading the page.
  next.autoOpenSeconds = clamp(Number(next.autoOpenSeconds), 0, 300, current.autoOpenSeconds);
  next.uploadsPerHour = clamp(Number(next.uploadsPerHour), 1, 200, current.uploadsPerHour);
  next.uploadsPerConversation = clamp(Number(next.uploadsPerConversation), 1, 100, current.uploadsPerConversation);
  next.retentionDays = clamp(Number(next.retentionDays), 1, 3650, current.retentionDays);
  next.handoffTimeoutMinutes = clamp(Number(next.handoffTimeoutMinutes), 1, 120, current.handoffTimeoutMinutes);
  // 25 MB ceiling: Freshdesk refuses attachments above 20 MB, so anything
  // larger would upload fine and then fail silently at the hand-off — the one
  // moment the file was needed.
  next.maxAttachmentMb = clamp(Number(next.maxAttachmentMb), 1, 25, current.maxAttachmentMb);
  if (!HEX.test(next.accentColor)) next.accentColor = current.accentColor;
  if (next.launcherIcon !== "bubble" && next.launcherIcon !== "avatar") {
    next.launcherIcon = current.launcherIcon;
  }
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

  // Brand overlays get the same validation as the base fields, plus a
  // whitelist: anything outside OVERLAY_FIELDS is dropped rather than stored,
  // so a future private field can never be smuggled into the public payload by
  // writing it under `profiles`.
  if (next.profiles) {
    const clean: Partial<Record<"getsign", ChatProfileOverlay>> = {};
    for (const [key, raw] of Object.entries(next.profiles)) {
      if (key !== "getsign" || !raw) continue;
      const o: ChatProfileOverlay = {};
      for (const k of OVERLAY_FIELDS) {
        const v = (raw as Record<string, unknown>)[k];
        if (v === undefined || v === null || v === "") continue;
        if (k === "accentColor") {
          if (HEX.test(String(v))) o.accentColor = String(v);
        } else if (k === "launcherIcon") {
          if (v === "bubble" || v === "avatar") o.launcherIcon = v;
        } else if (k === "launcherPosition") {
          if (v === "left" || v === "right") o.launcherPosition = v;
        } else if (k === "avatarUrl") {
          const a = String(v).trim();
          if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(a) && a.length <= AVATAR_MAX_CHARS) {
            o.avatarUrl = a;
          }
        } else if (k === "requireIdentity") {
          // Only a real boolean counts. A stray "false" string would otherwise
          // store as truthy and turn the gate back on for the brand that just
          // asked for it off.
          if (typeof v === "boolean") o.requireIdentity = v;
        } else if (k === "autoOpenSeconds") {
          // Same bounds as the base field, and 0 (off) is kept, not dropped.
          const n = Number(v);
          if (Number.isFinite(n)) o.autoOpenSeconds = clamp(n, 0, 300, 0);
        } else {
          o[k] = String(v).slice(0, 400);
        }
      }
      if (Object.keys(o).length) clean.getsign = o;
    }
    next.profiles = Object.keys(clean).length ? clean : undefined;
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
