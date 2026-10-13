/**
 * Read both dev boards (read-only) and write the DevItem records to a JSON file —
 * the fixture /dev-board's metrics and miner are developed against.
 *   npx tsx --env-file=.env.local scripts/dev-board-dump.ts out.json [days=120]
 */
import { writeFileSync } from "node:fs";
import { readBoards, readPosts } from "../lib/dev-board-read";

async function main() {
const out = process.argv[2] ?? "dev-board.json";
const days = Number(process.argv[3] ?? 120);
const since = Date.now() - days * 86_400_000;
const t = Date.now();
const read = await readBoards(since, new Date(since).toISOString());
console.log(`items ${read.items.length}, logs for ${read.changes.size} items, ${Date.now() - t} ms`);
const posts = await readPosts(read.items.map((i) => i.id));
console.log(`posts read, ${Date.now() - t} ms`);
const items = read.items.map((i) => ({ ...i, posts: posts.get(i.id) ?? [], changes: (read.changes.get(i.id) ?? []).sort((a, b) => a.at - b.at) }));
writeFileSync(out, JSON.stringify({ self: read.self, boardNames: read.boardNames, at: Date.now(), items }, null, 1));
console.log(`wrote ${out}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
