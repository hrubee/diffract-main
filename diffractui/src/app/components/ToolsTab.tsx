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

const BLANK_FORM = {
  name: "",
  description: "",
  repo: "",
  ref: "main",
  entry: "dist/index.js",
  bin: "",
  build: "npm ci --no-audit --no-fund && npm run build",
  apiHosts: "",
  secretEnv: "",
  configEnv: "",
  summary: "",
};

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

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-nc-text-dim text-xs">{label}</span>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-nc-border bg-nc-surface px-2 py-1 text-xs text-nc-text font-mono"
      />
      {hint && <span className="text-nc-text-muted text-[10px]">{hint}</span>}
    </label>
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

  // Add-tool form + install job
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [adding, setAdding] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [jobLog, setJobLog] = useState<string>("");

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

  // Poll the live-install job until it finishes, then refresh the list.
  useEffect(() => {
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(`/api/tools/add?job=${encodeURIComponent(job)}`);
        const d = await r.json();
        if (!active) return;
        setJobLog(d.log || "");
        setJobStatus(d.status || "running");
        if (d.status === "done" || d.status === "failed") {
          load();
          return;
        }
      } catch {
        /* keep polling */
      }
      if (active) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job, load]);

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

  async function submitAdd() {
    setAdding(true);
    setError("");
    setJobLog("");
    setJobStatus("");
    try {
      const tool = {
        name: form.name.trim(),
        description: form.description.trim(),
        repo: form.repo.trim(),
        ref: form.ref.trim() || "main",
        entry: form.entry.trim(),
        bin: form.bin.trim() || form.name.trim(),
        build: form.build.trim(),
        apiHosts: form.apiHosts.split(",").map((s) => s.trim()).filter(Boolean),
        secretEnv: form.secretEnv.trim() || undefined,
        configEnv: Object.fromEntries(
          form.configEnv.split(",").map((s) => s.trim()).filter(Boolean).map((k) => [k, ""]),
        ),
        skill: { summary: form.summary.trim() || form.description.trim() },
      };
      const r = await fetch("/api/tools/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandbox: sandboxName, tool }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "Add failed");
      setShowAdd(false);
      setForm({ ...BLANK_FORM });
      setJob(data.job); // begin polling install progress
      setJobStatus("running");
    } catch (e) {
      setError((e as Error).message || "Add failed");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-nc-text text-sm font-semibold">Tools</h2>
          <p className="text-nc-text-muted text-xs">
            CLIs the agent can use — baked into the sandbox, advertised as a skill, credentialed
            host-side (the agent only ever sees a placeholder).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAdd((s) => !s)}
            disabled={!running}
            className="rounded bg-nc-green/15 px-2 py-1 text-xs text-nc-green hover:bg-nc-green/25 disabled:opacity-40"
          >
            {showAdd ? "Cancel" : "+ Add tool"}
          </button>
          <button
            onClick={load}
            className="rounded border border-nc-border px-2 py-1 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
          >
            Refresh
          </button>
        </div>
      </div>

      {!running && (
        <div className="rounded border border-nc-warning/30 bg-nc-warning/10 px-3 py-2 text-xs text-nc-warning">
          Sandbox is not running — start it to add or connect tools.
        </div>
      )}
      {error && (
        <div className="rounded border border-nc-danger/30 bg-nc-danger/10 px-3 py-2 text-xs text-nc-danger">
          {error}
        </div>
      )}

      {/* Add-tool form */}
      {showAdd && (
        <div className="rounded border border-nc-border bg-nc-bg p-3 space-y-2">
          <p className="text-nc-text-muted text-xs">
            Registers the tool and installs it into the running sandbox now (git clone + build, ~a
            minute). It also re-bakes on the next recreate. The build runs inside the sandbox.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="gdrive" hint="lowercase, a-z0-9-" />
            <Field label="Binary" value={form.bin} onChange={(v) => setForm({ ...form, bin: v })} placeholder="(defaults to name)" />
            <Field label="Git repo *" value={form.repo} onChange={(v) => setForm({ ...form, repo: v })} placeholder="https://github.com/owner/cli.git" />
            <Field label="Ref" value={form.ref} onChange={(v) => setForm({ ...form, ref: v })} placeholder="main" />
            <Field label="Entry *" value={form.entry} onChange={(v) => setForm({ ...form, entry: v })} hint="path run by the bin, e.g. dist/index.js" />
            <Field label="API host(s)" value={form.apiHosts} onChange={(v) => setForm({ ...form, apiHosts: v })} placeholder="api.example.com:443" hint="comma-separated host:port" />
            <Field label="Secret env key" value={form.secretEnv} onChange={(v) => setForm({ ...form, secretEnv: v })} placeholder="EXAMPLE_TOKEN" hint="UPPER_SNAKE (the secret)" />
            <Field label="Config env key(s)" value={form.configEnv} onChange={(v) => setForm({ ...form, configEnv: v })} placeholder="EXAMPLE_REGION" hint="comma-separated, non-secret" />
          </div>
          <Field label="Build command" value={form.build} onChange={(v) => setForm({ ...form, build: v })} hint="runs in the cloned tool dir, in the sandbox" />
          <Field label="Description / skill summary" value={form.summary} onChange={(v) => setForm({ ...form, summary: v })} placeholder="What the agent uses this for" />
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={adding || !form.name || !form.repo || !form.entry}
              onClick={submitAdd}
              className="rounded bg-nc-green px-3 py-1.5 text-xs text-nc-bg font-medium hover:opacity-90 disabled:opacity-40"
            >
              {adding ? "Starting…" : "Add & install"}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded border border-nc-border px-3 py-1.5 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Install job progress */}
      {job && (
        <div
          className={
            "rounded border px-3 py-2 text-xs " +
            (jobStatus === "failed"
              ? "border-nc-danger/30 bg-nc-danger/10"
              : jobStatus === "done"
                ? "border-nc-green/30 bg-nc-green/10"
                : "border-nc-border bg-nc-bg")
          }
        >
          <div className="flex items-center justify-between">
            <span className="text-nc-text font-mono">
              {jobStatus === "running" ? `Installing ${job}…` : jobStatus === "done" ? `Installed ${job} ✓` : `Install of ${job} failed`}
            </span>
            {jobStatus !== "running" && (
              <button onClick={() => setJob(null)} className="text-nc-text-dim hover:text-nc-text">
                dismiss
              </button>
            )}
          </div>
          {jobLog && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-nc-text-muted text-[11px] font-mono">
              {jobLog}
            </pre>
          )}
          {jobStatus === "done" && (
            <p className="text-nc-green mt-1">Now click Connect to wire its credentials.</p>
          )}
        </div>
      )}

      {loading && tools.length === 0 ? (
        <div className="text-nc-text-muted text-xs">Loading…</div>
      ) : tools.length === 0 ? (
        <div className="text-nc-text-muted text-xs">No tools yet — add one above.</div>
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <div key={t.name} className="rounded border border-nc-border bg-nc-bg">
              <div className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-nc-text text-sm font-medium font-mono">{t.name}</span>
                    {t.apiHosts[0] && (
                      <span className="text-nc-text-muted text-xs truncate">→ {t.apiHosts[0].split(":")[0]}</span>
                    )}
                  </div>
                  {t.description && <p className="text-nc-text-dim text-xs mt-0.5">{t.description}</p>}
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
                    Values go to the host-side provider and are never stored in the UI, the sandbox,
                    or git. The agent receives only a placeholder.
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
