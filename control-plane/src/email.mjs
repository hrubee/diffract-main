// ─────────────────────────────────────────────────────────────────────────────
// Welcome email — dependency-free, best-effort. Provisioning NEVER fails because
// email failed: we always write the message to an on-disk outbox (audit + manual
// resend) and, if SMTP is configured, deliver it via a tiny built-in SMTP client.
//
// SMTP is configured with SMTP_URL, e.g. (Hostinger business mailbox):
//   smtps://you@diffraction.in:APP_PASSWORD@smtp.hostinger.com:465
// `smtps://` = implicit TLS (port 465, what Hostinger recommends). SMTP_FROM must
// be that mailbox (or one of its aliases) or the provider will reject the sender.
//
// No nodemailer / no npm deps: the client below speaks just enough SMTP (EHLO →
// AUTH LOGIN → MAIL/RCPT/DATA) to send one message over node:tls.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";

/** Parse smtps://user:pass@host:port (smtps = implicit TLS). Returns null if unset/invalid. */
export function parseSmtpUrl(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "smtps:" && u.protocol !== "smtp:") return null;
  const secure = u.protocol === "smtps:";
  return {
    secure,
    host: u.hostname,
    port: u.port ? Number(u.port) : (secure ? 465 : 587),
    user: decodeURIComponent(u.username || ""),
    pass: decodeURIComponent(u.password || ""),
  };
}

/** Pull the bare address out of `Name <addr@x>` (or return the input if already bare). */
export function addrOnly(s) {
  const m = /<([^>]+)>/.exec(String(s ?? ""));
  return (m ? m[1] : String(s ?? "")).trim();
}

/** RFC 5321 dot-stuffing: lines beginning with "." must be doubled. */
export function dotStuff(data) {
  return data.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

/**
 * Send one message via SMTP. Resolves {ok, error} — never throws.
 * Implicit-TLS (465) and plain/explicit (587, no STARTTLS upgrade) supported;
 * for Hostinger use smtps://…:465.
 */
export function smtpSend({ host, port, secure, user, pass, from, to, raw }, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const data = raw.endsWith("\r\n") ? raw : raw + "\r\n";
    const seq = [
      { cmd: `EHLO diffract\r\n`, ok: 250 },
      { cmd: `AUTH LOGIN\r\n`, ok: 334 },
      { cmd: `${b64(user)}\r\n`, ok: 334 },
      { cmd: `${b64(pass)}\r\n`, ok: 235 },
      { cmd: `MAIL FROM:<${addrOnly(from)}>\r\n`, ok: 250 },
      { cmd: `RCPT TO:<${addrOnly(to)}>\r\n`, ok: 250 },
      { cmd: `DATA\r\n`, ok: 354 },
      { cmd: `${dotStuff(data)}.\r\n`, ok: 250 },
      { cmd: `QUIT\r\n`, ok: 221, last: true },
    ];
    let i = -1; // -1 = awaiting the 220 greeting
    let buf = "";
    let done = false;
    const sock = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, error: error ?? null });
    };
    sock.setTimeout(timeoutMs, () => finish(false, `smtp timeout connecting ${host}:${port}`));
    sock.on("error", (e) => finish(false, `smtp socket ${e.code || e.errno || e.syscall || e.message || "error"} (${host}:${port})`));
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (/^\d{3}-/.test(line)) continue; // multiline continuation; wait for final line
        const code = parseInt(line.slice(0, 3), 10);
        if (i === -1) {
          if (code !== 220) return finish(false, `greeting: ${line}`);
          i = 0; sock.write(seq[0].cmd); continue;
        }
        const step = seq[i];
        if (code !== step.ok) {
          return finish(false, `SMTP ${step.cmd.split("\r\n")[0]} -> ${line}`);
        }
        if (step.last) return finish(true);
        i += 1; sock.write(seq[i].cmd);
      }
    });
  });
}

/**
 * @param {{ smtpUrl?: string, from: string, support: string }} cfg
 * @param {{ to: string, subdomain: string, url: string, adminPassword: string, outboxDir: string }} msg
 * @returns {Promise<{ sent: boolean, outboxPath: string|null, error: string|null }>}
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
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    body.replace(/\n/g, "\r\n");

  // Always persist to the outbox (audit + manual resend), never fatal.
  let outboxPath = null;
  try {
    await fs.mkdir(outboxDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    outboxPath = path.join(outboxDir, `${stamp}-${subdomain}.eml`);
    await fs.writeFile(outboxPath, raw);
  } catch { /* non-fatal */ }

  const smtp = parseSmtpUrl(cfg.smtpUrl);
  if (!to || !smtp) return { sent: false, outboxPath, error: smtp ? "no recipient" : "SMTP not configured" };

  const r = await smtpSend({ ...smtp, from: cfg.from, to, raw });
  return { sent: r.ok, outboxPath, error: r.error };
}
