import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexChildEnv } from "../src/runtime/codex-child-env.js";

test("buildCodexChildEnv keeps runtime basics and strips gateway secrets", () => {
  const env = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/operator",
    OPENAI_API_KEY: "openai-secret",
    CODEX_HOME: "/home/operator/.codex",
    CODEX_CONFIG_PATH: "/home/operator/.codex/config.toml",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    TELEGRAM_FORUM_CHAT_ID: "-100",
    ENV_FILE: "/state/runtime.env",
    STATE_ROOT: "/state",
    HOST_REGISTRY_PATH: "/state/hosts/registry.json",
    CODEX_GATEWAY_BACKEND: "exec-json",
    CODEX_MODEL: "gpt-5.5",
    SPIKE_DEBUG_TOKEN: "hidden",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/operator");
  assert.equal(env.OPENAI_API_KEY, "openai-secret");
  assert.equal(env.CODEX_HOME, "/home/operator/.codex");
  assert.equal(env.CODEX_CONFIG_PATH, "/home/operator/.codex/config.toml");
  assert.equal("TELEGRAM_BOT_TOKEN" in env, false);
  assert.equal("TELEGRAM_FORUM_CHAT_ID" in env, false);
  assert.equal("ENV_FILE" in env, false);
  assert.equal("STATE_ROOT" in env, false);
  assert.equal("HOST_REGISTRY_PATH" in env, false);
  assert.equal("CODEX_GATEWAY_BACKEND" in env, false);
  assert.equal("CODEX_MODEL" in env, false);
  assert.equal("SPIKE_DEBUG_TOKEN" in env, false);
});
