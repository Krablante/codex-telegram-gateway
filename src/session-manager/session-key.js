function normalizeId(value, label) {
  const normalized = String(value);
  if (!/^-?\d+$/u.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer-like value, got: ${value}`);
  }

  return normalized;
}

export function getTopicIdFromMessage(message) {
  return Number.isInteger(message?.message_thread_id)
    ? String(message.message_thread_id)
    : null;
}

export function getSessionKey(chatId, topicId) {
  return `${normalizeId(chatId, "chat_id")}:${normalizeId(topicId, "topic_id")}`;
}

export function normalizeSessionIds(chatId, topicId) {
  return {
    chatId: normalizeId(chatId, "chat_id"),
    topicId: normalizeId(topicId, "topic_id"),
  };
}
