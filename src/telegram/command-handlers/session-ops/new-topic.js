import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../../session-manager/session-key.js";
import { buildReplyMessageParams, parseNewTopicCommandArgs } from "../../command-parsing.js";
import { ensureTopicControlPanelMessage } from "../../topic-control-panel.js";
import { safeSendMessage } from "../../topic-delivery.js";
import {
  buildBindingResolutionErrorMessage,
  buildNewTopicAckMessage,
  buildNewTopicBootstrapMessage,
  buildNewTopicHostUnavailableMessage,
} from "../topic-commands.js";
import { resolveGeneralUiLanguage } from "../control-surface.js";

export async function handleNewTopicCommand({
  api,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  message,
  promptFragmentAssembler = null,
  topicControlPanelStore = null,
  sessionService,
  workerPool,
}) {
  const newTopicArgs = parseNewTopicCommandArgs(message.command_args || "");
  const sourceSession = getTopicIdFromMessage(message)
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const sourceLanguage = sourceSession
    ? getSessionUiLanguage(sourceSession)
    : await resolveGeneralUiLanguage(globalControlPanelStore);
  let workspaceBinding;
  let inheritedFromSessionKey = null;

  if (newTopicArgs.bindingPath) {
    try {
      workspaceBinding = await sessionService.resolveBindingPath(
        newTopicArgs.bindingPath,
      );
    } catch (error) {
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildBindingResolutionErrorMessage(
            newTopicArgs.bindingPath,
            error,
            sourceLanguage,
          ),
        ),
        null,
        lifecycleManager,
      );
      return { reason: "binding-error", handledSession: null };
    }
  } else if (sourceSession) {
    workspaceBinding = sourceSession.workspace_binding;
    inheritedFromSessionKey = sourceSession.session_key;
  } else {
    const inherited = await sessionService.resolveInheritedBinding(message);
    workspaceBinding = inherited.binding;
    inheritedFromSessionKey = inherited.inheritedFromSessionKey;
  }

  let createdTopic;
  try {
    createdTopic = await sessionService.createTopicSession({
      api,
      executionHostId: newTopicArgs.executionHostId,
      message,
      title: newTopicArgs.title,
      uiLanguage: sourceLanguage,
      workspaceBinding,
      inheritedFromSessionKey,
    });
  } catch (error) {
    if (error?.code !== "EXECUTION_HOST_UNAVAILABLE") {
      throw error;
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildNewTopicHostUnavailableMessage(
          {
            hostId: error.hostId,
            hostLabel: error.hostLabel,
          },
          sourceLanguage,
        ),
      ),
      null,
      lifecycleManager,
    );
    return { reason: "host-unavailable", handledSession: null };
  }

  const { forumTopic, session } = createdTopic;

  await safeSendMessage(
    api,
    {
      chat_id: message.chat.id,
      message_thread_id: forumTopic.message_thread_id,
      text: buildNewTopicBootstrapMessage(session, forumTopic, sourceLanguage),
    },
    session,
    lifecycleManager,
  );
  if (topicControlPanelStore) {
    await ensureTopicControlPanelMessage({
      activeScreen: "root",
      actor: {
        chat: { id: message.chat.id },
        from: message.from,
        message_thread_id: forumTopic.message_thread_id,
      },
      api,
      config,
      lifecycleManager,
      promptFragmentAssembler,
      session,
      sessionService,
      topicControlPanelStore,
      workerPool,
      pin: true,
    });
  }
  const ack = await safeSendMessage(
    api,
    buildReplyMessageParams(
      message,
      buildNewTopicAckMessage(session, forumTopic, sourceLanguage),
    ),
    session,
    lifecycleManager,
  );

  return {
    handledSession: ack.session || session,
    reason: ack.parked ? "topic-unavailable" : "new-topic-created",
  };
}
