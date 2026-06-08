"use client";

import { useState, useEffect, useCallback } from "react";

interface ToolStatus {
  installed: boolean;
  connected: boolean;
  advertised: boolean;
  egress: boolean;
}

interface Tool {
  name: string;
  description: string;
  bin: string;
  provider: string;
  apiHosts: string[];
  authHeader: string;
  secretKeys: string[];
  configKeys: string[];
  status: ToolStatus;
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs " +
        (ok ? "bg-nc-green/10 text-nc-green" : "bg-nc-surface text-nc-text-muted")
      }
      title={label}
    >
      <span>{ok ? "✓" : "○"}</span>
      {label}
    </span>
  );
}

export default function ToolsTab({ sandboxName }: { sandboxName: string }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [running, setRunning] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ tool: string; ok: boolean; msg: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/tools?sandbox=${encodeURIComponent(sandboxName)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Failed to load tools");
        setTools(data.tools || []);
        setRunning(!!data.running);
      })
      .catch((e) => setError(e.message || "Failed to load tools"))
      .finally(() => setLoading(false));
  }, [sandboxName]);

  useEffect(() => {
    load();
  }, [load]);

  function startConnect(t: Tool) {
    setResult(null);
    const blank: Record<string, string> = {};
    [...t.secretKeys, ...t.configKeys].forEach((k) => (blank[k] = ""));
    setCreds(blank);
    setOpenTool(t.name);
  }

  async function submitConnect(t: Tool) {
    setSubmitting(true);
    setResult(null);
    try {
      const r = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandbox: sandboxName, tool: t.name, credentials: creds }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "Connect failed");
      setResult({ tool: t.name, ok: true, msg: data.output || "Connected." });
      setOpenTool(null);
      setCreds({});
      load();
    } catch (e) {
      setResult({ tool: t.name, ok: false, msg: (e as Error).message || "Connect failed" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-nc-text text-sm font-semibold">Tools</h2>
          <p className="text-nc-text-muted text-xs">
            CLIs the agent can use. Each is baked into the sandbox, advertised as a skill, and
            credentialed host-side — the agent only ever sees a placeholder.
          </p>
        </div>
        <button
          onClick={load}
          className="rounded border border-nc-border px-2 py-1 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
        >
          Refresh
        </button>
      </div>

      {!running && (
        <div className="rounded border border-nc-warning/30 bg-nc-warning/10 px-3 py-2 text-xs text-nc-warning">
          Sandbox is not running — status reflects the registry only. Start the sandbox to connect tools.
        </div>
      )}
      {error && (
        <div className="rounded border border-nc-danger/30 bg-nc-danger/10 px-3 py-2 text-xs text-nc-danger">
          {error}
        </div>
      )}

      {loading && tools.length === 0 ? (
        <div className="text-nc-text-muted text-xs">Loading…</div>
      ) : tools.length === 0 ? (
        <div className="text-nc-text-muted text-xs">No tools in the registry.</div>
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <div key={t.name} className="rounded border border-nc-border bg-nc-bg">
              <div className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-nc-text text-sm font-medium font-mono">{t.name}</span>
                    {t.apiHosts[0] && (
                      <span className="text-nc-text-muted text-xs truncate">
                        → {t.apiHosts[0].split(":")[0]}
                      </span>
                    )}
                  </div>
                  {t.description && (
                    <p className="text-nc-text-dim text-xs mt-0.5">{t.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge ok={t.status.installed} label="Installed" />
                    <Badge ok={t.status.connected} label="Connected" />
                    <Badge ok={t.status.advertised} label="Advertised" />
                    <Badge ok={t.status.egress} label="Egress" />
                  </div>
                </div>
                <button
                  disabled={!running || (t.secretKeys.length === 0 && t.configKeys.length === 0)}
                  onClick={() => (openTool === t.name ? setOpenTool(null) : startConnect(t))}
                  className="shrink-0 rounded bg-nc-green/15 px-3 py-1.5 text-xs text-nc-green hover:bg-nc-green/25 disabled:opacity-40"
                >
                  {t.status.connected ? "Reconnect" : "Connect"}
                </button>
              </div>

              {openTool === t.name && (
                <div className="border-t border-nc-border p-3 space-y-2">
                  <p className="text-nc-text-muted text-xs">
                    Values are sent to the host-side provider and never stored in the UI, the
                    sandbox, or git. The agent receives only a placeholder.
                  </p>
                  {t.secretKeys.map((k) => (
                    <label key={k} className="block">
                      <span className="text-nc-text-dim text-xs font-mono">{k} (secret)</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={creds[k] || ""}
                        onChange={(e) => setCreds((c) => ({ ...c, [k]: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-nc-border bg-nc-surface px-2 py-1 text-xs text-nc-text font-mono"
                      />
                    </label>
                  ))}
                  {t.configKeys.map((k) => (
                    <label key={k} className="block">
                      <span className="text-nc-text-dim text-xs font-mono">{k}</span>
                      <input
                        type="text"
                        autoComplete="off"
                        value={creds[k] || ""}
                        onChange={(e) => setCreds((c) => ({ ...c, [k]: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-nc-border bg-nc-surface px-2 py-1 text-xs text-nc-text font-mono"
                      />
                    </label>
                  ))}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      disabled={submitting}
                      onClick={() => submitConnect(t)}
                      className="rounded bg-nc-green px-3 py-1.5 text-xs text-nc-bg font-medium hover:opacity-90 disabled:opacity-40"
                    >
                      {submitting ? "Connecting…" : "Connect"}
                    </button>
                    <button
                      onClick={() => setOpenTool(null)}
                      className="rounded border border-nc-border px-3 py-1.5 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {result?.tool === t.name && (
                <div
                  className={
                    "border-t border-nc-border px-3 py-2 text-xs font-mono whitespace-pre-wrap " +
                    (result.ok ? "text-nc-green" : "text-nc-danger")
                  }
                >
                  {result.msg}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
