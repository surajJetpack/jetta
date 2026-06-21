/**
 * Keyword fallback search over the managed KB (human-curated + Knowledge-Loop
 * articles). Used only when the vector store is unavailable — when vectors are
 * enabled, managed articles are searched via the index instead.
 */
import { listManagedArticles } from "../kv";

export interface DynamicKbHit {
  title: string;
  url: string;
  body: string;
  source: "managed";
}

export async function searchManagedKb(query: string, limit = 3): Promise<DynamicKbHit[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];

  const articles = await listManagedArticles().catch(() => []);
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
    .map(({ a }) => ({ title: a.title, url: a.url, body: a.body, source: "managed" as const }));
}
