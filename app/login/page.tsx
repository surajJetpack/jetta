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
    <div className="wrap">
      <header className="hdr">
        <div className="logo">J</div>
        <div>
          <h1>Jetta — Ops Console</h1>
          <p>Internal · sign in to continue</p>
        </div>
      </header>
      <section className="card" style={{ maxWidth: 420 }}>
        <h2>Sign in</h2>
        <LoginForm next={target} />
      </section>
    </div>
  );
}
