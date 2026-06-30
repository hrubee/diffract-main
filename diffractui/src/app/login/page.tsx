"use client";

import { useState } from "react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const unconfigured =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("error") === "unconfigured";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.href = next && next.startsWith("/") ? next : "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Login failed");
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-nc-border bg-nc-surface p-6 flex flex-col gap-4"
      >
        <div>
          <h1 className="text-lg font-semibold text-nc-text">Diffract</h1>
          <p className="text-sm text-nc-text-muted">Sign in to continue</p>
        </div>

        {unconfigured && (
          <div className="rounded-md border border-nc-warning/40 bg-nc-warning/10 px-3 py-2 text-xs text-nc-warning">
            Admin auth is not configured on this server. Set
            <code className="mx-1">DIFFRACT_ADMIN_PASSWORD</code> and
            <code className="mx-1">DIFFRACT_AUTH_SECRET</code>, then restart.
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs text-nc-text-muted">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="admin"
            className="rounded-md border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text outline-none focus:border-nc-green font-mono"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-nc-text-muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="rounded-md border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text outline-none focus:border-nc-green"
          />
        </label>

        {error && <div className="text-xs text-nc-danger">{error}</div>}

        <button
          type="submit"
          disabled={loading || !password}
          className="rounded-md bg-nc-green px-3 py-2 text-sm font-medium text-black transition-all hover:bg-nc-green-dark disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
