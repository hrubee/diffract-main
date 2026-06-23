export const dynamic = "force-dynamic";

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { readFacebookRecord, FACEBOOK_TOOL } from "@/lib/facebook";

const execFileAsync = promisify(execFile);
const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const CONNECTED_FILE = process.env.DIFFRACT_CONNECTED_TOOLS || "/var/lib/diffract/connected-tools";
const RECORD_FILE = process.env.DIFFRACT_FACEBOOK_RECORD || "/var/lib/diffract/facebook.json";

async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// GET /api/facebook → connected state (non-secret) for the dashboard.
export async function GET(): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const rec = await readFacebookRecord();
  if (!rec) return Response.json({ connected: false });
  return Response.json({
    connected: true,
    pageName: rec.pageName,
    pageId: rec.pageId,
    igUserId: rec.igUserId || null,
    igUsername: rec.igUsername || null,
    connectedAt: rec.connectedAt,
  });
}

// DELETE /api/facebook?sandbox=<name> → disconnect (best-effort): detach + delete
// the provider, drop it from the connected-tools record, remove the state file.
// The registry entry stays so it can be reconnected. Takes full effect on the
// next sandbox recreate.
export async function DELETE(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const sandbox = searchParams.get("sandbox") || "";

  if (SANDBOX_NAME_RE.test(sandbox)) {
    await execFileAsync(OPENSHELL, ["sandbox", "provider", "detach", sandbox, FACEBOOK_TOOL]).catch(() => {});
  }
  await execFileAsync(OPENSHELL, ["provider", "delete", FACEBOOK_TOOL]).catch(() => {});

  // Drop "facebook" from the gateway-independent connected-tools list.
  try {
    const lines = (await fs.readFile(CONNECTED_FILE, "utf8")).split("\n");
    const kept = lines.filter((l) => l.trim() && l.trim() !== FACEBOOK_TOOL);
    await fs.writeFile(CONNECTED_FILE, kept.length ? kept.join("\n") + "\n" : "");
  } catch {
    /* no record file — nothing to prune */
  }
  await fs.rm(RECORD_FILE, { force: true }).catch(() => {});

  return Response.json({ ok: true });
}
