import path from "node:path";

import {
  WORK_STYLE_HEADING,
  normalizePromptSuffixText,
} from "./prompt-suffix.js";
import { buildTelegramFileDirectiveInstructions } from "../transport/telegram-file-directive.js";

export const TOPIC_CONTEXT_FILE_NAME = "telegram-topic-context.md";

function formatTopicName(session) {
  return session?.topic_name ?? "unknown";
}

function normalizePosixPath(input) {
  return String(input || "").replace(/\\/gu, path.posix.sep);
}

function isWindowsStylePath(input) {
  return /^[A-Za-z]:[\\/]/u.test(String(input || ""))
    || /^\\\\/u.test(String(input || ""));
}

function isContainedRelativePath(relativePath, pathModule) {
  return relativePath === ""
    || (
      !relativePath.startsWith("..")
      && !pathModule.isAbsolute(relativePath)
    );
}

function resolveContainerMirrorPath(session, hostPath) {
  const hostRoot = String(session?.workspace_binding?.workspace_root || "").trim();
  const normalizedHostPath = String(hostPath || "").trim();
  if (!hostRoot || !normalizedHostPath) {
    return null;
  }

  if (isWindowsStylePath(hostRoot) || isWindowsStylePath(normalizedHostPath)) {
    const normalizedHostRoot = path.win32.normalize(hostRoot);
    const normalizedTarget = path.win32.normalize(normalizedHostPath);
    const relative = path.win32.relative(normalizedHostRoot, normalizedTarget);
    if (!isContainedRelativePath(relative, path.win32)) {
      return null;
    }

    const rootName = path.win32.basename(normalizedHostRoot).toLowerCase();
    if (!rootName) {
      return null;
    }

    return relative
      ? path.posix.join("/workspace", rootName, normalizePosixPath(relative))
      : path.posix.join("/workspace", rootName);
  }

  const normalizedHostRoot = normalizePosixPath(hostRoot);
  const normalizedTarget = normalizePosixPath(normalizedHostPath);
  const relative = path.posix.relative(normalizedHostRoot, normalizedTarget);
  if (!isContainedRelativePath(relative, path.posix)) {
    return null;
  }

  const rootName = path.posix.basename(normalizedHostRoot);
  if (!rootName) {
    return null;
  }

  return relative
    ? path.posix.join("/workspace", rootName, relative)
    : path.posix.join("/workspace", rootName);
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function formatRootList(roots = []) {
  return roots
    .map((value) => normalizeOptionalText(value))
    .filter(Boolean)
    .join("; ");
}

function buildTopicContextLines(session, topicContextPath = null) {
  const hostWorkspaceRoot = session.workspace_binding?.workspace_root ?? null;
  const containerWorkspaceRoot = resolveContainerMirrorPath(session, hostWorkspaceRoot);
  const containerCwd = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.cwd ?? null,
  );
  const lines = [
    "# Telegram topic context",
    "",
    "The live user-turn prompt stays small.",
    "Thread developer instructions carry the short Telegram routing contract.",
    "Read this file only when you need fuller routing or file-delivery detail.",
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${session.chat_id}`,
    `topic_id: ${session.topic_id}`,
    `topic_name: ${formatTopicName(session)}`,
    `execution_host_id: ${session.execution_host_id ?? "unknown"}`,
    `cwd: ${session.workspace_binding?.cwd ?? "unknown"}`,
  ];

  if (topicContextPath) {
    lines.push(`topic_context_file: ${topicContextPath}`);
  }

  lines.push(
    "",
    "Routing rules:",
    "- This Telegram topic is the current conversation and default delivery target.",
    '- If the user says "this topic", "here", "сюда", or "в этот топик", they mean this topic.',
    "- Do not ask to reconfirm the topic unless the user explicitly requests a different destination.",
    "- Do not call the raw Telegram Bot API directly for normal delivery from Codex.",
    "- For telegram-file, path: must resolve on the bound execution host, not on the Telegram control-plane host.",
    "- These file-delivery roots apply only to telegram-file sends; they are not a general filesystem sandbox.",
    "- Telegram file delivery is allowed only from the current worktree or this session state directory.",
    "- If you need some other host file, copy it into one of those locations first, then send it.",
    ...(hostWorkspaceRoot && containerWorkspaceRoot
      ? [
          "",
          "MCP path mapping:",
          `- Host workspace root: ${hostWorkspaceRoot}`,
          `- Container-backed MCP mirror root: ${containerWorkspaceRoot}`,
          ...(containerCwd
            ? [`- Current cwd inside container-backed MCP tools: ${containerCwd}`]
            : []),
          "- For pitlane, translate host workspace paths into the /workspace/... mirror before calling the tool.",
        ]
      : []),
    "",
    "File delivery:",
    ...buildTelegramFileDirectiveInstructions(),
    "",
  );

  return lines;
}

export function buildTopicContextFileText(session, { topicContextPath = null } = {}) {
  return `${buildTopicContextLines(session, topicContextPath).join("\n")}\n`;
}

export function buildTopicDeveloperInstructions(
  session,
  {
    topicContextPath = null,
    executionCwd = null,
    fileDeliveryRoots = [],
    topicContextFileOnControlPlane = false,
    workStyleText = null,
  } = {},
) {
  const containerWorkspaceRoot = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.workspace_root ?? null,
  );
  const containerCwd = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.cwd ?? null,
  );
  const normalizedExecutionCwd =
    normalizeOptionalText(executionCwd)
    || session.workspace_binding?.cwd
    || "unknown";
  const topicId = session.topic_id ?? "unknown";
  const sessionKey = session.session_key ?? "unknown";
  const boundHost = session.execution_host_id ?? "unknown";
  const formattedDeliveryRoots = formatRootList(fileDeliveryRoots);
  const baseLines = [
    "Context:",
    `You are operating inside Telegram topic ${topicId} (${sessionKey}). Treat "this topic", "here", "сюда", and "в этот топик" as this Telegram topic.`,
    "",
    "Runtime:",
    `- bound host: ${boundHost}`,
    `- workspace cwd: ${normalizedExecutionCwd}`,
    "- if the bound host is unavailable, say so; do not silently rebind to another host.",
    ...(containerWorkspaceRoot
      ? [
          `- for container-backed MCP use the workspace mirror root: ${containerWorkspaceRoot}`,
        ]
      : []),
    ...(containerCwd && containerCwd !== containerWorkspaceRoot
      ? [`- current cwd inside container-backed MCP tools: ${containerCwd}`]
      : []),
    "",
    "Telegram delivery:",
    "- keep Telegram as the delivery surface unless the user explicitly asks for another channel.",
    "- during long or multi-step work, write short natural-language progress notes; do not expose hidden chain-of-thought.",
    "- send files back to this topic unless the user says otherwise.",
    `- telegram-file paths must be absolute paths on the bound host ${boundHost}, not on the Telegram control-plane host.`,
    ...(formattedDeliveryRoots
      ? [`- allowed telegram-file send roots: ${formattedDeliveryRoots}`]
      : []),
    "",
    "Extra context:",
    ...(topicContextFileOnControlPlane
      ? [
          "- topic context file stays on the Telegram control-plane host for this remote run; rely on the inline rules above unless you need extra routing or file-send detail.",
        ]
      : []),
    ...(!topicContextFileOnControlPlane && topicContextPath
      ? [
          `- topic context file: ${topicContextPath}`,
          "- read the topic context file only when you need extra routing, delivery, or continuity details.",
        ]
      : []),
  ];
  const normalizedWorkStyle = normalizePromptSuffixText(workStyleText);
  if (normalizedWorkStyle) {
    baseLines.push("", WORK_STYLE_HEADING, normalizedWorkStyle);
  }

  return baseLines.join("\n");
}

export function buildTopicContextPrompt(session, options = {}) {
  return buildTopicDeveloperInstructions(session, options);
}
