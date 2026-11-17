/**
 * A read-only GitHub client for the GetSign app repositories.
 *
 * Two readers use it: the configuration reference (lib/getsign-reference.ts,
 * which keeps its own fetch) and the release watcher (lib/release-watch.ts).
 * Both use the same token, JETTA_GETSIGN_REFERENCE_TOKEN: read-only, Contents
 * and Pull requests, on the GetSign repositories and nothing else.
 *
 * GET only, on purpose. Jetta never writes to GitHub.
 */
import { config } from "./config";

const API = "https://api.github.com";
export const GITHUB_OWNER = "Jetpack-Work-Labs";

/**
 * False with no token: callers do nothing rather than fail.
 *
 * The token is the whole switch. NOT `config.stubMode`: production runs with
 * STUB_MODE on and each integration switched live by its own `*_LIVE` flag,
 * and GitHub has no such flag, so a stub-mode check here meant GitHub was
 * never read in production while everything reported success. Reading is
 * safe to leave to the token alone: it is GET only.
 */
export function githubReady(): boolean {
  return !!config.getsignReferenceToken;
}

/** One GET. Throws with the status on anything but 2xx. */
export async function githubGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${config.getsignReferenceToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jetta-release-watch",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path.split("?")[0]}`);
  return (await res.json()) as T;
}
