import test from "node:test";
import assert from "node:assert/strict";

import { createHostAwareRunTask } from "../src/pty-worker/host-aware-run-task.js";

test("createHostAwareRunTask uses local runner for local execution host", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      currentHostId: "controller",
      hostSshConnectTimeoutSecs: 5,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: {
      session_key: "s1",
    },
    executionHost: {
      ok: true,
      isLocal: true,
      hostId: "controller",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "local");
});

test("createHostAwareRunTask uses remote runner for ready remote host", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      currentHostId: "controller",
      hostSshConnectTimeoutSecs: 9,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: {
      session_key: "s2",
    },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "worker-a",
      host: {
        host_id: "worker-a",
        ssh_target: "worker-a",
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "remote");
  assert.equal(calls[0].args.currentHostId, "controller");
  assert.equal(calls[0].args.connectTimeoutSecs, 9);
});

test("createHostAwareRunTask switches to exec-json runners when configured", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "exec-json",
      currentHostId: "controller",
      hostSshConnectTimeoutSecs: 7,
    },
    runLocalTask() {
      calls.push({ kind: "local-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask() {
      calls.push({ kind: "remote-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalExecTask(args) {
      calls.push({ kind: "local-exec", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteExecTask(args) {
      calls.push({ kind: "remote-exec", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-exec-local" },
    executionHost: { ok: true, isLocal: true, hostId: "controller" },
  });
  await runTask({
    session: { session_key: "s-exec-remote" },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "worker-a",
      host: {
        host_id: "worker-a",
        ssh_target: "worker-a",
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), [
    "local-exec",
    "remote-exec",
  ]);
  assert.equal(calls[1].args.currentHostId, "controller");
  assert.equal(calls[1].args.connectTimeoutSecs, 7);
});

test("createHostAwareRunTask defaults to exec-json runners", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      currentHostId: "controller",
      hostSshConnectTimeoutSecs: 7,
    },
    runLocalTask() {
      calls.push({ kind: "local-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalExecTask(args) {
      calls.push({ kind: "local-exec", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-default-exec" },
    executionHost: { ok: true, isLocal: true, hostId: "controller" },
  });

  assert.deepEqual(calls.map((call) => call.kind), ["local-exec"]);
});

test("createHostAwareRunTask fails closed for unavailable execution hosts", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      currentHostId: "controller",
      hostSshConnectTimeoutSecs: 9,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await assert.rejects(
    () => runTask({
      session: {
        session_key: "s3",
      },
      executionHost: {
        ok: false,
        isLocal: false,
        hostId: "worker-a",
        hostLabel: "worker-a",
        failureReason: "host-not-ready",
      },
    }),
    {
      code: "EXECUTION_HOST_UNAVAILABLE",
      hostId: "worker-a",
      failureReason: "host-not-ready",
    },
  );

  assert.equal(calls.length, 0);
});
