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
    <div className="flex min-h-svh items-center justify-center p-5">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Image
            src="/jetta.png"
            alt="Jetta"
            width={72}
            height={72}
            className="mx-auto mb-2 size-18 rounded-full ring-2 ring-primary/20"
          />
          <CardTitle className="text-lg">Jetta — Ops Console</CardTitle>
          <CardDescription>Internal · sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={target} />
        </CardContent>
      </Card>
    </div>
  );
}
