// Admin-managed user store for Diffract multi-user auth + per-box RBAC.
//
// Users live in a root-only host file (default /var/lib/diffract/users.json),
// each: { username, passHash, boxes: [sandbox names the user may access], isAdmin }.
// Passwords are stored as HMAC digests (hashPassword) — never plaintext. The
// store is managed ONLY by the super-admin via /api/users; the bootstrap admin
// (DIFFRACT_ADMIN_PASSWORD, username "admin") is implicit and not in this file.

import { promises as fs } from "fs";
import * as path from "path";
import { hashPassword, verifyPasswordHash } from "./auth";

export interface StoredUser {
  username: string;
  passHash: string;
  boxes: string[];
  isAdmin: boolean;
}

/** A user as exposed to the admin UI — never includes the password hash. */
export type PublicUser = Omit<StoredUser, "passHash">;

const USERS_FILE = process.env.DIFFRACT_USERS_FILE || "/var/lib/diffract/users.json";
// RFC1123-ish: same shape as sandbox names so usernames are safe in headers/paths.
const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function validUsername(u: string): boolean {
  return typeof u === "string" && USERNAME_RE.test(u);
}

export async function readUsers(): Promise<StoredUser[]> {
  try {
    const arr = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
    return Array.isArray(arr)
      ? arr.filter((u) => u && typeof u.username === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeUsers(users: StoredUser[]): Promise<void> {
  await fs.mkdir(path.dirname(USERS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${USERS_FILE}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(tmp, USERS_FILE);
}

export async function listUsers(): Promise<PublicUser[]> {
  // Explicitly project to drop passHash (never expose the digest to the UI).
  return (await readUsers()).map((u) => ({
    username: u.username,
    boxes: Array.isArray(u.boxes) ? u.boxes : [],
    isAdmin: u.isAdmin === true,
  }));
}

export async function findUser(username: string): Promise<StoredUser | null> {
  return (await readUsers()).find((u) => u.username === username) ?? null;
}

/** Return the user iff the password matches; else null. */
export async function verifyUserPassword(
  username: string,
  password: string,
): Promise<StoredUser | null> {
  const u = await findUser(username);
  if (!u) return null;
  return (await verifyPasswordHash(password, u.passHash)) ? u : null;
}

/** The boxes a user may access (admins get all — resolved by the caller). */
export async function userBoxes(username: string): Promise<string[]> {
  const u = await findUser(username);
  return u && Array.isArray(u.boxes) ? u.boxes : [];
}

/**
 * Create or update a user. On create, `password` is required. On update, a
 * provided `password` resets it; omit to keep the existing hash. `boxes` and
 * `isAdmin` replace the stored values when provided.
 */
export async function upsertUser(input: {
  username: string;
  password?: string;
  boxes?: string[];
  isAdmin?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!validUsername(input.username)) {
    return { ok: false, error: "Invalid username (lowercase, 2-32 chars, a-z0-9-_)." };
  }
  const users = await readUsers();
  const idx = users.findIndex((u) => u.username === input.username);
  const boxes = Array.isArray(input.boxes) ? input.boxes.filter((b) => typeof b === "string") : undefined;

  if (idx === -1) {
    if (!input.password) return { ok: false, error: "Password required for a new user." };
    users.push({
      username: input.username,
      passHash: await hashPassword(input.password),
      boxes: boxes ?? [],
      isAdmin: input.isAdmin === true,
    });
  } else {
    const u = users[idx];
    if (input.password) u.passHash = await hashPassword(input.password);
    if (boxes !== undefined) u.boxes = boxes;
    if (input.isAdmin !== undefined) u.isAdmin = input.isAdmin === true;
  }
  await writeUsers(users);
  return { ok: true };
}

export async function deleteUser(username: string): Promise<void> {
  const users = await readUsers();
  const next = users.filter((u) => u.username !== username);
  if (next.length !== users.length) await writeUsers(next);
}
