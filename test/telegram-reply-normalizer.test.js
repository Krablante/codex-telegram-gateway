import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTelegramReply,
  renderTelegramHtml,
  splitTelegramReply,
} from "../src/transport/telegram-reply-normalizer.js";

const TELEGRAM_INDENT = "\u00A0\u00A0\u00A0\u00A0";

test("normalizeTelegramReply keeps plain session-friendly text and strips local file targets", () => {
  const source = [
    "Создан [`test.js`](/workspace/test.js).",
    "Проверил `SIGTERM` и **workspace**.",
    "",
    "Смотри [документацию](https://example.com/docs).",
  ].join("\n");

  assert.equal(
    normalizeTelegramReply(source),
    [
      "Создан test.js.",
      "Проверил SIGTERM и workspace.",
      "",
      "Смотри документацию: https://example.com/docs.",
    ].join("\n"),
  );
});

test("renderTelegramHtml converts supported Codex markdown to Telegram HTML", () => {
  const source = [
    "# Заголовок",
    "",
    "Смотри [`README.md#L5`](/workspace/README.md#L5) и [документацию](https://example.com/docs).",
    "",
    "> Цитата с `code`, **bold**, ~~strike~~ и ||spoiler||.",
    "",
    "```js",
    "console.log('hello');",
    "```",
  ].join("\n");

  assert.equal(
    renderTelegramHtml(source),
    [
      "<b>Заголовок</b>",
      "",
      'Смотри <code>README.md#L5</code> и <a href="https://example.com/docs">документацию</a>.',
      "",
      "<blockquote>Цитата с <code>code</code>, <b>bold</b>, strike и spoiler.</blockquote>",
      "",
      '<pre><code class="language-js">console.log(\'hello\');</code></pre>',
    ].join("\n"),
  );
});

test("renderTelegramHtml keeps nested list structure readable in Telegram", () => {
  const source = [
    "- top bullet",
    "  - nested bullet with `code`",
    "    - deep bullet",
    "1. first step",
    "  1. nested numbered step",
  ].join("\n");

  assert.equal(
    renderTelegramHtml(source),
    [
      "• top bullet",
      `${TELEGRAM_INDENT}◦ nested bullet with <code>code</code>`,
      `${TELEGRAM_INDENT}${TELEGRAM_INDENT}▪ deep bullet`,
      "1. first step",
      `${TELEGRAM_INDENT}1. nested numbered step`,
    ].join("\n"),
  );
});

test("splitTelegramReply keeps fenced code blocks valid across chunks", () => {
  const repeated = Array.from({ length: 12 }, (_, index) => `line-${index}-${"x".repeat(40)}`);
  const source = [
    "```txt",
    ...repeated,
    "```",
  ].join("\n");

  const chunks = splitTelegramReply(source, 220);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 220);
    assert.match(chunk, /^<pre>/u);
    assert.match(chunk, /<\/pre>$/u);
  }
});
