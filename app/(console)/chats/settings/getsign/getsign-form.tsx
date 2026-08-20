"use client";

/**
 * Editor for the GetSign brand overlay.
 *
 * Every control here has three states, not two: overridden, or inherited from
 * the default skin. Text fields express that with an empty box and the
 * inherited value as placeholder; the switches need an explicit "inherit"
 * option, because a checkbox cannot say "I have no opinion" — and without one,
 * simply opening this page would silently pin GetSign to whatever the
 * checkbox happened to render as.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RotateCw, Save, TriangleAlert, Image as ImageIcon, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/jetta/status-chip";
import { WidgetPreview, type PreviewSettings } from "@/components/jetta/widget-preview";

interface Base extends PreviewSettings {
  profiles?: { getsign?: Overlay };
}
interface Overlay {
  title?: string;
  subtitle?: string;
  greeting?: string;
  placeholder?: string;
  accentColor?: string;
  launcherLabel?: string;
  launcherPosition?: "left" | "right";
  launcherIcon?: "bubble" | "avatar";
  avatarUrl?: string;
  requireIdentity?: boolean;
  autoOpenSeconds?: number;
}
type TextKey = "title" | "subtitle" | "greeting" | "placeholder" | "accentColor" | "launcherLabel";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** inherit / on / off — the three states a per-brand switch actually has. */
function Tri<T extends string | boolean>({
  value,
  options,
  onChange,
}: {
  value: T | undefined;
  options: { v: T; label: string }[];
  onChange: (v: T | undefined) => void;
}) {
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        size="sm"
        variant={value === undefined ? "default" : "outline"}
        onClick={() => onChange(undefined)}
      >
        inherit
      </Button>
      {options.map((o) => (
        <Button
          key={String(o.v)}
          type="button"
          size="sm"
          variant={value === o.v ? "default" : "outline"}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export default function GetSignSkinForm() {
  const [base, setBase] = useState<Base | null>(null);
  const [o, setO] = useState<Overlay>({});
  const [saved, setSaved] = useState<string>("{}");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/chat-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { settings: Base }) => {
        setBase(d.settings);
        const overlay = d.settings.profiles?.getsign ?? {};
        setO(overlay);
        setSaved(JSON.stringify(overlay));
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = <K extends keyof Overlay>(k: K, v: Overlay[K]) =>
    setO((prev) => {
      const next = { ...prev };
      // Undefined and "" both mean inherit, so they are stored as absence
      // rather than as an empty value the server would have to interpret.
      if (v === undefined || v === "") delete next[k];
      else next[k] = v;
      return next;
    });

  const save = (patch: Overlay = o) => {
    setSaving(true);
    fetch("/api/admin/chat-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles: { getsign: patch } }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { settings: Base }) => {
        setBase(d.settings);
        const stored = d.settings.profiles?.getsign ?? {};
        // Show what was actually stored: values are clamped and validated
        // server-side, so an auto-open of 9999 comes back as 300.
        setO(stored);
        setSaved(JSON.stringify(stored));
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
  if (!base) return <Skeleton className="h-64 w-full" />;

  const count = Object.keys(o).length;
  const dirty = JSON.stringify(o) !== saved;
  const text = (k: TextKey) => o[k] ?? "";
  /** What the visitor ends up with: the override when set, the default otherwise. */
  const effective: PreviewSettings = {
    title: o.title ?? base.title,
    subtitle: o.subtitle ?? base.subtitle,
    greeting: o.greeting ?? base.greeting,
    placeholder: o.placeholder ?? base.placeholder,
    accentColor: o.accentColor ?? base.accentColor,
    launcherLabel: o.launcherLabel ?? base.launcherLabel,
    launcherPosition: o.launcherPosition ?? base.launcherPosition,
    launcherIcon: o.launcherIcon ?? base.launcherIcon,
    avatarUrl: o.avatarUrl ?? base.avatarUrl,
    requireIdentity: o.requireIdentity ?? base.requireIdentity,
    autoOpenSeconds: o.autoOpenSeconds ?? base.autoOpenSeconds,
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            What a GetSign visitor sees
            <StatusChip tone={count ? "published" : "archived"}>
              {count ? `${count} override${count === 1 ? "" : "s"}` : "all inherited"}
            </StatusChip>
          </CardTitle>
          <CardAction>
            <Button variant="ghost" size="sm" onClick={load} disabled={saving}>
              <RotateCw className={saving ? "animate-spin" : undefined} /> Reload
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input value={text("title")} placeholder={base.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Subtitle">
              <Input
                value={text("subtitle")}
                placeholder={base.subtitle}
                onChange={(e) => set("subtitle", e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Opening message" hint="Shown before the visitor has said anything.">
                <Textarea
                  rows={2}
                  value={text("greeting")}
                  placeholder={base.greeting}
                  onChange={(e) => set("greeting", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Input placeholder">
              <Input
                value={text("placeholder")}
                placeholder={base.placeholder}
                onChange={(e) => set("placeholder", e.target.value)}
              />
            </Field>
            <Field label="Launcher label">
              <Input
                value={text("launcherLabel")}
                placeholder={base.launcherLabel}
                onChange={(e) => set("launcherLabel", e.target.value)}
              />
            </Field>
            <Field label="Accent colour" hint="Hex, e.g. #2563eb. Anything else is ignored.">
              <div className="flex items-center gap-2">
                <Input
                  value={text("accentColor")}
                  placeholder={base.accentColor}
                  onChange={(e) => set("accentColor", e.target.value)}
                />
                <span
                  className="size-8 shrink-0 rounded-md border"
                  style={{ backgroundColor: effective.accentColor }}
                />
              </div>
            </Field>

            <Field label="Launcher position">
              <Tri
                value={o.launcherPosition}
                options={[
                  { v: "left" as const, label: "left" },
                  { v: "right" as const, label: "right" },
                ]}
                onChange={(v) => set("launcherPosition", v)}
              />
            </Field>

            <Field
              label="What the closed button shows"
              hint="GetSign's own site is the case for the logo; the avatar still appears inside the chat either way."
            >
              <Tri
                value={o.launcherIcon}
                options={[
                  { v: "bubble" as const, label: "message icon" },
                  { v: "avatar" as const, label: "the avatar" },
                ]}
                onChange={(v) => set("launcherIcon", v)}
              />
            </Field>

            <Field
              label="Ask for name and email first"
              hint="getsign.io is a marketing site; the app view already knows who the visitor is."
            >
              <Tri
                value={o.requireIdentity}
                options={[
                  { v: true, label: "ask" },
                  { v: false, label: "don't ask" },
                ]}
                onChange={(v) => set("requireIdentity", v)}
              />
            </Field>

            <Field label="Open by itself after (seconds)" hint="Blank inherits. 0 means never.">
              <Input
                type="number"
                min={0}
                max={300}
                value={o.autoOpenSeconds ?? ""}
                placeholder={String(base.autoOpenSeconds)}
                onChange={(e) =>
                  set("autoOpenSeconds", e.target.value === "" ? undefined : Number(e.target.value))
                }
              />
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="Chat avatar"
                hint="Square PNG or WebP around 96px, under 100 kB. Blank inherits the default skin's."
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
                    {effective.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={effective.avatarUrl} alt="" className="size-full object-cover" />
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
                  {o.avatarUrl && (
                    <Button size="sm" variant="ghost" onClick={() => set("avatarUrl", undefined)}>
                      Inherit
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <WidgetPreview s={effective} label="GetSign" />
            <p className="text-[11px] text-muted-foreground">
              Behaviour, allowed origins, rate limits and retention are shared by every brand and
              live on{" "}
              <Link href="/chats/settings" className="text-primary hover:underline">
                Chat settings
              </Link>
              .
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => save()} disabled={saving || !dirty}>
          <Save /> {saving ? "Saving…" : "Save"}
        </Button>
        {count > 0 && (
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setO({});
              save({});
            }}
          >
            <Undo2 /> Clear all overrides
          </Button>
        )}
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes.</span>}
      </div>
    </div>
  );
}
