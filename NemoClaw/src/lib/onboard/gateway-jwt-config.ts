// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway-minted sandbox JWT config for OpenShell >= 0.0.57.
//
// 0.0.39 starts the gateway env-only with auth disabled. 0.0.57 isolates the
// workload in a netns (the credential-injection / no-bypass model) and requires
// the gateway to mint short-lived JWTs for its sandboxes, configured via a TOML
// `--config` file (NOT env). This module generates the Ed25519 keypair + the
// TOML idempotently under the gateway state dir, so the launch can append
// `--config <toml>`. It is version-gated: on 0.0.39 nothing here runs.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MIN_JWT_VERSION = "0.0.57";

function compareDottedVersions(a: string, b: string): number {
  const left = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const right = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Detect the gateway version (e.g. "0.0.57") from `<bin> --version`. */
export function detectGatewayVersion(gatewayBin: string): string | null {
  try {
    const out = execFileSync(gatewayBin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when the gateway version needs the TOML gateway-JWT config (>= 0.0.57). */
export function gatewayNeedsJwtConfig(version: string | null): boolean {
  return Boolean(version) && compareDottedVersions(version as string, MIN_JWT_VERSION) >= 0;
}

export interface GatewayJwtConfigPaths {
  tomlPath: string;
  signingKeyPath: string;
  publicKeyPath: string;
  kidPath: string;
}

/**
 * Idempotently ensure the Ed25519 keypair + gateway TOML exist under `stateDir`
 * and return their paths. Keys + TOML live under `stateDir` because the compat
 * container launch mounts `stateDir` rw at the same path, so `--config <toml>`
 * resolves identically on host and in-container.
 */
export function ensureGatewayJwtConfig(stateDir: string, ttlSecs = 3600): GatewayJwtConfigPaths {
  const jwtDir = path.join(stateDir, "jwt");
  const signingKeyPath = path.join(jwtDir, "signing.pem");
  const publicKeyPath = path.join(jwtDir, "public.pem");
  const kidPath = path.join(jwtDir, "kid");
  const tomlPath = path.join(stateDir, "gateway-config.toml");

  fs.mkdirSync(jwtDir, { recursive: true });

  if (!fs.existsSync(signingKeyPath) || !fs.existsSync(publicKeyPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    fs.writeFileSync(signingKeyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
  }

  if (!fs.existsSync(kidPath)) {
    const pub = fs.readFileSync(publicKeyPath);
    const kid = crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16);
    fs.writeFileSync(kidPath, kid, { mode: 0o644 });
  }

  const toml =
    "[openshell.gateway.auth]\n" +
    "allow_unauthenticated_users = true\n\n" +
    "[openshell.gateway.gateway_jwt]\n" +
    `ttl_secs = ${ttlSecs}\n` +
    `signing_key_path = ${JSON.stringify(signingKeyPath)}\n` +
    `public_key_path = ${JSON.stringify(publicKeyPath)}\n` +
    `kid_path = ${JSON.stringify(kidPath)}\n`;
  fs.writeFileSync(tomlPath, toml, { mode: 0o644 });

  return { tomlPath, signingKeyPath, publicKeyPath, kidPath };
}

/**
 * Return the extra gateway CLI args for the configured OpenShell version: the
 * `--config <toml>` pair on >= 0.0.57 (generating keys/TOML as a side effect),
 * or [] on 0.0.39. Pure passthrough so the launch builder stays version-agnostic.
 */
export function gatewayJwtConfigArgs(gatewayBin: string, stateDir: string): string[] {
  const version = detectGatewayVersion(gatewayBin);
  if (!gatewayNeedsJwtConfig(version)) return [];
  const { tomlPath } = ensureGatewayJwtConfig(stateDir);
  return ["--config", tomlPath];
}
