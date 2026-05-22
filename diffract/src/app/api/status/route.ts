import { spawn, execFileSync } from "child_process";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";
  const wantLogs = searchParams.get("logs") === "true";
  const wantPolicy = searchParams.get("policy") === "true";
  const wantRules = searchParams.get("rules") === "true";

  if (wantLogs) {
    return streamLogs(sandbox);
  }

  if (wantPolicy) {
    return getPolicy(sandbox);
  }

  if (wantRules) {
    return getRules(sandbox);
  }

  return getStatus(sandbox);
}

async function getStatus(sandbox: string) {
  try {
    // If no sandbox name provided, detect from nemoclaw list
    let name = sandbox;
    if (!name) {
      const listOutput = run(DIFFRACT, ["list"]);
      const defaultMatch = listOutput.match(/^\s+(\S+)\s+\*/m);
      const anyMatch = listOutput.match(/^\s{4}(\S+)/m);
      name = defaultMatch?.[1] || anyMatch?.[1] || "";
    }

    if (!name) {
      return Response.json({ status: { state: "No sandbox found" }, policies: [], rules: [] });
    }

    const statusOutput = run(DIFFRACT, [name, "status"]);

    const status: Record<string, string> = {
      state: "Running",
      name,
      provider: extractField(statusOutput, "Provider") || "—",
      model: extractField(statusOutput, "Model") || "—",
      gpu: extractField(statusOutput, "GPU") || "No",
    };

    const cleanOutput = stripAnsi(statusOutput);
    const phaseMatch = cleanOutput.match(/Phase:\s*(\S+)/);
    if (phaseMatch) {
      status.state = phaseMatch[1];
    }

    const policyMatch = cleanOutput.match(/Policies?:\s*(.+)/i);
    const policies = policyMatch
      ? policyMatch[1].split(/,\s*/).map((p) => p.trim()).filter(Boolean)
      : [];

    return Response.json({ status, policies });
  } catch {
    return Response.json({
      status: { state: "Unknown" },
      policies: [],
    });
  }
}

async function getPolicy(sandbox: string) {
  try {
    const name = sandbox || detectSandbox();
    const output = run(OPENSHELL, ["policy", "get", name, "--full"]);
    return Response.json({ policy: output });
  } catch {
    return Response.json({ policy: "" }, { status: 500 });
  }
}

async function getRules(sandbox: string) {
  try {
    const name = sandbox || detectSandbox();
    const output = run(OPENSHELL, ["rule", "get", name]);
    return Response.json({ rules: output });
  } catch {
    return Response.json({ rules: "" }, { status: 500 });
  }
}

function streamLogs(sandbox: string) {
  const name = sandbox || detectSandbox();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Use openshell logs --tail for live streaming
      const proc = spawn(OPENSHELL, ["logs", name, "--tail"], {
        shell: true,
      });

      proc.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const payload = JSON.stringify({ type: "log", message: line });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const payload = JSON.stringify({ type: "log", message: line });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
      });

      proc.on("close", () => {
        controller.close();
      });

      proc.on("error", () => {
        controller.close();
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

function detectSandbox(): string {
  try {
    const listOutput = run(DIFFRACT, ["list"]);
    const defaultMatch = listOutput.match(/^\s+(\S+)\s+\*/m);
    const anyMatch = listOutput.match(/^\s{4}(\S+)/m);
    return defaultMatch?.[1] || anyMatch?.[1] || "";
  } catch {
    return "";
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    timeout: 15000,
    encoding: "utf-8",
    shell: true,
  });
}

function extractField(text: string, field: string): string {
  const clean = stripAnsi(text);
  const regex = new RegExp(`${field}[:\\s]+(.+)`, "i");
  const match = clean.match(regex);
  return match ? match[1].trim() : "";
}
