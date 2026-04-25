import test from "node:test";
import assert from "node:assert/strict";

import {
  extractUpdateSessionSelector,
  resolveSpikeUpdateRoute,
} from "../src/telegram/spike-update-routing.js";

test("extractUpdateSessionSelector reads topic selectors from messages and callbacks", () => {
  assert.deepEqual(
    extractUpdateSessionSelector({
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 2203,
      },
    }),
    {
      chatId: "-1001234567890",
      topicId: "2203",
    },
  );

  assert.deepEqual(
    extractUpdateSessionSelector({
      callback_query: {
        message: {
          chat: { id: -1001234567890 },
          message_thread_id: 2204,
        },
      },
    }),
    {
      chatId: "-1001234567890",
      topicId: "2204",
    },
  );
});

test("resolveSpikeUpdateRoute forwards running foreign-owned topics to a live owner generation", async () => {
  const route = await resolveSpikeUpdateRoute({
    update: {
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 2203,
      },
    },
    generationId: "gen-new",
    generationStore: {
      async loadGeneration(generationId) {
        assert.equal(generationId, "gen-old");
        return {
          generation_id: "gen-old",
          ipc_endpoint: "http://127.0.0.1:39111/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive() {
        return true;
      },
    },
    sessionStore: {
      async load() {
        return {
          last_run_status: "running",
          session_owner_generation_id: "gen-old",
          session_owner_mode: "retiring",
        };
      },
    },
  });

  assert.equal(route.type, "forward");
  assert.equal(route.ownerGeneration.generation_id, "gen-old");
});

test("resolveSpikeUpdateRoute forwards running topics owned only by spike run generation", async () => {
  const route = await resolveSpikeUpdateRoute({
    update: {
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 2203,
      },
    },
    generationId: "gen-new",
    generationStore: {
      async loadGeneration(generationId) {
        assert.equal(generationId, "gen-old");
        return {
          generation_id: "gen-old",
          ipc_endpoint: "http://127.0.0.1:39111/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive() {
        return true;
      },
    },
    sessionStore: {
      async load() {
        return {
          last_run_status: "running",
          spike_run_owner_generation_id: "gen-old",
        };
      },
    },
  });

  assert.equal(route.type, "forward");
  assert.equal(route.ownerGeneration.generation_id, "gen-old");
});

test("resolveSpikeUpdateRoute falls back local when the owner generation is stale", async () => {
  const route = await resolveSpikeUpdateRoute({
    update: {
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 2203,
      },
    },
    generationId: "gen-new",
    generationStore: {
      async loadGeneration() {
        return {
          generation_id: "gen-old",
          ipc_endpoint: "http://127.0.0.1:39111/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive() {
        return false;
      },
    },
    sessionStore: {
      async load() {
        return {
          last_run_status: "running",
          session_owner_generation_id: "gen-old",
        };
      },
    },
  });

  assert.equal(route.type, "local");
  assert.equal(route.staleOwnerGenerationId, "gen-old");
});

test("resolveSpikeUpdateRoute trusts the verified generation check when available", async () => {
  const route = await resolveSpikeUpdateRoute({
    update: {
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 2203,
      },
    },
    generationId: "gen-new",
    generationStore: {
      async loadGeneration() {
        return {
          generation_id: "gen-old",
          ipc_endpoint: "http://127.0.0.1:39111/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive() {
        return true;
      },
      async isGenerationRecordVerifiablyLive() {
        return false;
      },
    },
    sessionStore: {
      async load() {
        return {
          last_run_status: "running",
          session_owner_generation_id: "gen-old",
        };
      },
    },
  });

  assert.equal(route.type, "local");
  assert.equal(route.staleOwnerGenerationId, "gen-old");
});
