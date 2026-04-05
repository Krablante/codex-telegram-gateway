import test from "node:test";
import assert from "node:assert/strict";

import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 250, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for buffered prompt flush");
    }
    await sleep(intervalMs);
  }
}

test("PromptFragmentAssembler flushes buffered long prompt fragments after a quiet window", async () => {
  const flushed = [];
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const firstMessage = {
    text: "A".repeat(3200),
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 1,
    message_thread_id: 77,
  };
  const secondMessage = {
    text: "B",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 2,
    message_thread_id: 77,
  };

  assert.equal(assembler.shouldBufferMessage(firstMessage, firstMessage.text), true);
  assert.equal(
    assembler.shouldBufferMessage(
      {
        ...firstMessage,
        text: "short",
        message_id: 3,
      },
      "short",
    ),
    false,
  );

  assembler.enqueue({
    message: firstMessage,
    flush: async (messages) => {
      flushed.push(messages.map((message) => message.message_id));
    },
  });
  await sleep(10);
  assembler.enqueue({
    message: secondMessage,
  });
  await waitFor(() => flushed.length === 1);

  assert.deepEqual(flushed, [[1, 2]]);
});

test("PromptFragmentAssembler auto-buffers Telegram media groups even when the caption is short", async () => {
  const flushed = [];
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const firstMessage = {
    caption: "bundle these files",
    media_group_id: "docs-1",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 5,
    message_thread_id: 77,
  };
  const secondMessage = {
    media_group_id: "docs-1",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 6,
    message_thread_id: 77,
  };

  assert.equal(assembler.shouldBufferMessage(firstMessage, firstMessage.caption), true);

  assembler.enqueue({
    message: firstMessage,
    flush: async (messages) => {
      flushed.push(messages.map((message) => message.message_id));
    },
  });
  await sleep(10);
  assembler.enqueue({
    message: secondMessage,
  });
  await waitFor(() => flushed.length === 1);

  assert.deepEqual(flushed, [[5, 6]]);
});

test("PromptFragmentAssembler extends buffering when a tail fragment lands during flush grace", async () => {
  const flushed = [];
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 20,
    longPromptThresholdChars: 3000,
  });
  const firstMessage = {
    text: "A".repeat(3200),
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 10,
    message_thread_id: 88,
  };
  const secondMessage = {
    text: " tail",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 11,
    message_thread_id: 88,
  };

  assembler.enqueue({
    message: firstMessage,
    flush: async (messages) => {
      flushed.push(messages.map((message) => message.message_id));
    },
  });
  await sleep(25);
  assembler.enqueue({
    message: secondMessage,
  });

  await sleep(20);
  assert.deepEqual(flushed, []);

  await waitFor(() => flushed.length === 1);
  assert.deepEqual(flushed, [[10, 11]]);
});

test("PromptFragmentAssembler restores buffered fragments after a flush failure", async () => {
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 1000,
    longPromptThresholdChars: 3000,
  });
  const message = {
    text: "A".repeat(3200),
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 20,
    message_thread_id: 89,
  };

  assembler.enqueue({
    message,
    flush: async () => {
      throw new Error("flush failed");
    },
  });

  await assert.rejects(
    assembler.flushPendingForMessage(message),
    /flush failed/u,
  );
  assert.equal(assembler.hasBufferedForMessage(message), true);
  assert.equal(assembler.cancelPendingForMessage(message).messageCount, 1);
});

test("PromptFragmentAssembler supports a topic-local one-shot wait window for short follow-up parts", async () => {
  const flushed = [];
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const manualWindowMessage = {
    text: "/wait 1m",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 30,
    message_thread_id: 90,
  };
  const firstPayload = {
    text: "short one",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 31,
    message_thread_id: 90,
  };
  const secondPayload = {
    text: " short two",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 32,
    message_thread_id: 90,
  };
  const thirdPayload = {
    text: "third prompt",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 33,
    message_thread_id: 91,
  };

  assembler.openWindow({
    message: manualWindowMessage,
    flushDelayMs: 30,
    flush: async (messages) => {
      flushed.push(messages.map((message) => message.message_id));
    },
  });

  await sleep(10);
  assembler.enqueue({ message: firstPayload });
  await sleep(20);
  assert.deepEqual(flushed, []);

  assembler.enqueue({ message: secondPayload });
  await sleep(20);
  assert.deepEqual(flushed, []);

  await waitFor(() => flushed.length === 1);
  assert.deepEqual(flushed, [[31, 32]]);
  assert.equal(assembler.getStateForMessage(firstPayload).active, false);
  assert.equal(assembler.getStateForMessage(firstPayload).local.active, false);
  assert.equal(assembler.shouldBufferMessage(thirdPayload, thirdPayload.text), false);
});

