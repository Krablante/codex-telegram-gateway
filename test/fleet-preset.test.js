import test from "node:test";
import assert from "node:assert/strict";

import {
  EXAMPLE_HOME_FLEET_PRESET,
  buildFleetPreset,
  mergeFleetPresetHosts,
} from "../src/hosts/fleet-preset.js";

test("mergeFleetPresetHosts replaces the legacy default stub with the canonical preset", () => {
  const presetHosts = buildFleetPreset(EXAMPLE_HOME_FLEET_PRESET);
  const mergedHosts = mergeFleetPresetHosts(presetHosts, [
    {
      host_id: "controller",
      label: "controller",
      ssh_target: "controller",
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
      last_health_checked_at: "2026-04-21T18:00:00.000Z",
      failure_reason: null,
      last_ready_at: null,
    },
  ]);

  const controller = mergedHosts.find((host) => host.host_id === "controller");

  assert.equal(controller.role, "controller");
  assert.equal(controller.workspace_root, "~/workspace");
  assert.equal(controller.supports_root_mesh, true);
  assert.deepEqual(controller.required_capabilities, ["codex", "docker"]);
  assert.equal(controller.last_health_checked_at, "2026-04-21T18:00:00.000Z");
});

test("mergeFleetPresetHosts keeps explicit existing host overrides", () => {
  const presetHosts = buildFleetPreset(EXAMPLE_HOME_FLEET_PRESET);
  const mergedHosts = mergeFleetPresetHosts(presetHosts, [
    {
      host_id: "worker-a",
      label: "Serious Node",
      ssh_target: "worker-a-alt",
      enabled: false,
      role: "worker-profile",
      workspace_root: "/srv/workspace",
      repo_root: "/srv/workspace/repo",
      default_binding_path: "/srv/workspace/work",
      worker_runtime_root: "/srv/workspace/state",
      codex_bin_path: "/usr/local/bin/codex",
      codex_config_path: "/srv/codex/config.toml",
      codex_auth_path: "/srv/codex/auth.json",
      profile_id: "custom-profile",
      suffix_id: "worker-a-custom",
      mcp_mode: "remote",
      required_capabilities: ["codex", "docker"],
      supports_root_mesh: false,
    },
  ]);

  const workerA = mergedHosts.find((host) => host.host_id === "worker-a");

  assert.equal(workerA.label, "Serious Node");
  assert.equal(workerA.enabled, false);
  assert.equal(workerA.workspace_root, "/srv/workspace");
  assert.deepEqual(workerA.required_capabilities, ["codex", "docker"]);
  assert.equal(workerA.supports_root_mesh, true);
});
