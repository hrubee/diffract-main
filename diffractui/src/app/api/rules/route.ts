import { execFileSync } from "child_process";
import { requireBoxAccess } from "@/lib/rbac";

const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";
  const __d = await requireBoxAccess(sandbox);
  if (__d) return __d;
  const chunkId = searchParams.get("chunkId") || "";
  const action = searchParams.get("action") || "";
  const reason = searchParams.get("reason") || "";

  if (!chunkId || !action) {
    return Response.json({ error: "chunkId and action required" }, { status: 400 });
  }

  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: "action must be approve or reject" }, { status: 400 });
  }

  try {
    const args = ["rule", action, "--chunk-id", chunkId];
    if (action === "reject" && reason) {
      args.push("--reason", reason);
    }
    if (sandbox) {
      args.push(sandbox);
    }

    const output = execFileSync(OPENSHELL, args, {
      timeout: 15000,
      encoding: "utf-8",
      shell: true,
    });

    return Response.json({ success: true, output: output.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
