import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Is a deploy/redeploy live right now?
//
// A deploy is "live" iff a `nemoclaw onboard` process is running on the host. The
// onboard process spans the whole deploy (sandbox create → gateway bring-up), so
// this single signal covers BOTH dashboard- and CLI-initiated deploys, and — unlike
// per-session UI state — it survives a page reload. The dashboard polls this to lock
// itself while a deploy runs and unlock automatically when it finishes or fails.
//
// Process-based (not a lock file) so it is self-healing: if a deploy crashes, the
// process is gone and the lock clears on its own — no stale lock to get stuck on.
export async function GET(): Promise<Response> {
  try {
    const { stdout } = await execAsync(
      "pgrep -fa 'nemoclaw onboard' 2>/dev/null | grep -v pgrep || true",
      { timeout: 5000 },
    );
    const live = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean).length > 0;
    return Response.json({ live });
  } catch {
    // On any error, fail "not live" so the UI never locks permanently by mistake.
    return Response.json({ live: false });
  }
}
