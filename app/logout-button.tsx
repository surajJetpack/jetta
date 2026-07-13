"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function LogoutButton() {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/login");
  }
  return (
    <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground">
      <LogOut /> Sign out
    </Button>
  );
}
