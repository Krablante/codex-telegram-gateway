import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  buildCodexExecPrompt,
  buildCodexExecTaskArgs,
  buildRemoteCodexExecSshArgs,
  runCodexExecTask,
  runRemoteCodexExecTask,
  summarizeCodexExecEvent,
} from "../src/codex-exec/telegram-exec-runner.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.stdinText = "";
    this.stdin.on("data", (chunk) => {
      this.stdinText += chunk.toString("utf8");
    });
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.signal = signal;
    return true;
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("close", code, signal);
    });
  }
}

function assertSshCommand(command) {
  assert.match(path.basename(String(command || "")).toLowerCase(), /^ssh(?:\.exe)?$/u);
}

test("buildCodexExecTaskArgs uses the 0.124.0 CLI shape for fresh and resume turns", () => {
  assert.deepEqual(buildCodexExecTaskArgs({ cwd: "/srv/codex-workspace" }), [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/srv/codex-workspace",
    "-",
  ]);

  assert.deepEqual(buildCodexExecTaskArgs({
    cwd: "/srv/codex-workspace",
    sessionThreadId: "thread-123",
  }), [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/srv/codex-workspace",
    "resume",
    "thread-123",
    "-",
  ]);
});

test("buildCodexExecTaskArgs appends runtime overrides and images without using -p as prompt", () => {
  assert.deepEqual(buildCodexExecTaskArgs({
    cwd: "/repo",
    sessionThreadId: "thread-123",
    imagePaths: ["/tmp/a.png"],
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    contextWindow: 500000,
    autoCompactTokenLimit: 450000,
  }), [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/repo",
    "resume",
    "-c",
    'model="gpt-5.5"',
    "-c",
    'model_reasoning_effort="xhigh"',
    "-c",
    "model_context_window=500000",
    "-c",
    "model_auto_compact_token_limit=450000",
    "-i",
    "/tmp/a.png",
    "thread-123",
    "-",
  ]);
});

test("buildCodexExecTaskArgs sends gateway context as developer instructions", () => {
  assert.deepEqual(buildCodexExecTaskArgs({
    cwd: "/repo",
    developerInstructions: "Context:\n- quote: \"ok\"",
  }), [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/repo",
    "-c",
    'developer_instructions="Context:\\n- quote: \\"ok\\""',
    "-",
  ]);
});

test("buildCodexExecTaskArgs keeps developer instructions before resume thread stdin", () => {
  assert.deepEqual(buildCodexExecTaskArgs({
    cwd: "/repo",
    sessionThreadId: "thread-123",
    developerInstructions: "Context:\n- resume: yes",
  }).slice(-4), [
    "-c",
    'developer_instructions="Context:\\n- resume: yes"',
    "thread-123",
    "-",
  ]);
});

test("buildRemoteCodexExecSshArgs sends only command args over ssh; prompt stays on stdin", () => {
  const args = buildRemoteCodexExecSshArgs({
    host: { ssh_target: "worker-a" },
    connectTimeoutSecs: 8,
    codexBinPath: "/srv/codex-workspace/state/oss/forks/codex/bin/codex",
    args: buildCodexExecTaskArgs({ cwd: "/srv/codex-workspace" }),
  });

  assert.deepEqual(args.slice(0, 6), [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "worker-a",
  ]);
  assert.match(args.at(-1), /^bash -lc /u);
  assert.match(args.at(-1), /exec 3<&0/u);
  assert.match(args.at(-1), /setsid/u);
  assert.match(args.at(-1), /trap/u);
  assert.match(args.at(-1), /codex/u);
  assert.match(args.at(-1), /exec/u);
  assert.match(args.at(-1), /--json/u);
  assert.doesNotMatch(args.join(" "), /secret prompt/u);
});

