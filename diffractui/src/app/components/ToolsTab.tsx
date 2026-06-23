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

// "Connect an API" (REST/API-key) form — no git clone/build. The agent calls the
// API with curl; the secret is held host-side and injected at egress.
const BLANK_REST = {
  name: "",
  description: "",
  baseUrl: "",
  authHeader: "Authorization: Bearer",
  authHeaderCustom: "",
  secretEnv: "",
  secretValue: "",
  endpoints: "",
};

const AUTH_PRESETS = ["Authorization: Bearer", "Authorization: Token", "x-api-key:", "Custom…"];

// "Connect MCP" form — connect an MCP server (Zapier, GoHighLevel, Notion, …).
// Paste the server URL; the secret is held host-side and the agent sees only a
// placeholder. `authStyle` picks how the secret is sent: in the URL (Zapier) or in
// a header. The header presets carry the scheme (e.g. "Authorization: Bearer") so
// the full header value is constructed correctly — GoHighLevel needs exactly that.
const MCP_AUTH_STYLES = [
  "URL-token (token already in the URL)",
  "Authorization: Bearer",
  "x-api-key:",
  "Custom header…",
];
const BLANK_MCP = { name: "", url: "", authStyle: MCP_AUTH_STYLES[0], authCustom: "", apiKey: "", extra: "" };

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

