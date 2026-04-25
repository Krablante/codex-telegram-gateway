export function buildSyntheticCommandMessage(actor, chat, commandText) {
  const rawCommand = String(commandText ?? "").trim().split(/\s+/u)[0] ?? "";
  return {
    text: commandText,
    entities: rawCommand.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: rawCommand.length }]
      : undefined,
    from: actor,
    chat,
    message_thread_id: Number.isInteger(chat?.message_thread_id)
      ? chat.message_thread_id
      : undefined,
    is_internal_global_control_dispatch: true,
  };
}

export function createGlobalControlDispatcher({
  handleIncomingMessage,
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async ({
    actor,
    chat,
    commandText,
  }) =>
    handleIncomingMessage({
      api,
      botUsername,
      config,
      lifecycleManager,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      message: buildSyntheticCommandMessage(actor, chat, commandText),
      promptStartGuard,
      promptFragmentAssembler,
      queuePromptAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
}