test("summarizeCodexExecEvent maps exec JSONL events to worker summaries", () => {
  assert.deepEqual(summarizeCodexExecEvent({
    type: "thread.started",
    thread_id: "thread-1",
  }), {
    kind: "thread",
    eventType: "thread.started",
    text: "Codex thread started: thread-1",
    threadId: "thread-1",
  });
  assert.equal(
    summarizeCodexExecEvent({
      type: "thread.started",
      source: "subagent",
      thread_id: "worker-thread",
    }),
    null,
  );

  assert.deepEqual(summarizeCodexExecEvent({
    type: "item.updated",
    item: { id: "msg-1", type: "agent_message", text: "partial" },
  }), null);

  assert.deepEqual(summarizeCodexExecEvent({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "complete candidate" },
  }), {
    kind: "agent_message",
    eventType: "item.completed",
    text: "complete candidate",
    messagePhase: "commentary",
    progressSource: "agent_message",
  });

  assert.deepEqual(summarizeCodexExecEvent({
    type: "item.completed",
    item: { id: "reasoning-1", type: "reasoning", text: "checking the live contract" },
  }), {
    kind: "agent_message",
    eventType: "item.completed",
    text: "checking the live contract",
    messagePhase: "commentary",
    progressSource: "reasoning",
  });

  for (const item of [
    { id: "reasoning-empty", type: "reasoning", text: "" },
    { id: "reasoning-subagent", type: "reasoning", text: "worker note", source: "subagent" },
    { id: "agent-subagent", type: "agent_message", text: "worker note", source: "subagent" },
    {
      id: "reasoning-collab",
      type: "reasoning",
      text: "collab note",
      sender_thread_id: "agent-thread",
    },
    { id: "todo-1", type: "todo_list", items: [{ text: "step", completed: false }] },
    {
      id: "patch-1",
      type: "file_change",
      changes: [{ path: "/repo/file.js", kind: "update" }],
      status: "completed",
    },
    {
      id: "mcp-1",
      type: "mcp_tool_call",
      server: "pitlane",
      tool: "search_content",
      status: "completed",
    },
    {
      id: "collab-1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      status: "completed",
    },
    {
      id: "search-1",
      type: "web_search",
      query: "docs",
    },
    {
      id: "warning-1",
      type: "error",
      message: "tool warning",
    },
  ]) {
    assert.equal(
      summarizeCodexExecEvent({ type: "item.completed", item }),
      null,
      `${item.type} must not become Telegram-visible commentary`,
    );
  }

  assert.equal(
    summarizeCodexExecEvent({
      type: "item.completed",
      source: "subagent",
      item: {
        id: "cmd-subagent",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/repo\n",
        exit_code: 0,
      },
    }),
    null,
  );

  assert.deepEqual(summarizeCodexExecEvent({
    type: "turn.failed",
    error: { message: "boom" },
  }), {
    kind: "turn",
    eventType: "turn.failed",
    text: "boom",
    turnStatus: "failed",
    turnError: { message: "boom" },
  });
});

