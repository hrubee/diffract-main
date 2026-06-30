import { requireBoxAccess as __rba } from "@/lib/rbac";
export const dynamic = "force-dynamic";

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────
// Files API — browse / upload / download / delete files inside the agent's
// sandbox so a user can hand the agent material to work on.
//
// SECURITY MODEL: this Route Handler runs as root-in-docker-group on the host
// and shells out to `docker exec` / `docker cp`. It is effectively host-RCE for
// anyone who holds an admin session, so every method:
//   1. Re-verifies the admin session (defense-in-depth; see deploy/route.ts).
//   2. Uses execFile/spawn with ARGV ARRAYS and NO shell — never `sh -c` and
//      never string-interpolated commands, so user input can't be a shell verb.
//   3. Confines every path to /sandbox via path.posix.normalize + prefix check,
//      rejecting `..` and the agent's private /sandbox/.hermes tree for writes.
//   4. Validates the sandbox name and resolves it to an exact container id.
// ─────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const DOCKER = process.env.DOCKER_PATH || "docker";

const ROOT = "/sandbox"; // agent home + cwd, owned by sandbox:sandbox
const HERMES = "/sandbox/.hermes"; // agent private dir — never a write target
const MAX_FILE = 100 * 1024 * 1024; // 100 MB hard cap per upload
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;

async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Resolve a validated sandbox name to its exact running container id, or null.
 *
 * OpenShell names containers `openshell-<name>-<uuid>`, so a name-based filter
 * would need a fragile substring/prefix match (and `foo` would shadow `foobar`).
 * Instead we match the exact OpenShell label `openshell.ai/sandbox-name`, which
 * docker compares by value — unambiguous and UUID-suffix-proof.
 */
async function resolveContainer(sandbox: string): Promise<string | null> {
  if (!sandbox || !SANDBOX_NAME_RE.test(sandbox)) return null;
  try {
    const { stdout } = await execFileAsync(DOCKER, [
      "ps",
      "-q",
      "-f",
      "label=openshell.ai/managed-by=openshell",
      "-f",
      `label=openshell.ai/sandbox-name=${sandbox}`,
    ]);
    const cid = stdout.trim().split("\n").filter(Boolean)[0];
    return cid || null;
  } catch {
    return null;
  }
}

/**
 * Normalize an absolute path and confine it to /sandbox. Returns the cleaned
 * path or null if it escapes the root. `..` is resolved by normalize, so e.g.
 * /sandbox/../etc/passwd → /etc/passwd → rejected by the prefix check.
 */
function safePath(input: string | null): string | null {
  if (!input) return null;
  const p = path.posix.normalize(input);
  if (p.split("/").includes("..")) return null; // belt-and-suspenders
  if (p !== ROOT && !p.startsWith(ROOT + "/")) return null;
  return p;
}

/** True if the path is the agent's private .hermes tree (never writable). */
function isHermes(p: string): boolean {
  return p === HERMES || p.startsWith(HERMES + "/");
}

// Python helper run inside the container to list a directory as JSON. The path
// arrives as argv[1] so it is never interpolated into the program text.
const LIST_PY = `
import os, sys, json
p = sys.argv[1]
out = []
try:
    with os.scandir(p) as it:
        for e in it:
            try:
                d = e.is_dir(follow_symlinks=False)
                st = e.stat(follow_symlinks=False)
                out.append({"name": e.name, "isDir": d, "size": st.st_size, "mtime": int(st.st_mtime)})
            except OSError:
                pass
    print(json.dumps({"ok": True, "items": out}))
except FileNotFoundError:
    print(json.dumps({"ok": False, "error": "not found"}))
except NotADirectoryError:
    print(json.dumps({"ok": False, "error": "not a directory"}))
except PermissionError:
    print(json.dumps({"ok": False, "error": "permission denied"}))
`.trim();

