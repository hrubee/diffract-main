import { spawn } from "child_process";

const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";

// Ports served by the sandbox-port-forwarder systemd service via a socat
// loopback-reorigination chain — NOT an `openshell forward`. 9119 (the agent
// dashboard + chat WebSocket) is the canonical case: its dashboard lives in the
// CONTAINER netns, but an `openshell forward` (ssh -L) lands in the WORKLOAD
// netns, so it forwards to nothing and the path 502s. So for these ports we must
// NEVER kill the listener or create an openshell forward — doing so is exactly
// what broke /chat. We only health-check and, if down, re-assert the managed
// service (which rebuilds the socat chain).
const SERVICE_MANAGED_PORTS = new Set(["9119", "9118"]);
const FORWARDER_SERVICE = "sandbox-port-forwarder.service";

async function agentPathHealthy(): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:9119/agent/", {
      signal: AbortSignal.timeout(4000),
      redirect: "manual",
    });
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "my-assistant";
  const port = searchParams.get("port") || "18789";

  // ── Service-managed (socat) ports: never openshell-forward, never kill ──
  if (SERVICE_MANAGED_PORTS.has(port)) {
    if (await agentPathHealthy()) {
      return Response.json({ success: true, message: "agent forward healthy (socat, service-managed)" });
    }
    // Down — let the forwarder rebuild the socat chain. (Restarting the service
    // is the safe recovery; it does NOT create an openshell forward for 9119.)
    try {
      await runCommand("systemctl", ["restart", FORWARDER_SERVICE]);
      return Response.json({ success: true, message: "rebuilt agent forward via sandbox-port-forwarder" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ success: false, message }, { status: 500 });
    }
  }

  // ── Other ports (e.g. workload-netns gateways): openshell forward is correct ──
  // First kill any stale SSH process holding the port.
  try {
    await runCommand("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"]).then((pids) => {
      const pidList = pids.trim().split("\n").filter(Boolean);
      for (const pid of pidList) {
        try {
          process.kill(Number(pid));
        } catch {
          // ignore
        }
      }
    });
  } catch {
    // no process on port, that's fine
  }

  await new Promise((r) => setTimeout(r, 500));

  try {
    const output = await runCommand(OPENSHELL, ["forward", "start", port, sandbox, "--background"]);
    return Response.json({ success: true, message: output.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const port = searchParams.get("port") || "";

  // For the agent dashboard port, "active" means the path actually serves —
  // not merely that some process holds the socket (the old check reported a
  // dead openshell-forward tunnel as "active").
  if (SERVICE_MANAGED_PORTS.has(port)) {
    const healthy = await agentPathHealthy();
    return Response.json({ active: healthy, output: healthy ? "healthy" : "unreachable" });
  }

  try {
    const output = await runCommand(OPENSHELL, ["forward", "list"]);
    const active = !output.includes("No active forwards");
    return Response.json({ active, output: output.trim() });
  } catch {
    return Response.json({ active: false, output: "" });
  }
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: true });
    let output = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(stderr || output || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}