test("runCodexExecTask streams JSONL summaries, persists first thread id, and writes prompt to stdin", async () => {
  const children = [];
  const spawnCalls = [];
  const summaries = [];
  const runtimeStates = [];
  const warnings = [];
  const finalAnswers = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "answer briefly",
    baseInstructions: "Telegram delivery stays here.",
    onEvent(summary) {
      summaries.push(summary);
      if (summary?.messagePhase === "final_answer") {
        finalAnswers.push(summary.text);
      }
    },
    onRuntimeState(payload) {
      runtimeStates.push(payload);
    },
    onWarning(line) {
      warnings.push(line);
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const child = children[0];
  child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"');
  child.stdout.write('}\nnot json\n');
  child.stdout.write(`${JSON.stringify({
    type: "item.updated",
    item: { id: "msg-1", type: "agent_message", text: "working" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "reasoning-1", type: "reasoning", text: "checking the repo" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "progress-1", type: "agent_message", text: "Сверяю фактический JSONL поток." },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "progress-2", type: "agent_message", text: "Готовлю минимальную правку без лишней архитектуры." },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.updated",
    item: { id: "todo-1", type: "todo_list", items: [{ text: "audit", completed: false }] },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "patch-1", type: "file_change", changes: [{ path: "/repo/a.js", kind: "update" }], status: "completed" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.started",
    item: { id: "collab-1", type: "collab_tool_call", tool: "spawn_agent", status: "in_progress" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "cmd-1", type: "command_execution", command: "echo ok", aggregated_output: "ok\n", exit_code: 0, status: "completed" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "done" },
  })}\n`);
  child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2}}\n');
  child.close(0, null);

  const result = await task.finished;
  assert.equal(result.backend, "exec-json");
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "thread-1");
  assert.deepEqual(runtimeStates, [{ threadId: "thread-1" }]);
  assert.equal(summaries[0].eventType, "thread.started");
  assert.equal(summaries.some((summary) => summary.text === "checking the repo"), true);
  assert.equal(summaries.some((summary) => summary.text === "Сверяю фактический JSONL поток."), true);
  assert.equal(
    summaries.some((summary) =>
      summary.text === "Готовлю минимальную правку без лишней архитектуры."
      && summary.messagePhase === "commentary"
      && summary.progressSource === "agent_message",
    ),
    true,
  );
  assert.equal(summaries.some((summary) => summary.text === "working"), false);
  assert.equal(summaries.filter((summary) => summary.text === "done").length, 2);
  assert.equal(
    summaries.filter((summary) => summary.text === "done" && summary.messagePhase === "final_answer").length,
    1,
  );
  assert.equal(
    summaries.some((summary) => /Plan:|File changes|Subagent|MCP|Web search/u.test(summary.text || "")),
    false,
  );
  assert.deepEqual(finalAnswers, ["done"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Malformed codex exec JSONL ignored/u);
  assert.match(result.warnings.join("\n"), /Ignored malformed codex exec JSONL lines: 1/u);
  assert.equal(spawnCalls[0].command, "codex");
  assert.deepEqual(
    spawnCalls[0].args,
    buildCodexExecTaskArgs({
      cwd: "/srv/codex-workspace",
      developerInstructions: "Telegram delivery stays here.",
    }),
  );
  assert.equal(child.stdinText, "answer briefly");
  assert.doesNotMatch(child.stdinText, /Context:\nContext:/u);
  assert.doesNotMatch(child.stdinText, /User request:/u);
});

