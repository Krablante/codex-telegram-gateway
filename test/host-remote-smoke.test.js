import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import { runHostRemoteSmoke } from "../src/hosts/host-remote-smoke.js";

function createExecFileStub() {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args });
    if (command === "ssh") {
      const script = Array.isArray(args) ? args.at(-1) : "";
      if (script.includes("smoke-proof-worker-a")) {
        callback(
          null,
          [
            "smoke_directory=/home/worker-a/workspace/state/codex-telegram-gateway/host-smoke/2026-04-21T18-30-00-000Z",
            "expected_text=smoke-proof-worker-a",
            "last_message=smoke-proof-worker-a",
            "matched=1",
            "before_session=",
            "after_session=/home/worker-a/.codex/sessions/2026/04/21/run.jsonl",
          ].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
      return;
    }

    callback(null, "", "");
  };

  return {
    calls,
    execFileImpl,
  };
}

test("runHostRemoteSmoke writes a successful smoke summary for a ready remote host", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-host-remote-smoke-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry.json"),
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
    codex_bin_path: "~/workspace/state/oss/forks/codex/bin/codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  const stub = createExecFileStub();

  const result = await runHostRemoteSmoke({
    autoCompactTokenLimit: 180000,
    connectTimeoutSecs: 5,
    contextWindow: 200000,
    currentHostId: "controller",
    execFileImpl: stub.execFileImpl,
    hostsRoot,
    model: "gpt-5.5",
    reasoningEffort: "low",
    registryService,
    targetHostId: "worker-a",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.smoke.last_message, "smoke-proof-worker-a");
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "remote-smoke-last-run.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
  const smokeScript = String(stub.calls.find((call) =>
    call.command === "ssh"
    && String(call.args.at(-1) || "").includes("smoke-proof-worker-a")
  )?.args.at(-1) || "");
  assert.equal(smokeScript.includes("configured_codex=$(expand_path"), true);
  assert.equal(smokeScript.includes("workspace/state/oss/forks/codex/bin/codex"), true);
  assert.equal(smokeScript.includes('timeout 120s "$configured_codex"'), true);
  assert.equal(smokeScript.includes("--json"), true);
  assert.equal(smokeScript.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(smokeScript.includes('"$working_directory"'), true);
  assert.equal(smokeScript.includes('model="gpt-5.5"'), true);
  assert.equal(smokeScript.includes('model_reasoning_effort="low"'), true);
  assert.equal(smokeScript.includes("model_context_window=200000"), true);
  assert.equal(smokeScript.includes("model_auto_compact_token_limit=180000"), true);
  assert.equal(smokeScript.includes("--skip-git-repo-check"), false);
  assert.equal(smokeScript.includes("-o \"$temp_last_message\""), false);
});
