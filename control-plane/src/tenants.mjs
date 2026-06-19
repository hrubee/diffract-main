// ─────────────────────────────────────────────────────────────────────────────
// Tenant registry — the multi-tenant source of truth (NOT sandboxes.json, which
// stays a per-VPS local detail). A single JSON file, mutated under an in-process
// mutex and written atomically (temp file + rename) so a crash mid-write can
// never corrupt it. The control plane is single-process, so an in-memory mutex
// is sufficient; if it ever scales out, swap this for SQLite/Postgres behind the
// same interface.
//
// Record shape (keyed by subdomain):
//   subdomain, displayName, email
//   status: pending | provisioning | active | suspended | failed | deprovisioned
//   vpsId, vpsIp                         backend the ingress routes to
//   dodoSubscriptionId, dodoCustomerId
//   currentPeriodEnd
//   adminPassword                        dashboard admin pw injected at provision
//   postInstallScriptId                  Hostinger script id (for cleanup)
//   error                                last failure (for retry/ops)
//   createdAt, updatedAt
//
// Idempotency: processed webhook-ids are kept in a bounded ring so Dodo retries
// (it delivers at-least-once) never provision twice.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_PROCESSED = 5000;

export class TenantStore {
  #file;
  #tmp;
  #state = null;
  #queue = Promise.resolve();

  constructor(file) {
    this.#file = path.resolve(file);
    this.#tmp = this.#file + ".tmp";
  }

  async #load() {
    if (this.#state) return this.#state;
    try {
      const raw = await fs.readFile(this.#file, "utf8");
      this.#state = JSON.parse(raw);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.#state = { tenants: {}, processed: [] };
    }
    this.#state.tenants ??= {};
    this.#state.processed ??= [];
    return this.#state;
  }

  async #persist() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#tmp, JSON.stringify(this.#state, null, 2));
    await fs.rename(this.#tmp, this.#file); // atomic on the same filesystem
  }

  // Serialize all mutations so concurrent webhooks can't interleave a read +
  // write. Read-only helpers also funnel through here for a consistent snapshot.
  #withLock(fn) {
    const run = this.#queue.then(async () => {
      const state = await this.#load();
      return fn(state);
    });
    // Keep the chain alive even if fn throws, but propagate the error to caller.
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  /** Has this webhook-id already been handled? Records it if not (idempotency). */
  markProcessed(webhookId) {
    return this.#withLock(async (state) => {
      if (state.processed.includes(webhookId)) return false;
      state.processed.push(webhookId);
      if (state.processed.length > MAX_PROCESSED) {
        state.processed.splice(0, state.processed.length - MAX_PROCESSED);
      }
      await this.#persist();
      return true;
    });
  }

  get(subdomain) {
    return this.#withLock((state) => state.tenants[subdomain] ?? null);
  }

  list() {
    return this.#withLock((state) => Object.values(state.tenants));
  }

  findBySubscription(subscriptionId) {
    return this.#withLock((state) =>
      Object.values(state.tenants).find((t) => t.dodoSubscriptionId === subscriptionId) ?? null);
  }

  /** Create or replace a tenant record. */
  upsert(subdomain, patch) {
    return this.#withLock(async (state) => {
      const now = new Date().toISOString();
      const prev = state.tenants[subdomain];
      const next = {
        subdomain,
        createdAt: prev?.createdAt ?? now,
        ...prev,
        ...patch,
        updatedAt: now,
      };
      state.tenants[subdomain] = next;
      await this.#persist();
      return next;
    });
  }

  /** Shallow-merge a patch onto an existing tenant (no-op if absent). */
  patch(subdomain, patch) {
    return this.#withLock(async (state) => {
      const prev = state.tenants[subdomain];
      if (!prev) return null;
      const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
      state.tenants[subdomain] = next;
      await this.#persist();
      return next;
    });
  }

  /** Remove a tenant record entirely (ops cleanup). Returns true if it existed. */
  delete(subdomain) {
    return this.#withLock(async (state) => {
      if (!state.tenants[subdomain]) return false;
      delete state.tenants[subdomain];
      await this.#persist();
      return true;
    });
  }

  /**
   * On startup there are NO in-flight provisions (fresh process), so any tenant
   * left in "provisioning" was interrupted (a redeploy/crash killed the work
   * after the webhook already ACK'd). Flag them "failed" so they're visible +
   * retryable — but DON'T auto-provision (a crash loop must never buy VPSs).
   * Returns the subdomains it recovered.
   */
  recoverInterrupted() {
    return this.#withLock(async (state) => {
      const recovered = [];
      const now = new Date().toISOString();
      for (const t of Object.values(state.tenants)) {
        if (t.status === "provisioning") {
          t.status = "failed";
          t.error = "provisioning interrupted (recovered on startup) — POST /internal/retry to resume";
          t.updatedAt = now;
          recovered.push(t.subdomain);
        }
      }
      if (recovered.length) await this.#persist();
      return recovered;
    });
  }
}
