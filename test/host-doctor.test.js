import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inspectHostReadiness,
  resolveCodexSpaceFreshnessMaxAgeSecs,
  runHostDoctor,
} from "../src/hosts/host-doctor.js";
import { HostRegistryService } from "../src/hosts/host-registry-service.js";

function createExecFileStub({ failScripts = [] } = {}) {
  return (command, args, options, callback) => {
    const script = Array.isArray(args) ? args.at(-1) : "";
    const matchedFailure = failScripts.find((entry) => script.includes(entry));
    if (matchedFailure) {
      const error = new Error(`failed: ${matchedFailure}`);
      error.code = 1;
      callback(error, "", matchedFailure);
      return;
    }

    callback(null, "", "");
  };
}

test("inspectHostReadiness fails early for remote hosts without ssh_target", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/codex-space",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    host: {
      host_id: "ser",
      label: "ser",
      enabled: true,
      ssh_target: null,
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "missing-ssh-target");
});

test("runHostDoctor persists ready snapshots and updates registry health", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-host-doctor-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry.json");
  const registryService = new HostRegistryService({
    registryPath,
    currentHostId: "controller",
  });
  await registryService.upsertHost({
    host_id: "controller",
    label: "controller",
    enabled: true,
    workspace_root: "~/atlas",
    repo_root: "~/workspace/codex-telegram-gateway",
    worker_runtime_root: "~/state/codex-telegram-gateway",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    required_capabilities: ["codex", "docker"],
  });

  const results = await runHostDoctor({
    codexSpaceRoot: path.join(stateRoot, "codex-space"),
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl: createExecFileStub(),
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
    targetHostId: "controller",
  });
  const stored = await registryService.getHost("controller");

  assert.equal(results.length, 1);
  assert.equal(results[0].snapshot.ready, true);
  assert.equal(stored.last_health, "ready");
  assert.equal(
    await fs
      .access(path.join(stateRoot, "hosts", "doctor", "controller.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
});

test("inspectHostReadiness reports docker as not ready when a local-MCP host lacks docker", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/codex-space",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl: createExecFileStub({ failScripts: ["docker info"] }),
    host: {
      host_id: "rtx",
      label: "rtx",
      enabled: true,
      ssh_target: "rtx",
      workspace_root: "~/atlas",
      repo_root: "~/workspace/codex-telegram-gateway",
      worker_runtime_root: "~/state/codex-telegram-gateway",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex", "docker"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "docker");
  assert.equal(snapshot.checks.some((check) => check.id === "docker" && check.ok === false), true);
});

test("inspectHostReadiness fails when synced codex-space is stale", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceMaxAgeSecs: resolveCodexSpaceFreshnessMaxAgeSecs(15),
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl: createExecFileStub({ failScripts: ["shared/rendered/manifest.json"] }),
    host: {
      host_id: "ser",
      label: "ser",
      enabled: true,
      ssh_target: "ser",
      workspace_root: "~/atlas",
      repo_root: "~/workspace/codex-telegram-gateway",
      worker_runtime_root: "~/state/codex-telegram-gateway",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "shared-codex-space-fresh");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "shared-codex-space-fresh" && check.ok === false,
    ),
    true,
  );
});

test("inspectHostReadiness treats missing passwordless sudo as advisory for normal execution", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/codex-space",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl: createExecFileStub({ failScripts: ["sudo -n true"] }),
    host: {
      host_id: "ser",
      label: "ser",
      enabled: true,
      ssh_target: "ser",
      workspace_root: "~/atlas",
      repo_root: "~/workspace/codex-telegram-gateway",
      worker_runtime_root: "~/state/codex-telegram-gateway",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.failure_reason, null);
  assert.equal(snapshot.checks.some((check) => check.id === "sudo" && check.ok === false), true);
});
