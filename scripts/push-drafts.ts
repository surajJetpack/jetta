/**
 * Push the gap-category drafts from a saved /tmp/fd-analysis.json into the /kb
 * approval queue (no LLM re-run). Requires KV_REST_API_URL/TOKEN.
 */
import fs from "node:fs";
import { addDraft } from "../lib/kv";

async function main() {
  const a = JSON.parse(fs.readFileSync("/tmp/fd-analysis.json", "utf8")) as {
    categories: { name: string; frequency: number; coveredByKb: boolean; draft: { title: string; body: string; keywords: string[] } }[];
  };
  const gaps = a.categories.filter((c) => !c.coveredByKb).sort((x, y) => y.frequency - x.frequency).slice(0, 12);
  let n = 0;
  for (const c of gaps) {
    await addDraft({
      id: `mined-${1000 + n}`,
      channel: "freshdesk-analysis",
      threadTs: `analysis-${n}`,
      title: c.draft.title,
      body: c.draft.body,
      keywords: c.draft.keywords,
      createdBy: "freshdesk-analysis",
      at: Math.floor(Date.now() / 1000) - n, // stable-ish ordering
    });
    n++;
    console.log("queued:", c.draft.title);
  }
  console.log(`\npushed ${n} drafts to the approval queue.`);
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
