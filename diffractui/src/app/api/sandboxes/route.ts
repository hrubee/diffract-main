export const dynamic = "force-dynamic";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { accessibleBoxes } from "@/lib/rbac";

const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
// Port registry written by diffract-sandbox-fleet.sh (Phase 2). The fleet serves
// each sandbox under the path /<name>/agent/ on the existing origin; `running:true`
// means its routes + forwards are live, so the UI can link to its chat. Absent
// until the fleet runs — then chatReady is false and the UI omits the chat link.
const PORT_REGISTRY = process.env.DIFFRACT_PORT_REGISTRY || "/var/lib/diffract/sandbox-ports.json";

function readPortRegistry(): Record<string, { running?: boolean }> {
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
      // chatReady once the fleet is actively serving this sandbox (running), so the
      // UI only links to /<name>/agent/ when it will actually resolve.
      const chatReady = p?.running === true;
      return {
        name: r.name,
        model: r.model ?? null,
        provider: r.provider ?? null,
        policies: Array.isArray(r.policies) ? r.policies : [],
        agent: r.agent ?? null,
        connected: Boolean(r.connected),
        activeSessionCount: r.activeSessionCount ?? null,
        isDefault: r.isDefault ?? r.name === defaultSandbox,
        chatReady,
      };
    });

    // RBAC: a non-admin user only sees the boxes assigned to them.
    const access = await accessibleBoxes();
    const visible = access?.all ? sandboxes : sandboxes.filter((s) => access?.boxes.includes(s.name));

    return Response.json({ defaultSandbox, sandboxes: visible });
  } catch {
    // No sandboxes / nemoclaw unavailable — return an empty inventory so the UI
    // falls back to the first-run setup form instead of erroring.
    return Response.json({ defaultSandbox: null, sandboxes: [] });
  }
}