test("runCodexExecTask mirrors raw JSONL lines for stale recovery", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-exec-jsonl-mirror-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const jsonlLogPath = path.join(tmpDir, "exec-json-run.jsonl");
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "mirror me",
    jsonlLogPath,
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stdout.write('{"type":"thread.started","thread_id":"mirror-thread"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "mirrored" },
  })}\n`);
  task.child.stdout.write('{"type":"turn.completed"}\n');
  task.child.close(0, null);

  const result = await task.finished;
  assert.equal(result.ok, true);
  const mirrored = await fs.readFile(jsonlLogPath, "utf8");
  assert.match(mirrored, /"thread_id":"mirror-thread"/u);
  assert.match(mirrored, /"text":"mirrored"/u);
  assert.match(mirrored, /"type":"turn.completed"/u);
});

test("runRemoteCodexExecTask expands remote tilde paths before launching ssh exec", async () => {
  const children = [];
  const spawnCalls = [];
  const execFileCalls = [];
  const runtimeStates = [];
  const task = await runRemoteCodexExecTask({
    codexBinPath: "codex",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    executionHost: {
      isLocal: false,
      hostId: "worker-a",
      host: {
        host_id: "worker-a",
        ssh_target: "worker-a",
        workspace_root: "~/workspace",
        worker_runtime_root:
          "~/.local/state/codex-telegram-gateway",
        codex_bin_path: "~/workspace/state/oss/forks/codex/bin/codex",
      },
    },
    session: {
      session_key: "chat:topic",
      workspace_binding: {
        workspace_root: "/srv/codex-workspace",
        cwd: "/srv/codex-workspace",
        cwd_relative_to_workspace_root: ".",
      },
    },
    sessionKey: "chat:topic",
    prompt: "remote prompt",
    baseInstructions: "remote context",
    onRuntimeState(payload) {
      runtimeStates.push(payload);
    },
    execFileImpl(command, args, _options, callback) {
      execFileCalls.push({ command, args });
      callback(
        null,
        [
          "cwd=/home/worker-a/workspace",
          "input_root=/home/worker-a/workspace/state/codex-telegram-gateway/remote-inputs/chat-topic",
          "codex_bin=/home/worker-a/workspace/state/oss/forks/codex/bin/codex",
        ].join("\n"),
        "",
      );
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const child = children[0];
  child.stdout.write('{"type":"thread.started","thread_id":"remote-thread"}\n');
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "remote done" },
  })}\n`);
  child.stdout.write('{"type":"turn.completed"}\n');
  child.close(0, null);

  const result = await task.finished;
  const sshCommand = spawnCalls[0].args.at(-1);
  assert.equal(result.threadId, "remote-thread");
  assert.deepEqual(runtimeStates, [{ threadId: "remote-thread" }]);
  assert.equal(execFileCalls[0].command, "ssh");
  assert.match(execFileCalls[0].args.at(-1), /expand_path/u);
  assertSshCommand(spawnCalls[0].command);
  assert.match(sshCommand, /\/home\/worker-a\/workspace\/state\/oss\/forks\/codex\/bin\/codex/u);
  assert.match(sshCommand, /-C/u);
  assert.match(sshCommand, /\/home\/worker-a\/workspace/u);
  assert.match(sshCommand, /developer_instructions=/u);
  assert.match(sshCommand, /remote context/u);
  assert.doesNotMatch(sshCommand, /~\/workspace/u);
  assert.equal(child.stdinText, "remote prompt");
  assert.doesNotMatch(child.stdinText, /User request:/u);
});

