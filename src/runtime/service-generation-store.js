import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { probeForwardingEndpoint } from "./update-forwarding-ipc.js";
import {
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const GENERATION_MODES = new Set(["standby", "leader", "retiring"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
}

function normalizeMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return GENERATION_MODES.has(normalized) ? normalized : "standby";
}

function buildGenerationHeartbeatPayload(payload) {
  return {
    schema_version: 1,
    generation_id: normalizeString(payload?.generation_id),
    service_kind: normalizeString(payload?.service_kind),
    instance_token: normalizeString(payload?.instance_token),
    pid: normalizePositiveInteger(payload?.pid),
    mode: normalizeMode(payload?.mode),
    ipc_endpoint: normalizeString(payload?.ipc_endpoint),
    updated_at: normalizeTimestamp(payload?.updated_at),
    heartbeat_expires_at: normalizeTimestamp(payload?.heartbeat_expires_at),
  };
}

function buildLeaderLeasePayload(payload) {
  return {
    schema_version: 1,
    generation_id: normalizeString(payload?.generation_id),
    service_kind: normalizeString(payload?.service_kind),
    instance_token: normalizeString(payload?.instance_token),
    pid: normalizePositiveInteger(payload?.pid),
    updated_at: normalizeTimestamp(payload?.updated_at),
    lease_expires_at: normalizeTimestamp(payload?.lease_expires_at),
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      await quarantineCorruptFile(filePath);
      return null;
    }

    throw error;
  }
}

function isFutureTimestamp(value, now = Date.now()) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) && timestamp > now;
}

