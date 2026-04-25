import { safeSendMessage } from "./topic-delivery.js";

const TOPIC_CONTROL_OPERATION_CHAINS = new Map();

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

export async function sendStatusMessage(api, session, text, lifecycleManager = null) {
  return safeSendMessage(
    api,
    {
      chat_id: session.chat_id,
      message_thread_id: Number(session.topic_id),
      text,
    },
    session,
    lifecycleManager,
  );
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDeleteMessageError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("message to delete not found");
}

export async function deleteTopicControlMessagesBestEffort(
  api,
  chatId,
  messageIds = [],
  {
    attempts = 1,
    retryDelayMs = 0,
  } = {},
) {
  if (typeof api?.deleteMessage !== "function") {
    return;
  }

  for (const messageId of messageIds) {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      continue;
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0 && retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }

      try {
        await api.deleteMessage({
          chat_id: chatId,
          message_id: messageId,
        });
        break;
      } catch (error) {
        if (
          attempt === attempts - 1 ||
          !isRetryableDeleteMessageError(error)
        ) {
          break;
        }
      }
    }
  }
}

export async function pinTopicControlPanelMessageSafe(api, session, messageId) {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return false;
  }

  try {
    await api.pinChatMessage({
      chat_id: session.chat_id,
      message_id: messageId,
      disable_notification: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function runSerializedTopicControlOperation(key, operation) {
  const previous = TOPIC_CONTROL_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation);

  TOPIC_CONTROL_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (TOPIC_CONTROL_OPERATION_CHAINS.get(key) === current) {
      TOPIC_CONTROL_OPERATION_CHAINS.delete(key);
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
