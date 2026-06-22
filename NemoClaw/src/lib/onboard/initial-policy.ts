// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import * as policies from "../policy";
import { cleanupTempDir, secureTempFile } from "./temp-files";

export type InitialSandboxPolicy = {
  policyPath: string;
  appliedPresets: string[];
  cleanup?: () => boolean;
};

const CREATE_TIME_POLICY_PRESETS_BY_CHANNEL: Record<string, string[]> = {
  slack: ["slack"],
};

const HERMES_MESSAGING_POLICY_KEYS: Record<string, string[]> = {
  discord: ["discord"],
  slack: ["slack"],
  telegram: ["telegram"],
  wechat: ["wechat_bridge"],
};

const PROC_PATH = "/proc";
const PROC_COMM_READ_WRITE_PATHS = ["/proc/self/comm", "/proc/self/task/*/comm"];

function isProcEntryOwnedByOpenShell(entry: string): boolean {
  return entry === PROC_PATH || PROC_COMM_READ_WRITE_PATHS.includes(entry);
}

type DirectGpuPolicyOptions = {
  procReadWrite?: boolean;
};

export function buildDirectGpuPolicyYaml(
  basePolicy: string,
  options: DirectGpuPolicyOptions = {},
): string {
  const parsed = YAML.parse(basePolicy);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Cannot prepare direct GPU sandbox policy; base policy is not a YAML mapping.");
  }
  parsed.filesystem_policy = parsed.filesystem_policy || {};
  const fsPolicy = parsed.filesystem_policy;
  // OpenShell adds /proc as read-write only after GPU devices are present.
  // Remove entries that would block that enrichment or be treated as literal paths.
  const readOnly = Array.isArray(fsPolicy.read_only)
    ? fsPolicy.read_only.map((entry: unknown) => String(entry))
    : [];
  fsPolicy.read_only = readOnly.filter((entry: string) => !isProcEntryOwnedByOpenShell(entry));
  const readWrite = Array.isArray(fsPolicy.read_write)
    ? fsPolicy.read_write.map((entry: unknown) => String(entry))
    : [];
  fsPolicy.read_write = readWrite.filter((entry: string) => !isProcEntryOwnedByOpenShell(entry));
  if (options.procReadWrite && !fsPolicy.read_write.includes(PROC_PATH)) {
    // Linux Docker-driver GPU patching recreates the container with GPU flags
    // after `openshell sandbox create`, so OpenShell never sees `--gpu` and
    // cannot add its native /proc GPU enrichment. Mirror that enrichment here
    // for the patched path; without it Landlock denies the NVIDIA runtime's
    // /proc/<pid>/task/<tid>/comm write even though Docker GPU access works.
    fsPolicy.read_write.push(PROC_PATH);
  }
  return YAML.stringify(parsed);
}

const PROC_COMM_WRITE_PROBE = [
  "set -eu;",
  'comm="/proc/self/comm";',
  'old="$(cat "$comm" 2>/dev/null || true)";',
  'printf nemoclaw-gpu >"$comm";',
  'if [ -n "$old" ]; then',
  'printf "%s" "$old" >"$comm" || true;',
  "fi",
].join(" ");

const CUDA_INIT_PROBE = [
  "python3",
  "-c",
  [
    "'import ctypes;",
    'lib = ctypes.CDLL("libcuda.so.1");',
    "rc = lib.cuInit(0);",
    'print(f"cuInit(0)={rc}");',
    "raise SystemExit(0 if rc == 0 else 1)'",
  ].join(" "),
].join(" ");

const NVIDIA_SMI_OPTIONAL_PROBE = [
  "set -eu;",
  "if command -v nvidia-smi >/dev/null 2>&1; then",
  "exec nvidia-smi;",
  "fi;",
  'echo "nvidia-smi not installed; skipping optional visibility check"',
].join(" ");

export type DirectSandboxGpuProofCommand = {
  id: string;
  label: string;
  args: string[];
  optional?: boolean;
};

export function buildDirectSandboxGpuProofCommands(
  sandboxName: string,
): DirectSandboxGpuProofCommand[] {
  return [
    {
      id: "nvidia-smi",
      label: "nvidia-smi when available",
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", NVIDIA_SMI_OPTIONAL_PROBE],
    },
    {
      id: "proc-comm-write",
      label: "/proc/<pid>/task/<tid>/comm write",
      optional: true,
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", PROC_COMM_WRITE_PROBE],
    },
    {
      id: "cuda-init",
      label: "cuInit(0) via libcuda.so.1",
      optional: true,
      args: ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", CUDA_INIT_PROBE],
    },
  ];
}

