function normalizeMessageId(value) {
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return normalizeMessageId(Number(value));
  }

  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeChatId(value) {
  return String(value ?? "").trim();
}

function isDeleteMessageAlreadyGoneError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to delete not found")
    || message.includes("message not found")
    || message.includes("message identifier is not specified")
  );
}

function isGeneralThreadId(value) {
  return value === undefined || value === 0 || value === "0";
}

function isGeneralChatPayload(params, config) {
  return (
    normalizeChatId(params?.chat_id) === normalizeChatId(config?.telegramForumChatId)
    && isGeneralThreadId(params?.message_thread_id)
  );
}

export function collectGeneralCleanupDeleteIds(
  trackedMessageIds,
  preservedMessageIds = [],
) {
  const preserved = new Set(
    (Array.isArray(preservedMessageIds) ? preservedMessageIds : [])
      .map(normalizeMessageId)
      .filter(Boolean),
  );
  const seen = new Set();
  const deletable = [];

  for (const value of Array.isArray(trackedMessageIds) ? trackedMessageIds : []) {
    const messageId = normalizeMessageId(value);
    if (!messageId || preserved.has(messageId) || seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    deletable.push(messageId);
  }

  return deletable.sort((left, right) => left - right);
}

async function trackOutgoingGeneralMessage(store, result) {
  const messageId = normalizeMessageId(result?.message_id);
  if (messageId) {
    await store.trackMessageId(messageId);
  }
}

export function createTrackedGeneralApi(api, config, generalMessageLedgerStore) {
  if (!generalMessageLedgerStore) {
    return api;
  }

  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (property === "sendMessage" || property === "sendDocument" || property === "sendPhoto") {
        return async function trackedGeneralSend(params, ...rest) {
          const result = await Reflect.apply(value, target, [params, ...rest]);
          if (isGeneralChatPayload(params, config)) {
            await trackOutgoingGeneralMessage(generalMessageLedgerStore, result);
          }
          return result;
        };
      }

      if (property === "deleteMessage") {
        return async function trackedGeneralDelete(params, ...rest) {
          const result = await Reflect.apply(value, target, [params, ...rest]);
          if (isGeneralChatPayload(params, config)) {
            await generalMessageLedgerStore.forgetMessageIds([params?.message_id]);
          }
          return result;
        };
      }

      if (property === "deleteMessages") {
        return async function trackedGeneralBulkDelete(params, ...rest) {
          const result = await Reflect.apply(value, target, [params, ...rest]);
          if (isGeneralChatPayload(params, config)) {
            await generalMessageLedgerStore.forgetMessageIds(params?.message_ids);
          }
          return result;
        };
      }

      return value.bind(target);
    },
  });
}

export async function clearTrackedGeneralMessages({
  api,
  chatId,
  generalMessageLedgerStore,
  preservedMessageIds = [],
}) {
  const ledgerState = await generalMessageLedgerStore.load({ force: true });
  const deleteIds = collectGeneralCleanupDeleteIds(
    ledgerState.tracked_message_ids,
    preservedMessageIds,
  );
  const deletedMessageIds = [];
  const failedMessageIds = [];

  for (const messageId of deleteIds) {
    try {
      await api.deleteMessage({
        chat_id: chatId,
        message_id: messageId,
      });
      deletedMessageIds.push(messageId);
    } catch (error) {
      if (isDeleteMessageAlreadyGoneError(error)) {
        deletedMessageIds.push(messageId);
        continue;
      }
      failedMessageIds.push(messageId);
    }
  }

  if (deletedMessageIds.length > 0) {
    await generalMessageLedgerStore.forgetMessageIds(deletedMessageIds);
  }

  return {
    deletedMessageIds,
    failedMessageIds,
    preservedMessageIds: Array.from(
      new Set(
        (Array.isArray(preservedMessageIds) ? preservedMessageIds : [])
          .map(normalizeMessageId)
          .filter(Boolean),
      ),
    ),
  };
}
