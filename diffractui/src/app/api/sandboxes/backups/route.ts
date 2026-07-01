export const dynamic = "force-dynamic";
import { execFileSync, execSync } from "child_process";
import { readdirSync, existsSync, readFileSync } from "fs";
import { cookies } from "next/headers";
import { SESSION_COOKIE, getSession } from "@/lib/auth";

// Restorable backups = sandboxes that have a saved /sandbox backup
// (diffract-persist.sh writes /var/lib/diffract/persist/<name>/home.tar.gz) but
// are NOT currently live — i.e. deleted boxes you can bring back. Recreating a box
// with the same name auto-restores its files (persist restore) AND re-attaches its
// tools (the per-box connected-tools/MCP records survive deletion), so we also
// surface which tools would come back. Admin-only (restoring = creating a box).
const DIFFRACT = process.env.DIFFRACT_PATH || "nemoclaw";
const PERSIST_ROOT = process.env.DIFFRACT_PERSIST_ROOT || "/var/lib/diffract/persist";
const SANDBOX_NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

async function requireAdmin(): Promise<Response | null> {
  const s = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // Currently-live sandboxes (a backup for one of these isn't a "deleted" restore).
  const live = new Set<string>();
  try {
    const out = execFileSync(DIFFRACT, ["list", "--json"], {
      timeout: 15000,
      encoding: "utf-8",
      shell: true,
    });
    for (const s of JSON.parse(out)?.sandboxes ?? []) {
      if (s?.name) live.add(s.name);
    }
  } catch {
    /* nemoclaw unavailable — treat none as live */
  }

  let names: string[] = [];
  try {
    names = readdirSync(PERSIST_ROOT);
  } catch {
    return Response.json({ backups: [] });
  }

  const backups = [];
  for (const name of names) {
    if (!SANDBOX_NAME_RE.test(name) || live.has(name)) continue;
    if (!existsSync(`${PERSIST_ROOT}/${name}/home.tar.gz`)) continue;
    let lastBackup = "";
    try {
      lastBackup = readFileSync(`${PERSIST_ROOT}/${name}/last-backup`, "utf-8").trim();
    } catch {
      /* no timestamp file */
    }
    // Tools/MCP that would re-attach on a same-name recreate (records persist).
    let tools: string[] = [];
    try {
      const t = execSync(`/usr/local/bin/diffract-tool-sync.sh providers ${name}`, {
        encoding: "utf-8",
        timeout: 12000,
      }).trim();
      const m = execSync(`/usr/local/bin/diffract-mcp-sync.sh providers ${name}`, {
        encoding: "utf-8",
        timeout: 12000,
      }).trim();
      tools = [t, m].filter(Boolean).join(",").split(",").filter(Boolean);
    } catch {
      /* sync helpers missing — just don't list tools */
    }
    backups.push({ name, lastBackup, tools });
  }

  return Response.json({ backups });
}
