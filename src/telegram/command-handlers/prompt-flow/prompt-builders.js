import { extractPromptText } from "../../incoming-attachments.js";
import { extractBotCommand } from "../../command-parsing.js";

export function buildPromptFromMessages(messages, { bufferMode = "auto" } = {}) {
  void bufferMode;
  return messages
    .map((entry) => extractPromptText(entry, { trim: true }))
    .filter((entry) => entry.length > 0)
    .join("\n\n")
    .trim();
}

export function buildQueuedPromptFromMessages(messages, botUsername) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (promptMessages.length === 0) {
    return "";
  }

  const firstMessage = promptMessages[0];
  const parsedCommand = extractBotCommand(firstMessage, botUsername);
  if (parsedCommand?.name !== "q") {
    return buildPromptFromMessages(promptMessages);
  }

  const parts = [];
  const commandText = String(parsedCommand.args || "").trim();
  if (commandText) {
    parts.push(commandText);
  }

  for (const entry of promptMessages.slice(1)) {
    const text = extractPromptText(entry, { trim: true });
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n").trim();
}
