export const dynamic = "force-dynamic";

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────
// Tools API — list the registry tools with live status, and securely CONNECT
// a tool's credentials so the sandboxed agent can use it.
//
// SECURITY MODEL (same as files/route.ts — this Handler is effectively host-RCE
// for an admin session):
//   1. Re-verify the admin session on every method.
//   2. execFile with ARGV ARRAYS and NO shell — never `sh -c`, never string
//      interpolation, so input can't become a shell verb.
//   3. The tool name must match a registry entry; the sandbox name is regex-
//      validated and resolved to an exact container id by label.
//   4. CONNECT secrets are read from the request body and passed to the connect
//      script ONLY via the child env — never logged, never written to disk, never
//      returned in a response. The script registers them in the host-side
//      OpenShell provider; the sandbox only ever sees placeholders.
// ─────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const DOCKER = process.env.DOCKER_PATH || "docker";
const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";
const SANDBOX_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/; // credential/config env keys

type RegistryTool = {
  name: string;
  description?: string;
  bin?: string;
  transport?: string; // "rest" = install-less (agent calls the API via curl)
  secretEnv?: string;
  configEnv?: Record<string, string>;
  apiHosts?: string[];
  provider?: string;
  authHeader?: string;
  skill?: { name?: string; title?: string; summary?: string };
};

