import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import { captureHostModelsCacheSnapshot } from "./codex-model-catalog.js";
import { renderCodexSpace, getCodexSpaceLayout } from "./codex-space.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "./host-command-runner.js";

async function syncRenderedDirectory({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  localDirectory,
  remoteDirectory,
}) {
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remoteDirectory)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$target"',
      'printf "%s\\n" "$target"',
    ].join("; "),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
  const resolvedRemoteDirectory = stdout.trim().split("\n").at(-1) || remoteDirectory;
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      normalizeRsyncLocalPath(`${localDirectory}${path.sep}`),
      buildRsyncRemotePath(host.ssh_target, `${resolvedRemoteDirectory}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
}

export async function runHostSync({
  codexSpaceRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  registryService,
  targetHostId = null,
}) {
  const hosts = await registryService.listHosts();
  const { layout } = await renderCodexSpace({
    codexSpaceRoot,
    currentHostId,
    hosts,
  });
  const selectedHosts = targetHostId
    ? hosts.filter((host) => host.host_id === targetHostId)
    : hosts.filter((host) => host.host_id !== currentHostId);

  if (targetHostId && selectedHosts.length === 0) {
    throw new Error(`Unknown host for sync: ${targetHostId}`);
  }

  const results = [];
  const currentHost = hosts.find((host) => host.host_id === currentHostId);
  if (currentHost) {
    await captureHostModelsCacheSnapshot({
      codexSpaceRoot,
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host: currentHost,
    });
  }

  for (const host of selectedHosts) {
    if (host.enabled === false) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: host.failure_reason || "host-disabled",
      });
      continue;
    }
    if (!host.ssh_target) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: "missing-ssh-target",
      });
      continue;
    }
    if (!host.worker_runtime_root) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: "missing-worker-runtime-root",
      });
      continue;
    }

    const localSharedRendered = layout.sharedRendered;
    const localHostRendered = getCodexSpaceLayout(
      codexSpaceRoot,
      host.host_id,
    ).hostRendered;
    const remoteBase = path.posix.join(host.worker_runtime_root, "codex-space");
    const remoteSharedRendered = path.posix.join(remoteBase, "shared", "rendered");
    const remoteHostRendered = path.posix.join(
      remoteBase,
      "hosts",
      host.host_id,
      "rendered",
    );

    try {
      await captureHostModelsCacheSnapshot({
        codexSpaceRoot,
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
      });
      await syncRenderedDirectory({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        localDirectory: localSharedRendered,
        remoteDirectory: remoteSharedRendered,
      });
      await syncRenderedDirectory({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        localDirectory: localHostRendered,
        remoteDirectory: remoteHostRendered,
      });
      results.push({
        host_id: host.host_id,
        status: "synced",
        reason: null,
      });
    } catch (error) {
      results.push({
        host_id: host.host_id,
        status: "failed",
        reason: String(error?.stderr || error?.message || "sync failed").trim() || "sync failed",
      });
    }
  }

  await writeTextAtomic(
    path.join(hostsRoot, "sync-last-run.json"),
    `${JSON.stringify({
      ran_at: new Date().toISOString(),
      current_host_id: currentHostId,
      results,
    }, null, 2)}\n`,
  );

  return results;
}
