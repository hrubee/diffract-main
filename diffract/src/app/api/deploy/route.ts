import { spawn } from "child_process";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";

export async function GET(request: Request) {
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

  const env = {
    ...process.env,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_PROVIDER: providerMap[provider] || provider,
    NEMOCLAW_MODEL: model,
    NEMOCLAW_POLICY_MODE: "custom",
    NEMOCLAW_POLICY_PRESETS: policies,
    [credentialMap[provider] || "COMPATIBLE_API_KEY"]: apiKey,
  };

  if (sandboxName) env.NEMOCLAW_SANDBOX_NAME = sandboxName;
  if (endpoint) env.NEMOCLAW_ENDPOINT_URL = endpoint;
  if (telegramToken) env.TELEGRAM_BOT_TOKEN = telegramToken;
  if (discordToken) env.DISCORD_BOT_TOKEN = discordToken;
  if (slackToken) env.SLACK_BOT_TOKEN = slackToken;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(type: string, message: string, extra?: Record<string, string>) {
        const payload = JSON.stringify({ type, message, ...extra });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }

      let detectedSandboxName = sandboxName || "";

      send("log", "Starting Diffract deployment...");
      send("log", `Provider: ${provider}, Model: ${model}`);

      const proc = spawn(DIFFRACT, ["onboard"], {
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

      proc.on("close", (code) => {
        if (code === 0) {
          send("done", "Deployment complete", {
            sandboxName: detectedSandboxName || "my-assistant",
          });
        } else {
          send("error", `Deployment failed with exit code ${code}`);
        }
        controller.close();
      });

      proc.on("error", (err) => {
        send("error", `Failed to start: ${err.message}`);
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

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox");

  if (!sandbox) {
    return Response.json({ error: "Sandbox name required" }, { status: 400 });
  }

  const proc = spawn(DIFFRACT, [sandbox, "destroy", "--yes"], {
    shell: true,
  });

  return new Promise<Response>((resolve) => {
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Response.json({ success: true }));
      } else {
        resolve(Response.json({ error: "Destroy failed" }, { status: 500 }));
      }
    });
  });
}
