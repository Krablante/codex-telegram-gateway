import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import { runHostSync } from "../src/hosts/host-sync.js";
import { mkdtempForTest } from "../test-support/tmp.js";

test("runHostSync can run from any configured current host", async (t) => {
  const stateRoot = await mkdtempForTest(t, "codex-telegram-gateway-host-sync-");
  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry.json"),
    currentHostId: "worker-a",
  });

  const results = await runHostSync({
    codexSpaceRoot: path.join(stateRoot, "codex-space"),
    connectTimeoutSecs: 5,
    currentHostId: "worker-a",
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
  });

  assert.deepEqual(results, []);
});

test("runHostSync renders and syncs host outputs over ssh and rsync", async (t) => {
  const stateRoot = await mkdtempForTest(t, "codex-telegram-gateway-host-sync-");
  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry.json"),
    currentHostId: "controller",
  });
  await registryService.upsertHost({
    host_id: "worker-a",
    label: "worker-a",
    ssh_target: "worker-a",
    enabled: true,
    workspace_root: "~/workspace",
    repo_root: "~/workspace/codex-telegram-gateway",
    worker_runtime_root: "~/.local/state/codex-telegram-gateway",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({
      command,
      args,
    });
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("models_cache.json")
    ) {
      callback(
        null,
        `${JSON.stringify({
          models: [
            {
              slug: "gpt-5.5",
              display_name: "GPT-5.5",
              visibility: "list",
              priority: 0,
            },
          ],
        }, null, 2)}\n`,
        "",
      );
      return;
    }

    callback(null, "", "");
  };

  const results = await runHostSync({
    codexSpaceRoot: path.join(stateRoot, "codex-space"),
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    execFileImpl,
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
    targetHostId: "worker-a",
  });

  assert.deepEqual(results, [
    {
      host_id: "worker-a",
      status: "synced",
      reason: null,
    },
  ]);
  assert.equal(
    calls.some((call) => call.command === "ssh"),
    true,
  );
  assert.equal(
    calls.some((call) => call.command === "rsync"),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("-s")
      && call.args.includes("-e")
      && call.args.includes("'ssh' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=5'")),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(
          stateRoot,
          "codex-space",
          "hosts",
          "worker-a",
          "rendered",
          "models_cache.json",
        ),
        "utf8",
      ),
    ).models.map((entry) => entry.slug),
    ["gpt-5.5"],
  );
});
