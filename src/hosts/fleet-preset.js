function buildExampleHost({
  hostId,
  role,
  profileId,
}) {
  return {
    host_id: hostId,
    label: hostId,
    ssh_target: hostId,
    enabled: true,
    role,
    workspace_root: "~/workspace",
    repo_root: "~/workspace/codex-telegram-gateway",
    default_binding_path: "~/workspace",
    worker_runtime_root: "~/.local/state/codex-telegram-gateway",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    profile_id: profileId,
    suffix_id: hostId,
    mcp_mode: "local",
    required_capabilities: ["codex", "docker"],
    supports_root_mesh: true,
  };
}

function isDefaultRegistryStub(host) {
  if (!host || typeof host !== "object") {
    return false;
  }

  const hostId = host.host_id;
  const hasNoStaticShape =
    host.role == null
    && host.workspace_root == null
    && host.repo_root == null
    && host.default_binding_path == null
    && host.worker_runtime_root == null
    && host.codex_bin_path == null
    && host.codex_config_path == null
    && host.codex_auth_path == null
    && host.profile_id == null
    && host.suffix_id == null
    && host.mcp_mode == null
    && (!Array.isArray(host.required_capabilities)
      || host.required_capabilities.length === 0)
    && host.supports_root_mesh !== true;

  return (
    !!hostId
    && host.label === hostId
    && (host.ssh_target == null || host.ssh_target === hostId)
    && host.enabled !== false
    && hasNoStaticShape
  );
}

function mergePresetHost(presetHost, existingHost) {
  if (!existingHost) {
    return presetHost;
  }

  if (isDefaultRegistryStub(existingHost)) {
    return {
      ...presetHost,
      last_health: existingHost.last_health ?? null,
      last_health_checked_at: existingHost.last_health_checked_at ?? null,
      failure_reason: existingHost.failure_reason ?? null,
      last_ready_at: existingHost.last_ready_at ?? null,
    };
  }

  return {
    ...presetHost,
    ...Object.fromEntries(
      Object.entries(existingHost).filter(([, value]) =>
        value !== null && value !== undefined && value !== "",
      ),
    ),
    host_id: presetHost.host_id,
    supports_root_mesh: presetHost.supports_root_mesh,
    required_capabilities:
      Array.isArray(existingHost.required_capabilities)
      && existingHost.required_capabilities.length > 0
        ? existingHost.required_capabilities
        : presetHost.required_capabilities,
  };
}

export const EXAMPLE_HOME_FLEET_PRESET = "example-home-fleet";

export function buildFleetPreset(presetName) {
  if (presetName !== EXAMPLE_HOME_FLEET_PRESET) {
    throw new Error(`Unsupported host preset: ${presetName}`);
  }

  return [
    buildExampleHost({
      hostId: "controller",
      role: "controller",
      profileId: "controller",
    }),
    buildExampleHost({
      hostId: "worker-a",
      role: "worker",
      profileId: "worker",
    }),
    buildExampleHost({
      hostId: "worker-b",
      role: "worker",
      profileId: "worker",
    }),
  ];
}

export function mergeFleetPresetHosts(presetHosts, existingHosts) {
  const mergedHosts = presetHosts.map((presetHost) => {
    const existingHost = existingHosts.find(
      (host) => host.host_id === presetHost.host_id,
    );
    return mergePresetHost(presetHost, existingHost);
  });

  return [
    ...mergedHosts,
    ...existingHosts.filter(
      (host) => !mergedHosts.some((entry) => entry.host_id === host.host_id),
    ),
  ];
}
