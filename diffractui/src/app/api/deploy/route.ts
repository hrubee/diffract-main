export const dynamic = "force-dynamic";
import { spawn, execSync, exec, execFile } from "child_process";
import { existsSync } from "fs";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
// Host helper that captures a sandbox's working files before destroy so they
// survive recreate (OpenShell sandboxes have no volume). Installed by setup.sh.
const PERSIST_SCRIPT = process.env.DIFFRACT_PERSIST_SCRIPT || "/usr/local/bin/diffract-persist.sh";
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;

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

// Defense-in-depth: re-verify the admin session inside the handler, not just
// in proxy.ts (the Next docs warn a matcher change can silently drop coverage).
async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
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
  const env = {
    ...process.env,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_PROVIDER: providerMap[provider] || provider,
    NEMOCLAW_MODEL: model,
    NEMOCLAW_POLICY_MODE: "custom",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_POLICY_PRESETS: policies,
    NEMOCLAW_IGNORE_RUNTIME_RESOURCES: "1",
    // Fall back to the host key when the form field is blank. A blank apiKey must
    // NOT blank out the inherited host credential (e.g. NVIDIA_API_KEY in
    // /etc/diffractui.env): the model-router credential is injected into the agent
    // only at sandbox create and only if present at onboard time, so blanking it
    // leaves the agent with no inference credential ("No inference provider
    // configured") even though the gateway route stays healthy. (Keeping this as a
    // computed property also preserves env's string-index type for the env.NEMOCLAW_*
    // assignments below.)
    [credKey]: apiKey || process.env[credKey] || "",
  };

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
  try {
    const connected = execSync("/usr/local/bin/diffract-tool-sync.sh providers", {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    if (connected) env.NEMOCLAW_SANDBOX_EXTRA_PROVIDERS = connected;
  } catch {
    // sync helper missing or gateway not yet up — deploy proceeds; tools can be
    // wired on a later recreate once connected.
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

      send("log", "Starting Diffract deployment...");
      send("log", `Provider: ${provider}, Model: ${model}`);

      const proc = spawn(`${DIFFRACT} onboard --no-gpu --agent hermes`, [], {
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

        // Restart the port forwarder systemd service (fast; log if it fails so a
        // dead chat backend isn't silent).
        exec(`sudo systemctl restart sandbox-port-forwarder`, (err) => {
          if (err) send("log", `WARN: port forwarder restart failed: ${err.message}`);
        });

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

        send("done", "Deployment complete", {
          sandboxName: sName,
        });
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      });

      proc.on("error", (err) => {
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
