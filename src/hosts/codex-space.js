import path from "node:path";

import { ensurePrivateDirectory, writeTextAtomic } from "../state/file-utils.js";

export function getCodexSpaceLayout(codexSpaceRoot, hostId = null) {
  const root = codexSpaceRoot;
  const sharedRoot = path.join(root, "shared");
  const sharedSource = path.join(sharedRoot, "source");
  const sharedRendered = path.join(sharedRoot, "rendered");
  const hostsRoot = path.join(root, "hosts");
  const hostRoot = hostId ? path.join(hostsRoot, hostId) : null;

  return {
    root,
    sharedRoot,
    sharedSource,
    sharedRendered,
    hostsRoot,
    hostRoot,
    hostSource: hostRoot ? path.join(hostRoot, "source") : null,
    hostRendered: hostRoot ? path.join(hostRoot, "rendered") : null,
  };
}

export async function ensureCodexSpaceLayout(codexSpaceRoot, hostIds = []) {
  const layout = getCodexSpaceLayout(codexSpaceRoot);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.sharedRoot);
  await ensurePrivateDirectory(layout.sharedSource);
  await ensurePrivateDirectory(layout.sharedRendered);
  await ensurePrivateDirectory(layout.hostsRoot);

  for (const hostId of hostIds) {
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, hostId);
    await ensurePrivateDirectory(hostLayout.hostRoot);
    await ensurePrivateDirectory(hostLayout.hostSource);
    await ensurePrivateDirectory(hostLayout.hostRendered);
  }

  return layout;
}

function buildFleetReminder({ currentHostId, hosts }) {
  const enabledHosts = hosts
    .filter((host) => host.enabled !== false)
    .map((host) => host.host_id);

  return [
    `Current controller host: ${currentHostId}`,
    `Known hosts: ${hosts.map((host) => host.host_id).join(", ") || "none"}`,
    `Enabled hosts: ${enabledHosts.join(", ") || "none"}`,
    "Execution host bindings are immutable per topic.",
    "If a bound host is unavailable, fail closed and say which host is unavailable.",
  ].join("\n");
}

function buildOperatorReminder() {
  return [
    "Operator preferences:",
    "- Avoid overengineering.",
    "- Prefer practical, low-overhead, modular solutions.",
    "- Prioritize efficiency, modularity, security, autonomy, and usability.",
    "- Keep communication concise, direct, and human-readable.",
    "- Preserve host boundaries; shared memory supplements host-local runtime only.",
    "- If a bound host is unavailable, fail closed and say which host is unavailable.",
  ].join("\n");
}

function buildHostPromptSnippet(host) {
  return [
    `Execution host: ${host.host_id}`,
    `Label: ${host.label || host.host_id}`,
    `Role: ${host.role || "unspecified"}`,
    `Workspace root: ${host.workspace_root || "unset"}`,
    `Repo root: ${host.repo_root || "unset"}`,
    `Runtime root: ${host.worker_runtime_root || "unset"}`,
    `Profile: ${host.profile_id || "unset"}`,
    `Suffix preset: ${host.suffix_id || host.host_id}`,
    "This host keeps its own local Codex auth, config, and runtime state.",
  ].join("\n");
}

function buildHostHealthSnapshot(host) {
  return {
    host_id: host.host_id,
    label: host.label,
    status: host.last_health || "unknown",
    checked_at: host.last_health_checked_at || null,
    last_ready_at: host.last_ready_at || null,
    failure_reason: host.failure_reason || null,
  };
}

export async function renderCodexSpace({
  codexSpaceRoot,
  currentHostId,
  hosts,
}) {
  const hostIds = hosts.map((host) => host.host_id);
  const layout = await ensureCodexSpaceLayout(codexSpaceRoot, hostIds);
  const fleetMapPath = path.join(layout.sharedRendered, "fleet-map.json");
  const fleetReminderPath = path.join(layout.sharedRendered, "fleet-reminder.txt");
  const operatorReminderPath = path.join(layout.sharedRendered, "operator-reminder.txt");
  const manifestPath = path.join(layout.sharedRendered, "manifest.json");

  await writeTextAtomic(
    fleetMapPath,
    `${JSON.stringify({
      current_host_id: currentHostId,
      generated_at: new Date().toISOString(),
      hosts,
    }, null, 2)}\n`,
  );
  await writeTextAtomic(
    fleetReminderPath,
    `${buildFleetReminder({ currentHostId, hosts })}\n`,
  );
  await writeTextAtomic(
    operatorReminderPath,
    `${buildOperatorReminder()}\n`,
  );
  await writeTextAtomic(
    manifestPath,
    `${JSON.stringify({
      generated_at: new Date().toISOString(),
      current_host_id: currentHostId,
      host_ids: hostIds,
    }, null, 2)}\n`,
  );

  const files = [
    fleetMapPath,
    fleetReminderPath,
    operatorReminderPath,
    manifestPath,
  ];

  for (const host of hosts) {
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, host.host_id);
    const profilePath = path.join(hostLayout.hostRendered, "profile.json");
    const promptSnippetPath = path.join(hostLayout.hostRendered, "prompt-snippet.txt");
    const healthPath = path.join(hostLayout.hostRendered, "health.json");

    await writeTextAtomic(
      profilePath,
      `${JSON.stringify(host, null, 2)}\n`,
    );
    await writeTextAtomic(
      promptSnippetPath,
      `${buildHostPromptSnippet(host)}\n`,
    );
    await writeTextAtomic(
      healthPath,
      `${JSON.stringify(buildHostHealthSnapshot(host), null, 2)}\n`,
    );

    files.push(profilePath, promptSnippetPath, healthPath);
  }

  return {
    files,
    layout,
  };
}