// ── GET ─ list a directory  (?sandbox&path)  or  download a file (&download=1)
export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";
  { const __d = await __rba(sandbox); if (__d) return __d; }
  const rawPath = searchParams.get("path") || ROOT;
  const isDownload = searchParams.get("download") === "1";

  const cid = await resolveContainer(sandbox);
  if (!cid) return Response.json({ error: "Sandbox not found or not running" }, { status: 404 });

  const target = safePath(rawPath);
  if (!target) return Response.json({ error: "Invalid path" }, { status: 400 });

  if (isDownload) return downloadFile(cid, target);

  // Directory listing
  try {
    const { stdout } = await execFileAsync(
      DOCKER,
      ["exec", cid, "python3", "-c", LIST_PY, target],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim());
    if (!parsed.ok) return Response.json({ error: parsed.error || "list failed" }, { status: 400 });
    // Hide dotfiles (the .hermes tree, shell rc, etc.) from the browser.
    const items = (parsed.items as DirItem[])
      .filter((it) => !it.name.startsWith("."))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return Response.json({ path: target, items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Listing failed: ${message}` }, { status: 500 });
  }
}

interface DirItem {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

function downloadFile(cid: string, target: string): Response {
  const proc = spawn(DOCKER, ["exec", cid, "cat", "--", target]);
  let errored = false;

  const stream = new ReadableStream({
    start(controller) {
      proc.stdout.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          /* client gone */
        }
      });
      proc.stderr.on("data", () => {
        errored = true;
      });
      proc.on("close", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      proc.on("error", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    },
  });

  const filename = path.posix.basename(target) || "download";
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── POST ─ upload a file into a directory  (?sandbox&path=<dir>, multipart body)
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  // Reject obviously-too-large bodies before buffering anything.
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared && declared > MAX_FILE + 16 * 1024 * 1024) {
    return Response.json({ error: "File too large (max 100 MB)" }, { status: 413 });
  }

  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";
  { const __d = await __rba(sandbox); if (__d) return __d; }
  const dir = safePath(searchParams.get("path") || ROOT);
  if (!dir) return Response.json({ error: "Invalid path" }, { status: 400 });
  if (isHermes(dir)) return Response.json({ error: "Cannot write to agent's private directory" }, { status: 403 });

  const cid = await resolveContainer(sandbox);
  if (!cid) return Response.json({ error: "Sandbox not found or not running" }, { status: 404 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return Response.json({ error: "Invalid upload" }, { status: 400 });
  }
  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });
  if (file.size > MAX_FILE) return Response.json({ error: "File too large (max 100 MB)" }, { status: 413 });

  // Sanitize the filename: take its basename only, no separators, no dotfiles.
  const name = path.posix.basename(file.name || "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.startsWith(".")) {
    return Response.json({ error: "Invalid file name" }, { status: 400 });
  }

  const destPath = path.posix.join(dir, name);
  if (isHermes(destPath)) return Response.json({ error: "Cannot write to agent's private directory" }, { status: 403 });

  // Stage the upload to a host temp file, copy it in, then fix ownership
  // (docker cp lands as root) so the sandbox user can read it.
  const tmp = path.join(os.tmpdir(), `diffract-upload-${process.pid}-${name}`);
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tmp, buf, { mode: 0o644 });
    await execFileAsync(DOCKER, ["cp", tmp, `${cid}:${destPath}`]);
    await execFileAsync(DOCKER, ["exec", cid, "chown", "sandbox:sandbox", destPath]);
    await execFileAsync(DOCKER, ["exec", cid, "chmod", "0644", destPath]);
    return Response.json({ success: true, path: destPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Upload failed: ${message}` }, { status: 500 });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// ── DELETE ─ remove a file or directory  (?sandbox&path)
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";
  { const __d = await __rba(sandbox); if (__d) return __d; }
  const target = safePath(searchParams.get("path"));
  if (!target) return Response.json({ error: "Invalid path" }, { status: 400 });
  if (target === ROOT) return Response.json({ error: "Cannot delete sandbox root" }, { status: 403 });
  if (isHermes(target)) return Response.json({ error: "Cannot delete agent's private directory" }, { status: 403 });

  const cid = await resolveContainer(sandbox);
  if (!cid) return Response.json({ error: "Sandbox not found or not running" }, { status: 404 });

  try {
    await execFileAsync(DOCKER, ["exec", cid, "rm", "-rf", "--", target]);
    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Delete failed: ${message}` }, { status: 500 });
  }
}
