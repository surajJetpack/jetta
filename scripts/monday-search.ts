import { searchDevBoard, addPlusOne } from "../lib/tools/monday";

async function main() {
  const r = await searchDevBoard("signed document syncing");
  console.log("search 'signed document syncing':", JSON.stringify(r, null, 2));
  if (r[0]) {
    await addPlusOne(r[0].id, "https://jetpackwork.freshdesk.com/a/tickets/99999");
    console.log("add_plus_one OK on", r[0].id);
  } else {
    console.log("(no match — search may need a simpler term)");
  }
}
main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
