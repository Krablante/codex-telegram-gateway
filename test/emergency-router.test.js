import test from "node:test";
import assert from "node:assert/strict";

import { EmergencyPrivateChatRouter } from "../src/emergency/private-chat-router.js";

const config = {
  telegramAllowedUserId: "5825672398",
  repoRoot: "/workspace/projects/codex-telegram-gateway",
  stateRoot: "/state/codex-telegram-gateway",
  codexBinPath: "codex",
};

function buildPrivateMessage(overrides = {}) {
  return {
    text: "fix the gateway",
    from: { id: 5825672398, is_bot: false },
    chat: { id: 5825672398, type: "private" },
    message_id: 1,
    ...overrides,
  };
}

function buildTopicMessage(overrides = {}) {
  return {
    text: "normal topic message",
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1003577434463, type: "supergroup" },
    message_thread_id: 2203,
    message_id: 1,
    ...overrides,
  };
}

test("EmergencyPrivateChatRouter starts an isolated emergency run in operator private chat", async () => {
  const sent = [];
  const started = [];
  let resolveDone;
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    startRun(args) {
      started.push(args);
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
    },
  });

  const result = await router.handleMessage(buildPrivateMessage());
  assert.equal(result.reason, "emergency-started");
  assert.equal(started.length, 1);
  assert.match(started[0].prompt, /fix the gateway/u);
  assert.match(sent[0].text, /Emergency run started/u);

  resolveDone({
    ok: true,
    interrupted: false,
    finalReply: "fixed",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(sent[1].text, /fixed/u);
});

test("EmergencyPrivateChatRouter buffers attachment-first prompts in private chat", async () => {
  const sent = [];
  const started = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    async ingestAttachments() {
      return [
        {
          file_path: "/tmp/emergency-log.txt",
          mime_type: "text/plain",
          size_bytes: 42,
          is_image: false,
        },
      ];
    },
    startRun(args) {
      started.push(args);
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: Promise.resolve({
          ok: true,
          interrupted: false,
          finalReply: "done",
        }),
      };
    },
  });

  const attachmentResult = await router.handleMessage(
    buildPrivateMessage({
      text: undefined,
      document: {
        file_id: "file-1",
        file_unique_id: "uniq-file-1",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 42,
      },
    }),
  );
  const textResult = await router.handleMessage(
    buildPrivateMessage({
      message_id: 2,
      text: "analyze this log and fix the bot",
    }),
  );

  assert.equal(attachmentResult.reason, "emergency-attachment-buffered");
  assert.equal(textResult.reason, "emergency-started");
  assert.equal(started.length, 1);
  assert.match(started[0].prompt, /Emergency attachments are included/u);
  assert.match(started[0].prompt, /\/tmp\/emergency-log\.txt/u);
  assert.equal(router.pendingAttachments.length, 0);
});

test("EmergencyPrivateChatRouter clears buffered attachments when a command arrives instead of the next prompt", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    async ingestAttachments() {
      return [
        {
          file_path: "/tmp/emergency-log.txt",
          telegram_file_unique_id: "uniq-file-1",
          is_image: false,
        },
      ];
    },
  });

  await router.handleMessage(
    buildPrivateMessage({
      text: undefined,
      document: {
        file_id: "file-1",
        file_unique_id: "uniq-file-1",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 42,
      },
    }),
  );
  const result = await router.handleMessage(
    buildPrivateMessage({
      message_id: 2,
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );

  assert.equal(result.reason, "emergency-status");
  assert.equal(router.pendingAttachments.length, 0);
  assert.match(sent.at(-1).text, /Emergency status/u);
});

test("EmergencyPrivateChatRouter reports status and supports interrupt", async () => {
  const sent = [];
  let killCount = 0;
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {
            killCount += 1;
          },
        },
        done: new Promise(() => {}),
      };
    },
  });

  await router.handleMessage(buildPrivateMessage());
  const statusResult = await router.handleMessage(
    buildPrivateMessage({
      message_id: 2,
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );
  const interruptResult = await router.handleMessage(
    buildPrivateMessage({
      message_id: 3,
      text: "/interrupt",
      entities: [{ type: "bot_command", offset: 0, length: 10 }],
    }),
  );

  assert.equal(statusResult.reason, "emergency-status");
  assert.equal(interruptResult.reason, "emergency-interrupted");
  assert.equal(killCount, 1);
  assert.match(sent[1].text, /run: running/u);
});

test("EmergencyPrivateChatRouter parses commands from attachment captions", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
  });

  const result = await router.handleMessage(
    buildPrivateMessage({
      text: undefined,
      caption: "/status",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
      document: {
        file_id: "file-1",
        file_unique_id: "uniq-file-1",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 42,
      },
    }),
  );

  assert.equal(result.reason, "emergency-status");
  assert.match(sent[0].text, /Emergency status/u);
});

