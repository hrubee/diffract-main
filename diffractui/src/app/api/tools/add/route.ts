export const dynamic = "force-dynamic";

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { promises as fs, openSync } from "fs";
import * as path from "path";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────
// Tools "Add" API — register a NEW CLI in the registry and live-install it
// into the running sandbox (no image rebuild). Because the install (git clone +
// build) is slow, this is a BACKGROUND JOB: POST kicks it off and returns
// immediately; GET ?job=<name> polls a log file until it ends with a
// "===DONE rc=N===" marker.
//
// SECURITY: admin-session gated (same as the rest of the dashboard, which is
// already privileged). The `build`/`patch` fields are shell that runs inside the
// sandbox — that is inherent to "install any CLI"; inputs are otherwise strictly
// validated (no shell metacharacters in identifiers/paths, no tabs/newlines in
// build strings, hosts/keys regex-checked). execFile/spawn use argv arrays.
// ─────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const BIN_RE = /^[a-z][a-z0-9-]{0,40}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const HOST_RE = /^[a-z0-9.-]+:[0-9]{1,5}$/;
const ENTRY_RE = /^[a-zA-Z0-9._/-]{1,120}$/;
const REPO_RE = /^https:\/\/[a-zA-Z0-9._/-]+\.git$/;
const REF_RE = /^[a-zA-Z0-9._/-]{1,80}$/;

type NewTool = {
  name: string;
  description?: string;
  repo: string;
  ref?: string;
  kind?: string;
  patch?: string;
  build?: string;
  entry: string;
  bin?: string;
  secretEnv?: string;
  configEnv?: Record<string, string>;
  apiHosts?: string[];
  binaries?: string[];
  authHeader?: string;
  skill?: { name?: string; title?: string; summary?: string; tags?: string[]; examples?: string[] };
};

async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

