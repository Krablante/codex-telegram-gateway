import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(cloneJson(value), null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function buildEvent(type, details = {}) {
  return {
    timestamp: new Date().toISOString(),
    type,
    pid: process.pid,
    ...cloneJson(details),
  };
}

export class RuntimeObserver {
  constructor({
    logsDir,
    config,
    serviceState,
    probe,
    mode,
    heartbeatFileName = "runtime-heartbeat.json",
    eventsFileName = "runtime-events.ndjson",
  }) {
    this.logsDir = logsDir;
    this.config = config;
    this.serviceState = serviceState;
    this.probe = probe;
    this.mode = mode;
    this.lifecycleState = "starting";
    this.currentOffset = null;
    this.lastRetentionSweepAt = null;
    this.lastErrorMessage = null;
    this.heartbeatPath = path.join(logsDir, heartbeatFileName);
    this.eventsPath = path.join(logsDir, eventsFileName);
  }

  buildHeartbeat({ observedAt = new Date().toISOString() } = {}) {
    return {
      observed_at: observedAt,
      pid: process.pid,
      lifecycle_state: this.lifecycleState,
      mode: this.mode,
      env_file: this.config.envFilePath,
      repo_root: this.config.repoRoot,
      state_root: this.config.stateRoot,
      forum_chat_id: this.config.telegramForumChatId,
      bot: {
        id: this.serviceState.botId,
        username: this.serviceState.botUsername,
        first_name: this.probe.me.first_name || null,
      },
      service_state: {
        started_at: this.serviceState.startedAt,
        handled_updates: this.serviceState.handledUpdates,
        ignored_updates: this.serviceState.ignoredUpdates,
        handled_commands: this.serviceState.handledCommands,
        accepted_prompts: this.serviceState.acceptedPrompts,
        poll_errors: this.serviceState.pollErrors,
        known_sessions: this.serviceState.knownSessions,
        active_run_count: this.serviceState.activeRunCount,
        last_update_id: this.serviceState.lastUpdateId,
        last_command_name: this.serviceState.lastCommandName,
        last_command_at: this.serviceState.lastCommandAt,
        last_prompt_at: this.serviceState.lastPromptAt,
        bootstrap_dropped_update_id: this.serviceState.bootstrapDroppedUpdateId,
      },
      polling: {
        current_offset: this.currentOffset,
        last_retention_sweep_at: this.lastRetentionSweepAt,
      },
      last_error_message: this.lastErrorMessage,
    };
  }

  async appendEvent(type, details = {}) {
    await fs.mkdir(this.logsDir, { recursive: true });
    await fs.appendFile(
      this.eventsPath,
      `${JSON.stringify(buildEvent(type, details))}\n`,
      "utf8",
    );
  }

  async writeHeartbeat() {
    const observedAt = new Date().toISOString();
    const heartbeat = this.buildHeartbeat({ observedAt });
    await writeJsonAtomic(this.heartbeatPath, heartbeat);
    return heartbeat;
  }

  async start({ currentOffset = null }) {
    this.currentOffset = currentOffset;
    this.lifecycleState = "running";
    await this.writeHeartbeat();
    await this.appendEvent("service.started", {
      current_offset: currentOffset,
      mode: this.mode,
      env_file: this.config.envFilePath,
    });
  }

  async noteBootstrapDrop(updateId) {
    await this.appendEvent("updates.bootstrap_drop", {
      update_id: updateId,
    });
    await this.writeHeartbeat();
  }

  async noteUpdateFailure(updateId, error) {
    this.lastErrorMessage = error.message;
    await this.appendEvent("update.failed", {
      update_id: updateId,
      error: error.message,
    });
    await this.writeHeartbeat();
  }

  async notePollError(error) {
    this.lastErrorMessage = error.message;
    await this.appendEvent("poll.error", {
      error: error.message,
      poll_errors: this.serviceState.pollErrors,
    });
    await this.writeHeartbeat();
  }

  async noteRetentionSweep(sweptAt) {
    this.lastRetentionSweepAt = sweptAt;
    await this.writeHeartbeat();
  }

  async noteSessionLifecycle({
    action,
    session,
    reason = null,
    previousState = null,
    nextState = null,
    trigger = null,
  }) {
    await this.appendEvent("session.lifecycle", {
      action,
      reason,
      trigger,
      previous_state: previousState,
      next_state: nextState,
      session_key: session?.session_key || null,
      chat_id: session?.chat_id || null,
      topic_id: session?.topic_id || null,
      topic_name: session?.topic_name || null,
    });
  }

  async noteOffset(offset) {
    this.currentOffset = offset;
    await this.writeHeartbeat();
  }

  async stop({ status = "stopped", error = null } = {}) {
    this.lifecycleState = status;
    if (error) {
      this.lastErrorMessage = error.message;
    }
    await this.writeHeartbeat();
    await this.appendEvent(
      status === "failed" ? "service.failed" : "service.stopped",
      {
        error: error?.message || null,
      },
    );
  }
}
