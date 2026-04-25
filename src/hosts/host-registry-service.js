import fs from "node:fs/promises";
import path from "node:path";

import {
  formatExecutionHostName,
  normalizeHostId,
  normalizeHostLabel,
} from "./topic-host.js";
import { ensurePrivateDirectory, writeTextAtomic } from "../state/file-utils.js";
import { normalizeSshTarget } from "./host-command-runner.js";

export const HOST_REGISTRY_SCHEMA_VERSION = 2;

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => normalizeOptionalText(value))
        .filter(Boolean),
    ),
  ];
}

function buildDefaultRegistry(currentHostId) {
  return {
    schema_version: HOST_REGISTRY_SCHEMA_VERSION,
    hosts: [
      {
        host_id: currentHostId,
        label: currentHostId,
        ssh_target: currentHostId,
        enabled: true,
        role: null,
        workspace_root: null,
        repo_root: null,
        default_binding_path: null,
        worker_runtime_root: null,
        codex_bin_path: null,
        codex_config_path: null,
        codex_auth_path: null,
        profile_id: null,
        suffix_id: null,
        mcp_mode: null,
        required_capabilities: [],
        supports_root_mesh: false,
        last_health: "unknown",
        last_health_checked_at: null,
        failure_reason: null,
        last_ready_at: null,
      },
    ],
  };
}

async function writeRegistry(registryPath, document) {
  await writeTextAtomic(
    registryPath,
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

async function quarantineMalformedRegistry(registryPath, text) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const quarantinePath = `${registryPath}.corrupt-${stamp}`;
  await writeTextAtomic(quarantinePath, text);
  await fs.rm(registryPath, { force: true });
}

function normalizeHostEntry(
  entry,
  currentHostId,
  { fallbackToCurrentHost = false } = {},
) {
  const hostId = normalizeHostId(
    entry?.host_id ?? entry?.hostId ?? entry?.id,
    fallbackToCurrentHost ? currentHostId : null,
  );
  const label = normalizeHostLabel(entry?.label, hostId);
  const sshTarget = normalizeOptionalText(
    entry?.ssh_target ?? entry?.sshTarget,
  ) || hostId;

  return {
    host_id: hostId,
    label,
    ssh_target: normalizeSshTarget(sshTarget),
    enabled: entry?.enabled !== false,
    role: normalizeOptionalText(entry?.role),
    workspace_root: normalizeOptionalText(
      entry?.workspace_root ?? entry?.workspaceRoot,
    ),
    repo_root: normalizeOptionalText(
      entry?.repo_root ?? entry?.repoRoot,
    ),
    default_binding_path: normalizeOptionalText(
      entry?.default_binding_path ?? entry?.defaultBindingPath,
    ),
    worker_runtime_root: normalizeOptionalText(
      entry?.worker_runtime_root ?? entry?.workerRuntimeRoot,
    ),
    codex_bin_path: normalizeOptionalText(
      entry?.codex_bin_path ?? entry?.codexBinPath,
    ),
    codex_config_path: normalizeOptionalText(
      entry?.codex_config_path ?? entry?.codexConfigPath,
    ),
    codex_auth_path: normalizeOptionalText(
      entry?.codex_auth_path ?? entry?.codexAuthPath,
    ),
    profile_id: normalizeOptionalText(
      entry?.profile_id ?? entry?.profileId,
    ),
    suffix_id: normalizeOptionalText(
      entry?.suffix_id ?? entry?.suffixId,
    ),
    mcp_mode: normalizeOptionalText(
      entry?.mcp_mode ?? entry?.mcpMode,
    ),
    required_capabilities: normalizeStringArray(
      entry?.required_capabilities ?? entry?.requiredCapabilities,
    ),
    supports_root_mesh:
      entry?.supports_root_mesh === true
      || entry?.supportsRootMesh === true,
    last_health:
      normalizeOptionalText(entry?.last_health ?? entry?.lastHealth)
      || "unknown",
    last_health_checked_at: normalizeOptionalText(
      entry?.last_health_checked_at ?? entry?.lastHealthCheckedAt,
    ),
    failure_reason: normalizeOptionalText(
      entry?.failure_reason ?? entry?.failureReason,
    ),
    last_ready_at: normalizeOptionalText(
      entry?.last_ready_at ?? entry?.lastReadyAt,
    ),
  };
}

function normalizeRegistryDocument(document, currentHostId) {
  const rawHosts = Array.isArray(document)
    ? document
    : Array.isArray(document?.hosts)
      ? document.hosts
      : [];
  const hostMap = new Map();
  for (const rawHost of rawHosts) {
    let host;
    try {
      host = normalizeHostEntry(rawHost, currentHostId);
    } catch {
      continue;
    }
    if (host.host_id) {
      hostMap.set(host.host_id, host);
    }
  }
  const hosts = [...hostMap.values()];

  if (!hosts.some((entry) => entry.host_id === currentHostId)) {
    hosts.unshift(
      normalizeHostEntry(
        { host_id: currentHostId },
        currentHostId,
        { fallbackToCurrentHost: true },
      ),
    );
  }

  return {
    schema_version:
      Number.isInteger(document?.schema_version) && document.schema_version > 0
        ? document.schema_version
        : HOST_REGISTRY_SCHEMA_VERSION,
    hosts,
  };
}

function buildHostUnavailableResult({
  host,
  hostId,
  hostLabel,
  failureReason,
  isLocal = false,
}) {
  return {
    ok: false,
    reason: "host-unavailable",
    hostId,
    hostLabel,
    failureReason,
    lastReadyAt: host?.last_ready_at ?? null,
    isLocal,
    host: host || null,
  };
}

function buildHostReadyResult({
  host,
  hostId,
  hostLabel,
  isLocal = false,
}) {
  return {
    ok: true,
    reason: null,
    hostId,
    hostLabel,
    lastReadyAt: host?.last_ready_at ?? new Date().toISOString(),
    failureReason: null,
    isLocal,
    host: host || null,
  };
}

function resolveHostAvailability(hostId, host, currentHostId) {
  const normalizedHostId = normalizeHostId(hostId, currentHostId);
  const hostLabel = formatExecutionHostName(host?.label, normalizedHostId);
  const isLocal = normalizedHostId === currentHostId;

  if (!host) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: "host-unregistered",
      isLocal,
    });
  }

  if (host.enabled === false) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason || "host-disabled",
      isLocal,
    });
  }

  if (host.failure_reason) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason,
      isLocal,
    });
  }

  if (!isLocal && (host.last_health !== "ready" || !host.last_ready_at)) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason || "host-not-ready",
      isLocal,
    });
  }

  return buildHostReadyResult({
    host,
    hostId: normalizedHostId,
    hostLabel,
    isLocal,
  });
}

