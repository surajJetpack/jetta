"use client";

import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";

export default function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (r.ok && j?.ok) {
        window.location.assign(next);
        return;
      }
      setError(j?.error ?? "Sign-in failed. Check your username and password.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 text-left" aria-busy={busy}>
      <div className="grid gap-1.5">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      <Button type="submit" size="lg" disabled={busy || !username.trim() || !password} className="w-full">
        {busy && <Loader2 className="animate-spin" />}
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
