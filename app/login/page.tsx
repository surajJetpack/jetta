import { redirect } from "next/navigation";
import Image from "next/image";
import { gate } from "@/lib/console-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-5">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="items-center gap-1 text-center">
          <Image
            src="/jetta.png"
            alt=""
            width={56}
            height={56}
            className="mx-auto mb-3 size-14 rounded-full ring-1 ring-border"
          />
          {/* scripts/manual-shots.mjs crops this card by the "Ops Console" title. */}
          <CardTitle className="text-xl font-semibold tracking-tight">Jetta Ops Console</CardTitle>
          <CardDescription>Sign in with your team account to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={target} />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Internal tool · access is limited to the support team</p>
    </main>
  );
}