async function requireSession(): Promise<Response | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// Locate the tool registry on the host (diffractui runs from <repo>/diffractui).
async function registryPath(): Promise<string | null> {
  const candidates = [
    process.env.DIFFRACT_TOOLS_REGISTRY,
    path.resolve(process.cwd(), "..", "NemoClaw/agents/hermes/diffract-tools.json"),
    "/usr/local/share/diffract/diffract-tools.json",
    "/root/diffract-main/NemoClaw/agents/hermes/diffract-tools.json",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function connectScriptPath(): Promise<string | null> {
  const candidates = [
    process.env.DIFFRACT_CONNECT_SCRIPT,
    "/usr/local/bin/diffract-tool-connect.sh",
    path.resolve(process.cwd(), "..", "scripts/diffract-tool-connect.sh"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readRegistry(): Promise<RegistryTool[]> {
  const p = await registryPath();
  if (!p) return [];
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.tools) ? parsed.tools : [];
}

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
    return stdout.trim().split("\n").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

// True if `docker exec <cid> <argv>` exits 0 (a quiet existence probe).
async function dockerExecOk(cid: string, argv: string[]): Promise<boolean> {
  try {
    await execFileAsync(DOCKER, ["exec", cid, ...argv], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function osCapture(argv: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(OPENSHELL, argv, { timeout: 12000 });
    return stdout || "";
  } catch (e: unknown) {
    // openshell may exit non-zero but still print useful stdout
    const err = e as { stdout?: string };
    return err?.stdout || "";
  }
}

// Strip ANSI color codes so substring checks are reliable.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function clean(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── GET: registry tools + live status ────────────────────────────────────
export async function GET(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const sandbox = searchParams.get("sandbox") || "";
  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json({ error: "Invalid sandbox name" }, { status: 400 });
  }

  let tools: RegistryTool[];
  try {
    tools = await readRegistry();
  } catch {
    return Response.json({ error: "Tool registry not found or unreadable" }, { status: 500 });
  }

  const cid = await resolveContainer(sandbox);
  // Read provider attachments + policy once (best-effort), reuse per tool.
  const providerList = cid ? clean(await osCapture(["sandbox", "provider", "list", sandbox])) : "";
  const policy = cid ? clean(await osCapture(["policy", "get", sandbox, "--full"])) : "";

  const result = await Promise.all(
    tools.map(async (t) => {
      const bin = t.bin || t.name;
      const provider = t.provider || t.name;
      const skillName = t.skill?.name || t.name;
      const secretKeys: string[] = [];
      if (t.secretEnv) secretKeys.push(t.secretEnv);
      const configKeys = Object.keys(t.configEnv || {});

      // REST tools install nothing — the agent calls the API via an in-image
      // binary (curl), so "installed" means that binary is on PATH, not that a
      // symlink was baked under /usr/local/bin.
      const installed = cid
        ? t.transport === "rest"
          ? await dockerExecOk(cid, ["sh", "-lc", `command -v ${bin} >/dev/null 2>&1`])
          : await dockerExecOk(cid, ["test", "-e", `/usr/local/bin/${bin}`])
        : false;
      const advertised = cid
        ? await dockerExecOk(cid, ["test", "-e", `/sandbox/.hermes/skills/diffract-tools/${skillName}/SKILL.md`])
        : false;
      // Provider attached: the provider name appears as a row in the list.
      const connected = new RegExp(`(^|\\s)${provider}(\\s|$)`, "m").test(providerList);
      // Egress: the tool's rule-name or one of its API hosts shows in the policy.
      const hostMatch = (t.apiHosts || []).some((h) => policy.includes(String(h).split(":")[0]));
      const egress = policy.includes(`${t.name}-api`) || hostMatch;

      return {
        name: t.name,
        description: t.description || t.skill?.summary || "",
        bin,
        provider,
        apiHosts: t.apiHosts || [],
        authHeader: t.authHeader || "",
        secretKeys, // secret-bearing env keys the Connect dialog must collect
        configKeys, // non-secret config keys
        status: { installed, connected, advertised, egress },
      };
    }),
  );

  return Response.json({ sandbox, running: !!cid, tools: result });
}

// ── POST: securely connect a tool's credentials ──────────────────────────
export async function POST(req: Request): Promise<Response> {
  const unauth = await requireSession();
  if (unauth) return unauth;

  let body: { sandbox?: string; tool?: string; credentials?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sandbox = body.sandbox || "";
  const toolName = body.tool || "";
  const credentials = body.credentials || {};

  if (!SANDBOX_NAME_RE.test(sandbox)) {
    return Response.json({ error: "Invalid sandbox name" }, { status: 400 });
  }

  let tools: RegistryTool[];
  try {
    tools = await readRegistry();
  } catch {
    return Response.json({ error: "Tool registry not found or unreadable" }, { status: 500 });
  }
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return Response.json({ error: "Unknown tool" }, { status: 404 });
  }

  // The exact set of credential keys this tool declares (secret + non-secret).
  const expected = new Set<string>();
  if (tool.secretEnv) expected.add(tool.secretEnv);
  for (const k of Object.keys(tool.configEnv || {})) expected.add(k);

  // Validate: every provided key must be expected + well-formed, and every
  // expected key must be present (the connect script requires all of them).
  for (const k of Object.keys(credentials)) {
    if (!expected.has(k) || !KEY_RE.test(k)) {
      return Response.json({ error: `Unexpected credential key: ${k}` }, { status: 400 });
    }
  }
  const missing = [...expected].filter((k) => !credentials[k] || credentials[k].length === 0);
  if (missing.length) {
    return Response.json({ error: `Missing values for: ${missing.join(", ")}` }, { status: 400 });
  }

  if (!(await resolveContainer(sandbox))) {
    return Response.json({ error: "Sandbox not found or not running" }, { status: 404 });
  }

  const script = await connectScriptPath();
  const registry = await registryPath();
  if (!script || !registry) {
    return Response.json({ error: "Connect script or registry not found on host" }, { status: 500 });
  }

  // Secrets flow to the script ONLY via the child env (never argv, never logs).
  // PATH is widened so the script finds `openshell` and `node`.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.PATH || ""}:${path.dirname(process.execPath)}:/usr/local/bin`,
    ...credentials,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [script, sandbox, toolName, registry],
      { env: childEnv, timeout: 120000 },
    );
    // The connect script prints only "[connect] …" status lines, no secrets.
    return Response.json({ ok: true, output: clean(`${stdout}\n${stderr}`).trim() });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = clean(`${err?.stdout || ""}\n${err?.stderr || err?.message || "connect failed"}`).trim();
    return Response.json({ ok: false, error: out }, { status: 500 });
  }
}
