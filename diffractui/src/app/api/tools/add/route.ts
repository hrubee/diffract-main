import { requireBoxAccess as __rba } from "@/lib/rbac";
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
// Credential/config key. Allow simple text: letters (any case), digits,
// underscore and hyphen — e.g. API_KEY, api_key, or x-api-key. Still no shell
// metacharacters, so it stays injection-safe; the connect script reads values
// via printenv (handles hyphens/lowercase), not bash $VAR expansion.
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const HOST_RE = /^[a-z0-9.-]+:[0-9]{1,5}$/;
const ENTRY_RE = /^[a-zA-Z0-9._/-]{1,120}$/;
const REPO_RE = /^https:\/\/[a-zA-Z0-9._/-]+\.git$/;
const REF_RE = /^[a-zA-Z0-9._/-]{1,80}$/;
// REST tools: an auth-header prefix like "Authorization: Bearer" or "x-api-key:".
const AUTH_HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,40}:(?: [A-Za-z][A-Za-z0-9-]{0,30})?$/;

type NewTool = {
  name: string;
  description?: string;
  // INSTALL (CLI tools only): a git-cloneable, buildable CLI.
  repo?: string;
  ref?: string;
  kind?: string;
  patch?: string;
  build?: string;
  entry?: string;
  bin?: string;
  // CONNECT (all tools): host-side credential placeholder + egress allowlist.
  secretEnv?: string;
  configEnv?: Record<string, string>;
  apiHosts?: string[];
  binaries?: string[];
  authHeader?: string;
  // REST tools only: the API base URL + a few example endpoints used to compose
  // the agent skill. `transport` marks an install-less REST entry.
  transport?: string;
  baseUrl?: string;
  endpoints?: string[];
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

  let body: { sandbox?: string; tool?: NewTool; transport?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sandbox = body.sandbox || "";
  { const __d = await __rba(sandbox); if (__d) return __d; }
  const transport = body.transport === "rest" ? "rest" : "cli";
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
  if (t.bin && !BIN_RE.test(t.bin)) errs.push("bin");
  for (const h of t.apiHosts || []) if (!HOST_RE.test(h)) errs.push(`apiHost '${h}' (host:port)`);
  for (const b of t.binaries || []) if (!/^\/[a-zA-Z0-9._/-]+$/.test(b)) errs.push(`binary '${b}'`);
  for (const k of Object.keys(t.configEnv || {})) if (!KEY_RE.test(k)) errs.push(`config key '${k}'`);

  if (transport === "rest") {
    // REST / API-key tool: NO git clone or build. The agent calls the API via
    // curl; the secret is held host-side and injected at egress (the sandbox
    // only sees a placeholder), so this never bakes a binary.
    if (!(t.apiHosts && t.apiHosts.length)) errs.push("apiHosts (at least one host:port)");
    if (!t.secretEnv || !KEY_RE.test(t.secretEnv)) errs.push("secretEnv key (letters/digits/_/-, start with a letter)");
    if (!t.authHeader || !AUTH_HEADER_RE.test(t.authHeader.trim()))
      errs.push("authHeader (e.g. 'Authorization: Bearer' or 'x-api-key:')");
    let baseHost = "";
    try {
      const u = new URL((t.baseUrl || "").trim());
      if (u.protocol !== "https:") errs.push("baseUrl (must be https://)");
      baseHost = u.host.split(":")[0];
    } catch {
      errs.push("baseUrl (valid https URL)");
    }
    if (baseHost && !(t.apiHosts || []).some((h) => h.split(":")[0] === baseHost))
      errs.push(`baseUrl host '${baseHost}' must be one of the API host(s)`);
    // Endpoints are illustrative paths embedded in the skill's curl examples; a
    // leading slash is added at compose time, so only forbid characters that
    // would break the example string (whitespace, quotes, backtick, redirects).
    const badEndpoint = (p: string) => p.length > 300 || /[\s"`\\<>]/.test(p);
    for (const p of t.endpoints || []) if (badEndpoint(p)) errs.push(`endpoint '${p}' (no spaces or quotes)`);
  } else {
    // CLI tool: git clone + build inside the sandbox.
    if (!REPO_RE.test(t.repo || "")) errs.push("repo (https://….git)");
    if (t.ref && !REF_RE.test(t.ref)) errs.push("ref");
    if (!ENTRY_RE.test(t.entry || "")) errs.push("entry (e.g. dist/index.js)");
    const noCtrl = (s?: string) => !s || !/[\t\n\r]/.test(s); // build/patch are 1-line
    if (!noCtrl(t.build)) errs.push("build (no tabs/newlines)");
    if (!noCtrl(t.patch)) errs.push("patch (no tabs/newlines)");
    if (t.secretEnv && !KEY_RE.test(t.secretEnv)) errs.push("secretEnv key (letters/digits/_/-, start with a letter)");
  }
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

  let entry: NewTool;
  if (transport === "rest") {
    // Compose a curl-based skill so the agent knows the base URL, which env var
    // holds the (placeholder) token, and how to pass it. `bin: "curl"` makes the
    // advertise layer emit a SKILL.md; egress is attributed to /usr/bin/curl so
    // the agent must call the API with curl (its native httpx tool egresses as a
    // different binary and would be denied).
    const secret = t.secretEnv as string;
    const authHeader = (t.authHeader as string).trim();
    const headerName = authHeader.split(":")[0];
    const baseUrl = (t.baseUrl || "").trim().replace(/\/+$/, "");
    const paths = t.endpoints && t.endpoints.length ? t.endpoints : ["/"];
    const examples = paths.map(
      (p) => `curl -sS -H "${authHeader} $${secret}" ${baseUrl}${p.startsWith("/") ? p : "/" + p}`,
    );
    const summary =
      (t.description?.trim() || `${t.name} REST API`) +
      ` — call it with curl at ${baseUrl}. The token is in $${secret} (a placeholder` +
      ` injected at egress; never print it); send it via the ${headerName} header.`;
    entry = {
      name: t.name,
      description: t.description || "",
      transport: "rest",
      bin: "curl",
      secretEnv: secret,
      configEnv: t.configEnv || {},
      apiHosts: t.apiHosts || [],
      binaries: t.binaries && t.binaries.length ? t.binaries : ["/usr/bin/curl"],
      authHeader,
      skill: {
        name: t.skill?.name || `${t.name}-tool`,
        title: t.skill?.title || t.description || t.name,
        summary: t.skill?.summary || summary,
        tags: t.skill?.tags && t.skill.tags.length ? t.skill.tags : ["rest", "api"],
        examples,
      },
    };
  } else {
    entry = {
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
  }
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
