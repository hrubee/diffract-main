export const dynamic = "force-dynamic";
import { accessibleBoxes } from "@/lib/rbac";

// Caddy forward_auth target for the per-box chat path /<box>/agent/*. Caddy calls
// GET /api/authz?box=<name> with the original request's cookies; on 2xx it lets the
// request through and copies X-Hermes-User-Id onto the upstream (so the agent's
// api_server can scope history per user). On failure Caddy returns this response to
// the browser — so we 302 unauthenticated callers to /login and 403 unauthorized
// ones. NOTE: this route is EXEMPT from the proxy gate (see proxy.ts matcher) so it
// can return these responses itself instead of the proxy's generic 401.
export async function GET(request: Request) {
  const box = (new URL(request.url).searchParams.get("box") || "").trim();
  const access = await accessibleBoxes();
  if (!access) {
    // Not signed in — send the browser to login (forward_auth copies this 302).
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  }
  if (access.all || access.boxes.includes(box)) {
    return new Response("ok", { status: 200, headers: { "X-Hermes-User-Id": access.username } });
  }
  return new Response("You don't have access to this box.", { status: 403 });
}
