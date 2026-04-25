const GLOBAL_CONTROL_OPERATION_CHAINS = new Map();

export function buildAuthMessageForCallbackQuery(callbackQuery) {
  return {
    from: callbackQuery?.from ?? null,
    chat: callbackQuery?.message?.chat ?? null,
    message_thread_id: callbackQuery?.message?.message_thread_id,
  };
}

export function isRecoverableEditError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to edit not found")
    || message.includes("message can't be edited")
  );
}

export function isNotModifiedError(error) {
  return String(error?.message ?? "").toLowerCase().includes("message is not modified");
}

export async function sendStatusMessage(api, chatId, text) {
  await api.sendMessage({
    chat_id: chatId,
    text,
  });
}

export async function answerCallbackQuerySafe(api, callbackQueryId, text = undefined) {
  if (!callbackQueryId) {
    return;
  }

  try {
    await api.answerCallbackQuery(
      text
        ? {
            callback_query_id: callbackQueryId,
            text,
          }
        : {
            callback_query_id: callbackQueryId,
          },
    );
  } catch {}
}

export async function runSerializedGlobalControlOperation(key, operation) {
  const previous = GLOBAL_CONTROL_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation);

  GLOBAL_CONTROL_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (GLOBAL_CONTROL_OPERATION_CHAINS.get(key) === current) {
      GLOBAL_CONTROL_OPERATION_CHAINS.delete(key);
    }
  }
}

export function syncPendingInputMessageId(pendingInput, menuMessageId) {
  if (!pendingInput) {
    return null;
  }

  return {
    ...pendingInput,
    menu_message_id: menuMessageId,
  };
}
