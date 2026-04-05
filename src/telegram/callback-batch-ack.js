function normalizeCallbackQueryId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export async function ackBatchCallbackQueriesBestEffort(api, updates = []) {
  if (typeof api?.answerCallbackQuery !== "function") {
    return {
      attempted: 0,
      acknowledged: 0,
    };
  }

  const callbackQueryIds = [];
  const seen = new Set();

  for (const update of Array.isArray(updates) ? updates : []) {
    const callbackQueryId = normalizeCallbackQueryId(update?.callback_query?.id);
    if (!callbackQueryId || seen.has(callbackQueryId)) {
      continue;
    }

    seen.add(callbackQueryId);
    callbackQueryIds.push(callbackQueryId);
  }

  if (callbackQueryIds.length === 0) {
    return {
      attempted: 0,
      acknowledged: 0,
    };
  }

  const results = await Promise.allSettled(
    callbackQueryIds.map((callbackQueryId) =>
      api.answerCallbackQuery({
        callback_query_id: callbackQueryId,
      })),
  );

  return {
    attempted: callbackQueryIds.length,
    acknowledged: results.filter((result) => result.status === "fulfilled").length,
  };
}
