"use client";

import { useState, useEffect, useRef } from "react";
import FilesTab from "./FilesTab";
import ToolsTab from "./ToolsTab";

interface Props {
  sandboxName: string;
  onDestroyed: () => void;
  // Return to the multi-sandbox list view. Optional so the component still works
  // standalone (e.g. a single-sandbox deployment with no list).
  onBack?: () => void;
  // True once the fleet serves this sandbox at /<name>/agent/. When set, the Web
  // Dashboard link points at the sandbox's OWN path (/<name>/agent/) instead of
  // the shared legacy /agent (which always serves the default sandbox).
  chatReady?: boolean;
  // Only admins may destroy a sandbox (the API enforces it; this hides the button).
  isAdmin?: boolean;
}

export default function Dashboard({ sandboxName, onDestroyed, onBack, chatReady, isAdmin }: Props) {
  const [activeTab, setActiveTab] = useState<"status" | "files" | "tools" | "logs" | "policies" | "rules">("status");
  const [status, setStatus] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
  const [policyYaml, setPolicyYaml] = useState("");
  const [rulesOutput, setRulesOutput] = useState("");
  const [ruleAction, setRuleAction] = useState<Record<string, string>>({});
  const [forwardActive, setForwardActive] = useState(false);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [gatewayToken, setGatewayToken] = useState("");
  const [tokenCopied, setTokenCopied] = useState("");
  // Redeploy (sandbox recreate) progress overlay.
  const [redeploying, setRedeploying] = useState(false);
  const [redeployDone, setRedeployDone] = useState(false);
  const [redeployFailed, setRedeployFailed] = useState(false);
  // Global deploy lock: ANY in-progress deploy on the server (dashboard- or
  // CLI-initiated, and surviving a page reload) locks the whole dashboard until
  // it finishes or fails. Driven by polling /api/deploy/status (a host process check).
  const [deployLive, setDeployLive] = useState(false);
  const deployWasLive = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  function checkForward() {
    fetch("/api/forward")
      .then((r) => r.json())
      .then((data) => setForwardActive(data.active))
      .catch(() => setForwardActive(false));
  }

  function startForward() {
    setForwardLoading(true);
    fetch(`/api/forward?sandbox=${sandboxName}&port=9119`, { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        setForwardActive(data.success);
        setForwardLoading(false);
      })
      .catch(() => setForwardLoading(false));
  }

  // Recreate the sandbox so the chat daemon re-binds tools / MCP servers connected
  // since the last create (OpenShell binds a tool's credential to the chat agent
  // only at sandbox create). The backend's action=redeploy mode omits provider/model
  // so the inference route is preserved; only relative URLs are used so this works
  // on any client's domain.
  function startRedeploy() {
    if (redeploying) return;
    if (
      !confirm(
        `Redeploy "${sandboxName}"?\n\n` +
          `This recreates the sandbox so the chat agent picks up newly-connected ` +
          `tools and MCP servers. Your /sandbox files and the current model are ` +
          `preserved. Chat is interrupted for about two minutes.`,
      )
    )
      return;
    setRedeploying(true);
    setRedeployDone(false);
    setRedeployFailed(false);
    // The onboard stream carries internal logs (provider names, build steps); they
    // are NOT shown — only a clean progress / done / failed state is surfaced. We
    // still read the stream to know WHEN it finished and whether it errored.
    let failed = false;
    const es = new EventSource(
      `/api/deploy?action=redeploy&sandboxName=${encodeURIComponent(sandboxName)}`,
    );
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "error") {
          failed = true;
          setRedeployFailed(true);
        } else if (data.type === "done") {
          setRedeployDone(true);
          es.close();
        }
      } catch {
        /* keep-alive / partial frame */
      }
    };
    es.onerror = () => {
      // EventSource also fires onerror on a normal end-of-stream close. The `done`
      // event is authoritative; if the stream drops before it, mark complete (unless
      // an error was already seen) so the user is never stuck on a spinner.
      es.close();
      if (failed) setRedeployFailed(true);
      else setRedeployDone(true);
    };
  }

  useEffect(() => {
    fetch(`/api/status?sandbox=${sandboxName}`)
      .then((r) => r.json())
      .then((data) => {
        setStatus(data.status || {});
        setPolicies(data.policies || []);
      })
      .catch(() => {});

    checkForward();
    const interval = setInterval(checkForward, 30000);

    fetch(`/api/gateway-token?sandbox=${sandboxName}`)
      .then((r) => r.json())
      .then((data) => setGatewayToken(data.token || ""))
      .catch(() => {});

    return () => clearInterval(interval);
  }, [sandboxName]);

  // Poll for an in-progress deploy and lock the dashboard while one runs. Self-healing
  // (process-based) and reload-proof: if the page is refreshed mid-deploy, the lock
  // re-appears; when the deploy finishes/fails, it clears and we refresh status.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/deploy/status");
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        const live = !!d.live;
        setDeployLive(live);
        if (deployWasLive.current && !live) {
          // A deploy just finished — refresh status so the dashboard reflects it.
          fetch(`/api/status?sandbox=${sandboxName}`)
            .then((r) => r.json())
            .then((data) => {
              setStatus(data.status || {});
              setPolicies(data.policies || []);
            })
            .catch(() => {});
        }
        deployWasLive.current = live;
      } catch {
        /* ignore transient poll errors */
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sandboxName]);

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setTokenCopied(label);
      setTimeout(() => setTokenCopied(""), 2000);
    });
  }

  function refreshRules() {
    return fetch(`/api/status?sandbox=${sandboxName}&rules=true`)
      .then((r) => r.json())
      .then((data) => setRulesOutput(data.rules || ""));
  }

  // Rules are re-decidable: openshell honors flipping an already-decided rule, and the
  // change is reflected in the effective egress policy. So after a click we hold the
  // button in "loading" until we re-fetch the rules, then clear the per-chunk action
  // state so the controls render from openshell's real, current status (rule.status).
  function handleRuleAction(chunkId: string, action: "approve" | "reject") {
    setRuleAction((prev) => ({ ...prev, [chunkId]: "loading" }));
    fetch(`/api/rules?sandbox=${sandboxName}&chunkId=${chunkId}&action=${action}`, {
      method: "POST",
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          return refreshRules().finally(() => {
            setRuleAction((prev) => {
              const next = { ...prev };
              delete next[chunkId];
              return next;
            });
          });
        }
        setRuleAction((prev) => ({ ...prev, [chunkId]: "error" }));
      })
      .catch(() => {
        setRuleAction((prev) => ({ ...prev, [chunkId]: "error" }));
      });
  }

  // Prefer this sandbox's OWN path (/<name>/agent) so the link opens THIS
  // sandbox's chat, not the default sandbox's legacy /agent. Fall back to /agent
  // when the fleet isn't serving this sandbox yet.
  const dashboardUrl =
    typeof window !== "undefined"
      ? chatReady
        ? `${window.location.origin}/${encodeURIComponent(sandboxName)}/agent`
        : `${window.location.origin}/agent`
      : "/agent";
  const dashboardUrlWithToken = gatewayToken
    ? `${dashboardUrl}/?password=${gatewayToken}#token=${gatewayToken}`
    : `${dashboardUrl}/`;

  // Stream logs from openshell logs --tail
  useEffect(() => {
    if (activeTab !== "logs") return;

    const eventSource = new EventSource(
      `/api/status?sandbox=${sandboxName}&logs=true`
    );
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        setLogs((prev) => [...prev.slice(-500), data.message]);
      }
    };
    return () => eventSource.close();
  }, [activeTab, sandboxName]);

  // Fetch full policy YAML from openshell policy get --full
  useEffect(() => {
    if (activeTab !== "policies") return;

    fetch(`/api/status?sandbox=${sandboxName}&policy=true`)
      .then((r) => r.json())
      .then((data) => setPolicyYaml(data.policy || ""))
      .catch(() => {});
  }, [activeTab, sandboxName]);

  // Fetch network rules from openshell rule get
  useEffect(() => {
    if (activeTab !== "rules") return;

    fetch(`/api/status?sandbox=${sandboxName}&rules=true`)
      .then((r) => r.json())
      .then((data) => setRulesOutput(data.rules || ""))
      .catch(() => {});
  }, [activeTab, sandboxName]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const tabs = [
    { key: "status" as const, label: "Status" },
    { key: "files" as const, label: "Files" },
    { key: "tools" as const, label: "Tools" },
    { key: "logs" as const, label: "Logs" },
    { key: "policies" as const, label: "Policy" },
    { key: "rules" as const, label: "Rules" },
  ];

  // Strip ANSI escape codes for clean display
  function stripAnsi(text: string) {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
  }

  // Parse rules into structured data
  function parseRules(raw: string) {
    const clean = stripAnsi(raw);
    const chunks = clean.split(/Chunk:\s*/);
    return chunks.slice(1).map((chunk) => {
      const id = chunk.match(/^(\S+)/)?.[1] || "";
      const statusMatch = chunk.match(/Status:\s*(\S+)/);
      const rule = chunk.match(/Rule:\s*(.+)/)?.[1]?.trim() || "";
      const binary = chunk.match(/Binary:\s*(.+)/)?.[1]?.trim() || "";
      const confidence = chunk.match(/Confidence:\s*(.+)/)?.[1]?.trim() || "";
      const endpoints = chunk.match(/Endpoints:\s*(.+)/)?.[1]?.trim() || "";
      const hits = chunk.match(/Hits:\s*(.+)/)?.[1]?.trim() || "";
      return {
        id,
        status: statusMatch?.[1] || "unknown",
        rule,
        binary,
        confidence,
        endpoints,
        hits,
      };
    });
  }

  // Color log lines based on content
  function logColor(line: string) {
    if (line.includes("DENIED") || line.includes("BLOCKED")) return "text-nc-danger";
    if (line.includes("WARN")) return "text-nc-warning";
    if (line.includes("ALLOWED")) return "text-nc-text-muted";
    if (line.includes("ERROR")) return "text-nc-danger";
    return "text-nc-text-dim";
  }

  return (
    <div className="w-full max-w-3xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="text-xs text-nc-text-muted hover:text-nc-text transition-all mb-1"
            >
              ← All sandboxes
            </button>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">Diffract</h1>
          <p className="text-nc-text-muted text-sm mt-0.5">
            Sandbox: <span className="text-nc-text font-mono">{sandboxName}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-nc-success animate-pulse" />
          <span className="text-sm text-nc-success font-medium">Running</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-nc-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-nc-green text-nc-green"
                : "border-transparent text-nc-text-muted hover:text-nc-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Status Tab */}
      {activeTab === "status" && (
        <div className="space-y-4">
          {/* OpenClaw Dashboard Access */}
          <div className="p-4 rounded-lg bg-nc-surface border border-nc-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-nc-text">Diffract Web Dashboard</div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${forwardActive ? "bg-nc-success" : "bg-nc-danger"}`} />
                  <span className={`text-xs font-medium ${forwardActive ? "text-nc-success" : "text-nc-danger"}`}>
                    {forwardActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <button
                  onClick={startForward}
                  disabled={forwardLoading}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    forwardLoading
                      ? "bg-nc-border text-nc-text-dim cursor-wait"
                      : forwardActive
                      ? "bg-nc-surface-hover border border-nc-border text-nc-text-muted hover:text-nc-text"
                      : "bg-nc-green text-black hover:bg-nc-green-dark"
                  }`}
                >
                  {forwardLoading ? "Starting..." : forwardActive ? "Restart Forward" : "Start Forward"}
                </button>
              </div>
            </div>

            {/* URL with embedded token */}
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2 rounded-md bg-nc-bg border border-nc-border font-mono text-xs text-nc-text-muted truncate">
                {dashboardUrlWithToken}
              </div>
              <button
                onClick={() => copyToClipboard(dashboardUrlWithToken, "url")}
                className="px-2.5 py-2 rounded-md border border-nc-border text-xs text-nc-text-muted hover:text-nc-text hover:bg-nc-surface-hover transition-all shrink-0"
              >
                {tokenCopied === "url" ? "Copied!" : "Copy URL"}
              </button>
              {forwardActive && (
                <a
                  href={dashboardUrlWithToken}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-2 rounded-md bg-nc-green text-black text-xs font-medium hover:bg-nc-green-dark transition-all shrink-0"
                >
                  Open
                </a>
              )}
            </div>

            {/* Gateway token row */}
            {gatewayToken && (
              <div className="flex items-center gap-2">
                <div className="text-xs text-nc-text-dim shrink-0">Token:</div>
                <div className="flex-1 px-3 py-2 rounded-md bg-nc-bg border border-nc-border font-mono text-xs text-nc-text-dim truncate">
                  {gatewayToken}
                </div>
                <button
                  onClick={() => copyToClipboard(gatewayToken, "token")}
                  className="px-2.5 py-2 rounded-md border border-nc-border text-xs text-nc-text-muted hover:text-nc-text hover:bg-nc-surface-hover transition-all shrink-0"
                >
                  {tokenCopied === "token" ? "Copied!" : "Copy Token"}
                </button>
              </div>
            )}
          </div>

          {/* Status Cards */}
          <div className="grid grid-cols-2 gap-4">
            <StatusCard label="Sandbox" value={sandboxName} />
            <StatusCard label="Status" value={status.state || "Running"} valueColor="text-nc-success" />
            <StatusCard label="Provider" value={status.provider || "—"} />
            <StatusCard label="Model" value={status.model || "—"} />
            <StatusCard label="GPU" value={status.gpu || "No"} />
            <StatusCard label="Policies" value={policies.length > 0 ? policies.join(", ") : "—"} />
          </div>

          <div className="flex gap-3 mt-2">
            <ActionButton label="Connect" desc="Copy SSH command" onClick={() => {
              navigator.clipboard.writeText(`nemohermes ${sandboxName} connect`);
              setTokenCopied("connect");
              setTimeout(() => setTokenCopied(""), 2000);
            }} labelOverride={tokenCopied === "connect" ? "Copied!" : undefined} />
            {isAdmin && (
            <ActionButton label="Redeploy" desc="Recreate the sandbox to load newly-connected tools / MCP servers into chat (model preserved)" variant="secondary" onClick={startRedeploy} />
            )}
            {isAdmin && (
            <ActionButton label="Destroy" desc="Delete sandbox" variant="danger" onClick={() => {
              if (
                confirm(
                  `Destroy sandbox "${sandboxName}"?\n\n` +
                    `Your working files in /sandbox are backed up first. To get them back, recreate the sandbox with the SAME name ("${sandboxName}").\n\n` +
                    `Installed tools baked into the image (e.g. GHL CLI) always return. Tools you installed into /sandbox yourself will NOT be restored with working deps — those should be baked in.`,
                )
              ) {
                fetch(`/api/deploy?action=destroy&sandbox=${sandboxName}`, { method: "DELETE" })
                  .then((r) => r.json())
                  .then((data) => {
                    if (data.success) {
                      const saved = typeof data.backup === "string" && data.backup.includes("saved");
                      alert(
                        saved
                          ? `Sandbox destroyed. Your working files were backed up — recreate with the name "${sandboxName}" to restore them.`
                          : `Sandbox destroyed. (No working files needed backing up.)`,
                      );
                      onDestroyed();
                    }
                  })
                  .catch(() => {});
              }
            }} />
            )}
          </div>
        </div>
      )}

      {/* Files Tab — browse / upload / download files in the sandbox */}
      {activeTab === "files" && <FilesTab sandboxName={sandboxName} />}

      {activeTab === "tools" && (
        <ToolsTab sandboxName={sandboxName} onRedeploy={startRedeploy} />
      )}

      {/* Logs Tab — openshell logs --tail */}
      {activeTab === "logs" && (
        <div
          ref={logRef}
          className="h-[32rem] overflow-y-auto rounded-lg bg-nc-surface border border-nc-border p-4 font-mono text-xs leading-5"
        >
          {logs.length === 0 && (
            <div className="text-nc-text-dim">Connecting to openshell logs...</div>
          )}
          {logs.map((log, i) => (
            <div key={i} className={logColor(log)}>
              {stripAnsi(log)}
            </div>
          ))}
        </div>
      )}

      {/* Policy Tab — openshell policy get --full */}
      {activeTab === "policies" && (
        <div className="space-y-4">
          {/* Quick preset view */}
          <div>
            <div className="text-xs text-nc-text-dim mb-2">Active Presets</div>
            <div className="grid grid-cols-4 gap-1.5">
              {policies.map((p) => (
                <div
                  key={p}
                  className="px-2.5 py-1.5 rounded-md border border-nc-green/50 bg-nc-green/10 text-nc-green text-xs font-medium text-center"
                >
                  {p}
                </div>
              ))}
            </div>
          </div>

          {/* Full policy YAML */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-nc-text-dim">Full Policy (openshell policy get --full)</div>
              <button
                onClick={() => copyToClipboard(stripAnsi(policyYaml), "policy")}
                className="px-2 py-1 rounded text-xs text-nc-text-dim hover:text-nc-text-muted transition-all"
              >
                {tokenCopied === "policy" ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre className="h-96 overflow-y-auto rounded-lg bg-nc-surface border border-nc-border p-4 font-mono text-xs leading-5 text-nc-text-muted whitespace-pre-wrap">
              {policyYaml ? stripAnsi(policyYaml) : "Loading policy..."}
            </pre>
          </div>
        </div>
      )}

      {/* Rules Tab — openshell rule get */}
      {activeTab === "rules" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-nc-text-dim">Network Rules</div>
            <button
              onClick={refreshRules}
              className="px-2 py-1 rounded text-xs text-nc-text-dim hover:text-nc-text-muted transition-all"
            >
              Refresh
            </button>
          </div>

          {rulesOutput ? (
            parseRules(rulesOutput).length > 0 ? (
              parseRules(rulesOutput).map((rule) => {
                const actionState = ruleAction[rule.id];
                const isPending = rule.status === "pending";

                return (
                  <div
                    key={rule.id}
                    className={`p-3 rounded-lg bg-nc-surface border space-y-2 ${
                      isPending ? "border-nc-warning/30" : "border-nc-border"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-nc-text">{rule.rule}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          rule.status === "approved"
                            ? "bg-nc-success/10 text-nc-success"
                            : rule.status === "rejected"
                            ? "bg-nc-danger/10 text-nc-danger"
                            : "bg-nc-warning/10 text-nc-warning"
                        }`}
                      >
                        {rule.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div><span className="text-nc-text-dim">Endpoints:</span> <span className="text-nc-text-muted">{rule.endpoints}</span></div>
                      <div><span className="text-nc-text-dim">Binary:</span> <span className="text-nc-text-muted">{rule.binary}</span></div>
                      <div><span className="text-nc-text-dim">Confidence:</span> <span className="text-nc-text-muted">{rule.confidence}</span></div>
                      <div><span className="text-nc-text-dim">Hits:</span> <span className="text-nc-text-muted">{rule.hits}</span></div>
                    </div>
                    <div className="text-xs text-nc-text-dim font-mono truncate">{rule.id}</div>

                    {/* Approve / Reject — always available so a decision can be changed at
                        any time (rules are re-decidable; the flip also updates the effective
                        egress policy). The active side reflects openshell's current status,
                        refreshed after each click; clicking the other side flips it. */}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => handleRuleAction(rule.id, "approve")}
                        disabled={actionState === "loading" || rule.status === "approved"}
                        aria-pressed={rule.status === "approved"}
                        className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                          actionState === "loading"
                            ? "bg-nc-border text-nc-text-dim cursor-wait"
                            : rule.status === "approved"
                            ? "bg-nc-success/20 text-nc-success ring-1 ring-nc-success/40 cursor-default"
                            : "bg-nc-success/10 border border-nc-success/30 text-nc-success hover:bg-nc-success/20"
                        }`}
                      >
                        {actionState === "loading" ? "..." : rule.status === "approved" ? "✓ Approved" : "Approve"}
                      </button>
                      <button
                        onClick={() => handleRuleAction(rule.id, "reject")}
                        disabled={actionState === "loading" || rule.status === "rejected"}
                        aria-pressed={rule.status === "rejected"}
                        className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                          actionState === "loading"
                            ? "bg-nc-border text-nc-text-dim cursor-wait"
                            : rule.status === "rejected"
                            ? "bg-nc-danger/20 text-nc-danger ring-1 ring-nc-danger/40 cursor-default"
                            : "bg-nc-danger/10 border border-nc-danger/30 text-nc-danger hover:bg-nc-danger/20"
                        }`}
                      >
                        {actionState === "loading" ? "..." : rule.status === "rejected" ? "✓ Rejected" : "Reject"}
                      </button>
                    </div>
                    {actionState === "error" && (
                      <div className="text-xs text-nc-danger pt-1">Action failed — try again.</div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="p-4 rounded-lg bg-nc-surface border border-nc-border text-nc-text-dim text-sm text-center">
                No network rules found
              </div>
            )
          ) : (
            <div className="p-4 rounded-lg bg-nc-surface border border-nc-border text-nc-text-dim text-sm text-center">
              Loading rules...
            </div>
          )}
        </div>
      )}

      {/* Redeploy progress overlay — internal onboard logs are intentionally hidden;
          only a clean progress / complete / failed state is shown. */}
      {redeploying && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-nc-border bg-nc-surface p-5">
            <div className="flex items-center gap-2">
              {!redeployDone && !redeployFailed && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-nc-green border-t-transparent" />
              )}
              <h3 className="text-sm font-semibold text-nc-text">
                {redeployFailed
                  ? "Redeploy failed"
                  : redeployDone
                    ? "Redeploy complete"
                    : "Redeploying…"}
              </h3>
            </div>
            <p className="text-xs text-nc-text-muted">
              {redeployFailed
                ? "The sandbox could not be redeployed. Please try again in a moment."
                : redeployDone
                  ? "Your connected tools and MCP servers are now available in chat. Start a new chat (or send a message) to use them."
                  : "Recreating the sandbox so the chat agent picks up connected tools. This takes about two minutes — keep this tab open."}
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setRedeploying(false);
                  setRedeployDone(false);
                  setRedeployFailed(false);
                  // Re-read status so Provider / Model / state reflect the new sandbox.
                  fetch(`/api/status?sandbox=${sandboxName}`)
                    .then((r) => r.json())
                    .then((data) => setStatus(data.status || {}))
                    .catch(() => {});
                }}
                disabled={!redeployDone && !redeployFailed}
                className="rounded-md bg-nc-green px-3 py-1.5 text-xs font-medium text-black transition-all hover:bg-nc-green-dark disabled:cursor-not-allowed disabled:opacity-40"
              >
                {redeployFailed ? "Close" : redeployDone ? "Done" : "Please wait…"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global deploy lock — shown for ANY in-progress deploy on the server (incl.
          ones started elsewhere or before a reload). No dismiss: the dashboard is
          locked until the deploy finishes or fails. The local redeploy overlay above
          supersedes it for a redeploy started from this session. */}
      {deployLive && !redeploying && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-nc-border bg-nc-surface p-5 text-center">
            <div className="flex items-center justify-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-nc-green border-t-transparent" />
              <h3 className="text-sm font-semibold text-nc-text">Deployment in progress</h3>
            </div>
            <p className="text-xs text-nc-text-muted">
              A deploy is running on this server. The dashboard is locked until it finishes or
              fails — this usually takes a couple of minutes. Keep this tab open; it unlocks
              automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusCard({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="px-4 py-3 rounded-lg bg-nc-surface border border-nc-border">
      <div className="text-xs text-nc-text-dim mb-1">{label}</div>
      <div className={`text-sm font-medium truncate ${valueColor || "text-nc-text"}`}>
        {value}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  desc,
  variant = "primary",
  onClick,
  labelOverride,
}: {
  label: string;
  desc: string;
  variant?: "primary" | "secondary" | "danger";
  onClick: () => void;
  labelOverride?: string;
}) {
  const styles = {
    primary:
      "bg-nc-green text-black hover:bg-nc-green-dark",
    secondary:
      "bg-nc-surface border border-nc-border text-nc-text hover:bg-nc-surface-hover",
    danger:
      "bg-nc-danger/10 border border-nc-danger/30 text-nc-danger hover:bg-nc-danger/20",
  };

  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${styles[variant]}`}
      title={desc}
    >
      {labelOverride || label}
    </button>
  );
}
