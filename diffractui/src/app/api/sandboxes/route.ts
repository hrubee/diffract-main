export const dynamic = "force-dynamic";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
// Port registry written by diffract-sandbox-fleet.sh (Phase 2). Maps each sandbox
// to its allocated { listen, web, gw } host ports. Absent until the fleet runs —
// then `listenPort` is null and the UI simply omits the per-sandbox "Open chat" link.
const PORT_REGISTRY = process.env.DIFFRACT_PORT_REGISTRY || "/var/lib/diffract/sandbox-ports.json";

function readPortRegistry(): Record<string, { listen?: number; running?: boolean }> {
  try {
    return JSON.parse(readFileSync(PORT_REGISTRY, "utf8"));
  } catch {
    return {};
  }
}

// One row per sandbox, surfaced to the dashboard list view. This is the multi-
// sandbox sibling of /api/status (which resolves a single sandbox). Auth is
// enforced by proxy.ts (gates all /api/* except api/auth), same as /api/status.
interface InventoryRow {
  name: string;
  model?: string | null;
  provider?: string | null;
  policies?: string[] | null;
  agent?: string | null;
  isDefault?: boolean;
  connected?: boolean;
  activeSessionCount?: number | null;
}

export async function GET() {
  try {
    // `nemoclaw list --json` (oclif enableJsonFlag) emits a clean
    // SandboxInventoryResult on stdout: { defaultSandbox, sandboxes: [...] }.
    const out = execFileSync(DIFFRACT, ["list", "--json"], {
      timeout: 15000,
      encoding: "utf-8",
      shell: true,
    });
    const parsed = JSON.parse(out);
    const defaultSandbox: string | null = parsed?.defaultSandbox ?? null;
    const rows: InventoryRow[] = Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : [];
    const ports = readPortRegistry();

    const sandboxes = rows.map((r) => {
      const p = ports[r.name];
      // Only expose a chat port once the fleet has it actively forwarded (running),
      // so the UI never links to a port that isn't serving yet.
      const listenPort = p?.running && typeof p.listen === "number" ? p.listen : null;
      return {
        name: r.name,
        model: r.model ?? null,
        provider: r.provider ?? null,
        policies: Array.isArray(r.policies) ? r.policies : [],
        agent: r.agent ?? null,
        connected: Boolean(r.connected),
        activeSessionCount: r.activeSessionCount ?? null,
        isDefault: r.isDefault ?? r.name === defaultSandbox,
        listenPort,
      };
    });

    return Response.json({ defaultSandbox, sandboxes });
  } catch {
    // No sandboxes / nemoclaw unavailable — return an empty inventory so the UI
    // falls back to the first-run setup form instead of erroring.
    return Response.json({ defaultSandbox: null, sandboxes: [] });
  }
}
