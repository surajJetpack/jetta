"use client";

export default function LogoutButton() {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/login");
  }
  return (
    <button
      onClick={logout}
      style={{ background: "var(--panel-2)", color: "var(--muted)", padding: "6px 12px", fontSize: 12 }}
    >
      Sign out
    </button>
  );
}
