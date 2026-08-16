"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fmtDate, fmtDuration } from "@/lib/format";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusChip } from "@/components/jetta/status-chip";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { EmptyState } from "@/components/jetta/empty-state";
import { TraceIO } from "@/components/jetta/step-card";

export interface Article {
  id: string;
  title: string;
  url: string;
  body: string;
  keywords: string[];
  category: string;
  tags: string[];
  state: "draft" | "in_review" | "published" | "archived";
  version: number;
  origin: string;
  source: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  reviewBy?: number;
  duplicates?: { id: string; title: string; score: number }[];
  freshdesk?: { articleId: string; folderId: string; syncedAt: number; syncedVersion: number };
}
export interface Category { slug: string; name: string; fdFolderId?: string }
export interface Usage { total: number; month: number; lastHit: number }
interface Hit { id: string; title: string; url: string; source: string; score?: number }

// Filter/sort state survives tab navigation (module cache) and reloads
// (sessionStorage) — same pattern as ticket-tester.tsx.
type ListState = { q: string; state: string; category: string; origin: string; sort: string; stale: boolean };
const DEFAULTS: ListState = { q: "", state: "", category: "", origin: "", sort: "updated", stale: false };
const STORAGE_KEY = "jetta:kbList";
let cache: ListState | null = null;

function readStorage(): ListState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ListState) : null;
  } catch {
    return null;
  }
}

// Radix Select items can't have an empty value — map "" (all) to a sentinel
// so the persisted filter state shape stays unchanged.
const ALL = "__all__";

const SECTION_LABEL = "text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";

