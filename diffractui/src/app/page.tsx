"use client";

import { useState, useEffect, useCallback } from "react";
import SetupForm from "./components/SetupForm";
import DeployProgress from "./components/DeployProgress";
import Dashboard from "./components/Dashboard";

type AppState = "loading" | "list" | "setup" | "deploying" | "dashboard";

// Hard cap on concurrent sandboxes for a single VPS (2 vCPU / 8 GB): each is a
// container plus its own inference connection. Surfaced in the list UI.
const MAX_SANDBOXES = 4;

interface SandboxRow {
  name: string;
  model: string | null;
  provider: string | null;
  policies: string[];
  connected: boolean;
  activeSessionCount: number | null;
  isDefault: boolean;
  // True once the fleet is serving this sandbox under /<name>/agent/; the
  // "Open chat" link is hidden until then.
  chatReady: boolean;
}

export default function Home() {
  const [state, setState] = useState<AppState>("loading");
  const [sandboxes, setSandboxes] = useState<SandboxRow[]>([]);
  const [selected, setSelected] = useState("");
  const [deployLogs, setDeployLogs] = useState<string[]>([]);

  // Load the full sandbox inventory. Returns the rows so callers can branch on
  // count (e.g. first-run -> setup form).
  const loadSandboxes = useCallback(async (): Promise<SandboxRow[]> => {
    try {
      const r = await fetch("/api/sandboxes");
      const data = await r.json();
      const rows: SandboxRow[] = Array.isArray(data?.sandboxes) ? data.sandboxes : [];
      setSandboxes(rows);
      return rows;
    } catch {
      setSandboxes([]);
      return [];
    }
  }, []);

  // On first load: list if any sandboxes exist, else show the setup form.
  // Fetch inline (rather than via loadSandboxes) so the effect doesn't call a
  // setState-wrapping helper synchronously — see react-hooks/set-state-in-effect.
  useEffect(() => {
    fetch("/api/sandboxes")
      .then((r) => r.json())
      .then((data) => {
        const rows: SandboxRow[] = Array.isArray(data?.sandboxes) ? data.sandboxes : [];
        setSandboxes(rows);
        setState(rows.length > 0 ? "list" : "setup");
      })
      .catch(() => setState("setup"));
  }, []);

  function handleDeploy(config: Record<string, string>) {
    setState("deploying");
    setDeployLogs([]);

    const params = new URLSearchParams(config);
    const eventSource = new EventSource(`/api/deploy?${params.toString()}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        setDeployLogs((prev) => [...prev, data.message]);
      } else if (data.type === "done") {
        const name = data.sandboxName || config.sandboxName || "my-assistant";
        eventSource.close();
        // Refresh the inventory, then open the freshly-created sandbox.
        loadSandboxes().then(() => {
          setSelected(name);
          setState("dashboard");
        });
      } else if (data.type === "error") {
        setDeployLogs((prev) => [...prev, `ERROR: ${data.message}`]);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };
  }

  // Return to the list, refreshing the inventory (used after create/destroy/back).
  function goToList() {
    loadSandboxes().then((rows) => setState(rows.length > 0 ? "list" : "setup"));
  }

  // Open a sandbox's dedicated chat at /<name>/agent/ (path-based, same origin) in
  // a new tab. The per-sandbox gateway token is fetched on demand and embedded so
  // the chat UI authenticates without a second prompt.
  async function openChat(name: string) {
    let token = "";
    try {
      const r = await fetch(`/api/gateway-token?sandbox=${encodeURIComponent(name)}`);
      token = (await r.json())?.token || "";
    } catch {
      /* no token — open anyway; the chat UI will prompt */
    }
    const base = `${window.location.origin}/${encodeURIComponent(name)}/agent/`;
    const url = token ? `${base}?password=${token}#token=${token}` : base;
    window.open(url, "_blank", "noopener");
  }

  const atCap = sandboxes.length >= MAX_SANDBOXES;

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      {state === "loading" && (
        <div className="text-nc-text-muted text-sm">Checking for existing sandboxes...</div>
      )}

      {state === "list" && (
        <div className="w-full max-w-3xl animate-fade-in">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Diffract</h1>
              <p className="text-nc-text-muted text-sm mt-0.5">
                {sandboxes.length} of {MAX_SANDBOXES} sandboxes
              </p>
            </div>
            <button
              onClick={() => setState("setup")}
              disabled={atCap}
              title={atCap ? `Limit of ${MAX_SANDBOXES} sandboxes reached` : "Create a new sandbox"}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                atCap
                  ? "bg-nc-border text-nc-text-dim cursor-not-allowed"
                  : "bg-nc-green text-black hover:bg-nc-green-dark"
              }`}
            >
              + New sandbox
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {sandboxes.map((s) => (
              <div
                key={s.name}
                className="p-4 rounded-lg bg-nc-surface border border-nc-border hover:border-nc-green/50 transition-all"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm text-nc-text truncate">{s.name}</span>
                  {s.isDefault && (
                    <span className="text-[10px] uppercase tracking-wide text-nc-green border border-nc-green/30 rounded px-1.5 py-0.5">
                      default
                    </span>
                  )}
                </div>
                <div className="text-xs text-nc-text-muted truncate">{s.model || "—"}</div>
                <div className="text-xs text-nc-text-dim mt-1">
                  {s.provider || "—"}
                  {s.activeSessionCount ? ` · ${s.activeSessionCount} active` : ""}
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => {
                      setSelected(s.name);
                      setState("dashboard");
                    }}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-nc-surface-hover border border-nc-border text-nc-text-muted hover:text-nc-text transition-all"
                  >
                    Manage
                  </button>
                  {s.chatReady && (
                    <button
                      onClick={() => openChat(s.name)}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-nc-green text-black hover:bg-nc-green-dark transition-all"
                    >
                      Open chat ↗
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {atCap && (
            <p className="text-xs text-nc-text-dim mt-4">
              You&apos;ve reached the {MAX_SANDBOXES}-sandbox limit for this server. Destroy one to
              create another.
            </p>
          )}
        </div>
      )}

      {state === "setup" && (
        <SetupForm
          onDeploy={handleDeploy}
          onCancel={sandboxes.length > 0 ? () => setState("list") : undefined}
        />
      )}

      {state === "deploying" && <DeployProgress logs={deployLogs} />}

      {state === "dashboard" && (
        <Dashboard
          sandboxName={selected}
          chatReady={sandboxes.find((s) => s.name === selected)?.chatReady ?? false}
          onBack={goToList}
          onDestroyed={goToList}
        />
      )}
    </main>
  );
}
