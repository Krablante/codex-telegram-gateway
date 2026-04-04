import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCodexLimitsMenuLines,
  buildCodexLimitsStatusLines,
  buildCodexLimitsSummary,
  CodexLimitsService,
  formatCodexLimitsMessage,
  normalizeLimitsSnapshot,
} from "../src/codex-runtime/limits.js";

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

test("normalizeLimitsSnapshot and render helpers treat unlimited Codex accounts as available", () => {
  const snapshot = {
    limit_id: "codex",
    plan_type: "business",
    credits: {
      has_credits: true,
      unlimited: true,
      balance: null,
    },
  };

  const normalized = normalizeLimitsSnapshot(snapshot);
  const summary = buildCodexLimitsSummary(snapshot, {
    capturedAt: "2026-04-04T13:00:00.000Z",
    source: "windows_rtx",
  });

  assert.equal(normalized.unlimited, true);
  assert.equal(summary.available, true);
  assert.equal(summary.unlimited, true);
  assert.equal(summary.planType, "business");
  assert.deepEqual(buildCodexLimitsStatusLines(summary, "rus"), [
    "лимиты: безлимит",
  ]);
  assert.deepEqual(buildCodexLimitsMenuLines(summary, "eng"), [
    "limits: unlimited",
  ]);
  assert.match(formatCodexLimitsMessage(summary, "rus"), /режим: безлимит/u);
  assert.match(formatCodexLimitsMessage(summary, "rus"), /план: business/u);
  assert.match(formatCodexLimitsMessage(summary, "eng"), /mode: unlimited/u);
});

test("buildCodexLimitsSummary renders remaining percentages for active windows", () => {
  const summary = buildCodexLimitsSummary({
    limit_id: "codex",
    primary: {
      used_percent: 16,
      window_minutes: 300,
      resets_at: 1772139094,
    },
    secondary: {
      used_percent: 80,
      window_minutes: 10080,
      resets_at: 1772307899,
    },
  });

  assert.equal(summary.available, true);
  assert.equal(summary.unlimited, false);
  assert.deepEqual(buildCodexLimitsMenuLines(summary, "eng"), [
    "limits 5h: 84% left",
    "limits 7d: 20% left",
  ]);
  assert.match(
    buildCodexLimitsStatusLines(summary, "rus")[0],
    /лимиты 5h: 84% осталось -> .*UTC/u,
  );
});

test("CodexLimitsService reads the newest unlimited snapshot from sessions root", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-limits-sessions-"),
  );
  const sessionsRoot = path.join(tempRoot, "sessions");
  const snapshotFile = path.join(
    sessionsRoot,
    "2026",
    "04",
    "04",
    "rollout.jsonl",
  );

  await writeJsonl(snapshotFile, [
    {
      timestamp: "2026-04-04T12:00:00.000Z",
      payload: {
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 22,
            window_minutes: 300,
            resets_at: 1775275200,
          },
          secondary: {
            used_percent: 41,
            window_minutes: 10080,
            resets_at: 1775880000,
          },
          credits: {
            has_credits: false,
            unlimited: false,
          },
        },
      },
    },
    {
      timestamp: "2026-04-04T12:05:00.000Z",
      payload: {
        rate_limits: {
          limit_id: "codex",
          plan_type: "business",
          credits: {
            has_credits: true,
            unlimited: true,
          },
        },
      },
    },
  ]);

  try {
    const service = new CodexLimitsService({
      sessionsRoot,
      cacheTtlMs: 1000,
    });
    const summary = await service.getSummary();

    assert.equal(summary.available, true);
    assert.equal(summary.unlimited, true);
    assert.equal(summary.planType, "business");
    assert.equal(summary.source, sessionsRoot);
    assert.equal(summary.capturedAt, "2026-04-04T12:05:00.000Z");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("CodexLimitsService accepts CODEX_LIMITS_COMMAND JSON wrapper payloads", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-limits-command-"),
  );
  const scriptPath = path.join(tempRoot, "read-limits.mjs");

  await fs.writeFile(
    scriptPath,
    [
      "console.log(JSON.stringify({",
      '  source: "windows_rtx",',
      '  captured_at: "2026-04-04T13:10:00.000Z",',
      "  snapshot: {",
      '    limit_id: "codex",',
      "    primary: { used_percent: 11, window_minutes: 300, resets_at: 1775277000 },",
      "    secondary: { used_percent: 33, window_minutes: 10080, resets_at: 1775881800 }",
      "  }",
      "}));",
    ].join("\n"),
    "utf8",
  );

  try {
    const service = new CodexLimitsService({
      command: `node ${scriptPath}`,
      cacheTtlMs: 1000,
      commandTimeoutMs: 5000,
    });
    const summary = await service.getSummary();

    assert.equal(summary.available, true);
    assert.equal(summary.unlimited, false);
    assert.equal(summary.source, "windows_rtx");
    assert.equal(summary.capturedAt, "2026-04-04T13:10:00.000Z");
    assert.deepEqual(buildCodexLimitsMenuLines(summary, "eng"), [
      "limits 5h: 89% left",
      "limits 7d: 67% left",
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("CodexLimitsService degrades to unavailable instead of throwing when the command fails", async () => {
  const service = new CodexLimitsService({
    command: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
    cacheTtlMs: 1000,
    commandTimeoutMs: 5000,
  });

  const summary = await service.getSummary();

  assert.equal(summary.available, false);
  assert.equal(summary.unlimited, false);
  assert.equal(summary.source, "command");
});
