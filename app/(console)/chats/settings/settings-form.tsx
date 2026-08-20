"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, RotateCw, TriangleAlert, Save, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/jetta/status-chip";

interface Settings {
  title: string;
  subtitle: string;
  greeting: string;
  placeholder: string;
  accentColor: string;
  launcherLabel: string;
  launcherPosition: "left" | "right";
  launcherIcon: "bubble" | "avatar";
  avatarUrl?: string;
  requireIdentity: boolean;
  autoOpenSeconds: number;
  attachmentsEnabled: boolean;
  maxAttachmentMb: number;
  uploadsPerHour: number;
  uploadsPerConversation: number;
  enabled: boolean;
  allowedOrigins: string[];
  debounceSeconds: number;
  rateLimitPerHour: number;
  retentionDays: number;
  handoffEnabled: boolean;
  handoffTimeoutMinutes: number;
  handoffChannel?: string;
  /** Per-brand overrides, edited on their own page. Absent = inherits this skin. */
  profiles?: { getsign?: Partial<Overlay> };
  updatedAt?: number;
  updatedBy?: string;
}
/**
 * What a brand may override. Only used here to count GetSign's overrides for
 * the link chip — the editing lives on /chats/settings/getsign, so this page
 * never writes it. Mirrors OVERLAY_FIELDS in lib/chat-settings.ts.
 */
type Overlay = Pick<
  Settings,
  | "title"
  | "subtitle"
  | "greeting"
  | "placeholder"
  | "accentColor"
  | "launcherLabel"
  | "launcherPosition"
  | "launcherIcon"
  | "avatarUrl"
  | "requireIdentity"
  | "autoOpenSeconds"
