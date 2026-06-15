// ─────────────────────────────────────────────────────────────────────────────
// Welcome email — best-effort, dependency-free. Provisioning NEVER fails because
// email failed; we always write the message to an on-disk outbox (audit + manual
// resend) and additionally try the system `sendmail` if it exists (Postfix/MSA
// on the VPS). Swap in a transactional provider (Resend/Postmark) here later if
// you want delivery guarantees — keep the same sendWelcome() signature.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

async function trySendmail(from, to, raw) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("sendmail", ["-t", "-f", from], { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(raw);
  });
}

/**
 * @param {{ from: string, support: string }} cfg
 * @param {{ to: string, subdomain: string, url: string, adminPassword: string, outboxDir: string }} msg
 */
export async function sendWelcome(cfg, { to, subdomain, url, adminPassword, outboxDir }) {
  const subject = `Your Diffract workspace ${subdomain} is ready`;
  const body =
    `Hi,\n\n` +
    `Your Diffract workspace is live:\n\n` +
    `  ${url}\n\n` +
    `Dashboard admin password: ${adminPassword}\n\n` +
    `The AI agent is already deployed and ready to chat. Log in at the URL above.\n\n` +
    `Questions? Reply to this email or write to ${cfg.support}.\n\n` +
    `— Diffract\n`;
  const raw =
    `From: ${cfg.from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    body.replace(/\n/g, "\r\n");

  // Always persist to the outbox (audit + manual resend).
  let outboxPath = null;
  try {
    await fs.mkdir(outboxDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    outboxPath = path.join(outboxDir, `${stamp}-${subdomain}.eml`);
    await fs.writeFile(outboxPath, raw);
  } catch { /* non-fatal */ }

  const sent = to ? await trySendmail(cfg.from, to, raw) : false;
  return { sent, outboxPath };
}