export class HostRegistryService {
  constructor({ registryPath, currentHostId }) {
    this.registryPath = registryPath;
    this.currentHostId = normalizeHostId(currentHostId, "local");
  }

  async ensureRegistryExists() {
    await ensurePrivateDirectory(path.dirname(this.registryPath));

    try {
      await fs.access(this.registryPath);
    } catch {
      const defaultRegistry = buildDefaultRegistry(this.currentHostId);
      await writeRegistry(this.registryPath, defaultRegistry);
    }
  }

  async saveRegistry(document) {
    const normalized = normalizeRegistryDocument(
      {
        ...document,
        schema_version: HOST_REGISTRY_SCHEMA_VERSION,
      },
      this.currentHostId,
    );
    await writeRegistry(this.registryPath, normalized);
    return normalized;
  }

  async loadRegistry() {
    await this.ensureRegistryExists();
    const text = await fs.readFile(this.registryPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      await quarantineMalformedRegistry(this.registryPath, text);
      const fallbackRegistry = buildDefaultRegistry(this.currentHostId);
      await writeRegistry(this.registryPath, fallbackRegistry);
      return fallbackRegistry;
    }

    return normalizeRegistryDocument(parsed, this.currentHostId);
  }

  async listHosts() {
    const registry = await this.loadRegistry();
    return registry.hosts;
  }

  async replaceHosts(hosts) {
    const registry = await this.loadRegistry();
    const nextRegistry = {
      ...registry,
      hosts,
    };
    const saved = await this.saveRegistry(nextRegistry);
    return saved.hosts;
  }

  async upsertHost(entry) {
    const incomingHostId = normalizeHostId(
      entry?.host_id ?? entry?.hostId ?? entry?.id,
      null,
    );
    if (!incomingHostId) {
      throw new Error("Cannot upsert a host entry without host_id");
    }

    const registry = await this.loadRegistry();
    const hosts = [...registry.hosts];
    const index = hosts.findIndex((host) => host.host_id === incomingHostId);
    const merged =
      index >= 0
        ? {
            ...hosts[index],
            ...entry,
            host_id: incomingHostId,
          }
        : {
            ...entry,
            host_id: incomingHostId,
          };

    if (index >= 0) {
      hosts[index] = merged;
    } else {
      hosts.push(merged);
    }

    const savedHosts = await this.replaceHosts(hosts);
    return savedHosts.find((host) => host.host_id === incomingHostId) || null;
  }

  async patchHost(hostId, patch) {
    const normalizedHostId = normalizeHostId(hostId, null);
    if (!normalizedHostId) {
      throw new Error("Cannot patch a host without host_id");
    }

    const existing = await this.getHost(normalizedHostId);
    return this.upsertHost({
      ...(existing || {}),
      ...patch,
      host_id: normalizedHostId,
    });
  }

  async getHost(hostId) {
    const normalizedHostId = normalizeHostId(hostId, this.currentHostId);
    const hosts = await this.listHosts();
    return hosts.find((entry) => entry.host_id === normalizedHostId) || null;
  }

  async listTopicCreationHosts() {
    const hosts = await this.listHosts();
    return hosts.map((host) =>
      resolveHostAvailability(host.host_id, host, this.currentHostId)
    );
  }

  async resolveTopicCreationHost(requestedHostId = null) {
    const hostId = normalizeHostId(requestedHostId, this.currentHostId);
    const host = await this.getHost(hostId);
    return resolveHostAvailability(hostId, host, this.currentHostId);
  }

  async resolveSessionExecution(session) {
    const hostId = normalizeHostId(session?.execution_host_id, this.currentHostId);
    const host = await this.getHost(hostId);
    return resolveHostAvailability(hostId, host, this.currentHostId);
  }
}
