// Per-box RBAC for the sandbox-scoped APIs. The proxy already requires a valid
// session for /api/*; these helpers add the box-level check: a non-admin user may
// only touch sandboxes assigned to them in the user store. Admins access all.

import { cookies } from "next/headers";
import { SESSION_COOKIE, getSession, type SessionInfo } from "./auth";
import { userBoxes } from "./users";

/** Resolve the current session, or null if unauthenticated. */
export async function currentSession(): Promise<SessionInfo | null> {
  return getSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** The boxes the current session may access; admins get { all: true }. */
export async function accessibleBoxes(): Promise<{ all: boolean; boxes: string[]; username: string } | null> {
  const s = await currentSession();
  if (!s) return null;
  if (s.isAdmin) return { all: true, boxes: [], username: s.username };
  return { all: false, boxes: await userBoxes(s.username), username: s.username };
}

/**
 * Gate a sandbox-scoped request: returns a 401/403 Response to short-circuit, or
 * null when the caller may access `sandbox`. Add as the first line of each
 * sandbox-scoped route: `const denied = await requireBoxAccess(sandbox); if (denied) return denied;`
 */
export async function requireBoxAccess(sandbox: string): Promise<Response | null> {
  const s = await currentSession();
  if (!s) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (s.isAdmin) return null;
  const boxes = await userBoxes(s.username);
  if (!sandbox || !boxes.includes(sandbox)) {
    return Response.json({ error: "Forbidden: you don't have access to this box." }, { status: 403 });
  }
  return null;
}
