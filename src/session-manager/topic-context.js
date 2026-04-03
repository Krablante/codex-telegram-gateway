import { buildTelegramFileDirectiveInstructions } from "../transport/telegram-file-directive.js";

export const TOPIC_CONTEXT_FILE_NAME = "telegram-topic-context.md";

function formatTopicName(session) {
  return session?.topic_name ?? "unknown";
}

function buildTopicContextLines(session, topicContextPath = null) {
  const lines = [
    "# Telegram topic context",
    "",
    "The live run prompt carries only a short Telegram routing stub.",
    "Read this file only when you need the fuller routing or file-delivery contract.",
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${session.chat_id}`,
    `topic_id: ${session.topic_id}`,
    `topic_name: ${formatTopicName(session)}`,
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
    "- File delivery is allowed only from the current worktree, this session state directory, or /tmp.",
    "- If you need some other host file, copy it into one of those locations first, then send it.",
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

export function buildTopicContextPrompt(session, { topicContextPath = null } = {}) {
  return [
    "Telegram topic routing context:",
    `- topic_id: ${session.topic_id}`,
    `- cwd: ${session.workspace_binding?.cwd ?? "unknown"}`,
    "- Default delivery target is this current Telegram topic.",
    '- Words like "this topic", "here", "сюда", or "в этот топик" mean this topic.',
    ...(topicContextPath
      ? [
          `- topic_context_file: ${topicContextPath}`,
          "- Read topic_context_file only if you need routing or file-send details.",
        ]
      : []),
  ].join("\n");
}
