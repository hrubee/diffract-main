import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  verifyPassword,
  createSessionToken,
  authConfigured,
  ADMIN_USERNAME,
  type SessionInfo,
} from "@/lib/auth";
import { verifyUserPassword } from "@/lib/users";

export const dynamic = "force-dynamic";

const TTL_SECONDS = 60 * 60 * 12; // 12h

export async function POST(request: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "Auth not configured. Set DIFFRACT_ADMIN_PASSWORD and DIFFRACT_AUTH_SECRET." },
      { status: 503 },
    );
  }

  let username = "";
  let password = "";
  try {
    const body = await request.json();
    password = typeof body?.password === "string" ? body.password : "";
    // No username -> the bootstrap super-admin (keeps the existing password-only
    // admin login working unchanged).
    username = (typeof body?.username === "string" ? body.username : "").trim() || ADMIN_USERNAME;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // The reserved "admin" username authenticates against DIFFRACT_ADMIN_PASSWORD;
  // everyone else against the user store.
  let session: SessionInfo | null = null;
  if (username === ADMIN_USERNAME) {
    if (await verifyPassword(password)) session = { username: ADMIN_USERNAME, isAdmin: true };
  } else {
    const u = await verifyUserPassword(username, password);
    if (u) session = { username: u.username, isAdmin: u.isAdmin };
  }
  if (!session) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const token = await createSessionToken(session, TTL_SECONDS);
  if (!token) {
    return NextResponse.json({ error: "Auth not configured" }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
  return res;
}
