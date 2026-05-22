import { spawn } from "child_process";

const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "my-assistant";
  const port = searchParams.get("port") || "18789";

  // First kill any stale SSH process holding the port
  try {
    await runCommand("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"]).then(
      (pids) => {
        const pidList = pids.trim().split("\n").filter(Boolean);
        for (const pid of pidList) {
          try {
            process.kill(Number(pid));
          } catch {
            // ignore
          }
        }
      }
    );
  } catch {
    // no process on port, that's fine
  }

  // Wait briefly for port to free
  await new Promise((r) => setTimeout(r, 500));

  // Start the forward
  try {
    const output = await runCommand(OPENSHELL, [
      "forward",
      "start",
      port,
      sandbox,
      "--background",
    ]);
    return Response.json({ success: true, message: output.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function GET(request: Request) {
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
