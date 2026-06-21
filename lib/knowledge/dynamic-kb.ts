/**
 * Dynamic knowledge base: human-approved articles produced by the Knowledge
 * Loop (a dev resolves an escalation → Jetta drafts an article → a human
 * approves it → it lands here). Stored in Redis and merged into
 * search_knowledge_base ahead of the static corpus, since these are
 * human-verified and specific to real resolved issues.
 */
import { listApprovedArticles } from "../kv";

export interface DynamicKbHit {
  title: string;
  url: string;
  body: string;
  source: "knowledge-loop";
  approvedBy: string;
}

/** Token-overlap search over approved articles (same scoring as the static KB). */
export async function searchApprovedKb(query: string, limit = 3): Promise<DynamicKbHit[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  const articles = await listApprovedArticles().catch(() => []);
  if (!articles.length) return [];

  return articles
    .map((a) => {
      const title = a.title.toLowerCase();
      const kw = (a.keywords ?? []).join(" ").toLowerCase();
      const body = a.body.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        if (kw.includes(t)) score += 2;
        if (body.includes(t)) score += 1;
      }
      return { a, score };
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ a }) => ({
      title: a.title,
      url: a.url,
      body: a.body,
      source: "knowledge-loop" as const,
      approvedBy: a.approvedBy,
    }));
}
