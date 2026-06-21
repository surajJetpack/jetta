import { queryVector } from "../lib/vector";

const QUERIES = [
  "my column mappings vanish when I close the editor",
  "the signed paper isn't showing as done on my board",
  "can GetSign automate vendor onboarding agreements?",
  "make the signer pick yes or no and require it",
  "emails going to spam, how do I use my own domain",
];

async function main() {
  for (const q of QUERIES) {
    const hits = await queryVector(q, 3);
    console.log(`\nQ: "${q}"`);
    for (const h of hits) console.log(`   ${h.score.toFixed(3)}  ${h.title} [${h.source}]`);
  }
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
