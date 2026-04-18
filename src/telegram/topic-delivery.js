import { deliverDocumentToTopic } from "../transport/topic-document-delivery.js";
import { deliverPhotoToTopic } from "../transport/topic-photo-delivery.js";

function isMissingReplyTargetError(error) {
  return String(error?.message || "")
    .toLowerCase()
    .includes("message to be replied not found");
}

async function sendDocumentToTopic(api, message, document) {
  return deliverDocumentToTopic({
    api,
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
    document: {
      filePath: document.filePath,
      fileName: document.fileName,
      caption: document.caption,
    },
  });
}

async function sendPhotoToTopic(api, message, photo) {
  return deliverPhotoToTopic({
    api,
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
    photo: {
      filePath: photo.filePath,
      fileName: photo.fileName,
      caption: photo.caption,
      contentType: photo.contentType,
    },
  });
}

async function handleDeliveryError(session, error, lifecycleManager) {
  const lifecycleResult = await lifecycleManager?.handleTransportError(
    session,
    error,
  );
  if (lifecycleResult?.handled) {
    return {
      delivered: false,
      parked: lifecycleResult.parked === true,
      session: lifecycleResult.session || session,
    };
  }

  throw error;
}

export async function safeSendMessage(api, params, session, lifecycleManager) {
  const deliveryParams = { ...params };
  let allowReplyTargetFallback = Boolean(deliveryParams.reply_to_message_id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await api.sendMessage(deliveryParams);
      return {
        delivered: true,
        session,
      };
    } catch (error) {
      if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
        delete deliveryParams.reply_to_message_id;
        allowReplyTargetFallback = false;
        continue;
      }

      return handleDeliveryError(session, error, lifecycleManager);
    }
  }
}

export async function safeSendDocumentToTopic(
  api,
  message,
  document,
  session,
  lifecycleManager,
) {
  try {
    return await sendDocumentToTopic(api, message, document);
  } catch (error) {
    return handleDeliveryError(session, error, lifecycleManager);
  }
}

export async function safeSendPhotoToTopic(
  api,
  message,
  photo,
  session,
  lifecycleManager,
) {
  try {
    return await sendPhotoToTopic(api, message, photo);
  } catch (error) {
    return handleDeliveryError(session, error, lifecycleManager);
  }
}
