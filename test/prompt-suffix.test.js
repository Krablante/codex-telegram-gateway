import test from "node:test";
import assert from "node:assert/strict";

import {
  composePromptWithSuffixes,
  extractRenderedUserPrompt,
  renderUserPrompt,
  replaceRenderedUserPrompt,
  resolveEffectiveWorkStyle,
} from "../src/session-manager/prompt-suffix.js";

test("resolveEffectiveWorkStyle keeps topic overrides and suppresses routing-off topics", () => {
  assert.equal(
    resolveEffectiveWorkStyle(
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "TOPIC\nKeep it short.",
      },
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    ),
    "TOPIC\nKeep it short.",
  );

  assert.equal(
    resolveEffectiveWorkStyle(
      {
        prompt_suffix_topic_enabled: false,
        prompt_suffix_enabled: true,
        prompt_suffix_text: "TOPIC\nKeep it short.",
      },
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    ),
    null,
  );
});

test("renderUserPrompt keeps only the User Prompt section", () => {
  assert.equal(
    renderUserPrompt("inspect the latest logs"),
    "User Prompt:\ninspect the latest logs",
  );
});

test("replaceRenderedUserPrompt preserves literal User Prompt lines inside work style text", () => {
  const renderedPrompt = composePromptWithSuffixes(
    "inspect the latest logs",
    {
      prompt_suffix_enabled: true,
      prompt_suffix_text: [
        "Keep it short.",
        "",
        "User Prompt:",
        "This line is literal suffix guidance, not a section boundary.",
      ].join("\n"),
    },
  );

  const rewrittenPrompt = replaceRenderedUserPrompt(
    renderedPrompt,
    "inspect the latest logs",
    [
      "Telegram attachments are included with this message. Use them as part of the context.",
      "- file: /tmp/log.txt [text/plain, 42 bytes]",
      "",
      "inspect the latest logs",
    ].join("\n"),
  );

  assert.equal(
    rewrittenPrompt,
    [
      "Work Style:",
      "Keep it short.",
      "",
      "User Prompt:",
      "This line is literal suffix guidance, not a section boundary.",
      "",
      "User Prompt:",
      "Telegram attachments are included with this message. Use them as part of the context.",
      "- file: /tmp/log.txt [text/plain, 42 bytes]",
      "",
      "inspect the latest logs",
    ].join("\n"),
  );
});

test("replaceRenderedUserPrompt rewrites unstructured prompts for direct worker starts", () => {
  assert.equal(
    replaceRenderedUserPrompt(
      "inspect the latest logs",
      "inspect the latest logs",
      "Telegram attachments are included.\n\ninspect the latest logs",
    ),
    "Telegram attachments are included.\n\ninspect the latest logs",
  );
});

test("extractRenderedUserPrompt unwraps the latest user body from a structured prompt", () => {
  const renderedPrompt = composePromptWithSuffixes(
    "inspect the latest logs",
    {
      prompt_suffix_enabled: true,
      prompt_suffix_text: "Keep it short.",
    },
  );

  assert.equal(
    extractRenderedUserPrompt(renderedPrompt),
    "inspect the latest logs",
  );
});

test("extractRenderedUserPrompt keeps plain prompts unchanged", () => {
  assert.equal(
    extractRenderedUserPrompt("inspect the latest logs"),
    "inspect the latest logs",
  );
});

test("extractRenderedUserPrompt skips known Telegram attachment preambles", () => {
  assert.equal(
    extractRenderedUserPrompt(
      [
        "Telegram attachments are included with this message. Use them as part of the context.",
        "- file: /tmp/log.txt [text/plain, 42 bytes]",
        "",
        "User Prompt:",
        "inspect the latest logs",
      ].join("\n"),
    ),
    "inspect the latest logs",
  );
});