test("EmergencyPrivateChatRouter refuses to start while normal topic runs are active", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config: {
      ...config,
      telegramForumChatId: "-1003577434463",
    },
    normalRunState: {
      hasActiveRuns: () => true,
      getRunCount: () => 2,
    },
  });

  const result = await router.handleMessage(buildPrivateMessage());
  assert.equal(result.reason, "emergency-normal-runs-active");
  assert.match(sent[0].text, /normal topic runs are active/u);
});

test("EmergencyPrivateChatRouter does not buffer attachment-only messages while an emergency run is active", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    async ingestAttachments() {
      return [
        {
          file_path: "/tmp/emergency-log.txt",
          telegram_file_unique_id: "uniq-file-1",
          is_image: false,
        },
      ];
    },
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise(() => {}),
      };
    },
  });

  await router.handleMessage(buildPrivateMessage());
  const result = await router.handleMessage(
    buildPrivateMessage({
      message_id: 2,
      text: undefined,
      document: {
        file_id: "file-1",
        file_unique_id: "uniq-file-1",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 42,
      },
    }),
  );

  assert.equal(result.reason, "emergency-busy");
  assert.equal(router.pendingAttachments.length, 0);
  assert.match(sent.at(-1).text, /already active/u);
});

test("EmergencyPrivateChatRouter blocks normal topic prompts while emergency mode is active", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config: {
      ...config,
      telegramForumChatId: "-1003577434463",
    },
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise(() => {}),
      };
    },
  });

  await router.handleMessage(buildPrivateMessage());
  const result = await router.handleCompetingTopicMessage(buildTopicMessage());

  assert.equal(result.reason, "emergency-topic-locked");
  assert.match(sent.at(-1).text, /Emergency repair is active in private chat/u);
});

test("EmergencyPrivateChatRouter lets topic commands pass through while emergency mode is active", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config: {
      ...config,
      telegramForumChatId: "-1003577434463",
    },
    botUsername: "gatewaybot",
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise(() => {}),
      };
    },
  });

  await router.handleMessage(buildPrivateMessage());
  const result = await router.handleCompetingTopicMessage(
    buildTopicMessage({
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );

  assert.equal(result.handled, false);
  assert.equal(result.reason, "not-emergency-topic-command");
  assert.equal(sent.length, 1);
});

test("EmergencyPrivateChatRouter splits long final replies for Telegram", async () => {
  const sent = [];
  let resolveDone;
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
    },
  });

  await router.handleMessage(
    buildPrivateMessage({
      text: "run a very long repair and report back",
    }),
  );
  resolveDone({
    ok: true,
    interrupted: false,
    finalReply: `${"a".repeat(3900)}\n\n${"b".repeat(3900)}`,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(sent.length >= 3);
  for (const payload of sent.slice(1)) {
    assert.ok(payload.text.length <= 3800);
  }
});

test("EmergencyPrivateChatRouter shutdown interrupts active emergency run", async () => {
  const killSignals = [];
  let resolveDone;
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      killSignals.push(signal);
      child.signalCode = signal;
      resolveDone?.({
        ok: false,
        interrupted: true,
        exitCode: null,
        signal,
        finalReply: "",
      });
    },
  };
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage() {},
      async sendChatAction() {},
    },
    config,
    startRun() {
      return {
        child,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
    },
  });

  await router.handleMessage(buildPrivateMessage());
  await router.shutdown();
  assert.deepEqual(killSignals, ["SIGTERM"]);
  assert.equal(router.isActive(), false);
  assert.equal(router.pendingAttachments.length, 0);
});

test("EmergencyPrivateChatRouter survives a failed start acknowledgement and still clears active state on completion", async () => {
  let resolveDone;
  let sendAttempts = 0;
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage() {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("telegram send failed");
        }
      },
      async sendChatAction() {},
    },
    config,
    startRun() {
      return {
        child: {
          exitCode: null,
          signalCode: null,
          kill() {},
        },
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
    },
  });

  const result = await router.handleMessage(buildPrivateMessage());
  assert.equal(result.reason, "emergency-started");
  assert.equal(router.isActive(), true);

  resolveDone({
    ok: true,
    interrupted: false,
    finalReply: "fixed",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(router.isActive(), false);
});

test("EmergencyPrivateChatRouter converts attachment ingest failures into handled replies", async () => {
  const sent = [];
  const router = new EmergencyPrivateChatRouter({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async sendChatAction() {},
    },
    config,
    async ingestAttachments() {
      throw new Error("download failed");
    },
  });

  const result = await router.handleMessage(
    buildPrivateMessage({
      text: undefined,
      document: {
        file_id: "file-1",
        file_unique_id: "uniq-file-1",
        file_name: "error.log",
        mime_type: "text/plain",
        file_size: 42,
      },
    }),
  );

  assert.equal(result.reason, "emergency-error");
  assert.match(sent.at(-1).text, /failed before the run could start cleanly/u);
});