test("runRemoteCodexExecTask forwards runtime overrides and staged images over ssh exec", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-remote-images-"));
  const localImage = path.join(tmpDir, "screen shot.png");
  await fs.writeFile(localImage, "fake image bytes");
  const children = [];
  const spawnCalls = [];
  const execFileCalls = [];
  const task = await runRemoteCodexExecTask({
    codexBinPath: "codex",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    executionHost: {
      isLocal: false,
      hostId: "worker-a",
      host: {
        host_id: "worker-a",
        ssh_target: "worker-a",
        workspace_root: "~/workspace",
        worker_runtime_root:
          "~/.local/state/codex-telegram-gateway",
        codex_bin_path: "~/workspace/state/oss/forks/codex/bin/codex",
      },
    },
    session: {
      session_key: "chat:topic",
      workspace_binding: {
        workspace_root: "/srv/codex-workspace",
        cwd: "/srv/codex-workspace",
        cwd_relative_to_workspace_root: ".",
      },
    },
    sessionKey: "chat:topic",
    sessionThreadId: "remote-resume-thread",
    prompt: "remote prompt with image",
    imagePaths: [localImage, localImage],
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    contextWindow: 500000,
    autoCompactTokenLimit: 450000,
    execFileImpl(command, args, _options, callback) {
      execFileCalls.push({ command, args });
      if (command === "ssh") {
        const script = args.at(-1) || "";
        const remoteInputRoot = script
          .match(/(~\/\.local\/state\/codex-telegram-gateway\/remote-inputs\/chat-topic\/run-[A-Za-z0-9.-]+)/u)
          ?.at(1)
          ?.replace(/^~\//u, "/home/worker-a/")
          || "/home/worker-a/.local/state/codex-telegram-gateway/remote-inputs/chat-topic";
        callback(
          null,
          [
            "cwd=/home/worker-a/workspace",
            `input_root=${remoteInputRoot}`,
            "codex_bin=/home/worker-a/workspace/state/oss/forks/codex/bin/codex",
          ].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
    },
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const child = children[0];
  child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
  child.close(0, null);

  const result = await task.finished;
  const rsyncCalls = execFileCalls.filter((call) => call.command === "rsync");
  const sshCommand = spawnCalls[0].args.at(-1);
  assert.equal(result.ok, true);
  assert.equal(result.threadId, "remote-resume-thread");
  assert.equal(rsyncCalls.length, 1);
  assert.equal(rsyncCalls[0].args.includes("-s"), true);
  assert.match(rsyncCalls[0].args.join(" "), /screen shot\.png/u);
  assert.match(sshCommand, /resume/u);
  assert.match(sshCommand, /remote-resume-thread/u);
  assert.match(sshCommand, /model="gpt-5\.5"/u);
  assert.match(sshCommand, /model_reasoning_effort="xhigh"/u);
  assert.match(sshCommand, /model_context_window=500000/u);
  assert.match(sshCommand, /model_auto_compact_token_limit=450000/u);
  assert.equal(
    (sshCommand.match(/\/home\/worker-a\/\.local\/state\/codex-telegram-gateway\/remote-inputs\/chat-topic\/run-[^']+\/0001-screen-shot\.png/gu) || []).length,
    4,
  );
});

test("runRemoteCodexExecTask treats requested steer exit code 1 as controlled interruption", async () => {
  const children = [];
  const spawnCalls = [];
  const task = await runRemoteCodexExecTask({
    codexBinPath: "codex",
    connectTimeoutSecs: 5,
    currentHostId: "controller",
    executionHost: {
      isLocal: false,
      hostId: "worker-a",
      host: {
        host_id: "worker-a",
        ssh_target: "worker-a",
        workspace_root: "~/workspace",
        worker_runtime_root:
          "~/.local/state/codex-telegram-gateway",
        codex_bin_path: "~/workspace/state/oss/forks/codex/bin/codex",
      },
    },
    session: {
      session_key: "chat:topic",
      workspace_binding: {
        workspace_root: "/srv/codex-workspace",
        cwd: "/srv/codex-workspace",
        cwd_relative_to_workspace_root: ".",
      },
    },
    sessionKey: "chat:topic",
    prompt: "remote steer prompt",
    execFileImpl(_command, _args, _options, callback) {
      callback(
        null,
        [
          "cwd=/home/worker-a/workspace",
          "input_root=/home/worker-a/workspace/state/codex-telegram-gateway/remote-inputs/chat-topic",
          "codex_bin=/home/worker-a/workspace/state/oss/forks/codex/bin/codex",
        ].join("\n"),
        "",
      );
    },
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const child = children[0];
  child.stdout.write('{"type":"thread.started","thread_id":"remote-steer-thread"}\n');
  child.stdout.write('{"type":"turn.started","turn_id":"remote-turn"}\n');
  assert.deepEqual(await task.steer(), { ok: true, reason: "steered" });
  assert.equal(child.signal, "SIGINT");
  child.close(1, null);

  const result = await task.finished;
  assertSshCommand(spawnCalls[0].command);
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "interrupted");
  assert.equal(result.preserveContinuity, true);
  assert.equal(result.threadId, "remote-steer-thread");
  assert.deepEqual(result.warnings, []);
});

test("buildCodexExecPrompt leaves plain prompts untouched", () => {
  assert.equal(buildCodexExecPrompt({ prompt: "hello" }), "hello");
  assert.equal(
    buildCodexExecPrompt({
      prompt: "hello",
      baseInstructions: "Context:\nignored",
    }),
    "hello",
  );
});

test("runCodexExecTask does not promote an agent message to final without turn.completed", async () => {
  const finalAnswers = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    sessionThreadId: "thread-1",
    prompt: "continue",
    onEvent(summary) {
      if (summary?.messagePhase === "final_answer") {
        finalAnswers.push(summary.text);
      }
    },
    spawnImpl() {
      return new FakeChild();
    },
  });

  const child = task.child;
  child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
  child.stdout.write('{"type":"turn.started"}\n');
  child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "not final yet" },
  })}\n`);
  child.stderr.write("runtime died\n");
  child.close(1, null);

  const result = await task.finished;
  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "exec_stream_incomplete");
  assert.equal(result.preserveContinuity, true);
  assert.equal(result.threadId, "thread-1");
  assert.deepEqual(finalAnswers, []);
});

test("runCodexExecTask caps oversized stderr tails in warnings", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "fail with noisy stderr",
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stderr.write(`${"x".repeat(12000)}\n`);
  for (let index = 0; index < 30; index += 1) {
    task.child.stderr.write(`${index}:${"y".repeat(4000)}\n`);
  }
  task.child.close(1, null);

  const result = await task.finished;
  const stderrWarning = result.warnings.find((warning) =>
    warning.startsWith("codex exec stderr:"),
  );
  assert.ok(stderrWarning);
  assert.match(stderrWarning, /truncated/u);
  assert.ok(
    Buffer.byteLength(stderrWarning, "utf8") < 17000,
    "stderr warning should stay bounded below the configured 16 KiB tail plus prefix",
  );
});

test("runCodexExecTask keeps subagent agent messages out of final answers", async () => {
  const finalAnswers = [];
  const commentary = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "root turn",
    onEvent(summary) {
      if (summary?.messagePhase === "final_answer") {
        finalAnswers.push(summary.text);
      } else if (summary?.kind === "agent_message") {
        commentary.push(summary.text);
      }
    },
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stdout.write('{"type":"thread.started","thread_id":"root-thread"}\n');
  task.child.stdout.write('{"type":"turn.started"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "root-msg", type: "agent_message", text: "root answer" },
  })}\n`);
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    source: "subagent",
    item: {
      id: "sub-msg",
      type: "agent_message",
      text: "subagent answer must not leak",
      agent_id: "worker-1",
    },
  })}\n`);
  task.child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
  task.child.close(0, null);

  const result = await task.finished;
  assert.equal(result.ok, true);
  assert.deepEqual(commentary, ["root answer"]);
  assert.deepEqual(finalAnswers, ["root answer"]);
});

test("runCodexExecTask keeps non-primary thread and command events out of root state", async () => {
  const runtimeStates = [];
  const summaries = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "root turn",
    onRuntimeState(state) {
      runtimeStates.push(state);
    },
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stdout.write('{"type":"thread.started","thread_id":"root-thread"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "thread.started",
    source: "subagent",
    thread_id: "worker-thread",
  })}\n`);
  task.child.stdout.write('{"type":"turn.started"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "root-msg", type: "agent_message", text: "root answer" },
  })}\n`);
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    source: "subagent",
    item: {
      id: "sub-command",
      type: "command_execution",
      command: "pwd",
      aggregated_output: "/repo\n",
      exit_code: 0,
    },
  })}\n`);
  task.child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
  task.child.close(0, null);

  const result = await task.finished;
  assert.equal(result.ok, true);
  assert.equal(result.threadId, "root-thread");
  assert.deepEqual(runtimeStates, [{ threadId: "root-thread" }]);
  assert.equal(summaries.some((summary) => summary.threadId === "worker-thread"), false);
  assert.equal(summaries.some((summary) => summary.command === "pwd"), false);
});

