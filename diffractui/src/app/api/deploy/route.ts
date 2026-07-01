export const dynamic = "force-dynamic";
import { spawn, execSync, exec, execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { cookies } from "next/headers";
import { SESSION_COOKIE, getSession } from "@/lib/auth";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
// Host helper that captures a sandbox's working files before destroy so they
// survive recreate (OpenShell sandboxes have no volume). Installed by setup.sh.
const PERSIST_SCRIPT = process.env.DIFFRACT_PERSIST_SCRIPT || "/usr/local/bin/diffract-persist.sh";
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Persisted inference credentials. The model-router key (e.g. NVIDIA_API_KEY) is
// entered in the setup form on the FIRST deploy and otherwise lives ONLY inside
// OpenShell's store, which has no read-back CLI. A "redeploy" recreates the sandbox,
// and onboard's non-interactive inference step REQUIRES the key in the env even
// though it recovers the provider/model — so we stash the key here (root-only, 0600)
// at deploy time and re-inject every stored key on redeploy. Kept in its OWN file
// (not /etc/diffractui.env, which setup.sh rewrites) so it survives setup re-runs.
const CRED_FILE = process.env.DIFFRACT_CRED_FILE || "/etc/diffract/credentials.env";

function loadPersistedCreds(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(CRED_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

function persistCred(key: string, value: string): void {
  if (!value || !/^[A-Z0-9_]+$/.test(key)) return;
  try {
    const creds = loadPersistedCreds();
    creds[key] = value;
    mkdirSync(CRED_FILE.replace(/\/[^/]*$/, ""), { recursive: true, mode: 0o700 });
    writeFileSync(
      CRED_FILE,
      Object.entries(creds).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      { mode: 0o600 },
    );
    chmodSync(CRED_FILE, 0o600);
  } catch {
    /* best-effort; redeploy surfaces a clear onboard error if the key is unavailable */
  }
}

// Best-effort backup of the sandbox home to the host store before we destroy
// the container. Never blocks or fails the destroy — if the helper is missing
// (e.g. local dev) or errors, we just skip it. argv array, no shell.
function backupBeforeDestroy(sandbox: string): Promise<string | null> {
  if (!SANDBOX_NAME_RE.test(sandbox) || !existsSync(PERSIST_SCRIPT)) {
    return Promise.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    let out = "";
    const b = spawn(PERSIST_SCRIPT, ["backup", sandbox]);
    b.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    b.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    b.on("close", () => resolve(out.trim() || "backup attempted"));
    b.on("error", () => resolve(null));
  });
}

// Creating / recreating / destroying sandboxes is an ADMIN operation (boxes are
// provisioned by the operator, then assigned to users). Require an admin session.
async function requireSession(): Promise<Response | null> {
  const s = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (s?.isAdmin) return null;
  return Response.json({ error: "Admin only" }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);

  const provider = searchParams.get("provider") || "nvidia";
  const model = searchParams.get("model") || "";
  const apiKey = searchParams.get("apiKey") || "";
  const sandboxName = searchParams.get("sandboxName") || "";
  const policies = searchParams.get("policies") || "pypi,npm";
  const endpoint = searchParams.get("endpoint") || "";
  const telegramToken = searchParams.get("telegramToken") || "";
  const discordToken = searchParams.get("discordToken") || "";
  const slackToken = searchParams.get("slackToken") || "";

  // Map provider keys to NemoClaw provider identifiers
  const providerMap: Record<string, string> = {
    nvidia: "build",
    openai: "openai",
    anthropic: "anthropic",
    gemini: "gemini",
    custom: "custom",
  };

  // Map provider keys to credential env var names
  const credentialMap: Record<string, string> = {
    nvidia: "NVIDIA_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    custom: "COMPATIBLE_API_KEY",
  };

  const credKey = credentialMap[provider] || "COMPATIBLE_API_KEY";

  // A plain "redeploy" (action=redeploy) just recreates the existing sandbox so the
  // chat daemon re-binds tools / MCP servers connected since the last create. It must
  // NOT touch the inference route: we omit NEMOCLAW_PROVIDER/MODEL/POLICY so
  // `onboard --recreate-sandbox` reuses the sandbox's stored route + policy, and we
  // inherit the host model-router key verbatim. (Proven safe — a recovery recreate
  // with only the host key + --agent hermes preserved the route.) A fresh deploy or
  // provider switch (no action) sets the route + credential from the form instead.
  const redeploy = searchParams.get("action") === "redeploy";

  const env = {
    ...process.env,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_IGNORE_RUNTIME_RESOURCES: "1",
    // Model-router credential. A blank form field must never blank it. On redeploy
    // there is no form, so it is re-injected from the persisted store below (onboard's
    // non-interactive inference step requires the key even when it recovers the
    // provider). The computed key also preserves env's string-index type for the
    // env.NEMOCLAW_* assignments below.
    [credKey]: redeploy ? process.env[credKey] || "" : apiKey || process.env[credKey] || "",
  };

  if (redeploy) {
    // Re-inject every stored inference credential — the key lives only in OpenShell's
    // store (no read-back CLI) and onboard needs it in the env. Provider-agnostic:
    // whichever key the recovered provider needs is present. Persisted at first deploy.
    Object.assign(env, loadPersistedCreds());
  } else {
    // Fresh deploy / provider switch: set the inference route + policy from the form.
    // (On redeploy these are deliberately omitted so onboard reuses the stored route,
    // avoiding inference-route drift when picking up newly-connected tools.)
    env.NEMOCLAW_PROVIDER = providerMap[provider] || provider;
    env.NEMOCLAW_MODEL = model;
    env.NEMOCLAW_POLICY_MODE = "custom";
    env.NEMOCLAW_POLICY_PRESETS = policies;
    // Stash the form key so a later redeploy (which has no form) can supply it.
    if (apiKey) persistCred(credKey, apiKey);
  }

  if (sandboxName) env.NEMOCLAW_SANDBOX_NAME = sandboxName;
  if (endpoint) env.NEMOCLAW_ENDPOINT_URL = endpoint;
  if (telegramToken) env.TELEGRAM_BOT_TOKEN = telegramToken;
  if (discordToken) env.DISCORD_BOT_TOKEN = discordToken;
  if (slackToken) env.SLACK_BOT_TOKEN = slackToken;

  // Diffract universal-tool infra: attach EVERY connected tool (any CLI in the
  // registry that has a provider) at sandbox CREATE so the chat agent can use it.
  // OpenShell >= 0.0.57 injects a tool's credential into the long-running agent
  // daemon only at create, so attaching after create reaches exec sessions but
  // not chat. The list is computed from the registry (diffract-tool-sync.sh) —
  // adding a tool needs no code here. Egress for each is applied after onboard.
  // Per-box isolation: attach only THIS sandbox's connected tools/MCP at create,
  // not the host-global set. A brand-new sandbox has none (starts clean); a
  // recreate re-attaches only its own. `sbxArg` is the validated sandbox name.
  const sbxArg = SANDBOX_NAME_RE.test(sandboxName) ? ` ${sandboxName}` : "";
  try {
    const toolProviders = execSync(`/usr/local/bin/diffract-tool-sync.sh providers${sbxArg}`, {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    // MCP servers also attach their token provider at create (diffract-mcp-sync.sh).
    let mcpProviders = "";
    try {
      mcpProviders = execSync(`/usr/local/bin/diffract-mcp-sync.sh providers${sbxArg}`, {
        encoding: "utf8",
        timeout: 15000,
      }).trim();
    } catch {
      /* mcp sync helper missing — no MCP servers to attach */
    }
    const allProviders = [toolProviders, mcpProviders].filter(Boolean).join(",");
    if (allProviders) env.NEMOCLAW_SANDBOX_EXTRA_PROVIDERS = allProviders;
  } catch {
    // sync helper missing or gateway not yet up — deploy proceeds; tools/MCP can be
    // wired on a later recreate once connected.
  }

  // Inject connected MCP servers into the agent config at CREATE (base64 JSON of
  // {name:{url,enabled}}). generate-config writes them into the chat agent's config
  // at agent-image build time, so the daemon starts WITH the servers enabled and
  // connects once at a clean startup — instead of the fragile post-create write +
  // gateway reload. The URLs hold ${SECRET_ENV} placeholders; the token lives in
  // the OpenShell provider attached at create (above).
  try {
    const mcpConfig = execSync(`/usr/local/bin/diffract-mcp-sync.sh config${sbxArg}`, {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    if (mcpConfig && mcpConfig !== "{}") {
      env.NEMOCLAW_MCP_SERVERS_B64 = Buffer.from(mcpConfig, "utf8").toString("base64");
    }
  } catch {
    /* mcp sync helper missing — no MCP servers to inject at create */
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;
      function send(type: string, message: string, extra?: Record<string, string>) {
        if (isClosed) return;
        try {
          const payload = JSON.stringify({ type, message, ...extra });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch (e) {
          isClosed = true;
        }
      }

      let detectedSandboxName = sandboxName || "";

      send(
        "log",
        redeploy
          ? "Redeploying sandbox to load connected tools into chat..."
          : "Starting Diffract deployment...",
      );
      if (!redeploy) send("log", `Provider: ${provider}, Model: ${model}`);

      // Restart the port forwarder + gateway watchdog. ALWAYS called after onboard,
      // on success AND failure, so a failed deploy never leaves them stopped.
      let forwardersRestarted = false;
      function restartForwarders() {
        if (forwardersRestarted) return;
        forwardersRestarted = true;
        exec("sudo systemctl restart sandbox-port-forwarder diffract-gateway-watchdog", (err) => {
          if (err) send("log", `WARN: forwarder/watchdog restart failed: ${err.message}`);
        });
      }

      // Stop the forwarder + watchdog BEFORE recreating. The forwarder holds host
      // :8642 (the default sandbox's gateway port); during the DEFAULT sandbox's own
      // rebuild that collides ("dashboard port 8642 became host-bound") and aborts
      // onboard — which then DELETES the half-built sandbox, taking the live default
      // down. The watchdog would also thrash the half-built box. restartForwarders()
      // below brings both back once onboard finishes. (Permanent fix for the
      // 2026-06-30 default-recreate outage — replaces the manual stop/restart.)
      try {
        execSync("sudo systemctl stop sandbox-port-forwarder diffract-gateway-watchdog", {
          timeout: 15000,
        });
      } catch {
        /* services absent (e.g. local dev) — nothing to stop */
      }

      const proc = spawn(`${DIFFRACT} onboard --no-gpu --agent hermes --recreate-sandbox`, [], {
        env,
        shell: true,
      });

      proc.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          send("log", line);
          // Detect sandbox name from output
          const sandboxMatch = line.match(/Sandbox\s+'([^']+)'\s+created/);
          if (sandboxMatch) {
            detectedSandboxName = sandboxMatch[1];
          }
          const altMatch = line.match(/sandbox[:\s]+(\S+)/i);
          if (!detectedSandboxName && altMatch && !altMatch[1].includes("...") && !altMatch[1].includes("=")) {
            detectedSandboxName = altMatch[1].replace(/['"]/g, "");
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          send("log", `WARN: ${line}`);
        }
      });

      proc.on("close", async (code) => {
        if (code !== 0) {
          // Bring the forwarder + watchdog back even on failure, so a failed deploy
          // never leaves the live default's chat backend down.
          restartForwarders();
          send("error", `Deployment failed with exit code ${code}`);
          if (!isClosed) {
            isClosed = true;
            controller.close();
          }
          return;
        }

        const sName = detectedSandboxName || "my-assistant";
        if (!detectedSandboxName) {
          send(
            "log",
            `WARN: could not detect the sandbox name from onboard output; assuming "${sName}". Tool egress below may target the wrong sandbox — verify it succeeds.`,
          );
        }

        // Bring the forwarder + watchdog back now that the rebuild is done.
        restartForwarders();

        // Reconcile tool/MCP attachments: detach any provider attached to this
        // sandbox that it does NOT own (per the per-box records) — self-heals
        // isolation on every recreate and cleans stale cross-sandbox attachments
        // (OpenShell can carry attachments across recreate by sandbox name). Never
        // touches the inference provider. Best-effort; streamed into the log.
        if (SANDBOX_NAME_RE.test(sName)) {
          for (const script of ["diffract-tool-sync.sh", "diffract-mcp-sync.sh"]) {
            try {
              const out = execSync(`/usr/local/bin/${script} reconcile ${sName}`, {
                encoding: "utf8",
                timeout: 20000,
              }).trim();
              for (const line of out.split("\n").filter(Boolean)) send("log", line);
            } catch {
              /* reconcile is best-effort */
            }
          }
        }

        // Apply egress (host allowlist + attributed binary, from the registry) for
        // EVERY connected tool to the fresh sandbox, so a tool attached at create
        // can actually reach its API. Registry-driven — covers any tool we add.
        //
        // This is AWAITED and STREAMED on purpose: a tool's credential is injected
        // at create, but egress is applied here. If this step silently failed, the
        // deploy would report success while that tool's API stays blocked in chat
        // until the next recreate. So we surface its per-tool output and exit code
        // into the deploy log, and use execFile (no shell) so the sandbox name
        // can't be used for shell injection.
        await new Promise<void>((resolve) => {
          if (!SANDBOX_NAME_RE.test(sName)) {
            send(
              "log",
              `WARN: sandbox name "${sName}" is not a safe identifier; skipping tool egress. Connected tools will be unreachable in chat until the next recreate.`,
            );
            return resolve();
          }
          const eg = execFile(
            "/usr/local/bin/diffract-tool-sync.sh",
            ["egress", sName],
            { timeout: 120000 },
          );
          eg.stdout?.on("data", (d: Buffer) => {
            for (const line of d.toString().split("\n").filter(Boolean)) send("log", line);
          });
          eg.stderr?.on("data", (d: Buffer) => {
            for (const line of d.toString().split("\n").filter(Boolean)) send("log", `WARN: ${line}`);
          });
          eg.on("close", (egCode) => {
            if (egCode === 0) {
              send("log", "Tool egress applied for all connected tools.");
            } else {
              send(
                "log",
                `WARN: tool egress exited ${egCode} — one or more connected tools may be unreachable in chat until the next recreate. Re-run: diffract-tool-sync.sh egress ${sName}`,
              );
            }
            resolve();
          });
          eg.on("error", (e) => {
            send(
              "log",
              `WARN: could not run tool egress (${e.message}); connected tools may be unreachable in chat until the next recreate.`,
            );
            resolve();
          });
        });

        // Apply every connected MCP server (egress + agent config + gateway
        // reload) to the fresh sandbox, mirroring the tool egress above. The MCP
        // provider is attached at create (NEMOCLAW_SANDBOX_EXTRA_PROVIDERS), so the
        // daemon already holds the token placeholder; this wires the mcp_servers
        // config so the chat agent can use the server's tools. Record-driven —
        // covers any MCP server connected from the dashboard.
        await new Promise<void>((resolve) => {
          if (!SANDBOX_NAME_RE.test(sName)) return resolve();
          const mc = execFile(
            "/usr/local/bin/diffract-mcp-sync.sh",
            ["apply", sName],
            { timeout: 120000 },
          );
          mc.stdout?.on("data", (d: Buffer) => {
            for (const line of d.toString().split("\n").filter(Boolean)) send("log", line);
          });
          mc.stderr?.on("data", (d: Buffer) => {
            for (const line of d.toString().split("\n").filter(Boolean)) send("log", `WARN: ${line}`);
          });
          mc.on("close", (mcCode) => {
            if (mcCode === 0) {
              send("log", "MCP servers applied for all connected servers.");
            } else {
              send(
                "log",
                `WARN: MCP apply exited ${mcCode} — connected MCP servers may be unavailable in chat until the next recreate.`,
              );
            }
            resolve();
          });
          mc.on("error", (e) => {
            send(
              "log",
              `WARN: could not run MCP apply (${e.message}); MCP servers may be unavailable in chat until the next recreate.`,
            );
            resolve();
          });
        });

        send("done", "Deployment complete", {
          sandboxName: sName,
        });
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      });

      proc.on("error", (err) => {
        // Onboard never started — restore the services we stopped above.
        restartForwarders();
        send("error", `Failed to start: ${err.message}`);
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox");

  if (!sandbox) {
    return Response.json({ error: "Sandbox name required" }, { status: 400 });
  }

  // Capture the user's working files to the host store BEFORE destroying, so a
  // recreated sandbox can restore them. Best-effort; never blocks the destroy.
  const backup = await backupBeforeDestroy(sandbox);

  const proc = spawn(DIFFRACT, [sandbox, "destroy", "--yes"], {
    shell: true,
  });

  return new Promise<Response>((resolve) => {
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Response.json({ success: true, backup }));
      } else {
        resolve(Response.json({ error: "Destroy failed", backup }, { status: 500 }));
      }
    });
  });
}