export default function ToolsTab({
  sandboxName,
  onRedeploy,
}: {
  sandboxName: string;
  onRedeploy?: () => void;
}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [mcpServers, setMcpServers] = useState<{ name: string; host: string; secretEnv: string }[]>([]);
  const [running, setRunning] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ tool: string; ok: boolean; msg: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Add-tool form + install job
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"rest" | "mcp" | "cli">("rest");
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [restForm, setRestForm] = useState({ ...BLANK_REST });
  const [mcpForm, setMcpForm] = useState({ ...BLANK_MCP });
  const [adding, setAdding] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [jobLog, setJobLog] = useState<string>("");
  // Shown after a successful connect: tools bind to the CHAT agent only at
  // sandbox create, so a redeploy is needed to use a just-connected tool in chat.
  const [chatNote, setChatNote] = useState<string | null>(null);

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
    // Connected MCP servers (host-side records — independent of the tool registry).
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((data) => setMcpServers(Array.isArray(data.servers) ? data.servers : []))
      .catch(() => {});
  }, [sandboxName]);

  useEffect(() => {
    load();
  }, [load]);

  async function disconnectMcp(name: string) {
    if (!confirm(`Disconnect MCP server "${name}"? Its host-side secret is deleted; it's removed from the agent on the next redeploy.`)) return;
    setRemoving(name);
    setError("");
    try {
      const r = await fetch(
        `/api/mcp?name=${encodeURIComponent(name)}&sandbox=${encodeURIComponent(sandboxName)}`,
        { method: "DELETE" },
      );
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Disconnect failed");
      load();
    } catch (e) {
      setError((e as Error).message || "Disconnect failed");
    } finally {
      setRemoving(null);
    }
  }

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
      setChatNote(t.name);
      setOpenTool(null);
      setCreds({});
      load();
    } catch (e) {
      setResult({ tool: t.name, ok: false, msg: (e as Error).message || "Connect failed" });
    } finally {
      setSubmitting(false);
    }
  }

  async function removeTool(t: Tool) {
    if (!confirm(`Remove tool "${t.name}"? This deletes it from the registry and uninstalls it from the sandbox.`)) {
      return;
    }
    setRemoving(t.name);
    setResult(null);
    try {
      const r = await fetch(
        `/api/tools?sandbox=${encodeURIComponent(sandboxName)}&tool=${encodeURIComponent(t.name)}`,
        { method: "DELETE" },
      );
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "Remove failed");
      if (openTool === t.name) setOpenTool(null);
      load();
    } catch (e) {
      setResult({ tool: t.name, ok: false, msg: (e as Error).message || "Remove failed" });
    } finally {
      setRemoving(null);
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

  // Connect an API/SaaS by key: register an install-less REST entry (advertised
  // as a curl skill), then wire the credential host-side — in one step.
  async function submitRest() {
    setAdding(true);
    setError("");
    setJobLog("");
    setJobStatus("");
    setChatNote(null);
    try {
      const name = restForm.name.trim();
      const secretEnv = restForm.secretEnv.trim();
      const authHeader = (
        restForm.authHeader === "Custom…" ? restForm.authHeaderCustom : restForm.authHeader
      ).trim();
      const baseUrl = restForm.baseUrl.trim();
      // Derive the egress host:port from the base URL so they always match.
      let apiHost = "";
      try {
        const u = new URL(baseUrl);
        apiHost = u.port ? u.host : `${u.hostname}:443`;
      } catch {
        throw new Error("Base URL must be a full https URL, e.g. https://api.example.com/v1");
      }
      if (!secretEnv) throw new Error("Secret env var name is required (e.g. EXAMPLE_TOKEN)");
      if (!restForm.secretValue.trim()) throw new Error("Paste the API token / key");

      const tool = {
        name,
        description: restForm.description.trim(),
        apiHosts: [apiHost],
        secretEnv,
        authHeader,
        baseUrl,
        endpoints: restForm.endpoints.split(",").map((s) => s.trim()).filter(Boolean),
        skill: { summary: restForm.description.trim() },
      };
      // 1) Register the install-less REST entry + advertise it as a skill.
      const r = await fetch("/api/tools/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandbox: sandboxName, transport: "rest", tool }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "Register failed");

      // 2) Connect the credential host-side (provider placeholder + egress).
      const c = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandbox: sandboxName,
          tool: name,
          credentials: { [secretEnv]: restForm.secretValue },
        }),
      });
      const cd = await c.json();
      if (!c.ok || !cd.ok)
        throw new Error(cd.error || "Connect failed — the tool was registered; use its Connect button to retry");

      setShowAdd(false);
      setRestForm({ ...BLANK_REST });
      setJob(name); // poll the advertise job
      setJobStatus("running");
      setChatNote(name);
    } catch (e) {
      setError((e as Error).message || "Connect failed");
    } finally {
      setAdding(false);
    }
  }

  // Connect an MCP server: paste the server URL; the backend extracts any embedded
  // token, holds it host-side, and stores a placeholder-URL in the agent config.
  async function submitMcp() {
    setAdding(true);
    setError("");
    setChatNote(null);
    try {
      const name = mcpForm.name.trim();
      const url = mcpForm.url.trim();
      if (!name) throw new Error("Name is required (lowercase, a-z0-9-)");
      if (!/^https:\/\//.test(url)) throw new Error("Paste the MCP server URL (https://…)");

      // Build the auth header from the selected style. URL-token => no header.
      // A header spec is "<HeaderName>[: <scheme>]" — the scheme (e.g. Bearer) is
      // prepended to the key so the FULL header value is sent (GoHighLevel needs
      // "Authorization: Bearer <token>", not a bare token under a custom header).
      let authHeader = "";
      let apiKey = "";
      const urlToken = mcpForm.authStyle.startsWith("URL-token");
      if (!urlToken) {
        const spec = (mcpForm.authStyle === "Custom header…" ? mcpForm.authCustom : mcpForm.authStyle).trim();
        const rawKey = mcpForm.apiKey.trim();
        if (!spec) throw new Error("Enter the header name (e.g. Authorization or X-Api-Key).");
        if (!rawKey) throw new Error("Enter the API key / token for the header.");
        const ci = spec.indexOf(":");
        const headerName = (ci >= 0 ? spec.slice(0, ci) : spec).trim();
        const scheme = (ci >= 0 ? spec.slice(ci + 1) : "").trim();
        authHeader = headerName;
        apiKey = scheme ? `${scheme} ${rawKey}` : rawKey;
      }

      // Additional NON-SECRET headers (one "Name: Value" per line) — e.g. GHL's
      // `locationId`. Sent verbatim (no provider) alongside the auth header.
      const extraHeaders: Record<string, string> = {};
      for (const line of mcpForm.extra.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const ci = t.indexOf(":");
        if (ci < 0) throw new Error(`Header "${t}" needs a colon, e.g. locationId: abc123`);
        const hn = t.slice(0, ci).trim();
        const hv = t.slice(ci + 1).trim();
        if (hn && hv) extraHeaders[hn] = hv;
      }

      const r = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandbox: sandboxName, name, url, authHeader, apiKey, extraHeaders }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "Connect failed");
      setShowAdd(false);
      setMcpForm({ ...BLANK_MCP });
      setResult({ tool: name, ok: true, msg: data.output || "Connected." });
      setChatNote(name);
      load();
    } catch (e) {
      setError((e as Error).message || "Connect failed");
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
            APIs, MCP servers, and CLIs the agent can use — credentialed host-side (the agent only
            ever sees a placeholder; the real key is injected at the network layer).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAdd((s) => !s)}
            disabled={!running}
            className="rounded bg-nc-green/15 px-2 py-1 text-xs text-nc-green hover:bg-nc-green/25 disabled:opacity-40"
          >
            {showAdd ? "Cancel" : "+ Connect tool"}
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

      {/* Add / Connect panel */}
      {showAdd && (
        <div className="rounded border border-nc-border bg-nc-bg p-3 space-y-2">
          {/* Mode toggle */}
          <div className="flex w-fit gap-0.5 rounded bg-nc-surface p-0.5 text-xs">
            <button
              onClick={() => setAddMode("rest")}
              className={
                "rounded px-2 py-1 " +
                (addMode === "rest" ? "bg-nc-green/20 text-nc-green" : "text-nc-text-dim hover:text-nc-text")
              }
            >
              Connect an API
            </button>
            <button
              onClick={() => setAddMode("mcp")}
              className={
                "rounded px-2 py-1 " +
                (addMode === "mcp" ? "bg-nc-green/20 text-nc-green" : "text-nc-text-dim hover:text-nc-text")
              }
            >
              Connect MCP
            </button>
            <button
              onClick={() => setAddMode("cli")}
              className={
                "rounded px-2 py-1 " +
                (addMode === "cli" ? "bg-nc-green/20 text-nc-green" : "text-nc-text-dim hover:text-nc-text")
              }
            >
              Add a CLI (advanced)
            </button>
          </div>

          {addMode === "rest" ? (
            <>
              <p className="text-nc-text-muted text-xs">
                Connect any SaaS or internal REST API by key (CRM, etc.). No code to build — the
                agent calls it with curl. Your key is stored host-side and injected at the network
                layer; the agent only ever sees a placeholder.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name *" value={restForm.name} onChange={(v) => setRestForm({ ...restForm, name: v })} placeholder="pipedrive" hint="lowercase, a-z0-9-" />
                <Field label="Base URL *" value={restForm.baseUrl} onChange={(v) => setRestForm({ ...restForm, baseUrl: v })} placeholder="https://api.pipedrive.com/v1" hint="full https URL — egress host is taken from this" />
                <label className="block">
                  <span className="text-nc-text-dim text-xs">Auth header</span>
                  <select
                    value={restForm.authHeader}
                    onChange={(e) => setRestForm({ ...restForm, authHeader: e.target.value })}
                    className="mt-0.5 w-full rounded border border-nc-border bg-nc-surface px-2 py-1 text-xs text-nc-text font-mono"
                  >
                    {AUTH_PRESETS.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </label>
                {restForm.authHeader === "Custom…" ? (
                  <Field label="Custom header prefix" value={restForm.authHeaderCustom} onChange={(v) => setRestForm({ ...restForm, authHeaderCustom: v })} placeholder="X-Api-Key:" hint="header name + optional scheme" />
                ) : (
                  <div />
                )}
              </div>
              <Field label="Secret env var *" value={restForm.secretEnv} onChange={(v) => setRestForm({ ...restForm, secretEnv: v })} placeholder="PIPEDRIVE_TOKEN or pipedrive-token" hint="letters/digits/_/- (e.g. API_KEY, api_key, x-api-key) — the name the key is referenced by" />
              <label className="block">
                <span className="text-nc-text-dim text-xs">API token / key *</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={restForm.secretValue}
                  onChange={(e) => setRestForm({ ...restForm, secretValue: e.target.value })}
                  placeholder="paste the secret"
                  className="mt-0.5 w-full rounded border border-nc-border bg-nc-surface px-2 py-1 text-xs text-nc-text font-mono"
                />
                <span className="text-nc-text-muted text-[10px]">
                  Goes to the host-side provider only — never stored in the UI, the sandbox, or git.
                </span>
              </label>
              <Field label="Example endpoints" value={restForm.endpoints} onChange={(v) => setRestForm({ ...restForm, endpoints: v })} placeholder="/deals, /persons" hint="comma-separated paths — helps the agent (optional)" />
              <Field label="What it's for" value={restForm.description} onChange={(v) => setRestForm({ ...restForm, description: v })} placeholder="Pipedrive CRM — read/write deals and contacts" />
              <div className="flex items-center gap-2 pt-1">
                <button
                  disabled={adding || !restForm.name || !restForm.baseUrl || !restForm.secretEnv || !restForm.secretValue}
                  onClick={submitRest}
                  className="rounded bg-nc-green px-3 py-1.5 text-xs text-nc-bg font-medium hover:opacity-90 disabled:opacity-40"
                >
                  {adding ? "Connecting…" : "Connect API"}
                </button>
                <button
                  onClick={() => setShowAdd(false)}
                  className="rounded border border-nc-border px-3 py-1.5 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : addMode === "mcp" ? (
            <>
              <p className="text-nc-text-muted text-xs">
                Connect an MCP server. The secret is held host-side — the agent only ever sees a
                placeholder. Pick how the server authenticates:
                <br />• <b>URL-token</b> (Zapier): paste the URL with its <code>?token=…</code>.
                <br />• <b>Authorization: Bearer</b> (GoHighLevel): paste the plain URL and your token — the <code>Bearer</code> scheme is added for you.
              </p>
              <Field label="Name *" value={mcpForm.name} onChange={(v) => setMcpForm({ ...mcpForm, name: v })} placeholder="myghl" hint="lowercase, a-z0-9-" />
              <Field label="MCP server URL *" value={mcpForm.url} onChange={(v) => setMcpForm({ ...mcpForm, url: v })} placeholder="https://services.leadconnectorhq.com/mcp/" hint="https URL (include the ?token=… for URL-token servers; plain for header auth)" />
              <label className="block">
                <span className="text-nc-text-dim text-xs">Authentication</span>
                <select
                  value={mcpForm.authStyle}
                  onChange={(e) => setMcpForm({ ...mcpForm, authStyle: e.target.value })}
                  className="mt-0.5 w-full rounded border border-nc-border bg-nc-bg px-2 py-1 text-xs text-nc-text"
                >
                  {MCP_AUTH_STYLES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              {mcpForm.authStyle === "Custom header…" && (
                <Field label="Custom header" value={mcpForm.authCustom} onChange={(v) => setMcpForm({ ...mcpForm, authCustom: v })} placeholder="X-Api-Key  or  Authorization: Bearer" hint="header name, optionally with a scheme after a colon" />
              )}
              {!mcpForm.authStyle.startsWith("URL-token") && (
                <Field label="API key / token *" value={mcpForm.apiKey} onChange={(v) => setMcpForm({ ...mcpForm, apiKey: v })} placeholder="pit-… (just the token)" hint="held host-side; the agent only sees a placeholder. Don't include the scheme — it's added for you." />
              )}
              <label className="block">
                <span className="text-nc-text-dim text-xs">Additional headers (optional)</span>
                <textarea
                  value={mcpForm.extra}
                  onChange={(e) => setMcpForm({ ...mcpForm, extra: e.target.value })}
                  rows={2}
                  placeholder={"locationId: YOUR_LOCATION_ID"}
                  className="mt-0.5 w-full rounded border border-nc-border bg-nc-bg px-2 py-1 font-mono text-xs text-nc-text"
                />
                <span className="text-nc-text-muted text-[11px]">
                  One <code>Name: Value</code> per line. Each value is held host-side too — the
                  agent only ever sees a placeholder. GoHighLevel needs{" "}
                  <code>locationId: &lt;your sub-account id&gt;</code>.
                </span>
              </label>
              <div className="flex items-center gap-2 pt-1">
                <button
                  disabled={adding || !mcpForm.name || !mcpForm.url}
                  onClick={submitMcp}
                  className="rounded bg-nc-green px-3 py-1.5 text-xs text-nc-bg font-medium hover:opacity-90 disabled:opacity-40"
                >
                  {adding ? "Connecting…" : "Connect MCP"}
                </button>
                <button
                  onClick={() => setShowAdd(false)}
                  className="rounded border border-nc-border px-3 py-1.5 text-xs text-nc-text-dim hover:bg-nc-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-nc-text-muted text-xs">
                Registers a git-cloneable CLI and installs it into the running sandbox now (clone +
                build, ~a minute). It also re-bakes on the next recreate. The build runs inside the
                sandbox.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="gdrive" hint="lowercase, a-z0-9-" />
                <Field label="Binary" value={form.bin} onChange={(v) => setForm({ ...form, bin: v })} placeholder="(defaults to name)" />
                <Field label="Git repo *" value={form.repo} onChange={(v) => setForm({ ...form, repo: v })} placeholder="https://github.com/owner/cli.git" />
                <Field label="Ref" value={form.ref} onChange={(v) => setForm({ ...form, ref: v })} placeholder="main" />
                <Field label="Entry *" value={form.entry} onChange={(v) => setForm({ ...form, entry: v })} hint="path run by the bin, e.g. dist/index.js" />
                <Field label="API host(s)" value={form.apiHosts} onChange={(v) => setForm({ ...form, apiHosts: v })} placeholder="api.example.com:443" hint="comma-separated host:port" />
                <Field label="Secret env key" value={form.secretEnv} onChange={(v) => setForm({ ...form, secretEnv: v })} placeholder="API_KEY or api-key" hint="letters/digits/_/- (e.g. API_KEY, api_key, x-api-key)" />
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
            </>
          )}
        </div>
      )}

      {/* Create-time binding note: tools reach the CHAT agent only at sandbox create. */}
      {chatNote && (
        <div className="space-y-2 rounded border border-nc-border bg-nc-surface px-3 py-2 text-xs text-nc-text-dim">
          <div>
            <span className="text-nc-text font-medium font-mono">{chatNote}</span> is connected and
            usable in headless / exec sessions now. To use it in{" "}
            <span className="text-nc-text">chat</span>, redeploy the sandbox — the chat agent binds
            tools at sandbox create.
          </div>
          <div className="flex items-center gap-2">
            {onRedeploy && (
              <button
                onClick={onRedeploy}
                className="rounded bg-nc-green/15 px-2 py-1 text-xs font-medium text-nc-green hover:bg-nc-green/25"
              >
                Redeploy now
              </button>
            )}
            <button
              onClick={() => setChatNote(null)}
              className="text-nc-text-muted underline hover:text-nc-text"
            >
              dismiss
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

      {mcpServers.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="text-nc-text-dim text-xs font-medium">Connected MCP servers</div>
          {mcpServers.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between gap-3 rounded border border-nc-border bg-nc-bg p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-nc-text text-sm font-medium font-mono">{s.name}</span>
                  <span className="text-nc-text-muted text-xs truncate">→ {s.host.split(":")[0]}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Badge ok={true} label="Connected" />
                  <Badge ok={true} label="Secret host-side" />
                </div>
              </div>
              <button
                disabled={removing === s.name}
                onClick={() => disconnectMcp(s.name)}
                className="shrink-0 rounded bg-nc-danger/10 px-3 py-1.5 text-xs text-nc-danger hover:bg-nc-danger/20 disabled:opacity-40"
              >
                {removing === s.name ? "Removing…" : "Disconnect"}
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && tools.length === 0 ? (
        <div className="text-nc-text-muted text-xs">Loading…</div>
      ) : tools.length === 0 ? (
        mcpServers.length === 0 ? (
          <div className="text-nc-text-muted text-xs">No tools or MCP servers yet — add one above.</div>
        ) : null
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
                <div className="shrink-0 flex items-center gap-2">
                  <button
                    disabled={!running || (t.secretKeys.length === 0 && t.configKeys.length === 0)}
                    onClick={() => (openTool === t.name ? setOpenTool(null) : startConnect(t))}
                    className="rounded bg-nc-green/15 px-3 py-1.5 text-xs text-nc-green hover:bg-nc-green/25 disabled:opacity-40"
                  >
                    {t.status.connected ? "Reconnect" : "Connect"}
                  </button>
                  <button
                    disabled={removing === t.name}
                    onClick={() => removeTool(t)}
                    title="Remove this tool from the registry and the sandbox"
                    className="rounded bg-nc-danger/10 px-3 py-1.5 text-xs text-nc-danger hover:bg-nc-danger/20 disabled:opacity-40"
                  >
                    {removing === t.name ? "Removing…" : "Remove"}
                  </button>
                </div>
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
