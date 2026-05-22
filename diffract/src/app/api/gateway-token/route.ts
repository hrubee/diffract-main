import { execFileSync } from "child_process";

const OPENSHELL = process.env.OPENSHELL_PATH || "openshell";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sandbox = searchParams.get("sandbox") || "";

  if (!sandbox) {
    return Response.json({ token: "" }, { status: 400 });
  }

  try {
    const output = execFileSync(
      OPENSHELL,
      ["sandbox", "exec", "--name", sandbox, "--", "cat", "/sandbox/.openclaw/openclaw.json"],
      { timeout: 15000, encoding: "utf-8", shell: true }
    );

    const config = JSON.parse(output);
    const token = config?.gateway?.auth?.token || "";

    return Response.json({ token });
  } catch {
    return Response.json({ token: "" }, { status: 500 });
  }
}
