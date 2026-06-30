export const dynamic = "force-dynamic";
import { cookies } from "next/headers";
import { SESSION_COOKIE, getSession } from "@/lib/auth";

// The current session's identity, for the UI to decide what to show (e.g. the
// admin-only Users view). Gated by the proxy like all /api/* — so reaching it
// already implies a valid session; we just surface who it is.
export async function GET() {
  const s = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ username: s.username, isAdmin: s.isAdmin });
}
