"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Trash2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { StatusChip } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { Md } from "./markdown";
import type { Article, Category, Usage } from "./kb-list";

interface Version {
  version: number;
  title: string;
  body: string;
  editedBy: string;
  at: number;
}
interface AuditEvent {
  at: number;
  actor: string;
  action: string;
  fromState?: string;
  toState?: string;
  version?: number;
  detail?: string;
}
interface FdFolder {
  id: string;
  name: string;
  categoryName: string;
}

/** Legal lifecycle moves — mirrors TRANSITIONS in lib/kb-store.ts. */
const NEXT_STATES: Record<string, string[]> = {
  draft: ["in_review", "published"],
  in_review: ["draft", "published"],
  published: ["archived"],
  archived: ["draft"],
};

// The review-by <input type="date"> needs YYYY-MM-DD — this is the edit-buffer
// encoding (also used by the dirty check), not display formatting.
const fmtDay = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");

// Radix Select items can't have an empty value — sentinel for "uncategorized".
const NONE = "__none__";

const SECTION_LABEL = "text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";

function Meta({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={SECTION_LABEL}>{k}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default function KbArticle({ id }: { id?: string }) {
  const router = useRouter();
  const isNew = !id;

  const [article, setArticle] = useState<Article | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [missing, setMissing] = useState(false);

  // Edit buffer
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [keywords, setKeywords] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [busy, setBusy] = useState(false);
  // Duplicate warning from the last save — stays inline (an easy-to-miss toast
  // isn't enough for a data-quality flag).
  const [dupTitles, setDupTitles] = useState<string[]>([]);

  // Freshdesk publishing
  const [fdFolders, setFdFolders] = useState<FdFolder[] | null>(null);
  const [fdFolderPick, setFdFolderPick] = useState("");

  const applyArticle = useCallback((a: Article) => {
    setArticle(a);
    setTitle(a.title);
    setUrl(a.url);
    setBody(a.body);
    setKeywords(a.keywords.join(", "));
    setCategory(a.category);
    setTags(a.tags.join(", "));
    setReviewBy(fmtDay(a.reviewBy));
  }, []);

  const load = useCallback(async () => {
    if (!id) {
      const r = await fetch("/api/admin/kb", { cache: "no-store" }).then((x) => x.json());
      setCategories(r.categories ?? []);
      return;
    }
    const r = await fetch(`/api/admin/kb?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (r.status === 404) {
      setMissing(true);
      return;
    }
    const j = await r.json();
    applyArticle(j.article);
    setCategories(j.categories ?? []);
    setUsage(j.usage ?? null);
    const [v, a] = await Promise.all([
      fetch(`/api/admin/kb/versions?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((x) => x.json()),
      fetch(`/api/admin/kb/audit?id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((x) => x.json()),
    ]);
    setVersions(v.versions ?? []);
    setAudit(a.events ?? []);
  }, [id, applyArticle]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    const payload = {
      id: article?.id,
      title,
      url,
      body,
      keywords: keywords.split(",").map((s) => s.trim()).filter(Boolean),
      category,
      tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
      reviewBy: reviewBy ? Math.floor(new Date(reviewBy).getTime() / 1000) : undefined,
      ...(isNew ? { state: "draft" } : {}),
    };
    const r = await fetch("/api/admin/kb", {
      method: article ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    if (isNew && r.article?.id) {
      router.replace(`/kb/article?id=${encodeURIComponent(r.article.id)}`);
      return;
    }
    setDupTitles(r.duplicates?.length ? r.duplicates.map((d: { title: string }) => d.title) : []);
    toast.success(`Saved v${r.article.version}.`);
    load();
  }

  async function transition(to: string) {
    setBusy(true);
    const r = await fetch("/api/admin/kb/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id, to }),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) toast.error(r.error);
    else toast.success(`Now ${to.replace("_", " ")}.`);
    load();
  }

  async function restore(version: number) {
    setBusy(true);
    const r = await fetch("/api/admin/kb/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id, version }),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) toast.error(r.error);
    else toast.success(`Restored v${version} as v${r.article.version}.`);
    load();
  }

  async function loadFdFolders() {
    const r = await fetch("/api/admin/kb/freshdesk", { cache: "no-store" }).then((x) => x.json());
    setFdFolders(r.folders ?? []);
    const mapped = (r.categories ?? []).find((c: Category) => c.slug === article?.category)?.fdFolderId;
    if (mapped) setFdFolderPick(mapped);
  }

  async function pushToFreshdesk() {
    setBusy(true);
    // Persist the folder mapping first if the reviewer picked one here.
    if (fdFolderPick && article?.category) {
      await fetch("/api/admin/kb/freshdesk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: article.category, fdFolderId: fdFolderPick }),
      });
    }
    const r = await fetch("/api/admin/kb/freshdesk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: article!.id }),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) toast.error(r.error);
    else toast.success(`Pushed to Freshdesk (v${r.freshdesk?.syncedVersion}) — ${r.url}`);
    load();
  }

  async function remove() {
    await fetch(`/api/admin/kb?id=${encodeURIComponent(article!.id)}`, { method: "DELETE" });
    router.push("/kb");
  }

  if (missing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Article not found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            It may have been deleted.{" "}
            <Link href={"/kb"} className="text-primary hover:underline">
              Back to the list
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!isNew && !article) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-8 w-1/2" />
        </CardContent>
      </Card>
    );
  }

  const dirty =
    !!article &&
    (title !== article.title ||
      url !== article.url ||
      body !== article.body ||
      keywords !== article.keywords.join(", ") ||
      category !== article.category ||
      tags !== article.tags.join(", ") ||
      reviewBy !== fmtDay(article.reviewBy));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {isNew ? "New article" : article!.title}
          {article && <StatusChip tone={article.state}>{article.state.replace("_", " ")}</StatusChip>}
        </CardTitle>
        <CardAction>
          <Link
            href={"/kb"}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeft className="size-3.5" /> all articles
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="text" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full" />
          <Input
            type="text"
            placeholder="Public citation URL (empty = internal)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full"
          />
          <Input
            type="text"
            placeholder="keywords, comma, separated"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Select value={category || NONE} onValueChange={(v) => setCategory(v === NONE ? "" : v)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>uncategorized</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.slug} value={c.slug}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            placeholder="tags, comma, separated"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="max-w-56"
          />
          <Label
            className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground"
            title="Review-by date — the article is flagged stale after this"
          >
            review by
            <Input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} className="w-fit" />
          </Label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Textarea
            placeholder="Article body (markdown)…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[420px] bg-background font-mono text-xs"
          />
          <div className="max-h-[500px] overflow-y-auto rounded-lg border bg-muted/40 px-3.5 py-1">
            {body ? <Md>{body}</Md> : <p className="py-2 text-sm text-muted-foreground">Live preview…</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={busy || !title || !body || (!isNew && !dirty)}>
            {busy ? "Saving…" : isNew ? "Create draft" : dirty ? `Save (v${(article?.version ?? 0) + 1})` : "Saved"}
          </Button>
          {article &&
            NEXT_STATES[article.state]?.map((s) => (
              <Button
                key={s}
                variant="secondary"
                size="sm"
                onClick={() => transition(s)}
                disabled={busy || dirty}
                title={dirty ? "Save your edits first" : undefined}
              >
                <ArrowRight /> {s.replace("_", " ")}
              </Button>
            ))}
          {article && (
            <ConfirmButton
              variant="destructive"
              title="Delete this article?"
              description="This also removes it from the vector index."
              confirmLabel="Delete"
              onConfirm={remove}
              disabled={busy}
            >
              <Trash2 /> Delete
            </ConfirmButton>
          )}
        </div>
        {dupTitles.length > 0 && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Possible duplicates: {dupTitles.join(" · ")}</AlertTitle>
          </Alert>
        )}

        {article && (
          <div className="grid gap-4 pt-2 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <div className={SECTION_LABEL}>Details</div>
              <Meta k="id">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{article.id}</code>
              </Meta>
              <Meta k="origin / source">
                {article.origin} · {article.source || "—"}
              </Meta>
              <Meta k="created">
                {fmtDateTime(article.createdAt)} by {article.createdBy}
              </Meta>
              <Meta k="last update">
                {fmtDateTime(article.updatedAt)} by {article.updatedBy}
              </Meta>
              <Meta k="usage (retrieval hits)">
                {usage
                  ? `${usage.total} all-time · ${usage.month} this month · last ${usage.lastHit ? fmtDateTime(usage.lastHit) : "never"}`
                  : "none recorded"}
              </Meta>
              {article.state === "published" && (
                <Meta k="freshdesk help center">
                  {article.freshdesk ? (
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      synced v{article.freshdesk.syncedVersion} on {fmtDateTime(article.freshdesk.syncedAt)}
                      {article.freshdesk.syncedVersion < article.version && (
                        <StatusChip tone="stale">outdated</StatusChip>
                      )}
                    </div>
                  ) : (
                    <div className="mb-1.5 text-muted-foreground">not published to the help center</div>
                  )}
                  {fdFolders === null ? (
                    <Button variant="secondary" size="sm" onClick={loadFdFolders} disabled={busy}>
                      <Upload /> {article.freshdesk ? "Push update…" : "Publish to Freshdesk…"}
                    </Button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={fdFolderPick} onValueChange={setFdFolderPick}>
                        <SelectTrigger size="sm" className="max-w-56">
                          <SelectValue placeholder="pick a folder…" />
                        </SelectTrigger>
                        <SelectContent>
                          {fdFolders.map((fo) => (
                            <SelectItem key={fo.id} value={fo.id}>
                              {fo.categoryName} / {fo.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" onClick={pushToFreshdesk} disabled={busy || (!fdFolderPick && !article.freshdesk)}>
                        Push
                      </Button>
                    </div>
                  )}
                </Meta>
              )}
              {(article.duplicates?.length ?? 0) > 0 && (
                <Meta k="possible duplicates">
                  {article.duplicates!.map((d) => (
                    <div key={d.id}>
                      <Link href={`/kb/article?id=${encodeURIComponent(d.id)}`} className="text-primary hover:underline">
                        {d.title}
                      </Link>{" "}
                      <span className="text-muted-foreground">({d.score})</span>
                    </div>
                  ))}
                </Meta>
              )}
            </div>

            <div className="space-y-2">
              <div className={SECTION_LABEL}>Versions ({versions.length})</div>
              <Table>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell className="w-10 font-mono text-xs text-muted-foreground">v{v.version}</TableCell>
                      <TableCell className="max-w-44 truncate" title={v.title}>
                        {v.title}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(v.at)}</TableCell>
                      <TableCell className="w-20 text-right">
                        {v.version !== article.version && (
                          <ConfirmButton
                            variant="outline"
                            size="xs"
                            title={`Restore the content of v${v.version}?`}
                            description="It will be saved as a new version."
                            confirmLabel="Restore"
                            onConfirm={() => restore(v.version)}
                            disabled={busy}
                          >
                            restore
                          </ConfirmButton>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-2">
              <div className={SECTION_LABEL}>Audit trail</div>
              {audit.slice(0, 12).map((e, i) => (
                <div key={i} className="py-0.5 font-mono text-xs text-muted-foreground">
                  {fmtDateTime(e.at)} · <b className="text-foreground">{e.action}</b>
                  {e.fromState ? ` ${e.fromState}→${e.toState}` : ""}
                  {e.version ? ` v${e.version}` : ""} · {e.actor}
                  {e.detail ? <span> — {e.detail}</span> : null}
                </div>
              ))}
              {audit.length === 0 && <p className="text-sm text-muted-foreground">No events.</p>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
