"use client";

import { useEffect, useState, useCallback } from "react";

interface PublicUser {
  username: string;
  boxes: string[];
  isAdmin: boolean;
}

interface Props {
  onBack: () => void;
}

// Admin-only user management: create users, set their password, assign which
// boxes (sandboxes) they may access, and delete them. Backs /api/users.
export default function UsersTab({ onBack }: Props) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [boxes, setBoxes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // New-user form
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([
        fetch("/api/users").then((r) => r.json()),
        fetch("/api/sandboxes").then((r) => r.json()),
      ]);
      setUsers(Array.isArray(u?.users) ? u.users : []);
      setBoxes(Array.isArray(s?.sandboxes) ? s.sandboxes.map((x: { name: string }) => x.name) : []);
    } catch {
      setError("Failed to load users");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, boxes: picked, isAdmin }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error || "Failed to create user");
        return;
      }
      setUsername("");
      setPassword("");
      setPicked([]);
      setIsAdmin(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveBoxes(u: PublicUser, nextBoxes: string[]) {
    await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u.username, boxes: nextBoxes, isAdmin: u.isAdmin }),
    });
    await load();
  }

  async function removeUser(u: string) {
    if (!confirm(`Delete user "${u}"?`)) return;
    await fetch(`/api/users?username=${encodeURIComponent(u)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="w-full max-w-3xl animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <button onClick={onBack} className="text-xs text-nc-text-muted hover:text-nc-text transition-all mb-1">
            ← All sandboxes
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-nc-text-muted text-sm mt-0.5">
            Each user signs in with their own password and only sees the boxes you assign.
          </p>
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-nc-danger">{error}</div>}

      {/* Create user */}
      <form onSubmit={createUser} className="mb-8 p-4 rounded-lg bg-nc-surface border border-nc-border space-y-3">
        <div className="text-sm font-medium text-nc-text">Add a user</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username (e.g. sales-jane)"
            className="px-3 py-2 rounded-md bg-nc-bg border border-nc-border text-sm font-mono"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="password"
            className="px-3 py-2 rounded-md bg-nc-bg border border-nc-border text-sm"
          />
        </div>
        <div>
          <div className="text-xs text-nc-text-muted mb-1.5">Boxes this user can access</div>
          <div className="flex flex-wrap gap-1.5">
            {boxes.length === 0 && <span className="text-xs text-nc-text-dim">No sandboxes yet.</span>}
            {boxes.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setPicked((p) => toggle(p, b))}
                className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-all ${
                  picked.includes(b)
                    ? "bg-nc-green/15 border-nc-green/40 text-nc-green"
                    : "bg-nc-bg border-nc-border text-nc-text-muted hover:text-nc-text"
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-nc-text-muted">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin (can manage users + access all boxes)
        </label>
        <button
          type="submit"
          disabled={busy || !username || !password}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            busy || !username || !password
              ? "bg-nc-border text-nc-text-dim cursor-not-allowed"
              : "bg-nc-green text-black hover:bg-nc-green-dark"
          }`}
        >
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>

      {/* Existing users */}
      <div className="space-y-2">
        {users.length === 0 && <div className="text-xs text-nc-text-muted">No users yet — add one above.</div>}
        {users.map((u) => (
          <div key={u.username} className="p-4 rounded-lg bg-nc-surface border border-nc-border">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-sm text-nc-text">
                {u.username}
                {u.isAdmin && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-nc-green border border-nc-green/30 rounded px-1.5 py-0.5">
                    admin
                  </span>
                )}
              </span>
              <button
                onClick={() => removeUser(u.username)}
                className="px-2.5 py-1 rounded-md text-xs text-nc-danger hover:bg-nc-danger/10 transition-all"
              >
                Delete
              </button>
            </div>
            {!u.isAdmin && (
              <div className="flex flex-wrap gap-1.5">
                {boxes.map((b) => (
                  <button
                    key={b}
                    onClick={() => saveBoxes(u, toggle(u.boxes, b))}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-all ${
                      u.boxes.includes(b)
                        ? "bg-nc-green/15 border-nc-green/40 text-nc-green"
                        : "bg-nc-bg border-nc-border text-nc-text-muted hover:text-nc-text"
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
