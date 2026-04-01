export async function runTelegramProbe(config, api) {
  const me = await api.call("getMe");
  const [chat, membership, webhookInfo] = await Promise.all([
    api.call("getChat", { chat_id: config.telegramForumChatId }),
    api.call("getChatMember", {
      chat_id: config.telegramForumChatId,
      user_id: me.id,
    }),
    api.getWebhookInfo(),
  ]);

  if (chat.type !== "supergroup") {
    throw new Error(
      `Configured forum chat must be a supergroup, got: ${chat.type}`,
    );
  }

  if (!chat.is_forum) {
    throw new Error("Configured chat is reachable, but topics are not enabled");
  }

  return {
    me,
    chat,
    membership,
    webhookInfo,
  };
}
