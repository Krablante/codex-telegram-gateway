import path from "node:path";
import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { auditSystemdUserGateway } from "../runtime/systemd-user-doctor.js";
import { writeTextAtomic } from "../state/file-utils.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { runTelegramProbe } from "../telegram/probe.js";

function printSummaryLine(label, value) {
  console.log(`${label}: ${value}`);
}

async function writeDoctorSnapshot(logsDir, report) {
  const outputPath = path.join(logsDir, "doctor-last-run.json");
  await writeTextAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

async function main() {
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const probe = await runTelegramProbe(config, api);
  const { me, chat, membership, webhookInfo } = probe;
  const systemdUser = await auditSystemdUserGateway({ config });

  const report = {
    checked_at: new Date().toISOString(),
    env_file: config.envFilePath,
    repo_root: config.repoRoot,
    state_root: config.stateRoot,
    operator: {
      allowed_user_id: config.telegramAllowedUserId,
      allowed_user_ids: config.telegramAllowedUserIds,
      forum_chat_id: config.telegramForumChatId,
      expected_topics: config.telegramExpectedTopics,
    },
    bot: {
      id: String(me.id),
      username: me.username || null,
      first_name: me.first_name || null,
      can_read_all_group_messages: Boolean(me.can_read_all_group_messages),
      has_topics_enabled: Boolean(me.has_topics_enabled),
    },
    forum_chat: {
      id: String(chat.id),
      title: chat.title || null,
      type: chat.type,
      is_forum: Boolean(chat.is_forum),
    },
    bot_membership: {
      status: membership.status,
      can_manage_topics: Boolean(membership.can_manage_topics),
      can_delete_messages: Boolean(membership.can_delete_messages),
    },
    webhook: {
      url: webhookInfo.url || "",
      pending_update_count: webhookInfo.pending_update_count || 0,
      allowed_updates: webhookInfo.allowed_updates || [],
    },
    systemd_user: systemdUser,
  };

  const snapshotPath = await writeDoctorSnapshot(layout.logs, report);
  const failures = [];
  if (systemdUser.supported) {
    if (systemdUser.main_unit.installed && systemdUser.main_unit.fresh === false) {
      failures.push(
        `systemd unit is stale: ${systemdUser.main_unit.mismatches.join(", ") || systemdUser.main_unit.error || "unknown mismatch"}`,
      );
    }
    if (systemdUser.stale_units.length > 0) {
      failures.push(
        `stale systemd units: ${systemdUser.stale_units
          .map((unit) => `${unit.name} (${unit.reasons.join(", ")})`)
          .join("; ")}`,
      );
    }
  }

  printSummaryLine("doctor", failures.length > 0 ? "failed" : "ok");
  printSummaryLine("env_file", config.envFilePath);
  printSummaryLine("bot", `${me.first_name} (@${me.username || "no-username"})`);
  printSummaryLine("forum_chat", `${chat.title} [${chat.id}]`);
  printSummaryLine("forum_enabled", String(Boolean(chat.is_forum)));
  printSummaryLine("bot_membership", membership.status);
  printSummaryLine("webhook_url", webhookInfo.url || "(none)");
  if (systemdUser.supported) {
    printSummaryLine(
      "systemd_unit",
      systemdUser.main_unit.installed
        ? `installed fresh=${String(systemdUser.main_unit.fresh)}`
        : "not-installed",
    );
    printSummaryLine(
      "stale_systemd_units",
      systemdUser.stale_units.length
        ? systemdUser.stale_units.map((unit) => unit.name).join(", ")
        : "none",
    );
  }
  printSummaryLine(
    "expected_topics",
    config.telegramExpectedTopics.length
      ? config.telegramExpectedTopics.join(", ")
      : "none",
  );
  printSummaryLine("snapshot", snapshotPath);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`doctor check failed: ${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`doctor failed: ${error.message}`);
  process.exitCode = 1;
});
