import path from "node:path";

import { splitTelegramReply } from "../transport/telegram-reply-normalizer.js";
import {
  extractPromptText,
  hasIncomingAttachments,
  ingestIncomingAttachments,
} from "../telegram/incoming-attachments.js";
import {
  buildReplyMessageParams,
  extractBotCommand,
} from "../telegram/command-parsing.js";
import { startEmergencyExecRun } from "./exec-runner.js";

const PENDING_ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const EMERGENCY_INTERRUPT_GRACE_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDoneOrTimeout(donePromise, timeoutMs) {
  return Promise.race([
    Promise.resolve(donePromise).then(
      () => true,
      () => true,
    ),
    sleep(timeoutMs).then(() => false),
  ]);
}

function signalChildProcessGroup(child, signal) {
  if (!child) {
    return false;
  }

  if (Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {}
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function isAllowedPrivateChatMessage(message, config) {
  if (!message?.from || message.from.is_bot) {
    return false;
  }

  return (
    message.chat?.type === "private" &&
    String(message.from.id) === config.telegramAllowedUserId
  );
}

function buildEmergencyHelpMessage() {
  return [
    "Emergency mode",
    "",
    "This private chat bypasses the normal topic/session pipeline.",
    "It runs one isolated emergency repair task against the gateway repo via codex exec.",
    "",
    "Commands: /help, /status, /interrupt",
    "Anything else is treated as an emergency prompt.",
  ].join("\n");
}

function buildEmergencyStatusMessage(router) {
  const activeRun = router.activeRun;
  return [
    "Emergency status",
    "",
    `repo: ${router.config.repoRoot}`,
    `state_root: ${router.config.stateRoot}`,
    `run: ${activeRun ? "running" : "idle"}`,
    `normal_runs_active: ${router.getNormalRunCount()}`,
    `pending_attachments: ${router.pendingAttachments.length}`,
    activeRun?.startedAt ? `started_at: ${activeRun.startedAt}` : null,
  ].filter(Boolean).join("\n");
}

function buildEmergencyBusyMessage() {
  return [
    "Emergency run is already active.",
    "",
    "Wait for it to finish or use /interrupt.",
  ].join("\n");
}

function buildEmergencyNormalRunConflictMessage() {
  return [
    "Emergency mode is locked while normal topic runs are active.",
    "",
    "Wait for them to finish or interrupt them first, then retry here.",
  ].join("\n");
}

function buildEmergencyTopicLockMessage() {
  return [
    "Emergency repair is active in private chat.",
    "",
    "Use that chat until it finishes or interrupt it there first.",
  ].join("\n");
}

function buildEmergencyAttachmentMessage() {
  return [
    "Emergency attachment received.",
    "",
    "Add a caption in the same message, or send the task text in the next message here and I will pair it with this attachment.",
  ].join("\n");
}

function buildEmergencyStartedMessage() {
  return [
    "Emergency run started.",
    "",
    "This path uses isolated codex exec fallback mode.",
  ].join("\n");
}

function buildEmergencyInterruptedMessage(interrupted) {
  return interrupted
    ? "Emergency run interrupted."
    : "There is no active emergency run.";
}

function buildEmergencyFailureMessage(result) {
  const detail =
    result.finalReply ||
    result.stderr ||
    result.stdout ||
    `codex exec failed (code=${result.exitCode ?? "null"}, signal=${result.signal ?? "null"})`;

  return [
    "Emergency run failed.",
    "",
    detail.trim(),
  ].join("\n");
}

function getAttachmentIdentity(attachment) {
  return (
    attachment?.telegram_file_unique_id ||
    attachment?.telegram_file_id ||
    attachment?.file_path ||
    null
  );
}

function mergeAttachments(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();

  for (const attachment of [...existing, ...incoming]) {
    const identity = getAttachmentIdentity(attachment);
    if (identity && seen.has(identity)) {
      continue;
    }
    if (identity) {
      seen.add(identity);
    }
    merged.push(attachment);
  }

  return merged;
}

function formatAttachmentForPrompt(attachment) {
  const detailParts = [];
  if (attachment.mime_type) {
    detailParts.push(attachment.mime_type);
  }
  if (Number.isInteger(attachment.size_bytes)) {
    detailParts.push(`${attachment.size_bytes} bytes`);
  }

  const typeLabel = attachment.is_image ? "image" : "file";
  const details = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
  return `- ${typeLabel}: ${attachment.file_path}${details}`;
}

function buildPromptWithAttachments(prompt, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return String(prompt || "").trim();
  }

  return [
    "Emergency attachments are included with this message. Use them as part of the context.",
    ...attachments.map(formatAttachmentForPrompt),
    "",
    String(prompt || "").trim(),
  ].join("\n");
}

async function defaultIngestEmergencyAttachments(api, config, message) {
  return ingestIncomingAttachments({
    api,
    message,
    session: {
      chat_id: String(message.chat.id),
      topic_id: "private",
      ui_language: "eng",
    },
    sessionStore: {
      getSessionDir(chatId, topicId) {
        return path.join(
          config.stateRoot,
          "emergency",
          "attachments",
          String(chatId),
          String(topicId),
        );
      },
    },
  });
}

export class EmergencyPrivateChatRouter {
  constructor({
    api,
    config,
    botUsername = null,
    startRun = startEmergencyExecRun,
    ingestAttachments = defaultIngestEmergencyAttachments,
    normalRunState = {
      hasActiveRuns: () => false,
      getRunCount: () => 0,
    },
    now = () => Date.now(),
  }) {
    this.api = api;
    this.config = config;
    this.botUsername = botUsername;
    this.startRun = startRun;
    this.ingestAttachments = ingestAttachments;
    this.normalRunState = normalRunState;
    this.now = now;
    this.activeRun = null;
    this.pendingAttachments = [];
    this.pendingAttachmentsExpireAt = 0;
  }

  isActive() {
    return Boolean(this.activeRun);
  }

  getNormalRunCount() {
    return Number(this.normalRunState?.getRunCount?.() || 0);
  }

  hasConflictingNormalRuns() {
    return Boolean(this.normalRunState?.hasActiveRuns?.());
  }

  clearExpiredPendingAttachments() {
    if (
      this.pendingAttachments.length > 0 &&
      this.pendingAttachmentsExpireAt > 0 &&
      this.pendingAttachmentsExpireAt <= this.now()
    ) {
      this.pendingAttachments = [];
      this.pendingAttachmentsExpireAt = 0;
    }
  }

  async reply(message, text) {
    const chunks = splitTelegramReply(text);
    if (chunks.length === 0) {
      return;
    }

    for (const chunk of chunks) {
      await this.api.sendMessage({
        ...buildReplyMessageParams(message, chunk),
        parse_mode: "HTML",
      });
    }
  }

  async safeReply(message, text) {
    try {
      await this.reply(message, text);
      return true;
    } catch (error) {
      console.warn(`emergency reply failed: ${error.message}`);
      return false;
    }
  }

  clearPendingAttachments() {
    this.pendingAttachments = [];
    this.pendingAttachmentsExpireAt = 0;
  }

  async handleFailure(message, error, {
    heading = "Emergency run failed.",
    clearPending = true,
  } = {}) {
    if (clearPending) {
      this.clearPendingAttachments();
    }

    if (this.activeRun) {
      return;
    }

    await this.safeReply(
      message,
      [heading, "", `Error: ${error.message}`].join("\n"),
    );
  }

  async handleCompetingTopicMessage(message) {
    if (!this.isActive()) {
      return { handled: false, reason: "emergency-idle" };
    }

    if (!message?.from || message.from.is_bot) {
      return { handled: false, reason: "emergency-non-user-message" };
    }

    const isOperatorForumMessage =
      String(message.from.id) === this.config.telegramAllowedUserId &&
      String(message.chat?.id) === this.config.telegramForumChatId;
    if (!isOperatorForumMessage) {
      return { handled: false, reason: "not-emergency-competing-message" };
    }

    if (extractBotCommand(message, this.botUsername)) {
      return { handled: false, reason: "not-emergency-topic-command" };
    }

    if (!extractPromptText(message, { trim: false }) && !hasIncomingAttachments(message)) {
      return { handled: false, reason: "not-emergency-topic-prompt" };
    }

    await this.safeReply(message, buildEmergencyTopicLockMessage());
    return { handled: true, reason: "emergency-topic-locked" };
  }

  async handleMessage(message) {
    if (!isAllowedPrivateChatMessage(message, this.config)) {
      return { handled: false, reason: "not-emergency-private-chat" };
    }

    this.clearExpiredPendingAttachments();
    try {
      const command = extractBotCommand(message, this.botUsername);
      if (command) {
        this.clearPendingAttachments();

        if (command.name === "help") {
          await this.safeReply(message, buildEmergencyHelpMessage());
          return { handled: true, reason: "emergency-help" };
        }

        if (command.name === "status") {
          await this.safeReply(message, buildEmergencyStatusMessage(this));
          return { handled: true, reason: "emergency-status" };
        }

        if (command.name === "interrupt") {
          const interrupted = this.interrupt();
          await this.safeReply(message, buildEmergencyInterruptedMessage(interrupted));
          return { handled: true, reason: interrupted ? "emergency-interrupted" : "emergency-idle" };
        }

        await this.safeReply(message, buildEmergencyHelpMessage());
        return { handled: true, reason: "emergency-help-fallback" };
      }

      if (this.activeRun) {
        await this.safeReply(message, buildEmergencyBusyMessage());
        return { handled: true, reason: "emergency-busy" };
      }

      if (this.hasConflictingNormalRuns()) {
        await this.safeReply(message, buildEmergencyNormalRunConflictMessage());
        return {
          handled: true,
          reason: "emergency-normal-runs-active",
        };
      }

      const prompt = extractPromptText(message, { trim: true });
      if (!prompt) {
        if (hasIncomingAttachments(message)) {
          const attachments = await this.ingestAttachments(
            this.api,
            this.config,
            message,
          );
          this.pendingAttachments = mergeAttachments(
            this.pendingAttachments,
            attachments,
          );
          this.pendingAttachmentsExpireAt = this.now() + PENDING_ATTACHMENT_TTL_MS;
          await this.safeReply(message, buildEmergencyAttachmentMessage());
          return { handled: true, reason: "emergency-attachment-buffered" };
        }

        return { handled: true, reason: "emergency-empty-message" };
      }

      const attachments = [...this.pendingAttachments];
      if (hasIncomingAttachments(message)) {
        attachments.splice(
          0,
          attachments.length,
          ...mergeAttachments(
            attachments,
            await this.ingestAttachments(this.api, this.config, message),
          ),
        );
      }

      const imagePaths = attachments
        .filter((attachment) => attachment?.is_image && attachment?.file_path)
        .map((attachment) => attachment.file_path);
      const finalPrompt = buildPromptWithAttachments(prompt, attachments);
      const run = this.startRun({
        codexBinPath: this.config.codexBinPath,
        repoRoot: this.config.repoRoot,
        stateRoot: this.config.stateRoot,
        prompt: finalPrompt,
        imagePaths,
      });

      this.clearPendingAttachments();
      const typingTimer = setInterval(() => {
        void this.api.sendChatAction({
          chat_id: message.chat.id,
          action: "typing",
        }).catch(() => {});
      }, 4000);
      typingTimer.unref();

      const activeRun = {
        child: run.child,
        done: run.done,
        finalizePromise: null,
        startedAt: new Date(this.now()).toISOString(),
        typingTimer,
      };
      activeRun.finalizePromise = run.done
        .then(async (result) => {
          if (this.activeRun === activeRun) {
            this.activeRun = null;
          }
          clearInterval(typingTimer);
          if (result.interrupted) {
            await this.safeReply(message, "Emergency run interrupted.");
            return;
          }

          if (result.ok) {
            await this.safeReply(
              message,
              result.finalReply || "Emergency run finished, but Codex returned no final reply.",
            );
            return;
          }

          await this.safeReply(message, buildEmergencyFailureMessage(result));
        })
        .catch(async (error) => {
          if (this.activeRun === activeRun) {
            this.activeRun = null;
          }
          clearInterval(typingTimer);
          await this.safeReply(
            message,
            ["Emergency run failed.", "", error.message].join("\n"),
          );
        });
      this.activeRun = activeRun;

      await this.safeReply(message, buildEmergencyStartedMessage());
      return { handled: true, reason: "emergency-started" };
    } catch (error) {
      await this.handleFailure(message, error, {
        heading: "Emergency request failed before the run could start cleanly.",
      });
      return { handled: true, reason: "emergency-error" };
    }
  }

  interrupt() {
    const child = this.activeRun?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }

    signalChildProcessGroup(child, "SIGTERM");
    const activeRun = this.activeRun;
    setTimeout(() => {
      if (this.activeRun === activeRun) {
        signalChildProcessGroup(child, "SIGKILL");
      }
    }, EMERGENCY_INTERRUPT_GRACE_MS).unref();
    return true;
  }

  async shutdown() {
    this.clearPendingAttachments();
    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }

    this.interrupt();
    const finishedAfterTerm = await waitForDoneOrTimeout(
      activeRun.done,
      EMERGENCY_INTERRUPT_GRACE_MS,
    );
    if (finishedAfterTerm) {
      return;
    }

    if (this.activeRun === activeRun) {
      signalChildProcessGroup(activeRun.child, "SIGKILL");
      const finishedAfterKill = await waitForDoneOrTimeout(
        activeRun.done,
        EMERGENCY_INTERRUPT_GRACE_MS,
      );
      if (!finishedAfterKill && this.activeRun === activeRun) {
        clearInterval(activeRun.typingTimer);
        this.activeRun = null;
        console.warn("emergency shutdown timed out waiting for codex exec to exit");
      }
    }
  }
}