export function isProcessAlive(pid) {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class ServiceGenerationStore {
  constructor({
    indexesRoot,
    tmpRoot,
    serviceKind,
    generationId,
    leaderTtlMs = 8000,
    generationTtlMs = 12000,
    now = () => Date.now(),
    pid = process.pid,
    instanceToken = crypto.randomUUID(),
    processAlive = isProcessAlive,
    probeGenerationIdentity = probeForwardingEndpoint,
  }) {
    this.indexesRoot = indexesRoot;
    this.tmpRoot = tmpRoot;
    this.serviceKind = serviceKind;
    this.generationId = generationId;
    this.leaderTtlMs = leaderTtlMs;
    this.generationTtlMs = generationTtlMs;
    this.now = now;
    this.pid = pid;
    this.instanceToken = normalizeString(instanceToken) || crypto.randomUUID();
    this.processAlive = processAlive;
    this.probeGenerationIdentity = probeGenerationIdentity;
  }

  getGenerationRegistryDir() {
    return path.join(this.tmpRoot, "generations", this.serviceKind);
  }

  getGenerationPath(generationId = this.generationId) {
    return path.join(this.getGenerationRegistryDir(), `${generationId}.json`);
  }

  getLeaderPath() {
    return path.join(this.indexesRoot, `${this.serviceKind}-leader.json`);
  }

  getLeaderLockPath() {
    return path.join(this.indexesRoot, `.${this.serviceKind}-leader.lock`);
  }

  async withLeaderLock(fn) {
    const lockPath = this.getLeaderLockPath();
    await ensurePrivateDirectory(this.indexesRoot);
    const startedAt = this.now();

    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }

        if (this.now() - startedAt >= LOCK_TIMEOUT_MS) {
          try {
            const stats = await fs.stat(lockPath);
            if (this.now() - stats.mtimeMs >= LOCK_STALE_MS) {
              await fs.rm(lockPath, { recursive: true, force: true });
              continue;
            }
          } catch (statError) {
            if (statError?.code !== "ENOENT") {
              throw statError;
            }
          }

          throw new Error(
            `Timed out acquiring leader lock for ${this.serviceKind}`,
            { cause: error },
          );
        }

        await sleep(LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  isGenerationRecordLive(record, now = this.now()) {
    return (
      record?.generation_id
      && isFutureTimestamp(record.heartbeat_expires_at, now)
      && this.processAlive(record.pid)
    );
  }

  isLeaderLeaseLive(lease, now = this.now()) {
    return (
      lease?.generation_id
      && isFutureTimestamp(lease.lease_expires_at, now)
      && this.processAlive(lease.pid)
    );
  }

  async isGenerationRecordVerifiablyLive(
    record,
    now = this.now(),
    { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {},
  ) {
    if (!this.isGenerationRecordLive(record, now)) {
      return false;
    }
    if (!record?.instance_token) {
      return true;
    }
    if (!record?.ipc_endpoint) {
      return false;
    }

    try {
      return await this.probeGenerationIdentity({
        endpoint: record.ipc_endpoint,
        generationId: record.generation_id,
        instanceToken: record.instance_token,
        timeoutMs,
      });
    } catch {
      return false;
    }
  }

  async isLeaderLeaseVerifiablyLive(
    lease,
    now = this.now(),
    { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {},
  ) {
    if (!this.isLeaderLeaseLive(lease, now)) {
      return false;
    }
    if (!lease?.instance_token) {
      return true;
    }

    const generation = await this.loadGeneration(lease.generation_id);
    if (
      lease?.instance_token
      && generation?.instance_token
      && lease.instance_token !== generation.instance_token
    ) {
      return false;
    }
    return this.isGenerationRecordVerifiablyLive(generation, now, {
      timeoutMs,
    });
  }

  async loadGeneration(generationId) {
    const payload = await readJsonIfExists(this.getGenerationPath(generationId));
    return payload ? buildGenerationHeartbeatPayload(payload) : null;
  }

  async heartbeat({ mode = "standby", ipcEndpoint = null } = {}) {
    const now = this.now();
    const payload = buildGenerationHeartbeatPayload({
      generation_id: this.generationId,
      service_kind: this.serviceKind,
      instance_token: this.instanceToken,
      pid: this.pid,
      mode,
      ipc_endpoint: ipcEndpoint,
      updated_at: new Date(now).toISOString(),
      heartbeat_expires_at: new Date(now + this.generationTtlMs).toISOString(),
    });

    await writeTextAtomic(
      this.getGenerationPath(),
      `${JSON.stringify(payload, null, 2)}\n`,
    );

    return payload;
  }

  async clearHeartbeat() {
    await fs.rm(this.getGenerationPath(), { force: true }).catch(() => {});
  }

  async loadLeaderLease() {
    const payload = await readJsonIfExists(this.getLeaderPath());
    return payload ? buildLeaderLeasePayload(payload) : null;
  }

  async saveLeaderLeaseUnlocked(lease) {
    if (!lease?.generation_id) {
      await fs.rm(this.getLeaderPath(), { force: true }).catch(() => {});
      return null;
    }

    const normalized = buildLeaderLeasePayload(lease);
    await writeTextAtomic(
      this.getLeaderPath(),
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
    return normalized;
  }

  async acquireLeadership() {
    return this.takeoverLeadership();
  }

  async takeoverLeadership({ allowedPreviousGenerationId = null } = {}) {
    return this.withLeaderLock(async () => {
      const now = this.now();
      const current = await this.loadLeaderLease();
      if (
        await this.isLeaderLeaseVerifiablyLive(current, now)
        && current.generation_id !== this.generationId
        && (
          !allowedPreviousGenerationId
          || current.generation_id !== allowedPreviousGenerationId
        )
      ) {
        return false;
      }

      await this.saveLeaderLeaseUnlocked({
        generation_id: this.generationId,
        service_kind: this.serviceKind,
        instance_token: this.instanceToken,
        pid: this.pid,
        updated_at: new Date(now).toISOString(),
        lease_expires_at: new Date(now + this.leaderTtlMs).toISOString(),
      });
      return true;
    });
  }

  async listGenerations() {
    let entries;
    try {
      entries = await fs.readdir(this.getGenerationRegistryDir(), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const generations = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const generationId = entry.name.slice(0, -".json".length);
      const payload = await this.loadGeneration(generationId);
      if (payload) {
        generations.push(payload);
      }
    }

    return generations;
  }

  async pruneStaleGenerations() {
    const generations = await this.listGenerations();
    const liveness = await Promise.all(
      generations.map(async (record) => ({
        record,
        live: await this.isGenerationRecordVerifiablyLive(record),
      })),
    );
    const stale = liveness
      .filter((entry) => !entry.live)
      .map((entry) => entry.record);

    await Promise.all(
      stale.map((record) =>
        fs.rm(this.getGenerationPath(record.generation_id), { force: true }).catch(() => {}),
      ),
    );

    return stale;
  }

  async renewLeadership() {
    return this.withLeaderLock(async () => {
      const now = this.now();
      const current = await this.loadLeaderLease();
      if (current?.generation_id !== this.generationId) {
        return false;
      }

      await this.saveLeaderLeaseUnlocked({
        ...current,
        pid: this.pid,
        updated_at: new Date(now).toISOString(),
        lease_expires_at: new Date(now + this.leaderTtlMs).toISOString(),
      });
      return true;
    });
  }

  async releaseLeadership() {
    return this.withLeaderLock(async () => {
      const current = await this.loadLeaderLease();
      if (current?.generation_id !== this.generationId) {
        return false;
      }

      await this.saveLeaderLeaseUnlocked(null);
      return true;
    });
  }
}
