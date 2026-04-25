import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { safeSendDocumentToTopic } from "../../topic-delivery.js";
import {
  buildCompactAlreadyRunningMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildDiffUnavailableMessage,
  buildDocumentTooLargeMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  buildPurgedSessionMessage,
} from "../topic-commands.js";
import { isEnglish } from "./common.js";

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
      caption: isEnglish(language) ? "Workspace diff snapshot" : "Workspace diff snapshot",
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

  if (await sessionService.isCompacting?.(session)) {
    return {
      responseText: buildCompactAlreadyRunningMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-already-running",
    };
  }

  if (
    workerPool?.getActiveRun?.(session.session_key)
    || (
      session.last_run_status === "running"
      && session.session_owner_generation_id
    )
  ) {
    return {
      responseText: buildCompactAlreadyRunningMessage(session, language),
      backgroundCompactPromise: null,
      reason: "compact-busy",
    };
  }

  return {
    responseText: buildCompactStartedMessage(session, language),
    backgroundCompactPromise: sessionService.compactSession(session),
    reason: "compact-started",
  };
}

export async function handlePurgeCommand({
  session,
  sessionService,
  workerPool,
  language,
}) {
  if (
    workerPool.getActiveRun(session.session_key)
    || await sessionService.isCompacting?.(session)
    || (
      session.last_run_status === "running"
      && session.session_owner_generation_id
    )
  ) {
    return {
      handledSession: session,
      responseText: buildPurgeBusyMessage(session, language),
      reason: "purge-busy",
    };
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