test("PromptFragmentAssembler keeps a global wait window across topics until disabled", async () => {
  const flushed = [];
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const manualWindowMessage = {
    text: "wait 600",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 40,
    message_thread_id: 90,
  };
  const firstPayload = {
    text: "first global part",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 41,
    message_thread_id: 91,
  };
  const secondPayload = {
    text: " second global part",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 42,
    message_thread_id: 92,
  };

  assembler.openWindow({
    message: manualWindowMessage,
    scope: "global",
    flushDelayMs: 30,
    flush: async (messages) => {
      flushed.push(messages.map((message) => message.message_id));
    },
  });

  assert.equal(assembler.shouldBufferMessage(firstPayload, firstPayload.text), true);
  assembler.enqueue({ message: firstPayload });
  await sleep(10);
  assembler.enqueue({ message: secondPayload });
  await sleep(20);
  assert.deepEqual(flushed, []);

  await waitFor(() => flushed.length === 1);
  assert.deepEqual(flushed, [[41, 42]]);
  assert.equal(assembler.getStateForMessage(firstPayload).active, true);
  assert.equal(assembler.getStateForMessage(firstPayload).global.active, true);
});

test("PromptFragmentAssembler keeps a topic-local wait draft invisible to other topics", () => {
  const assembler = new PromptFragmentAssembler();
  const manualWindowMessage = {
    text: "wait 600",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 50,
    message_thread_id: 100,
  };
  const payload = {
    text: "pending draft",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 51,
    message_thread_id: 101,
  };
  const otherTopicCommand = {
    text: "/status",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 52,
    message_thread_id: 102,
  };

  assembler.openWindow({
    message: manualWindowMessage,
  });
  assembler.enqueue({ message: payload });

  assert.equal(assembler.hasPendingForMessage(otherTopicCommand), false);
  assert.equal(assembler.hasPendingForSameTopicMessage(otherTopicCommand), false);
});

test("PromptFragmentAssembler gives topic-local wait priority over global wait", () => {
  const assembler = new PromptFragmentAssembler();
  const globalWaitMessage = {
    text: "wait global 600",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 60,
    message_thread_id: 100,
  };
  const localWaitMessage = {
    text: "wait 60",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 61,
    message_thread_id: 101,
  };
  const localPayload = {
    text: "local draft",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 62,
    message_thread_id: 101,
  };
  const otherTopicPayload = {
    text: "global draft",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 63,
    message_thread_id: 102,
  };

  assembler.openWindow({ message: globalWaitMessage, scope: "global" });
  assembler.openWindow({ message: localWaitMessage, scope: "topic" });

  assert.equal(assembler.shouldBufferMessage(localPayload, localPayload.text), true);
  assert.equal(assembler.shouldBufferMessage(otherTopicPayload, otherTopicPayload.text), true);
  assert.equal(assembler.getStateForMessage(localPayload).scope, "topic");
  assert.equal(assembler.getStateForMessage(otherTopicPayload).scope, "global");
});

test("PromptFragmentAssembler keeps auto long-prompt buffering topic-local", async () => {
  const assembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const longMessage = {
    text: "A".repeat(3200),
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 50,
    message_thread_id: 101,
  };
  const otherTopicShortMessage = {
    text: "short",
    chat: { id: -1001234567890 },
    from: { id: 5825672398 },
    message_id: 51,
    message_thread_id: 102,
  };

  assembler.enqueue({
    message: longMessage,
    flush: async () => {},
  });

  assert.equal(assembler.shouldBufferMessage(otherTopicShortMessage, otherTopicShortMessage.text), false);
});
