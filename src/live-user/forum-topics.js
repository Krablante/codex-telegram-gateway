function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

// In MTProto forum topics, `id` is the stable Bot API thread id. `topMessage`
// is just the current anchor message inside that thread and can differ.
export function summarizeForumTopic(topic) {
  if (topic?.className !== "ForumTopic") {
    return null;
  }

  const forumTopicId = normalizePositiveInteger(topic.id);
  if (!forumTopicId) {
    return null;
  }

  return {
    forumTopicId,
    topicId: forumTopicId,
    title: String(topic.title || ""),
    topMessage: normalizePositiveInteger(topic.topMessage),
    closed: Boolean(topic.closed),
    hidden: Boolean(topic.hidden),
  };
}
