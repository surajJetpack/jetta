"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Lets an admin see the console as their colleagues do.
 *
 * The cookie only ever removes privilege — the API reads it too, so a preview
 * that hides a button also refuses the request behind it. That makes it safe
 * to set from the client: a general user writing it by hand gains nothing.
 *
 * Not httpOnly for the same reason. It is a view preference, not a credential.
 */
const COOKIE = "jetta_view_as";

export function ViewAsSwitch({ viewingAsGeneral }: { viewingAsGeneral: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const set = (general: boolean) => {
    setBusy(true);
    document.cookie = general
      ? `${COOKIE}=general; path=/; max-age=${8 * 3600}; samesite=lax`
      : `${COOKIE}=; path=/; max-age=0; samesite=lax`;
    // Server components decide what to render from this cookie, so the page
    // has to come back from the server rather than re-render on the client.
    router.refresh();
    setTimeout(() => setBusy(false), 400);
  };

  if (viewingAsGeneral) {
    return (
      <Button
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={() => set(false)}
        title="You are seeing the console with a general user's permissions"
      >
        <EyeOff /> Viewing as general — back to admin
      </Button>
    );
  }
  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(true)} title="See what a general user sees">
      <Eye /> View as general
    </Button>
  );
}
