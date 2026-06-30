export const dynamic = "force-dynamic";
import { cookies } from "next/headers";
import { SESSION_COOKIE, getSession, ADMIN_USERNAME } from "@/lib/auth";
import { listUsers, upsertUser, deleteUser, validUsername } from "@/lib/users";

// Admin-only user management. Only a session with isAdmin may list or mutate
// users; the proxy already gates /api/* behind a valid session, this adds the
// admin check (defense-in-depth, same pattern as deploy/route.ts).
async function requireAdmin(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await getSession(token);
  if (!s || !s.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  return Response.json({ users: await listUsers(), adminUsername: ADMIN_USERNAME });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { username?: string; password?: string; boxes?: string[]; isAdmin?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const username = (body.username || "").trim();
  if (username === ADMIN_USERNAME) {
    return Response.json({ error: "'admin' is reserved for the super-admin." }, { status: 400 });
  }
  if (!validUsername(username)) {
    return Response.json({ error: "Invalid username (lowercase, 2-32 chars, a-z0-9-_)." }, { status: 400 });
  }
  const res = await upsertUser({
    username,
    password: typeof body.password === "string" ? body.password : undefined,
    boxes: Array.isArray(body.boxes) ? body.boxes : undefined,
    isAdmin: typeof body.isAdmin === "boolean" ? body.isAdmin : undefined,
  });
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const username = (new URL(request.url).searchParams.get("username") || "").trim();
  if (username === ADMIN_USERNAME) {
    return Response.json({ error: "'admin' is reserved." }, { status: 400 });
  }
  await deleteUser(username);
  return Response.json({ ok: true });
}
