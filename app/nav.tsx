import Link from "next/link";

const TABS = [
  { href: "/", label: "Console", id: "console" },
  { href: "/kb", label: "Knowledge Base", id: "kb" },
  { href: "/analytics", label: "Insights", id: "insights" },
];

/** Shared header + tab bar. Preserves the admin key across navigation. */
export function Nav({ current, adminKey }: { current: string; adminKey: string }) {
  const q = adminKey ? `?key=${encodeURIComponent(adminKey)}` : "";
  return (
    <>
      <header className="hdr">
        <div className="logo">J</div>
        <div>
          <h1>Jetta — Ops Console</h1>
          <p>Autonomous support agent for Jetpack Apps &amp; GetSign · internal</p>
        </div>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.id} href={t.href + q} className={`tab${t.id === current ? " active" : ""}`}>
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** Shown when the admin key is missing/wrong. */
export function Locked() {
  return (
    <div className="wrap">
      <header className="hdr">
        <div className="logo">J</div>
        <div>
          <h1>Jetta — Ops Console</h1>
          <p>Internal · access restricted</p>
        </div>
      </header>
      <section className="card">
        <h2>🔒 Admin key required</h2>
        <p className="muted">
          Append <code>?key=YOUR_ADMIN_SECRET</code> to the URL to access the console.
        </p>
      </section>
    </div>
  );
}
