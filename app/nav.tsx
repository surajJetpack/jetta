import Link from "next/link";
import LogoutButton from "./logout-button";
import { GuideBanner } from "./guide-banner";

const TABS = [
  { href: "/", label: "Console", id: "console" },
  { href: "/drafts", label: "Drafts", id: "drafts" },
  { href: "/evals", label: "Evals", id: "evals" },
  { href: "/kb", label: "Knowledge Base", id: "kb" },
  { href: "/analytics", label: "Insights", id: "insights" },
  { href: "/guide", label: "Guide", id: "guide" },
];

/** Shared header + tab bar. Auth rides the session cookie — no key in links. */
export function Nav({ current, user }: { current: string; user: string }) {
  return (
    <>
      <header className="hdr" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small static asset, no optimization needed */}
          <img src="/jetta.png" alt="Jetta" className="logo" />
          <div>
            <h1>Jetta — Ops Console</h1>
            <p>Autonomous support agent for Jetpack Apps &amp; GetSign · internal</p>
          </div>
        </div>
        {user !== "dev" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="muted" style={{ fontSize: 13 }}>{user}</span>
            <LogoutButton />
          </div>
        )}
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.id} href={t.href} className={`tab${t.id === current ? " active" : ""}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <GuideBanner user={user} current={current} />
    </>
  );
}