>;
interface Payload {
  settings: Settings;
  env: { live: boolean; hasSecret: boolean; envOrigins: string[] };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function ChatSettingsForm() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [originsText, setOriginsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/chat-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Payload) => {
        setData(d);
        setForm(d.settings);
        setOriginsText((d.settings.allowedOrigins ?? []).join("\n"));
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const getsignOverrides = Object.values(form?.profiles?.getsign ?? {}).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;

  const save = () => {
    if (!form) return;
    setSaving(true);
    fetch("/api/admin/chat-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        allowedOrigins: originsText.split("\n").map((s) => s.trim()).filter(Boolean),
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { settings: Settings }) => {
        setForm(d.settings);
        setOriginsText(d.settings.allowedOrigins.join("\n"));
        // Values are normalised and clamped server-side, so showing what was
        // actually stored matters — a retention of 99999 comes back as 3650.
        toast.success("Saved. Live within 30 seconds.");
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  if (err) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{err}</AlertTitle>
      </Alert>
    );
  }
  if (!form || !data) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-5">
      {!data.env.live && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The chat is switched off at the environment level</AlertTitle>
          <AlertDescription>
            <code>JETTACHAT_LIVE</code> is not true, so nothing here will serve visitors. That switch
            lives outside the console on purpose — this page can turn the chat off, never on.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Behaviour <StatusChip tone="archived">shared across brands</StatusChip>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3 sm:col-span-2">
            <label className="flex items-start gap-2.5">
              <Checkbox checked={form.enabled} onCheckedChange={(v) => set("enabled", !!v)} />
              <span className="text-sm">
                Chat is on
                <span className="block text-[11px] text-muted-foreground">
                  Turning this off stops new conversations immediately. Existing ones stop being served too.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <Checkbox checked={form.requireIdentity} onCheckedChange={(v) => set("requireIdentity", !!v)} />
              <span className="text-sm">
                Ask for name and email before the chat starts
                <span className="block text-[11px] text-muted-foreground">
                  Inside the monday app the SDK supplies both, so the form never appears there.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <Checkbox
                checked={form.attachmentsEnabled}
                onCheckedChange={(v) => set("attachmentsEnabled", !!v)}
              />
              <span className="text-sm">
                Let visitors attach screenshots and PDFs
                <span className="block text-[11px] text-muted-foreground">
                  Images are read by a vision model so Jetta can answer about them, and they ride onto
                  the Freshdesk ticket if the chat is escalated.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <Checkbox checked={form.handoffEnabled} onCheckedChange={(v) => set("handoffEnabled", !!v)} />
              <span className="text-sm">
                Let Jetta hand a live chat to a person
                <span className="block text-[11px] text-muted-foreground">
                  She pings Slack and goes silent. If nobody joins in time she takes it back and offers a ticket.
                </span>
              </span>
            </label>
          </div>

          <Field
            label="Open the chat by itself after (seconds)"
            hint="0 is off. Once per visitor per day, never after they close it, never on phones."
          >
            <Input
              type="number"
              value={form.autoOpenSeconds}
              onChange={(e) => set("autoOpenSeconds", Number(e.target.value))}
            />
          </Field>
          <Field label="Wait before replying (seconds)" hint="Lets a visitor finish a three-message thought before Jetta answers.">
            <Input
              type="number"
              value={form.debounceSeconds}
              onChange={(e) => set("debounceSeconds", Number(e.target.value))}
            />
          </Field>
          <Field label="Give up waiting for a person after (minutes)" hint="Then Jetta apologises and carries on herself.">
            <Input
              type="number"
              value={form.handoffTimeoutMinutes}
              onChange={(e) => set("handoffTimeoutMinutes", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Largest attachment (MB)"
            hint="Capped at 25 — Freshdesk refuses anything larger when a chat becomes a ticket."
          >
            <Input
              type="number"
              value={form.maxAttachmentMb}
              disabled={!form.attachmentsEnabled}
              onChange={(e) => set("maxAttachmentMb", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Uploads per visitor per hour"
            hint="Every upload costs storage plus a vision call on a public endpoint. Real people send one or two."
          >
            <Input
              type="number"
              value={form.uploadsPerHour}
              disabled={!form.attachmentsEnabled}
              onChange={(e) => set("uploadsPerHour", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Files per conversation (lifetime)"
            hint="Counts files that were uploaded and never sent, since those cost the same."
          >
            <Input
              type="number"
              value={form.uploadsPerConversation}
              disabled={!form.attachmentsEnabled}
              onChange={(e) => set("uploadsPerConversation", Number(e.target.value))}
            />
          </Field>
          <Field label="Slack channel for handoff pings" hint="Blank uses the escalation channel.">
            <Input
              value={form.handoffChannel ?? ""}
              placeholder="#jetta-chat"
              onChange={(e) => set("handoffChannel", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What the visitor sees</CardTitle>
          <CardAction>
            <Link
              href="/chats/settings/getsign"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              GetSign skin
              <StatusChip tone={getsignOverrides ? "published" : "archived"}>
                {getsignOverrides
                  ? `${getsignOverrides} override${getsignOverrides === 1 ? "" : "s"}`
                  : "all inherited"}
              </StatusChip>
              <ChevronRight className="size-3.5" />
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <p className="sm:col-span-2 text-[11px] text-muted-foreground">
            The default skin — what every surface shows unless a brand overrides it.
          </p>
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </Field>
          <Field label="Subtitle">
            <Input
              value={form.subtitle}
              onChange={(e) => set("subtitle", e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Opening message" hint="Shown before the visitor has said anything.">
              <Textarea
                rows={2}
                value={form.greeting}
                onChange={(e) => set("greeting", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Input placeholder">
            <Input
              value={form.placeholder}
              onChange={(e) => set("placeholder", e.target.value)}
            />
          </Field>
          <Field label="Launcher label">
            <Input
              value={form.launcherLabel}
              onChange={(e) => set("launcherLabel", e.target.value)}
            />
          </Field>
          <Field label="Accent colour" hint="Hex, e.g. #2563eb. Anything else is ignored.">
            <div className="flex items-center gap-2">
              <Input
                value={form.accentColor}
                onChange={(e) => set("accentColor", e.target.value)}
              />
              <span
                className="size-8 shrink-0 rounded-md border"
                style={{
                  backgroundColor: (() => {
                    const c = form.accentColor;
                    return /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
                  })(),
                }}
              />
            </div>
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Chat avatar"
              hint="Shown in the header and beside Jetta's messages. A square PNG or WebP around 96px. Stored with the settings, so keep it small — under 100 kB."
            >
              <div className="flex items-center gap-3">
                <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
                  {form.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={form.avatarUrl}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="size-5 text-muted-foreground" />
                  )}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  className="text-xs file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-xs"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    // 100 kB before base64, which inflates by about a third —
                    // the server refuses anything over its own ceiling anyway,
                    // and failing here says why instead of silently reverting.
                    if (file.size > 100_000) {
                      toast.error("That image is over 100 kB — resize it and try again.");
                      e.target.value = "";
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => set("avatarUrl", String(reader.result));
                    reader.readAsDataURL(file);
                  }}
                />
                {form.avatarUrl && (
                  <Button size="sm" variant="ghost" onClick={() => set("avatarUrl", undefined)}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
          </div>

          <Field label="Launcher position">
            <div className="flex gap-2">
              {(["left", "right"] as const).map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={form.launcherPosition === p ? "default" : "outline"}
                  onClick={() => set("launcherPosition", p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </Field>

          <Field
            label="What the closed button shows"
            hint="The avatar still appears inside the chat either way. A logo in a 56px circle on someone else's page reads as an advert; the bubble reads as an invitation."
          >
            <div className="flex gap-2">
              {(
                [
                  ["bubble", "Message icon"],
                  ["avatar", "The avatar"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={form.launcherIcon === value ? "default" : "outline"}
                  onClick={() => set("launcherIcon", value)}
                  disabled={value === "avatar" && !form.avatarUrl}
                >
                  {label}
                </Button>
              ))}
            </div>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Access &amp; limits <StatusChip tone="archived">shared across brands</StatusChip>{" "}
            <StatusChip tone="stale">changes here are security-relevant</StatusChip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Sites allowed to embed the chat"
            hint="One origin per line, scheme included. Empty means the chat can only run on this domain — nothing else can embed it. Every change is recorded in the event log with your name."
          >
            <Textarea
              rows={4}
              value={originsText}
              placeholder={"https://jetpackapps.io\nhttps://getsign.io"}
              onChange={(e) => setOriginsText(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
          {data.env.envOrigins.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Environment default: <code>{data.env.envOrigins.join(", ")}</code> — used until you save a list here.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Messages per visitor per hour" hint="Abuse backstop on a public endpoint.">
              <Input
                type="number"
                value={form.rateLimitPerHour}
                onChange={(e) => set("rateLimitPerHour", Number(e.target.value))}
              />
            </Field>
            <Field label="Keep transcripts for (days)" hint="After this, conversations expire and cannot be recovered.">
              <Input
                type="number"
                value={form.retentionDays}
                onChange={(e) => set("retentionDays", Number(e.target.value))}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          <Save /> {saving ? "Saving…" : "Save settings"}
        </Button>
        <Button variant="ghost" onClick={load} disabled={saving}>
          <RotateCw /> Discard changes
        </Button>
        {form.updatedAt && (
          <span className="text-[11px] text-muted-foreground">
            Last changed by {form.updatedBy} · {new Date(form.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
