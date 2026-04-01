import fs from "node:fs/promises";

export async function deliverPhotoToTopic({
  api,
  chatId,
  messageThreadId,
  replyToMessageId = null,
  photo,
}) {
  const stats = await fs.stat(photo.filePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${photo.filePath}`);
  }

  const params = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    caption: photo.caption,
    photo: {
      filePath: photo.filePath,
      fileName: photo.fileName,
      contentType: photo.contentType,
    },
  };
  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  await api.sendPhoto(params);
  return {
    delivered: true,
    sizeBytes: stats.size,
  };
}