test("runCodexExecTask ignores foreign terminal events instead of completing the root run", async () => {
  const finalAnswers = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "root turn",
    onEvent(summary) {
      if (summary?.messagePhase === "final_answer") {
        finalAnswers.push(summary.text);
      }
    },
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stdout.write('{"type":"thread.started","thread_id":"root-thread"}\n');
  task.child.stdout.write('{"type":"turn.started"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "root-msg", type: "agent_message", text: "root answer" },
  })}\n`);
  task.child.stdout.write(`${JSON.stringify({
    type: "turn.completed",
    source: "subagent",
    agent_id: "worker-1",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  })}\n`);
  task.child.close(0, null);

  const result = await task.finished;
  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "exec_stream_incomplete");
  assert.equal(result.threadId, "root-thread");
  assert.deepEqual(finalAnswers, []);
});

test("runCodexExecTask preserves requested resume thread when exec exits before thread.started", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    sessionThreadId: "old-thread",
    prompt: "continue",
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stderr.write("thread not found\n");
  task.child.close(1, null);

  const result = await task.finished;
  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "resume_unavailable");
  assert.equal(result.preserveContinuity, true);
  assert.equal(result.threadId, "old-thread");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "old-thread",
    replacementThreadId: null,
    reason: "exec-resume-unavailable",
  });
});

test("runCodexExecTask treats successful resume without thread.started as completed", async () => {
  const finalAnswers = [];
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    sessionThreadId: "old-thread",
    prompt: "continue",
    onEvent(summary) {
      if (summary?.messagePhase === "final_answer") {
        finalAnswers.push(summary.text);
      }
    },
    spawnImpl() {
      return new FakeChild();
    },
  });

  task.child.stdout.write('{"type":"turn.started"}\n');
  task.child.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "resumed ok" },
  })}\n`);
  task.child.stdout.write('{"type":"turn.completed"}\n');
  task.child.close(0, null);

  const result = await task.finished;
  assert.equal(result.ok, true);
  assert.equal(result.resumeReplacement, null);
  assert.equal(result.abortReason, null);
  assert.equal(result.threadId, "old-thread");
  assert.deepEqual(finalAnswers, ["resumed ok"]);
});

