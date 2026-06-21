/**
 * RAG retrieval layer — Upstash Vector + Gemini embeddings (AI SDK).
 *
 * Behind a config flag: if UPSTASH_VECTOR_REST_* are set, semantic search is
 * used; otherwise callers fall back to keyword search. Embeddings use
 * gemini-embedding-001 at a fixed 768 dims (the index must be created with the
 * same dimension + cosine metric). Documents are embedded with the
 * RETRIEVAL_DOCUMENT task type and queries with RETRIEVAL_QUERY for best recall.
 */
import { Index } from "@upstash/vector";
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
  title: string;
  url: string;
  body: string;
  source: string;
  score: number;
}

/** Embed + upsert documents (chunk = title + body; articles are short). */
export async function upsertDocs(docs: VectorDoc[]): Promise<number> {
  const i = index();
  if (!i || !docs.length) return 0;
  const { embeddings } = await embedMany({
    model: embedModel(),
    values: docs.map((d) => `${d.title}\n\n${d.body}`),
    providerOptions: providerOptions("RETRIEVAL_DOCUMENT"),
  });
  await i.upsert(
    docs.map((d, n) => ({
      id: d.id,
      vector: embeddings[n],
      metadata: { title: d.title, url: d.url, body: d.body, source: d.source },
    })),
  );
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
  const { embedding } = await embed({
    model: embedModel(),
    value: query,
    providerOptions: providerOptions("RETRIEVAL_QUERY"),
  });
  const res = await i.query({ vector: embedding, topK, includeMetadata: true });
  return res
    .filter((r) => r.metadata)
    .map((r) => {
      const m = r.metadata as { title: string; url: string; body: string; source: string };
      return { title: m.title, url: m.url, body: m.body, source: m.source, score: r.score };
    });
}
