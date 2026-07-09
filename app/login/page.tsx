import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

/** Only allow same-origin path redirects (no protocol-relative //host). */
function sanitizeNext(next?: string): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = sanitizeNext(next);
  const { locked } = await gate();
  if (!locked) redirect(target); // already signed in (or dev-open)

  return (
    <div className="wrap" style={{ display: "flex", minHeight: "80vh", alignItems: "center", justifyContent: "center" }}>
      <section className="card" style={{ width: "100%", maxWidth: 400, textAlign: "center", padding: "32px 28px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no optimization needed */}
        <img src="/jetta.png" alt="Jetta" className="logo lg" style={{ margin: "0 auto 14px" }} />
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--heading)" }}>
          Jetta — Ops Console
        </h1>
        <p className="muted" style={{ margin: "4px 0 22px" }}>Internal · sign in to continue</p>
        <LoginForm next={target} />
      </section>
    </div>
  );
}
