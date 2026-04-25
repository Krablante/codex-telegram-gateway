import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import { ensureCodexSpaceLayout, getCodexSpaceLayout } from "./codex-space.js";
import { runHostBash, shellQuote } from "./host-command-runner.js";

const REQUIRED_NODE_MAJOR = 20;

function buildCheck(id, label, ok, detail = null) {
  return {
    id,
    label,
    ok,
    detail,
  };
}

function buildExistsScript(kind, targetPath) {
  if (!targetPath) {
    return "exit 1";
  }

  return [
    `target=${shellQuote(targetPath)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
    `test -${kind} "$target"`,
  ].join("; ");
}

function buildSupportedNodeRuntimeScript() {
  return [
    'command -v node >/dev/null 2>&1',
    `node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(Number.isFinite(major) && major >= ${REQUIRED_NODE_MAJOR} ? 0 : 1)'`,
  ].join("; ");
}

function buildCodexExecHelpScript(executablePath) {
  if (!executablePath) {
    return "exit 1";
  }

  if (/[\\/]/u.test(executablePath) || executablePath.startsWith("~")) {
    return [
      `target=${shellQuote(executablePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'test -x "$target"',
      '"$target" exec --help >/dev/null 2>&1',
    ].join("; ");
  }

  return [
    `name=${shellQuote(executablePath)}`,
    'command -v -- "$name" >/dev/null',
    '"$name" exec --help >/dev/null 2>&1',
  ].join("; ");
}

function buildDockerRuntimeScript() {
  return [
    'command -v docker >/dev/null 2>&1',
    'docker info >/dev/null 2>&1',
  ].join("; ");
}

function hostRequiresDocker(host) {
  if (Array.isArray(host?.required_capabilities)) {
    return host.required_capabilities.includes("docker");
  }

  return host?.mcp_mode === "local";
}

async function runDoctorCheck({
  host,
  currentHostId,
  connectTimeoutSecs,
  execFileImpl,
  label,
  id,
  script,
}) {
  try {
    await runHostBash({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      script,
      timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
    });
    return buildCheck(id, label, true);
  } catch (error) {
    return buildCheck(
      id,
      label,
      false,
      String(error?.stderr || error?.message || "check failed").trim() || null,
    );
  }
}

export async function inspectHostReadiness({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  host,
}) {
  const checkedAt = new Date().toISOString();
  const checks = [];

  if (host.enabled === false) {
    return {
      checked_at: checkedAt,
      host_id: host.host_id,
      host_label: host.label || host.host_id,
      ready: false,
      status: "disabled",
      failure_reason: host.failure_reason || "host-disabled",
      checks: [
        buildCheck("enabled", "host is enabled", false, "host disabled in registry"),
      ],
    };
  }

  if (host.host_id !== currentHostId && !host.ssh_target) {
    return {
      checked_at: checkedAt,
      host_id: host.host_id,
      host_label: host.label || host.host_id,
      ready: false,
      status: "not-ready",
      failure_reason: "missing-ssh-target",
      checks: [
        buildCheck("ssh", "SSH alias is reachable", false, "ssh_target is missing"),
      ],
    };
  }

  const hostCodexSpaceRoot = `${host.worker_runtime_root || ""}/codex-space`;
  const hostHealthPath = path.posix.join(
    hostCodexSpaceRoot,
    "hosts",
    host.host_id,
    "rendered",
    "health.json",
  );
  const sharedReminderPath = path.posix.join(
    hostCodexSpaceRoot,
    "shared",
    "rendered",
    "fleet-reminder.txt",
  );

  if (host.host_id !== currentHostId) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "ssh",
        label: "SSH alias is reachable",
        script: "true",
      }),
    );
  }

  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "sudo",
      label: "sudo -n true works",
      script: "sudo -n true",
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "workspace-root",
      label: "workspace root exists",
      script: buildExistsScript("d", host.workspace_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "repo-root",
      label: "repo root exists",
      script: buildExistsScript("d", host.repo_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "runtime-root",
      label: "worker runtime root exists",
      script: buildExistsScript("d", host.worker_runtime_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "node-bin",
      label: "node runtime supports exec-json helpers",
      script: buildSupportedNodeRuntimeScript(),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-bin",
      label: "codex exec is available",
      script: buildCodexExecHelpScript(host.codex_bin_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-config",
      label: "codex config exists",
      script: buildExistsScript("f", host.codex_config_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-auth",
      label: "codex auth exists",
      script: buildExistsScript("f", host.codex_auth_path),
    }),
  );
  if (hostRequiresDocker(host)) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "docker",
        label: "docker runtime is ready for local MCP",
        script: buildDockerRuntimeScript(),
      }),
    );
  }
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "shared-codex-space",
      label: "shared codex-space was synced",
      script: buildExistsScript("f", sharedReminderPath),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "host-codex-space",
      label: "host codex-space was synced",
      script: buildExistsScript("f", hostHealthPath),
    }),
  );

  const failedCheck = checks.find(
    (check) => check.ok === false && check.id !== "sudo",
  );
  return {
    checked_at: checkedAt,
    host_id: host.host_id,
    host_label: host.label || host.host_id,
    ready: !failedCheck,
    status: failedCheck ? "not-ready" : "ready",
    failure_reason: failedCheck ? failedCheck.id : null,
    checks,
  };
}

export async function runHostDoctor({
  codexSpaceRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  registryService,
  targetHostId = null,
}) {
  const hosts = await registryService.listHosts();
  const selectedHosts = targetHostId
    ? hosts.filter((host) => host.host_id === targetHostId)
    : hosts;

  if (selectedHosts.length === 0) {
    throw new Error(`Unknown host for doctor: ${targetHostId}`);
  }

  await ensureCodexSpaceLayout(
    codexSpaceRoot,
    selectedHosts.map((host) => host.host_id),
  );

  const results = [];
  for (const host of selectedHosts) {
    const snapshot = await inspectHostReadiness({
      codexSpaceRoot,
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
    });
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, host.host_id);
    const snapshotPath = path.join(hostsRoot, "doctor", `${host.host_id}.json`);
    await writeTextAtomic(
      snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    await writeTextAtomic(
      path.join(hostLayout.hostRendered, "health.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );

    const updatedHost = await registryService.patchHost(host.host_id, {
      last_health: snapshot.status,
      last_health_checked_at: snapshot.checked_at,
      last_ready_at: snapshot.ready
        ? snapshot.checked_at
        : host.last_ready_at ?? null,
      failure_reason: snapshot.failure_reason,
    });
    results.push({
      host: updatedHost,
      snapshot,
      snapshot_path: snapshotPath,
    });
  }

  return results;
}
