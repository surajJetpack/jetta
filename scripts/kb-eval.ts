/**
 * Retrieval eval harness — runs the golden set (lib/eval/golden-set.json)
 * against the live retrieval path and reports hit@1, recall@3, recall@5, and
 * MRR. Run BEFORE and AFTER any KB or retrieval change and compare.
 *
 *   UPSTASH_VECTOR_REST_URL=... UPSTASH_VECTOR_REST_TOKEN=... \
 *   GOOGLE_GENERATIVE_AI_API_KEY=... npx tsx scripts/kb-eval.ts
 *
 * Flags:
 *   --no-rerank    skip the reranker stage (raw fusion/vector order)
 *   --k <n>        candidates fetched per query (default 12; scored at 1/3/5)
 *   --json         machine-readable output (for before/after diffing)
 *   --min-mrr <x>  exit 1 if MRR falls below x (CI/pre-deploy gate)
 *   --keyword      force the keyword fallback path instead of vectors
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vectorEnabled, queryVector } from "../lib/vector";
import { searchPublishedKb } from "../lib/knowledge/dynamic-kb";

interface Matcher {
  articleId?: string;
  url?: string;
  titleIncludes?: string;
}
interface GoldenItem {
  id: string;
  query: string;
  expected: Matcher[];
  tags?: string[];
}
interface Hit {
  id?: string;
  title: string;
  url: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const K = Number(opt("--k") ?? 12);
const NO_RERANK = flag("--no-rerank");
const AS_JSON = flag("--json");
const KEYWORD = flag("--keyword");
const MIN_MRR = opt("--min-mrr") ? Number(opt("--min-mrr")) : undefined;

const normUrl = (u: string) => u.toLowerCase().replace(/\/+$/, "");

function matches(hit: Hit, m: Matcher): boolean {
  if (m.articleId) return hit.id === m.articleId;
  if (m.url) return normUrl(hit.url) === normUrl(m.url);
  if (m.titleIncludes) return hit.title.toLowerCase().includes(m.titleIncludes.toLowerCase());
  return false;
}

/** Rank (1-based) of the first hit matching any expected matcher, or 0. */
function firstMatchRank(hits: Hit[], expected: Matcher[]): number {
  for (let r = 0; r < hits.length; r++) {
    if (expected.some((m) => matches(hits[r], m))) return r + 1;
  }
  return 0;
}

async function retrieve(query: string): Promise<{ hits: Hit[]; retrievalMs: number; rerankMs: number }> {
  const t0 = Date.now();
  let hits: Hit[];
  if (!KEYWORD && vectorEnabled()) {
    hits = await queryVector(query, K);
  } else {
    hits = await searchPublishedKb(query, K);
  }
  const retrievalMs = Date.now() - t0;

  let rerankMs = 0;
  if (!NO_RERANK) {
    // lib/rerank.ts lands in a later phase; degrade gracefully until then.
    // (computed specifier so tsc doesn't require the module to exist yet)
    try {
      const rerankModule = "../lib/rerank";
      const { rerankHits } = await import(rerankModule);
      const t1 = Date.now();
      hits = (await rerankHits(query, hits as never[], Math.min(5, hits.length))) as unknown as Hit[];
      rerankMs = Date.now() - t1;
    } catch {
      /* reranker not built / not configured — score raw order */
    }
  }
  return { hits, retrievalMs, rerankMs };
}

async function main() {
  const golden: GoldenItem[] = JSON.parse(
    readFileSync(join(__dirname, "..", "lib", "eval", "golden-set.json"), "utf8"),
  );
  const mode = !KEYWORD && vectorEnabled() ? "vector" : "keyword";

  const rows: { id: string; query: string; rank: number; retrievalMs: number; rerankMs: number }[] = [];
  for (const item of golden) {
    const { hits, retrievalMs, rerankMs } = await retrieve(item.query);
    rows.push({ id: item.id, query: item.query, rank: firstMatchRank(hits, item.expected), retrievalMs, rerankMs });
  }

  const n = rows.length;
  const hitAt = (k: number) => rows.filter((r) => r.rank > 0 && r.rank <= k).length / n;
  const mrr = rows.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
  const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

  const summary = {
    mode,
    reranked: !NO_RERANK && rows.some((r) => r.rerankMs > 0),
    queries: n,
    hitAt1: +hitAt(1).toFixed(3),
    recallAt3: +hitAt(3).toFixed(3),
    recallAt5: +hitAt(5).toFixed(3),
    mrr: +mrr.toFixed(3),
    meanRetrievalMs: mean(rows.map((r) => r.retrievalMs)),
    meanRerankMs: mean(rows.filter((r) => r.rerankMs > 0).map((r) => r.rerankMs)),
    misses: rows.filter((r) => r.rank === 0).map((r) => r.id),
  };

  if (AS_JSON) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
  } else {
    console.log(`\nKB retrieval eval — mode=${summary.mode}${summary.reranked ? "+rerank" : ""}, ${n} queries, k=${K}\n`);
    for (const r of rows) {
      const mark = r.rank === 0 ? "MISS " : r.rank === 1 ? "  #1 " : `  #${r.rank} `;
      console.log(`${mark} ${r.id}  ${r.query.slice(0, 70)}`);
    }
    console.log(`\n  hit@1     ${summary.hitAt1}`);
    console.log(`  recall@3  ${summary.recallAt3}`);
    console.log(`  recall@5  ${summary.recallAt5}`);
    console.log(`  MRR       ${summary.mrr}`);
    console.log(`  latency   retrieval ~${summary.meanRetrievalMs}ms${summary.meanRerankMs ? `, rerank ~${summary.meanRerankMs}ms` : ""}`);
    if (summary.misses.length) console.log(`  misses    ${summary.misses.join(", ")}`);
    console.log();
  }

  if (MIN_MRR !== undefined && mrr < MIN_MRR) {
    console.error(`FAIL: MRR ${mrr.toFixed(3)} < required ${MIN_MRR}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