function prepareDirectGpuSandboxPolicy(
  basePolicyPath: string,
  options: DirectGpuPolicyOptions = {},
): InitialSandboxPolicy {
  const basePolicy = fs.readFileSync(basePolicyPath, "utf-8");
  const policyPath = secureTempFile("nemoclaw-gpu-policy", ".yaml");
  fs.writeFileSync(policyPath, buildDirectGpuPolicyYaml(basePolicy, options), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    policyPath,
    appliedPresets: [],
    cleanup: () => {
      try {
        cleanupTempDir(policyPath, "nemoclaw-gpu-policy");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function getNetworkPolicyNames(policyContent: string): Set<string> | null {
  try {
    const parsed = YAML.parse(policyContent);
    const networkPolicies = parsed?.network_policies;
    if (
      !networkPolicies ||
      typeof networkPolicies !== "object" ||
      Array.isArray(networkPolicies)
    ) {
      return new Set();
    }
    return new Set(Object.keys(networkPolicies));
  } catch {
    return null;
  }
}

function isYamlObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterHermesInactiveMessagingPolicies(
  policyContent: string,
  activeMessagingChannels: string[],
): { content: string; changed: boolean } {
  const parsed = YAML.parse(policyContent);
  if (!isYamlObject(parsed) || !isYamlObject(parsed.network_policies)) {
    return { content: policyContent, changed: false };
  }

  const active = new Set(activeMessagingChannels);
  let changed = false;
  for (const [channel, policyKeys] of Object.entries(HERMES_MESSAGING_POLICY_KEYS)) {
    if (active.has(channel)) continue;
    for (const key of policyKeys) {
      if (Object.prototype.hasOwnProperty.call(parsed.network_policies, key)) {
        delete parsed.network_policies[key];
        changed = true;
      }
    }
  }

  return {
    content: changed ? YAML.stringify(parsed) : policyContent,
    changed,
  };
}

function isHermesPolicyPath(policyPath: string): boolean {
  const normalized = policyPath.split(path.sep).join("/");
  return /(^|\/)agents\/hermes\/policy-additions\.yaml$/.test(normalized);
}

/**
 * Allow the connected MCP server hosts in the CREATE-TIME policy, so MCP egress is
 * active BEFORE the chat daemon's startup MCP discovery. Without this the daemon
 * discovers MCP at startup — before the deploy flow applies per-server egress — and
 * registers 0 tools; and the api_server (chat) agent only picks up MCP tools at
 * startup, so a later reload can't help it.
 *
 * Hosts are derived from NEMOCLAW_MCP_SERVERS_B64 (the create-time mcp_servers config
 * the deploy route already passes): each enabled server's URL (`url`, or the last
 * `args` entry for command/bridge servers). Scoped to the python binaries that run the
 * stdio bridge (diffract-mcp-bridge.py) — the daemon's OWN in-process egress is
 * mis-attributed (binary=-) and 403'd, but the bridge SUBPROCESS is attributed
 * correctly. See docs/bugs/openshell-egress-attribution-mcp-403.md.
 */
function buildMcpEgressInjector(): ((content: string) => string) | null {
  const b64 = process.env.NEMOCLAW_MCP_SERVERS_B64;
  if (!b64 || b64 === "e30=") return null;
  let servers: unknown;
  try {
    servers = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  if (!isYamlObject(servers)) return null;

  const seen = new Set<string>();
  const endpoints: Array<{ host: string; port: number }> = [];
  for (const cfg of Object.values(servers)) {
    if (!isYamlObject(cfg) || cfg.enabled === false) continue;
    const args = (cfg as Record<string, unknown>).args;
    const url =
      typeof cfg.url === "string"
        ? (cfg.url as string)
        : Array.isArray(args) && typeof args[args.length - 1] === "string"
          ? (args[args.length - 1] as string)
          : "";
    if (!/^https?:\/\//.test(url)) continue;
    try {
      const u = new URL(url);
      const port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
      const key = `${u.hostname}:${port}`;
      if (!seen.has(key)) {
        seen.add(key);
        endpoints.push({ host: u.hostname, port });
      }
    } catch {
      /* skip malformed url */
    }
  }
  if (endpoints.length === 0) return null;

  return (content: string): string => {
    const parsed = YAML.parse(content);
    if (!isYamlObject(parsed)) return content;
    const net = isYamlObject(parsed.network_policies)
      ? (parsed.network_policies as Record<string, unknown>)
      : {};
    net.diffract_mcp = {
      endpoints: endpoints.map((e) => ({
        host: e.host,
        port: e.port,
        protocol: "rest",
        enforcement: "enforce",
        access: "full",
      })),
      binaries: [
        { path: "/usr/bin/python3.13" },
        { path: "/opt/hermes/.venv/bin/python3.13" },
        { path: "/opt/hermes/.venv/bin/python3" },
        { path: "/opt/hermes/.venv/bin/python" },
      ],
    };
    parsed.network_policies = net;
    return YAML.stringify(parsed);
  };
}

export function prepareInitialSandboxCreatePolicy(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: {
    directGpu?: boolean;
    dockerGpuPatch?: boolean;
    additionalPresets?: string[];
    agentName?: string | null;
  } = {},
): InitialSandboxPolicy {
  const base = prepareInitialSandboxCreatePolicyBase(
    basePolicyPath,
    activeMessagingChannels,
    options,
  );
  const inject = buildMcpEgressInjector();
  if (!inject) return base;
  let content: string;
  try {
    content = fs.readFileSync(base.policyPath, "utf-8");
  } catch {
    return base;
  }
  const injected = inject(content);
  if (injected === content) return base;
  const policyPath = secureTempFile("nemoclaw-mcp-policy", ".yaml");
  fs.writeFileSync(policyPath, injected, { encoding: "utf-8", mode: 0o600 });
  const prevCleanup = base.cleanup;
  return {
    policyPath,
    appliedPresets: base.appliedPresets,
    cleanup: () => {
      let ok = true;
      try {
        cleanupTempDir(policyPath, "nemoclaw-mcp-policy");
      } catch {
        ok = false;
      }
      if (prevCleanup) ok = prevCleanup() && ok;
      return ok;
    },
  };
}

function prepareInitialSandboxCreatePolicyBase(
  basePolicyPath: string,
  activeMessagingChannels: string[],
  options: {
    directGpu?: boolean;
    dockerGpuPatch?: boolean;
    additionalPresets?: string[];
    agentName?: string | null;
  } = {},
): InitialSandboxPolicy {
  const directGpuPolicy = options.directGpu
    ? prepareDirectGpuSandboxPolicy(basePolicyPath, {
        procReadWrite: options.dockerGpuPatch === true,
      })
    : null;
  let effectiveBasePolicyPath = directGpuPolicy?.policyPath || basePolicyPath;
  const cleanupFns = directGpuPolicy?.cleanup ? [directGpuPolicy.cleanup] : [];
  const buildCleanup = () =>
    cleanupFns.length > 0
      ? () => cleanupFns.map((cleanup) => cleanup()).every(Boolean)
      : undefined;
  const requestedCreateTimePresets = [
    ...new Set(
      [
        ...activeMessagingChannels.flatMap(
          (channel) => CREATE_TIME_POLICY_PRESETS_BY_CHANNEL[channel] || [],
        ),
        ...(options.additionalPresets || []),
      ],
    ),
  ];
  const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];

  let basePolicy = fs.readFileSync(effectiveBasePolicyPath, "utf-8");
  if (options.agentName === "hermes" || isHermesPolicyPath(basePolicyPath)) {
    const filtered = filterHermesInactiveMessagingPolicies(basePolicy, activeMessagingChannels);
    if (filtered.changed) {
      const policyPath = secureTempFile("nemoclaw-agent-policy", ".yaml");
      fs.writeFileSync(policyPath, filtered.content, { encoding: "utf-8", mode: 0o600 });
      cleanupFns.push(() => {
        try {
          cleanupTempDir(policyPath, "nemoclaw-agent-policy");
          return true;
        } catch {
          return false;
        }
      });
      effectiveBasePolicyPath = policyPath;
      basePolicy = filtered.content;
    }
  }

  const basePolicyNames = getNetworkPolicyNames(basePolicy);
  if (basePolicyNames === null) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: [],
      cleanup: buildCleanup(),
    };
  }
  const existingChannelPresets = activeMessagingChannels.filter((channel) =>
    basePolicyNames.has(channel),
  );

  if (requestedCreateTimePresets.length === 0) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: dedupe(existingChannelPresets),
      cleanup: buildCleanup(),
    };
  }

  const existingCreateTimePresets = requestedCreateTimePresets.filter((preset) =>
    basePolicyNames.has(preset),
  );
  const createTimePresets = requestedCreateTimePresets.filter(
    (preset) => !basePolicyNames.has(preset),
  );
  if (createTimePresets.length === 0) {
    return {
      policyPath: effectiveBasePolicyPath,
      appliedPresets: dedupe([...existingChannelPresets, ...existingCreateTimePresets]),
      cleanup: buildCleanup(),
    };
  }

  const mergedPolicy = policies.mergePresetNamesIntoPolicy(basePolicy, createTimePresets);
  if (mergedPolicy.missingPresets.length > 0) {
    throw new Error(
      `Cannot prepare sandbox create policy; missing policy preset(s): ${mergedPolicy.missingPresets.join(", ")}`,
    );
  }

  const policyPath = secureTempFile("nemoclaw-initial-policy", ".yaml");
  fs.writeFileSync(policyPath, mergedPolicy.policy, { encoding: "utf-8", mode: 0o600 });
  cleanupFns.push(() => {
    try {
      cleanupTempDir(policyPath, "nemoclaw-initial-policy");
      return true;
    } catch {
      return false;
    }
  });

  return {
    policyPath,
    appliedPresets: dedupe([
      ...existingChannelPresets,
      ...existingCreateTimePresets,
      ...mergedPolicy.appliedPresets,
    ]),
    cleanup: buildCleanup(),
  };
}