export default function KbList() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  const [byState, setByState] = useState<Record<string, number>>({});
  const [f, setF] = useState<ListState>(() => cache ?? DEFAULTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Retrieval tester
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searchMeta, setSearchMeta] = useState("");

  useEffect(() => {
    if (cache) return;
    const saved = readStorage();
    if (!saved) return;
    cache = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time rehydration from storage on mount
    setF(saved);
  }, []);
  useEffect(() => {
    cache = f;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(f));
    } catch {
      /* module cache still covers tab nav */
    }
  }, [f]);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/kb", { cache: "no-store" }).then((x) => x.json());
    setArticles(r.articles ?? []);
    setCategories(r.categories ?? []);
    setUsage(r.usage ?? {});
    setStaleIds(new Set(r.stale ?? []));
    setByState(r.byState ?? {});
    setLoaded(true);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state set after await, not synchronously
    load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = f.q.toLowerCase();
    let out = articles.filter(
      (a) =>
        (!f.state || a.state === f.state) &&
        (!f.category || a.category === f.category) &&
        (!f.origin || a.origin === f.origin) &&
        (!f.stale || staleIds.has(a.id)) &&
        (!needle ||
          a.title.toLowerCase().includes(needle) ||
          a.body.toLowerCase().includes(needle) ||
          a.keywords.some((k) => k.toLowerCase().includes(needle))),
    );
    out = [...out].sort((x, y) => {
      switch (f.sort) {
        case "title":
          return x.title.localeCompare(y.title);
        case "usage":
          return (usage[y.id]?.total ?? 0) - (usage[x.id]?.total ?? 0);
        case "stale":
          return (x.reviewBy ?? Infinity) - (y.reviewBy ?? Infinity);
        default:
          return y.updatedAt - x.updatedAt;
      }
    });
    return out;
  }, [articles, f, staleIds, usage]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function bulk(action: "publish" | "archive" | "delete" | "reingest") {
    if (!selected.size) return;
    setBusy(true);
    const r = await fetch("/api/admin/kb/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected], action }),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) {
      toast.error(r.error);
    } else {
      toast.success(
        `${action}: ${r.ok ?? 0} ok${r.failed?.length ? `, ${r.failed.length} failed (${r.failed.map((e: { error: string }) => e.error).join("; ")})` : ""}`,
      );
    }
    setSelected(new Set());
    load();
  }

  async function testSearch() {
    if (!q.trim()) return;
    const r = await fetch(`/api/admin/kb/search?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" }).then((x) => x.json());
    setHits(r.hits ?? []);
    setSearchMeta(
      r.vectorEnabled
        ? `vector ${fmtDuration(r.timings?.retrievalMs)}${r.reranked ? ` + rerank ${fmtDuration(r.timings?.rerankMs)}` : " (rerank off)"}`
        : "keyword fallback (vector store not configured)",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Articles ({articles.length})</CardTitle>
        <CardDescription className="text-xs">
          {(["published", "draft", "in_review", "archived"] as const).map((s) => `${byState[s] ?? 0} ${s.replace("_", " ")}`).join(" · ")}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button size="sm" asChild>
            <Link href="/kb/article">
              <Plus /> New article
            </Link>
          </Button>
          <Button variant="outline" size="icon-sm" onClick={load} aria-label="Reload articles">
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Retrieval tester — the exact pipeline the agent runs */}
        <div className="space-y-2">
          <div className={SECTION_LABEL}>Test retrieval (what Jetta finds)</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              className="w-72 flex-1 sm:flex-none"
              placeholder="e.g. my mappings disappear"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && testSearch()}
            />
            <Button variant="secondary" onClick={testSearch}>
              <Search /> Search
            </Button>
          </div>
          {searchMeta && <div className="text-xs text-muted-foreground">{searchMeta}</div>}
          {hits &&
            (hits.length ? (
              <div className="space-y-1">
                {hits.map((h, i) => (
                  <TraceIO key={i}>
                    {h.score !== undefined ? h.score.toFixed(3) : "kw"}{" "}
                    <Link href={`/kb/article?id=${encodeURIComponent(h.id)}`} className="text-primary hover:underline">
                      {h.title}
                    </Link>{" "}
                    [{h.source}]
                  </TraceIO>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No hits.</p>
            ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Input
            type="text"
            className="w-52"
            placeholder="filter articles…"
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
          />
          <Select value={f.state || ALL} onValueChange={(v) => setF({ ...f, state: v === ALL ? "" : v })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>all states</SelectItem>
              <SelectItem value="draft">draft</SelectItem>
              <SelectItem value="in_review">in review</SelectItem>
              <SelectItem value="published">published</SelectItem>
              <SelectItem value="archived">archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={f.category || ALL} onValueChange={(v) => setF({ ...f, category: v === ALL ? "" : v })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>all categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.slug} value={c.slug}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={f.origin || ALL} onValueChange={(v) => setF({ ...f, origin: v === ALL ? "" : v })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>all origins</SelectItem>
              <SelectItem value="manual">manual</SelectItem>
              <SelectItem value="knowledge-loop">knowledge-loop</SelectItem>
              <SelectItem value="fd-mined">fd-mined</SelectItem>
              <SelectItem value="seed-getsign">seed-getsign</SelectItem>
            </SelectContent>
          </Select>
          <Select value={f.sort} onValueChange={(v) => setF({ ...f, sort: v })}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">newest first</SelectItem>
              <SelectItem value="title">by title</SelectItem>
              <SelectItem value="usage">most used</SelectItem>
              <SelectItem value="stale">stalest first</SelectItem>
            </SelectContent>
          </Select>
          <Label className="flex cursor-pointer items-center gap-1.5 text-sm font-normal text-muted-foreground">
            <Checkbox checked={f.stale} onCheckedChange={(v) => setF({ ...f, stale: v === true })} />
            stale only ({staleIds.size})
          </Label>
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => bulk("publish")}>
              Publish
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => bulk("archive")}>
              Archive
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => bulk("reingest")}>
              Re-ingest
            </Button>
            <ConfirmButton
              variant="destructive"
              size="sm"
              title={`Delete ${selected.size} article(s)?`}
              description="This also removes them from the vector index."
              confirmLabel="Delete"
              onConfirm={() => bulk("delete")}
              disabled={busy}
            >
              <Trash2 /> Delete
            </ConfirmButton>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {/* Rows */}
        {!loaded ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState title="No articles match the filters" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Select</span>
                </TableHead>
                <TableHead className="w-24">State</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-20 text-right" title="retrieval hits — all time / this month">
                  Hits
                </TableHead>
                <TableHead className="w-14 text-right">Ver</TableHead>
                <TableHead className="w-28 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((a) => (
                <TableRow key={a.id} data-state={selected.has(a.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                      aria-label={`Select ${a.title}`}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={a.state}>{a.state.replace("_", " ")}</StatusChip>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Link
                        href={`/kb/article?id=${encodeURIComponent(a.id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {a.title}
                      </Link>
                      {staleIds.has(a.id) && <StatusChip tone="stale">stale</StatusChip>}
                      {(a.duplicates?.length ?? 0) > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <StatusChip tone="stale">dup?</StatusChip>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="whitespace-pre-line">
                            {a.duplicates!.map((d) => d.title).join("\n")}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-xs text-muted-foreground"
                    title="retrieval hits — all time / this month"
                  >
                    {usage[a.id]?.total ?? 0}/{usage[a.id]?.month ?? 0}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">v{a.version}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{fmtDate(a.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
