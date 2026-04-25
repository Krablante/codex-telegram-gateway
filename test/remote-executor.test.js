import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  assertSafeRemoteGatewayRepoRoot,
  buildRemoteStartRunParams,
  runRemoteCodexTask,
} from "../src/pty-worker/remote-executor.js";

class FakeRemoteExecutorChild extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signal = null;
    this.buffer = "";
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flushRequests();
    });
  }

  flushRequests() {
    while (this.buffer.includes("\n")) {
      const lineEnd = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (!line.trim()) {
        continue;
      }
      const request = JSON.parse(line);
      if (request.method === "startRun") {
        queueMicrotask(() => {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { message: "remote start failed" },
          })}\n`);
        });
      }
    }
  }

  kill(signal = "SIGTERM") {
    this.signal = signal;
    return true;
  }
}

test("buildRemoteStartRunParams keeps developerInstructions on the remote startRun payload", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {
      codex_bin_path: "/home/worker-b/workspace/state/oss/forks/codex/bin/codex",
    },
    codexBinPath: "/fallback/codex",
    remoteCwd: "/home/worker-b/workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
    localizedImagePaths: ["/tmp/image.png"],
    sessionKey: "-1001234567890:2203",
    contextWindow: 400000,
    autoCompactTokenLimit: 375000,
  });

  assert.equal(
    params.developerInstructions,
    "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
  );
  assert.equal(
    params.baseInstructions,
    "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
  );
  assert.equal(
    params.codexBinPath,
    "/home/worker-b/workspace/state/oss/forks/codex/bin/codex",
  );
  assert.equal(params.contextWindow, 400000);
  assert.equal(params.autoCompactTokenLimit, 375000);
});

test("buildRemoteStartRunParams omits blank developer/base instructions", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {},
    codexBinPath: "/fallback/codex",
    remoteCwd: "/home/worker-b/workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "   ",
  });

  assert.equal("developerInstructions" in params, false);
  assert.equal("baseInstructions" in params, false);
});

test("buildRemoteStartRunParams prefers explicit developerInstructions over legacy baseInstructions", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {},
    codexBinPath: "/fallback/codex",
    remoteCwd: "/home/worker-b/workspace",
    prompt: "User Prompt:\nrun a quick task",
    developerInstructions: "Context:\n- fresh developer context",
    baseInstructions: "Context:\n- legacy base context",
  });

  assert.equal(params.developerInstructions, "Context:\n- fresh developer context");
  assert.equal(params.baseInstructions, "Context:\n- fresh developer context");
});

test("assertSafeRemoteGatewayRepoRoot rejects broad destructive sync targets", () => {
  assert.doesNotThrow(() =>
    assertSafeRemoteGatewayRepoRoot(
      "/srv/codex-workspace/codex-telegram-gateway",
      "worker-a",
    ));
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot("/srv/codex-workspace", "worker-a"),
    /repo_root must point at a codex-telegram-gateway checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot("~", "worker-a"),
    /repo_root must point at a codex-telegram-gateway checkout/u,
  );
});

test("runRemoteCodexTask detaches ssh on Linux and tree-signals startup failures", async () => {
  const execCalls = [];
  const spawnCalls = [];
  const child = new FakeRemoteExecutorChild();
  const host = {
    host_id: "worker-a",
    ssh_target: "worker-a",
    repo_root: "/srv/codex-workspace/codex-telegram-gateway",
    worker_runtime_root: "/srv/codex-workspace/state/codex-telegram-gateway",
    workspace_root: "/srv/codex-workspace",
    codex_bin_path: "/home/operator/bin/codex",
  };

  await assert.rejects(
    () =>
      runRemoteCodexTask({
        codexBinPath: "codex",
        connectTimeoutSecs: 1,
        currentHostId: "controller",
        executionHost: { hostId: "worker-a", host },
        prompt: "hello",
        session: {
          workspace_binding: {
            workspace_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            worktree_path: "/srv/codex-workspace",
          },
        },
        platform: "linux",
        execFileImpl(command, args, options, callback) {
          execCalls.push({ command, args, options });
          callback(null, "", "");
        },
        spawnImpl(command, args, options) {
          spawnCalls.push({ command, args, options });
          return child;
        },
      }),
    /remote start failed/u,
  );

  assert.equal(execCalls.some((call) => call.command === "rsync"), true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "ssh");
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(child.signal, "SIGTERM");
});
