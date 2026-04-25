import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HOST_REGISTRY_SCHEMA_VERSION,
  HostRegistryService,
} from "../src/hosts/host-registry-service.js";

test("HostRegistryService creates a default registry for the current host", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const hosts = await service.listHosts();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host_id, "controller");
  assert.equal(hosts[0].enabled, true);

  const stored = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(stored.hosts[0].host_id, "controller");
});

test("HostRegistryService returns remote routing metadata for a ready remote host", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 1,
      hosts: [
        { host_id: "controller", label: "controller", enabled: true },
        {
          host_id: "worker-a",
          label: "worker-a",
          enabled: true,
          ssh_target: "worker-a",
          workspace_root: "~/workspace",
          repo_root: "~/workspace/codex-telegram-gateway",
          worker_runtime_root:
            "~/.local/state/codex-telegram-gateway",
          codex_bin_path: "codex",
          last_health: "ready",
          last_ready_at: "2026-04-21T18:00:00.000Z",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const resolved = await service.resolveSessionExecution({
    execution_host_id: "worker-a",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.hostId, "worker-a");
  assert.equal(resolved.hostLabel, "worker-a");
  assert.equal(resolved.isLocal, false);
  assert.equal(resolved.host.ssh_target, "worker-a");
});

test("HostRegistryService drops invalid host entries instead of duplicating current host", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 2,
      hosts: [
        { label: "missing id", enabled: true, ssh_target: "bad-alias" },
        { host_id: "bad", enabled: true, ssh_target: "-o ProxyCommand=bad" },
        { host_id: "controller", label: "controller", enabled: true },
        { id: "worker-a", label: "worker-a-a", enabled: true },
        { hostId: "worker-a", label: "worker-a-b", enabled: true },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const hosts = await service.listHosts();

  assert.deepEqual(hosts.map((host) => host.host_id), ["controller", "worker-a"]);
  assert.equal(hosts.find((host) => host.host_id === "worker-a").label, "worker-a-b");
});

test("HostRegistryService can resolve an explicit ready host for topic creation", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 2,
      hosts: [
        { host_id: "controller", label: "controller", enabled: true },
        {
          host_id: "worker-a",
          label: "worker-a",
          enabled: true,
          last_health: "ready",
          last_ready_at: "2026-04-21T18:20:00.000Z",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const resolved = await service.resolveTopicCreationHost("worker-a");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.hostId, "worker-a");
  assert.equal(resolved.isLocal, false);
});

test("HostRegistryService fails closed for not-ready remote hosts", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 1,
      hosts: [
        { host_id: "controller", label: "controller", enabled: true },
        {
          host_id: "worker-a",
          label: "worker-a",
          enabled: true,
          last_health: "not-ready",
          failure_reason: "repo-root",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const resolved = await service.resolveSessionExecution({
    execution_host_id: "worker-a",
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "host-unavailable");
  assert.equal(resolved.hostId, "worker-a");
  assert.equal(resolved.failureReason, "repo-root");
});

test("HostRegistryService refuses local topic creation when the current host is disabled", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 1,
      hosts: [
        {
          host_id: "controller",
          label: "controller",
          enabled: false,
          failure_reason: "maintenance-window",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const resolved = await service.resolveTopicCreationHost();
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "host-unavailable");
  assert.equal(resolved.hostId, "controller");
  assert.equal(resolved.failureReason, "maintenance-window");
});

test("HostRegistryService lists topic creation availability for all known hosts", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 2,
      hosts: [
        { host_id: "controller", label: "controller", enabled: true },
        {
          host_id: "worker-a",
          label: "worker-a",
          enabled: true,
          last_health: "ready",
          last_ready_at: "2026-04-21T18:30:00.000Z",
        },
        {
          host_id: "worker-b",
          label: "worker-b",
          enabled: true,
          last_health: "not-ready",
          failure_reason: "codex-auth",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const hosts = await service.listTopicCreationHosts();
  assert.equal(hosts.length, 3);
  assert.equal(hosts.find((host) => host.hostId === "controller").ok, true);
  assert.equal(hosts.find((host) => host.hostId === "worker-a").ok, true);
  assert.equal(hosts.find((host) => host.hostId === "worker-b").failureReason, "codex-auth");
});

test("HostRegistryService quarantines malformed registry json and rebuilds a safe default", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "{ definitely-not-json\n", "utf8");
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });

  const hosts = await service.listHosts();
  const entries = await fs.readdir(path.dirname(registryPath));

  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host_id, "controller");
  assert.equal(entries.includes("registry.json"), true);
  assert.equal(
    entries.some((entry) => entry.startsWith("registry.json.corrupt-")),
    true,
  );
});

test("HostRegistryService normalizes and persists the richer host schema", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      schema_version: 1,
      hosts: [
        {
          host_id: "worker-a",
          label: "worker-a",
          ssh_target: "worker-a",
          enabled: true,
          workspace_root: "~/workspace",
          repo_root: "~/workspace/codex-telegram-gateway",
          worker_runtime_root:
            "~/.local/state/codex-telegram-gateway",
          codex_bin_path: "codex",
          codex_config_path: "~/.codex/config.toml",
          codex_auth_path: "~/.codex/auth.json",
          profile_id: "worker-profile",
          suffix_id: "worker-a",
          required_capabilities: ["codex", "codex"],
          supports_root_mesh: true,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const service = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });
  const hosts = await service.listHosts();
  const workerA = hosts.find((host) => host.host_id === "worker-a");

  assert.equal(workerA.workspace_root, "~/workspace");
  assert.deepEqual(workerA.required_capabilities, ["codex"]);
  assert.equal(workerA.supports_root_mesh, true);

  const updated = await service.patchHost("worker-a", {
    last_health: "ready",
    last_health_checked_at: "2026-04-21T18:00:00.000Z",
    last_ready_at: "2026-04-21T18:00:00.000Z",
  });
  const stored = JSON.parse(await fs.readFile(registryPath, "utf8"));

  assert.equal(updated.last_health, "ready");
  assert.equal(stored.schema_version, HOST_REGISTRY_SCHEMA_VERSION);
  assert.equal(stored.hosts.find((host) => host.host_id === "worker-a").last_health, "ready");
});
