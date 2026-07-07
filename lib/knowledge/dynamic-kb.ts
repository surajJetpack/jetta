/**
 * Keyword fallback search — used only when the vector store is unavailable.
 * Thin re-export over the unified store's published-article search (which
 * covers the seeded GetSign corpus, manual articles, and approved
 * Knowledge-Loop articles alike).
 */
export { searchPublishedKb, type KbHit } from "../kb-store";
