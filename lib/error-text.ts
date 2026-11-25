/**
 * An error's message together with the messages of its causes.
 *
 * The database client wraps a refused query as "Failed query: select ..." and
 * keeps the database's own words ("a usage quota has been exceeded") on
 * `cause`. Logging `err.message` alone recorded the query a thousand times and
 * the reason never. Pure.
 */
export function errorWithCauses(err: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i <= maxDepth && cur != null; i++) {
    const text = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (text && !parts.includes(text)) parts.push(text);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.length ? parts.join(" | caused by: ") : String(err);
}
