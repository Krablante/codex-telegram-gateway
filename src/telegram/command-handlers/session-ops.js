import {
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { parseNewTopicCommandArgs } from "../command-parsing.js";
import { ensureTopicControlPanelMessage } from "../topic-control-panel.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
} from "../topic-delivery.js";
import {
  buildBindingResolutionErrorMessage,
  buildCompactAlreadyRunningMessage,
  buildCompactFailureMessage,
  buildCompactMessage,
  buildCompactQueuedHandoffMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildDiffUnavailableMessage,
  buildDocumentTooLargeMessage,
  buildNewTopicAckMessage,
  buildNewTopicBootstrapMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  buildPurgedSessionMessage,
} from "./topic-commands.js";
import { resolveGeneralUiLanguage } from "./control-surface.js";
import { buildReplyMessageParams } from "../command-parsing.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

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
  } else {
    if (sourceSession) {
      workspaceBinding = sourceSession.workspace_binding;
      inheritedFromSessionKey = sourceSession.session_key;
    } else {
      const inherited = await sessionService.resolveInheritedBinding(message);
      workspaceBinding = inherited.binding;
      inheritedFromSessionKey = inherited.inheritedFromSessionKey;
    }
  }

  const { forumTopic, session } = await sessionService.createTopicSession({
    api,
    message,
    title: newTopicArgs.title,
    uiLanguage: sourceLanguage,
    workspaceBinding,
    inheritedFromSessionKey,
  });

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

export async function handleDiffCommand({
  api,
  lifecycleManager = null,
  message,
  session,
  sessionService,
  language,
}) {
  const diffArtifact = await sessionService.createDiffArtifact(session);
  if (diffArtifact.unavailable) {
    return {
      handledSession: session,
      responseText: buildDiffUnavailableMessage(
        session,
        diffArtifact.generatedAt,
        language,
      ),
      reason: "diff-unavailable",
    };
  }

  if (diffArtifact.clean) {
    return {
      handledSession: session,
      responseText: buildDiffCleanMessage(session, diffArtifact.generatedAt, language),
      reason: "diff-clean",
    };
  }

  const sent = await safeSendDocumentToTopic(
    api,
    message,
    {
      filePath: diffArtifact.filePath,
      fileName: diffArtifact.artifact.file_name,
      caption: [
        isEnglish(language) ? "Workspace diff snapshot" : "Workspace diff snapshot",
        `session_key: ${session.session_key}`,
      ].join("\n"),
    },
    diffArtifact.session,
    lifecycleManager,
  );
  const handledSession = sent.session || diffArtifact.session;
  if (sent.parked) {
    return {
      handledSession,
      responseText: null,
      reason: "topic-unavailable",
    };
  }

  if (!sent.delivered) {
    return {
      handledSession,
      responseText: buildDocumentTooLargeMessage(
        session,
        diffArtifact.filePath,
        sent.sizeBytes,
        language,
      ),
      reason: "diff-too-large",
    };
  }

  return {
    handledSession,
    responseText: null,
    reason: "diff-delivered",
  };
}

export async function handleCompactCommand({
  session,
  sessionService,
  promptHandoffStore = null,
  workerPool = null,
  language,
}) {
  if (session.lifecycle_state === "purged") {
    return {
      responseText: buildPurgedSessionMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-purged",
    };
  }

  if (sessionService.isCompacting?.(session)) {
    return {
      responseText: buildCompactAlreadyRunningMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-already-running",
    };
  }

  if (
    workerPool?.getActiveRun?.(session.session_key) ||
    (
      session.last_run_status === "running" &&
      session.session_owner_generation_id
    )
  ) {
    return {
      responseText: buildCompactAlreadyRunningMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-busy",
    };
  }

  if (promptHandoffStore && await promptHandoffStore.load(session)) {
    return {
      responseText: buildCompactQueuedHandoffMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-handoff-queued",
    };
  }

  return {
    responseText: buildCompactStartedMessage(session, language),
    backgroundCompactPromise: sessionService.compactSession(session),
    reason: "compact-started",
  };
}

export function handlePurgeCommand({
  session,
  sessionService,
  workerPool,
  language,
}) {
  if (workerPool.getActiveRun(session.session_key)) {
    return Promise.resolve({
      handledSession: session,
      responseText: buildPurgeBusyMessage(session, language),
      reason: "purge-busy",
    });
  }

  return sessionService.purgeSession(session).then((handledSession) => ({
    handledSession,
    responseText: buildPurgeAckMessage(
      handledSession,
      getSessionUiLanguage(handledSession),
    ),
    reason: "purged",
  }));
}

export function launchCompactionInBackground({
  api,
  lifecycleManager,
  message,
  session,
  compactPromise,
}) {
  void (async () => {
    try {
      const compacted = await compactPromise;
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildCompactMessage(
            compacted.session,
            compacted,
            getSessionUiLanguage(compacted.session),
          ),
        ),
        compacted.session,
        lifecycleManager,
      );
    } catch (error) {
      console.error(
        `background compact failed for ${session.session_key}: ${error.message}`,
      );
      try {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildCompactFailureMessage(
              session,
              error,
              getSessionUiLanguage(session),
            ),
          ),
          session,
          lifecycleManager,
        );
      } catch (deliveryError) {
        console.error(
          `background compact failure reply failed for ${session.session_key}: ${deliveryError.message}`,
        );
      }
    }
  })();
}
