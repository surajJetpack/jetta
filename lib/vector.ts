/**
 * RAG retrieval layer — Upstash Vector, in one of two modes:
 *
 * HYBRID (config.vector.hybrid, the target setup): the index is created in
 * Upstash as a hybrid index (hosted dense embedding model + BM25 sparse).
 * We send raw text on upsert/query and Upstash embeds server-side; results
 * are fused with Reciprocal Rank Fusion. BM25 covers exact-term queries
 * (error strings, "OTP", "docx") where pure dense retrieval is weak.
 *
 * LEGACY DENSE (default): client-side Gemini embeddings (gemini-embedding-001,
 * 768 dims, cosine — the index must be created to match). Kept as the
 * rollback path: flipping UPSTASH_VECTOR_HYBRID + the index URL env vars
 * switches modes with no code change.
 *
 * Behind a config flag: if UPSTASH_VECTOR_REST_* are unset, callers fall back
 * to keyword search over the KB store.
 */
import { FusionAlgorithm, Index } from "@upstash/vector";
import { embed, embedMany } from "ai";
import { google } from "@ai-sdk/google";
import { config } from "./config";

let idx: Index | null = null;
function index(): Index | null {
  if (config.vector.url && config.vector.token) {
    idx ??= new Index({ url: config.vector.url, token: config.vector.token });
    return idx;
  }
  return null;
}

export function vectorEnabled(): boolean {
  return !!(config.vector.url && config.vector.token);
}

const embedModel = () => google.embedding(config.vector.embedModel);
const providerOptions = (taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") => ({
  google: { outputDimensionality: config.vector.dimension, taskType },
});

export interface VectorDoc {
  id: string;
  title: string;
  url: string;
  body: string;
  source: string;
}

export interface VectorHit {
  id: string;
  title: string;
  url: string;
  body: string;
  source: string;
  score: number;
}

type HitMetadata = { title: string; url: string; body: string; source: string };

/** Embed + upsert documents (chunk = title + body; articles are short). */
export async function upsertDocs(docs: VectorDoc[]): Promise<number> {
  const i = index();
  if (!i || !docs.length) return 0;
  const metadata = (d: VectorDoc): HitMetadata => ({
    title: d.title,
    url: d.url,
    body: d.body,
    source: d.source,
  });
  if (config.vector.hybrid) {
    // Hybrid index: raw text; Upstash embeds dense + BM25 server-side.
    await i.upsert(
      docs.map((d) => ({ id: d.id, data: `${d.title}\n\n${d.body}`, metadata: metadata(d) })),
    );
    return docs.length;
  }
  const { embeddings } = await embedMany({
    model: embedModel(),
    values: docs.map((d) => `${d.title}\n\n${d.body}`),
    providerOptions: providerOptions("RETRIEVAL_DOCUMENT"),
  });
  await i.upsert(docs.map((d, n) => ({ id: d.id, vector: embeddings[n], metadata: metadata(d) })));
  return docs.length;
}

/** Delete documents by id. */
export async function deleteDocs(ids: string[]): Promise<void> {
  const i = index();
  if (!i || !ids.length) return;
  await i.delete(ids);
}

/** Wipe the entire index (used when rebuilding from sources). */
export async function resetIndex(): Promise<void> {
  const i = index();
  if (!i) return;
  await i.reset();
}

/** Semantic search. Returns [] if the vector store isn't configured. */
export async function queryVector(query: string, topK = 5): Promise<VectorHit[]> {
  const i = index();
  if (!i) return [];
  let res;
  if (config.vector.hybrid) {
    res = await i.query({
      data: query,
      topK,
      includeMetadata: true,
      fusionAlgorithm: FusionAlgorithm.RRF,
    });
  } else {
    const { embedding } = await embed({
      model: embedModel(),
      value: query,
      providerOptions: providerOptions("RETRIEVAL_QUERY"),
    });
    res = await i.query({ vector: embedding, topK, includeMetadata: true });
  }
  return res
    .filter((r) => r.metadata)
    .map((r) => {
      const m = r.metadata as HitMetadata;
      return { id: String(r.id), title: m.title, url: m.url, body: m.body, source: m.source, score: r.score };
    });
}
