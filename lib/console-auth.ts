import { config } from "./config";

/** Resolve the admin key from a page's searchParams and whether access is locked. */
export async function gate(searchParams: Promise<{ key?: string }>) {
  const { key } = await searchParams;
  return { locked: !!config.adminSecret && key !== config.adminSecret, adminKey: key ?? "" };
}
