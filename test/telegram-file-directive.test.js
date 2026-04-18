import test from "node:test";
import assert from "node:assert/strict";

import { extractTelegramFileDirectives } from "../src/transport/telegram-file-directive.js";

test("extractTelegramFileDirectives strips telegram-file blocks and returns parsed documents", () => {
  const source = [
    "Скидываю артефакт.",
    "",
    "```telegram-file",
    "action: send",
    "path: /tmp/report.txt",
    "filename: report.txt",
    "caption: Daily report",
    "```",
    "",
    "Проверь его в этом topic.",
  ].join("\n");

  const parsed = extractTelegramFileDirectives(source);
  assert.equal(parsed.text, "Скидываю артефакт.\n\nПроверь его в этом topic.");
  assert.deepEqual(parsed.documents, [
    {
      filePath: "/tmp/report.txt",
      fileName: "report.txt",
      caption: "Daily report",
    },
  ]);
  assert.deepEqual(parsed.warnings, []);
});

test("extractTelegramFileDirectives reports malformed blocks without leaking them into visible text", () => {
  const source = [
    "```telegram-file",
    "action: send",
    "caption: Missing path",
    "```",
  ].join("\n");

  const parsed = extractTelegramFileDirectives(source);
  assert.equal(parsed.text, "");
  assert.deepEqual(parsed.documents, []);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /<absolute-host-path-to-file>/u);
});

test("extractTelegramFileDirectives keeps example blocks visible when action sentinel is missing", () => {
  const source = [
    "Показываю синтаксис.",
    "",
    "```telegram-file",
    "path: /tmp/example.txt",
    "filename: example.txt",
    "```",
  ].join("\n");

  const parsed = extractTelegramFileDirectives(source);
  assert.equal(parsed.text, source);
  assert.deepEqual(parsed.documents, []);
  assert.deepEqual(parsed.warnings, []);
});

test("extractTelegramFileDirectives ignores the legacy placeholder example even if action: send is present", () => {
  const source = [
    "Показываю старый пример.",
    "",
    "```telegram-file",
    "action: send",
    "path: <absolute-host-path-to-file>",
    "filename: optional-name.ext",
    "caption: optional caption",
    "```",
  ].join("\n");

  const parsed = extractTelegramFileDirectives(source);
  assert.equal(parsed.text, source);
  assert.deepEqual(parsed.documents, []);
  assert.deepEqual(parsed.warnings, []);
});

test("extractTelegramFileDirectives understands CRLF fenced blocks", () => {
  const source = [
    "Uploading artifact.",
    "",
    "```telegram-file",
    "action: send",
    "path: C:/Temp/report.txt",
    "filename: report.txt",
    "caption: Windows report",
    "```",
    "",
    "Check it here.",
  ].join("\r\n");

  const parsed = extractTelegramFileDirectives(source, { language: "eng" });
  assert.equal(parsed.text, "Uploading artifact.\n\nCheck it here.");
  assert.deepEqual(parsed.documents, [
    {
      filePath: "C:/Temp/report.txt",
      fileName: "report.txt",
      caption: "Windows report",
    },
  ]);
  assert.deepEqual(parsed.warnings, []);
});
