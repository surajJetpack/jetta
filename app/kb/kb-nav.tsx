import Link from "next/link";

/**
 * Sub-navigation inside the Knowledge Base tab. The admin key travels as a
 * query param, same as the top-level tabs.
 */
export function KbNav({
  current,
  adminKey,
  draftCount,
}: {
  current: "list" | "review";
  adminKey: string;
  draftCount?: number;
}) {
  const q = adminKey ? `?key=${encodeURIComponent(adminKey)}` : "";
  return (
    <nav className="pills">
      <Link href={`/kb${q}`} className={`pill${current === "list" ? " active" : ""}`}>
        Articles
      </Link>
      <Link href={`/kb/review${q}`} className={`pill${current === "review" ? " active" : ""}`}>
        Review queue{typeof draftCount === "number" && draftCount > 0 ? ` (${draftCount})` : ""}
      </Link>
    </nav>
  );
}
