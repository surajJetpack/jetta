import Link from "next/link";

/** Sub-navigation inside the Knowledge Base tab. */
export function KbNav({
  current,
  draftCount,
}: {
  current: "list" | "review";
  draftCount?: number;
}) {
  return (
    <nav className="pills">
      <Link href="/kb" className={`pill${current === "list" ? " active" : ""}`}>
        Articles
      </Link>
      <Link href="/kb/review" className={`pill${current === "review" ? " active" : ""}`}>
        Review queue{typeof draftCount === "number" && draftCount > 0 ? ` (${draftCount})` : ""}
      </Link>
    </nav>
  );
}
