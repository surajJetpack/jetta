/**
 * LLM-as-reranker for KB retrieval.
 *
 * The fused/dense top-K from the vector index is loosely ordered; a small,
 * cheap model re-orders it by actual relevance to the query before the agent
 * sees it. No new vendor: uses the already-configured provider with its
 * cheapest fast model (gemini-2.5-flash-lite / claude-haiku).
 *
 * Failure posture: retrieval must NEVER fail because reranking failed. Any
 * error, timeout (3.5s), or malformed ranking falls back to the input order.
 * Kill-switch: RERANK_ENABLED=false.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { config } from "./config";
import type { VectorHit } from "./vector";

const RankSchema = z.object({
  ranking: z
    .array(z.number().int())
    .describe("Candidate numbers, most relevant first. Include ONLY relevant candidates."),
});

function rerankModel() {
  const provider = config.llm.provider;
  const modelId = config.rerank.models[provider];
  return provider === "google" ? google(modelId) : anthropic(modelId);
}

function providerKeyPresent(): boolean {
  return config.llm.provider === "google" ? !!config.google.apiKey : !!config.anthropic.apiKey;
}

export function rerankEnabled(): boolean {
  return config.rerank.enabled && providerKeyPresent();
}

/**
 * Re-order `hits` by relevance to `query` and return the top `topN`.
 * Falls back to `hits.slice(0, topN)` (input order) on any failure.
 */
export async function rerankHits(
  query: string,
  hits: VectorHit[],
  topN: number,
): Promise<VectorHit[]> {
  if (!rerankEnabled() || hits.length <= topN) return hits.slice(0, topN);

  const candidates = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.body.slice(0, 400)}`)
    .join("\n\n");

  try {
    const { object } = await generateObject({
      model: rerankModel(),
      schema: RankSchema,
      abortSignal: AbortSignal.timeout(config.rerank.timeoutMs),
      system:
        "You rank knowledge-base articles by relevance to a customer-support query. " +
        "Return candidate numbers, most relevant first. Omit candidates that do not help answer the query.",
      prompt: `Query: ${query}\n\nCandidates:\n\n${candidates}`,
    });

    // Map indices back, drop invalid/duplicate entries, pad with fusion order.
    const seen = new Set<number>();
    const ranked: VectorHit[] = [];
    for (const n of object.ranking) {
      const i = n - 1;
      if (i >= 0 && i < hits.length && !seen.has(i)) {
        seen.add(i);
        ranked.push(hits[i]);
      }
    }
    for (let i = 0; i < hits.length && ranked.length < topN; i++) {
      if (!seen.has(i)) {
        seen.add(i);
        ranked.push(hits[i]);
      }
    }
    return ranked.slice(0, topN);
  } catch (e) {
    console.warn("rerank failed, using fusion order:", e instanceof Error ? e.message : e);
    return hits.slice(0, topN);
  }
}