test("runCodexExecTask interrupt signals the child process tree", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "stop me",
    spawnImpl() {
      return new FakeChild();
    },
  });

  assert.equal(await task.interrupt(), true);
  assert.equal(task.child.signal, "SIGINT");
  task.child.close(null, "SIGINT");
  const result = await task.finished;
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "user");
  assert.equal(result.abortReason, "interrupted");
});

test("runCodexExecTask steer interrupts the child as an upstream continuation signal", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "keep going",
    spawnImpl() {
      return new FakeChild();
    },
  });

  assert.deepEqual(await task.steer(), { ok: true, reason: "steered" });
  assert.equal(task.child.signal, "SIGINT");
  task.child.close(null, "SIGINT");
  const result = await task.finished;
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "interrupted");
});

test("runCodexExecTask treats requested steer exit code 1 as controlled interruption", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "keep going",
    spawnImpl() {
      return new FakeChild();
    },
  });

  assert.deepEqual(await task.steer(), { ok: true, reason: "steered" });
  assert.equal(task.child.signal, "SIGINT");
  task.child.close(1, null);
  const result = await task.finished;
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "interrupted");
  assert.deepEqual(result.warnings, []);
});

test("runCodexExecTask does not hide fatal JSONL errors behind requested steer", async () => {
  const task = runCodexExecTask({
    codexBinPath: "codex",
    cwd: "/repo",
    prompt: "keep going",
    spawnImpl() {
      return new FakeChild();
    },
  });

  assert.deepEqual(await task.steer(), { ok: true, reason: "steered" });
  task.child.stdout.write('{"type":"error","message":"boom"}\n');
  task.child.close(1, null);

  const result = await task.finished;
  assert.equal(result.interrupted, false);
  assert.equal(result.interruptReason, null);
  assert.equal(result.abortReason, "exec_stream_error");
  assert.match(result.warnings.join("\n"), /Codex exec failed: boom/u);
});
