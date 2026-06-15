// ─────────────────────────────────────────────────────────────────────────────
// Provisioner — the core pipeline. Given a verified, paid claim:
//
//   create post-install script (install.sh + tenant env)
//     -> purchase a Hostinger VPS (charges YOUR billing) referencing that script
//     -> poll until the VM is running + has an IP
//     -> point <sub>.diffraction.in at vpsIp:80 via the ingress
//     -> health-check the box through the ingress
//     -> status=active, email the client their URL
//
// Every step updates the tenant row so a failure is visible + retryable, never a
// silent half-provision. On cancel/refund we remove the route and suspend (VPS
// teardown is left manual on purpose — destroying a paid box should be a human
// decision, see deprovision()).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import path from "node:path";
import { buildPostInstallScript } from "./postinstall.mjs";
import { extractVmId, extractVmIp, extractVmState } from "./hostinger.mjs";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60_000; // VM order + OS install + base-image build
const HEALTH_TIMEOUT_MS = 8 * 60_000;
const RUNNING_STATES = new Set(["running", "active", "started"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomPassword = () => crypto.randomBytes(18).toString("base64url");

export class Provisioner {
  #cfg; #store; #hostinger; #caddy; #email; #log;

  constructor({ config, store, hostinger, caddy, email, logger = console }) {
    this.#cfg = config;
    this.#store = store;
    this.#hostinger = hostinger;
    this.#caddy = caddy;
    this.#email = email;
    this.#log = logger;
  }

  /**
   * @param {{ subdomain: string, email: string, name: string,
   *           subscriptionId: string, customerId: string, currentPeriodEnd: string }} claim
   */
  async provision(claim) {
    const { subdomain } = claim;

    // Idempotency at the tenant level: an already-active tenant for this sub is
    // never re-provisioned (the webhook-id dedupe is the first guard; this is the
    // second, covering renewals that re-send subscription.active).
    const existing = await this.#store.get(subdomain);
    if (existing && (existing.status === "active" || existing.status === "provisioning")) {
      this.#log.log(`[provision] ${subdomain} already ${existing.status} — skipping`);
      return existing;
    }

    const adminPassword = existing?.adminPassword ?? randomPassword();
    await this.#store.upsert(subdomain, {
      displayName: claim.name || subdomain,
      email: claim.email,
      status: "provisioning",
      dodoSubscriptionId: claim.subscriptionId,
      dodoCustomerId: claim.customerId,
      currentPeriodEnd: claim.currentPeriodEnd,
      adminPassword,
      error: null,
    });

    let scriptId = null;
    try {
      // 1. Post-install script (tenant env baked in).
      const content = buildPostInstallScript({
        subdomain,
        adminPassword,
        ingressIp: this.#cfg.install.ingressIp,
        install: this.#cfg.install,
        inject: this.#cfg.inject,
      });
      const script = await this.#hostinger.createPostInstallScript({
        name: `diffract-${subdomain}`,
        content,
      });
      scriptId = script?.id ?? script?.data?.id ?? null;
      await this.#store.patch(subdomain, { postInstallScriptId: scriptId });
      this.#log.log(`[provision] ${subdomain}: post-install script ${scriptId}`);

      // 2. Purchase + set up the VPS.
      const setup = {
        templateId: this.#cfg.hostinger.templateId,
        dataCenterId: this.#cfg.hostinger.dataCenterId,
        hostname: `${subdomain}.${this.#cfg.controlDomain}`,
        password: adminPassword,
        enableBackups: this.#cfg.hostinger.enableBackups,
      };
      if (scriptId) setup.postInstallScriptId = scriptId;

      const purchase = await this.#hostinger.purchaseVirtualMachine({
        itemId: this.#cfg.hostinger.itemId,
        paymentMethodId: this.#cfg.hostinger.paymentMethodId || undefined,
        setup,
      });
      const vpsId = extractVmId(purchase);
      if (!vpsId) throw new Error(`purchase returned no VM id: ${JSON.stringify(purchase)}`);
      await this.#store.patch(subdomain, { vpsId });
      this.#log.log(`[provision] ${subdomain}: ordered VPS ${vpsId}`);

      // 3. Poll until running + has an IP.
      const vpsIp = await this.#waitForVm(vpsId, subdomain);
      await this.#store.patch(subdomain, { vpsIp });
      this.#log.log(`[provision] ${subdomain}: VPS ${vpsId} running at ${vpsIp}`);

      // 4. Point the subdomain at the box.
      await this.#caddy.upsertTenantRoute(subdomain, this.#cfg.controlDomain, vpsIp);
      this.#log.log(`[provision] ${subdomain}: ingress route -> ${vpsIp}:80`);

      // 5. Health-check through the ingress (install.sh + base-image build is slow).
      const url = `https://${subdomain}.${this.#cfg.controlDomain}`;
      await this.#waitForHealthy(url, subdomain);

      // 6. Active + email.
      await this.#store.patch(subdomain, { status: "active", error: null });
      const mail = await this.#email(claim.email, { subdomain, url, adminPassword });
      this.#log.log(`[provision] ${subdomain}: ACTIVE (${url}); email sent=${mail.sent}`);
      return await this.#store.get(subdomain);
    } catch (err) {
      const msg = err?.message ?? String(err);
      this.#log.error(`[provision] ${subdomain} FAILED: ${msg}`);
      await this.#store.patch(subdomain, { status: "failed", error: msg });
      throw err;
    }
  }

  async #waitForVm(vpsId, subdomain) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let vm;
      try { vm = await this.#hostinger.getVirtualMachine(vpsId); }
      catch (e) { this.#log.log(`[provision] ${subdomain}: poll error ${e.message}`); }
      if (vm) {
        const state = extractVmState(vm);
        const ip = extractVmIp(vm);
        if (RUNNING_STATES.has(state) && ip) return ip;
        this.#log.log(`[provision] ${subdomain}: VM state=${state || "?"} ip=${ip || "?"}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`VPS ${vpsId} not running within ${POLL_TIMEOUT_MS / 60000}m`);
  }

  async #waitForHealthy(url, subdomain) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        // Any HTTP response (even a redirect/login) means Caddy reached the box.
        if (res.status > 0) return true;
      } catch { /* not up yet */ }
      await sleep(POLL_INTERVAL_MS);
    }
    // Non-fatal: the box may still be finishing the base-image build. Mark active
    // anyway is risky, so surface it — caller decides. Here we throw so status=failed.
    throw new Error(`health-check timed out for ${subdomain} (${url})`);
  }

  /** Cancel/refund/expire: drop the route + suspend. VPS teardown stays manual. */
  async deprovision(subscriptionId) {
    const tenant = await this.#store.findBySubscription(subscriptionId);
    if (!tenant) {
      this.#log.log(`[deprovision] no tenant for subscription ${subscriptionId}`);
      return null;
    }
    try { await this.#caddy.removeTenantRoute(tenant.subdomain); } catch (e) {
      this.#log.error(`[deprovision] route removal failed: ${e.message}`);
    }
    const next = await this.#store.patch(tenant.subdomain, { status: "suspended" });
    this.#log.log(`[deprovision] ${tenant.subdomain}: suspended (VPS ${tenant.vpsId} left for manual teardown)`);
    return next;
  }
}