async function firstExisting(cands: (string | undefined)[]): Promise<string | null> {
  for (const c of cands.filter(Boolean) as string[]) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

function registryCandidates(): (string | undefined)[] {
  return [
    process.env.DIFFRACT_TOOLS_REGISTRY,
    path.resolve(process.cwd(), "..", "NemoClaw/agents/hermes/diffract-tools.json"),
    "/usr/local/share/diffract/diffract-tools.json",
    "/root/diffract-main/NemoClaw/agents/hermes/diffract-tools.json",
  ];
}

function logPathFor(tool: string): string {
  return `/tmp/diffract-add-${tool}.log`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

// ── GET: poll an in-flight add job ───────────────────────────────────────
export async function GET(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const tool = new URL(req.url).searchParams.get("job") || "";
  if (!TOOL_NAME_RE.test(tool)) {
    return Response.json({ error: "Invalid job" }, { status: 400 });
  }
  let log = "";
  try {
    log = await fs.readFile(logPathFor(tool), "utf8");
  } catch {
    return Response.json({ status: "unknown", log: "" });
  }
  log = log.replace(ANSI_RE, "");
  const m = log.match(/===DONE rc=(\d+)===/);
  const status = !m ? "running" : m[1] === "0" ? "done" : "failed";
  return Response.json({ status, log: log.replace(/===DONE rc=\d+===\s*$/, "").trim() });
}

// ── POST: validate + register + start the live install ───────────────────
export async function POST(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  let body: { sandbox?: string; tool?: NewTool };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sandbox = body.sandbox || "";
  const t = body.tool;
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json({ error: "Invalid sandbox name" }, { status: 400 });
  }
  if (!t || typeof t !== "object") {
    return Response.json({ error: "Missing tool definition" }, { status: 400 });
  }

  // ── Validate every field that becomes a command, path, or identifier ──
  const errs: string[] = [];
  if (!TOOL_NAME_RE.test(t.name || "")) errs.push("name (lowercase, a-z0-9-)");
  if (!REPO_RE.test(t.repo || "")) errs.push("repo (https://….git)");
  if (t.ref && !REF_RE.test(t.ref)) errs.push("ref");
  if (!ENTRY_RE.test(t.entry || "")) errs.push("entry (e.g. dist/index.js)");
  if (t.bin && !BIN_RE.test(t.bin)) errs.push("bin");
  const noCtrl = (s?: string) => !s || !/[\t\n\r]/.test(s); // build/patch are 1-line
  if (!noCtrl(t.build)) errs.push("build (no tabs/newlines)");
  if (!noCtrl(t.patch)) errs.push("patch (no tabs/newlines)");
  for (const h of t.apiHosts || []) if (!HOST_RE.test(h)) errs.push(`apiHost '${h}' (host:port)`);
  for (const b of t.binaries || []) if (!/^\/[a-zA-Z0-9._/-]+$/.test(b)) errs.push(`binary '${b}'`);
  if (t.secretEnv && !KEY_RE.test(t.secretEnv)) errs.push("secretEnv key (UPPER_SNAKE)");
  for (const k of Object.keys(t.configEnv || {})) if (!KEY_RE.test(k)) errs.push(`config key '${k}'`);
  if (errs.length) {
    return Response.json({ error: "Invalid: " + errs.join(", ") }, { status: 400 });
  }

  const registry = await firstExisting(registryCandidates());
  if (!registry) {
    return Response.json({ error: "Tool registry not found on host" }, { status: 500 });
  }

  // Append the entry (reject duplicate names).
  let reg: { $comment?: string; tools: NewTool[] };
  try {
    reg = JSON.parse(await fs.readFile(registry, "utf8"));
  } catch {
    return Response.json({ error: "Registry unreadable" }, { status: 500 });
  }
  reg.tools = Array.isArray(reg.tools) ? reg.tools : [];
  if (reg.tools.some((x) => x.name === t.name)) {
    return Response.json({ error: `Tool '${t.name}' already exists` }, { status: 409 });
  }

  const entry: NewTool = {
    name: t.name,
    description: t.description || "",
    repo: t.repo,
    ref: t.ref || "main",
    kind: t.kind || "node",
    ...(t.patch ? { patch: t.patch } : {}),
    build: t.build || "npm ci --no-audit --no-fund && npm run build",
    entry: t.entry,
    bin: t.bin || t.name,
    ...(t.secretEnv ? { secretEnv: t.secretEnv } : {}),
    configEnv: t.configEnv || {},
    apiHosts: t.apiHosts || [],
    binaries: t.binaries && t.binaries.length ? t.binaries : ["/usr/local/bin/node"],
    ...(t.authHeader ? { authHeader: t.authHeader } : {}),
    skill: {
      name: t.skill?.name || `${t.name}-tool`,
      title: t.skill?.title || t.description || t.name,
      summary: t.skill?.summary || t.description || `${t.name} CLI`,
      tags: t.skill?.tags || [],
      examples: t.skill?.examples && t.skill.examples.length ? t.skill.examples : [`${t.bin || t.name} --help`],
    },
  };
  reg.tools.push(entry);

  // Atomic-ish write (tmp + rename).
  try {
    const tmp = `${registry}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
    await fs.rename(tmp, registry);
  } catch {
    return Response.json({ error: "Failed to write registry" }, { status: 500 });
  }

  // Spawn the live install detached; it logs to /tmp and ends with a DONE marker.
  const addScript = await firstExisting([
    process.env.DIFFRACT_ADD_SCRIPT,
    "/usr/local/bin/diffract-tool-add.sh",
    path.resolve(process.cwd(), "..", "scripts/diffract-tool-add.sh"),
  ]);
  if (!addScript) {
    return Response.json({ error: "diffract-tool-add.sh not found on host (registry updated though)" }, { status: 500 });
  }
  const logPath = logPathFor(t.name);
  try {
    const out = openSync(logPath, "w");
    const child = spawn("bash", [addScript, sandbox, t.name, registry], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin` },
    });
    child.unref();
  } catch {
    return Response.json({ error: "Failed to start install" }, { status: 500 });
  }

  return Response.json({ ok: true, job: t.name });
}
