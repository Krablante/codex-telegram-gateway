import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { ensureStateLayout } from "../state/layout.js";
import { SessionAdmin, buildSessionCounts } from "../session-manager/session-admin.js";
import { SessionStore } from "../session-manager/session-store.js";

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

function parseIntegerFlag(name, value) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Expected ${name} to be a positive integer, got: ${value}`);
  }

  return Number(value);
}

function parseSelector(args) {
  if (args.length === 1 && args[0].includes(":")) {
    const [chatId, topicId] = args[0].split(":");
    if (!chatId || !topicId) {
      throw new Error("Expected selector as <chat_id>:<topic_id>");
    }

    return { chatId, topicId };
  }

  if (args.length >= 2) {
    return {
      chatId: args[0],
      topicId: args[1],
    };
  }

  throw new Error("Expected <chat_id> <topic_id> or <chat_id>:<topic_id>");
}

function parseAdminArgs(argv) {
  const options = {
    command: argv[0] || "status",
    args: [],
    json: false,
    state: null,
    limit: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token === "--state") {
      index += 1;
      options.state = argv[index] || null;
      continue;
    }

    if (token.startsWith("--state=")) {
      options.state = token.slice("--state=".length) || null;
      continue;
    }

    if (token === "--limit") {
      index += 1;
      options.limit = parseIntegerFlag("--limit", argv[index] || "");
      continue;
    }

    if (token.startsWith("--limit=")) {
      options.limit = parseIntegerFlag(
        "--limit",
        token.slice("--limit=".length),
      );
      continue;
    }

    options.args.push(token);
  }

  return options;
}

async function readJsonIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function createCliRuntimeObserver({ logsDir, config }) {
  return new RuntimeObserver({
    logsDir,
    config,
    serviceState: {
      startedAt: null,
      botId: null,
      botUsername: null,
      handledUpdates: 0,
      ignoredUpdates: 0,
      handledCommands: 0,
      acceptedPrompts: 0,
      pollErrors: 0,
      knownSessions: 0,
      activeRunCount: 0,
      lastUpdateId: null,
      lastCommandName: null,
      lastCommandAt: null,
      lastPromptAt: null,
      bootstrapDroppedUpdateId: null,
    },
    probe: {
      me: {
        first_name: null,
      },
    },
    mode: "admin",
  });
}

function formatSessionLine(session) {
  const parts = [
    session.session_key,
    `[${session.lifecycle_state}]`,
    `updated=${session.updated_at || "unknown"}`,
  ];

  if (session.topic_name) {
    parts.push(`topic=${JSON.stringify(session.topic_name)}`);
  }
  if (session.retention_pin) {
    parts.push("pinned=true");
  }
  if (session.purge_after) {
    parts.push(`purge_after=${session.purge_after}`);
  }
  if (session.workspace_binding?.cwd) {
    parts.push(`cwd=${session.workspace_binding.cwd}`);
  }

  return parts.join(" ");
}

function buildStatusReport({ heartbeat, counts, config }) {
  return {
    heartbeat: heartbeat
      ? {
          observed_at: heartbeat.observed_at,
          lifecycle_state: heartbeat.lifecycle_state,
          active_run_count: heartbeat.service_state?.active_run_count ?? null,
          last_update_id: heartbeat.service_state?.last_update_id ?? null,
          last_command_name: heartbeat.service_state?.last_command_name ?? null,
          mode: heartbeat.mode ?? null,
        }
      : null,
    codex: {
      bin_path: config.codexBinPath,
      config_path: config.codexConfigPath,
      mcp_servers: Array.isArray(config.codexMcpServerNames)
        ? config.codexMcpServerNames
        : [],
    },
    sessions: counts,
  };
}

async function runStatus({ sessionAdmin, layout, config, json }) {
  const sessions = await sessionAdmin.listSessions();
  const counts = buildSessionCounts(sessions);
  const heartbeat = await readJsonIfExists(
    path.join(layout.logs, "runtime-heartbeat.json"),
  );
  const report = buildStatusReport({ heartbeat, counts, config });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printLine(
    "service_state",
    heartbeat?.lifecycle_state || "unknown",
  );
  printLine(
    "heartbeat_observed_at",
    heartbeat?.observed_at || "missing",
  );
  printLine(
    "active_run_count",
    String(heartbeat?.service_state?.active_run_count ?? 0),
  );
  printLine(
    "last_update_id",
    heartbeat?.service_state?.last_update_id ?? "none",
  );
  printLine("codex_bin_path", config.codexBinPath || "unknown");
  printLine("codex_config_path", config.codexConfigPath || "unknown");
  printLine(
    "codex_mcp_servers",
    Array.isArray(config.codexMcpServerNames) && config.codexMcpServerNames.length > 0
      ? config.codexMcpServerNames.join(",")
      : "none",
  );
  printLine("sessions_total", counts.total);
  printLine("sessions_active", counts.active);
  printLine("sessions_parked", counts.parked);
  printLine("sessions_purged", counts.purged);
  printLine("sessions_pinned", counts.pinned);
}

async function runSessions({ sessionAdmin, state, limit, json }) {
  const sessions = await sessionAdmin.listSessions({ state });
  const limited = Number.isInteger(limit) ? sessions.slice(0, limit) : sessions;

  if (json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log("no sessions");
    return;
  }

  for (const session of limited) {
    console.log(formatSessionLine(session));
  }
}

async function runShow({ sessionAdmin, args, json }) {
  const { chatId, topicId } = parseSelector(args);
  const session = await sessionAdmin.getSession(chatId, topicId);

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(JSON.stringify(session, null, 2));
}

async function runMutation({ sessionAdmin, command, args, json }) {
  const { chatId, topicId } = parseSelector(args);
  let session = null;

  if (command === "pin") {
    session = await sessionAdmin.setRetentionPin(
      chatId,
      topicId,
      true,
      "admin/pin",
    );
  } else if (command === "unpin") {
    session = await sessionAdmin.setRetentionPin(
      chatId,
      topicId,
      false,
      "admin/unpin",
    );
  } else if (command === "reactivate") {
    session = await sessionAdmin.reactivateSession(chatId, topicId);
  } else if (command === "purge") {
    session = await sessionAdmin.purgeSession(chatId, topicId);
  } else {
    throw new Error(`Unsupported admin command: ${command}`);
  }

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  printLine("session_key", session.session_key);
  printLine("lifecycle_state", session.lifecycle_state);
  printLine("retention_pin", String(Boolean(session.retention_pin)));
  printLine("purge_after", session.purge_after ?? "none");
}

async function main() {
  const parsed = parseAdminArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const sessionStore = new SessionStore(layout.sessions);
  const sessionAdmin = new SessionAdmin({
    sessionStore,
    config,
    runtimeObserver: createCliRuntimeObserver({
      logsDir: layout.logs,
      config,
    }),
  });

  if (parsed.command === "status") {
    await runStatus({
      sessionAdmin,
      layout,
      config,
      json: parsed.json,
    });
    return;
  }

  if (parsed.command === "sessions") {
    await runSessions({
      sessionAdmin,
      state: parsed.state,
      limit: parsed.limit,
      json: parsed.json,
    });
    return;
  }

  if (parsed.command === "show") {
    await runShow({
      sessionAdmin,
      args: parsed.args,
      json: parsed.json,
    });
    return;
  }

  if (
    parsed.command === "pin" ||
    parsed.command === "unpin" ||
    parsed.command === "reactivate" ||
    parsed.command === "purge"
  ) {
    await runMutation({
      sessionAdmin,
      command: parsed.command,
      args: parsed.args,
      json: parsed.json,
    });
    return;
  }

  throw new Error(`Unknown admin command: ${parsed.command}`);
}

main().catch((error) => {
  console.error(`admin failed: ${error.message}`);
  process.exitCode = 1;
});
