// ─────────────────────────────────────────────────────────────────────────────
// Hostinger VPS API client (the subset we provision with).
//
// Endpoints (Bearer auth; base default https://developers.hostinger.com):
//   POST /api/vps/v1/post-install-scripts          create a root post-install script (<=48KB)
//   POST /api/vps/v1/virtual-machines              purchaseNewVirtualMachineV1 (orders + sets up a VPS)
//   GET  /api/vps/v1/virtual-machines/{id}         poll state / read IP
//   POST /api/vps/v1/virtual-machines/{id}/recreate reinstall OS + post-install (warm-pool reuse)
//   DELETE /api/vps/v1/post-install-scripts/{id}   cleanup
//
// The purchase body (VPSV1VirtualMachinePurchaseRequest):
//   { itemId, paymentMethodId?, setup: VPSV1VirtualMachineSetupRequest }
// setup (VPSV1VirtualMachineSetupRequest):
//   { templateId, dataCenterId, postInstallScriptId?, password?, hostname?, enableBackups? }
//
// Field names verified against hostinger/api-php-sdk model docs.
// ─────────────────────────────────────────────────────────────────────────────

export class HostingerError extends Error {
  constructor(method, pathName, status, body) {
    super(`Hostinger ${method} ${pathName} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "HostingerError";
    this.status = status;
    this.body = body;
  }
}

export class Hostinger {
  #token;
  #base;

  constructor({ token, base = "https://developers.hostinger.com" }) {
    this.#token = token;
    this.#base = base.replace(/\/+$/, "");
  }

  async #req(method, pathName, body) {
    const res = await fetch(this.#base + pathName, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new HostingerError(method, pathName, res.status, parsed);
    return parsed;
  }

  /** Create a post-install script. Returns the created resource (incl. its id). */
  createPostInstallScript({ name, content }) {
    return this.#req("POST", "/api/vps/v1/post-install-scripts", { name, content });
  }

  deletePostInstallScript(id) {
    return this.#req("DELETE", `/api/vps/v1/post-install-scripts/${id}`);
  }

  /**
   * Order a brand-new VPS and set it up in one call.
   * @param {{ itemId: string, paymentMethodId?: number, setup: object }} args
   */
  purchaseVirtualMachine({ itemId, paymentMethodId, setup }) {
    const body = { itemId, setup };
    if (paymentMethodId) body.paymentMethodId = paymentMethodId;
    return this.#req("POST", "/api/vps/v1/virtual-machines", body);
  }

  getVirtualMachine(id) {
    return this.#req("GET", `/api/vps/v1/virtual-machines/${id}`);
  }

  listVirtualMachines() {
    return this.#req("GET", "/api/vps/v1/virtual-machines");
  }

  /** Reinstall OS + post-install on an existing VM (warm-pool / recovery). */
  recreateVirtualMachine(id, setup) {
    return this.#req("POST", `/api/vps/v1/virtual-machines/${id}/recreate`, setup);
  }
}

// Hostinger returns the VM with a numeric id and an ipv4 list once provisioned.
// Shapes drift across API versions, so pull defensively.
export function extractVmId(vm) {
  return vm?.id ?? vm?.data?.id ?? vm?.virtual_machine?.id ?? null;
}

export function extractVmState(vm) {
  return String(vm?.state ?? vm?.status ?? vm?.data?.state ?? "").toLowerCase();
}

export function extractVmIp(vm) {
  const node = vm?.data ?? vm;
  const v4 = node?.ipv4 ?? node?.ip_addresses ?? node?.ips ?? [];
  if (Array.isArray(v4) && v4.length) {
    const first = v4[0];
    return typeof first === "string" ? first : (first?.address ?? first?.ip ?? null);
  }
  return node?.ip ?? node?.main_ip ?? null;
}
