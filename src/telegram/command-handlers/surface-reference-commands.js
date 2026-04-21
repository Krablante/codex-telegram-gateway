import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../i18n/ui-language.js";
import { buildReplyMessageParams } from "../command-parsing.js";
import { getHelpCardAssets } from "../help-card.js";
import { getGuidebookAsset } from "../guidebook.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
} from "../topic-delivery.js";
import {
  finalizeHandledCommand,
  isEnglish,
  maybeFinalizeParkedDelivery,
} from "./surface-command-common.js";
import { buildPromptSuffixHelpMessage } from "./topic-commands.js";

function buildHelpTextMessage(
  language = DEFAULT_UI_LANGUAGE,
  { omniEnabled = true } = {},
) {
  if (isEnglish(language)) {
    return [
      "SEVERUS quick help",
      "",
      "/help - this cheat sheet",
      "/guide - beginner PDF guidebook from General",
      "/clear - clear General and keep only the active menu",
      "/new [cwd=...|path=...] [title] - create a new work topic",
      "/zoo - open the dedicated Zoo topic",
      "/status - session, model, and context status",
      "/limits - current Codex rate-limit windows",
      "/global - pin-friendly global settings menu in General",
      "/menu - pin-friendly local settings menu in this topic",
      ...(omniEnabled
        ? [
            "/auto | /auto status | /auto off - Omni auto mode in this topic",
            "/omni [question] - ask Omni, or just send a plain question during /auto",
          ]
        : []),
      "/language - show or change the UI language",
      "/q <text> - add a prompt to the Spike queue",
      "/q status | /q delete <n> - inspect or remove queued prompts",
      "/wait 60 | wait 600 - local one-shot collection window",
      "/wait global 60 - persistent global collection window",
      "`All`, `Все`, or `Всё` - flush the collected prompt immediately",
      "/wait off - cancel the local one-shot window",
      "/wait global off - disable the global window",
      "/interrupt - stop the run",
      "/diff - diff for the current workspace",
      "/compact - rebuild the brief from the exchange log",
      "/purge - clear local session state",
      "/suffix <text> - topic prompt suffix",
      "/suffix global <text> - global prompt suffix",
      "/suffix topic on|off - routing suffixes for this topic",
      "/suffix help - separate suffix cheat sheet",
      "/model [list|clear|<slug>] - Spike model for this topic",
      "/model global [list|clear|<slug>] - global Spike model default",
      "/reasoning [list|clear|<level>] - Spike reasoning for this topic",
      "/reasoning global [list|clear|<level>] - global Spike reasoning default",
      ...(omniEnabled
        ? [
            "/omni_model [list|clear|<slug>] - Omni model for this topic",
            "/omni_model global [list|clear|<slug>] - global Omni model default",
            "/omni_reasoning [list|clear|<level>] - Omni reasoning for this topic",
            "/omni_reasoning global [list|clear|<level>] - global Omni reasoning default",
          ]
        : []),
    ].join("\n");
  }

  return [
    "SEVERUS quick help",
    "",
    "/help - эта шпаргалка",
    "/guide - PDF-гайдбук для новичка из General",
    "/clear - очистить General и оставить только active menu",
    "/new [cwd=...|path=...] [title] - новая рабочая тема",
    "/zoo - открыть отдельный Zoo topic",
    "/status - статус сессии, модели и контекста",
    "/limits - текущие окна лимитов Codex",
    "/global - pin-friendly Global settings menu в General",
    "/menu - pin-friendly menu локальных настроек в этом топике",
    ...(omniEnabled
      ? [
          "/auto | /auto status | /auto off - режим Omni /auto в этом топике",
          "/omni [вопрос] - спросить Omni, или просто прислать вопрос текстом во время /auto",
        ]
      : []),
    "/language - показать или сменить язык интерфейса",
    "/q <текст> - поставить prompt в очередь Spike",
    "/q status | /q delete <n> - посмотреть или удалить queued prompts",
    "/wait 60 | wait 600 - local one-shot collection window",
    "/wait global 60 - persistent global collection window",
    "`Все`, `Всё` или `All` - сразу отправить накопленное",
    "/wait off - выключить local one-shot window",
    "/wait global off - выключить global collection window",
    "/interrupt - остановить active run",
    "/diff - diff текущего workspace",
    "/compact - пересобрать brief из exchange log",
    "/purge - очистить local session state",
    "/suffix <text> - topic prompt suffix",
    "/suffix global <text> - global prompt suffix",
    "/suffix topic on|off - topic prompt suffix routing",
    "/suffix help - отдельная шпаргалка по prompt suffix",
    "/model [list|clear|<slug>] - Spike model для этого топика",
    "/model global [list|clear|<slug>] - global default для Spike model",
    "/reasoning [list|clear|<level>] - Spike reasoning для этого топика",
    "/reasoning global [list|clear|<level>] - global default для Spike reasoning",
    ...(omniEnabled
      ? [
          "/omni_model [list|clear|<slug>] - Omni model для этого топика",
          "/omni_model global [list|clear|<slug>] - global default для Omni model",
          "/omni_reasoning [list|clear|<level>] - Omni reasoning для этого топика",
          "/omni_reasoning global [list|clear|<level>] - global default для Omni reasoning",
        ]
      : []),
  ].join("\n");
}

function buildHelpCardPartialFailureMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "I sent part of the help card, but a later page failed.",
      "",
      "Run /help again if you still need the missing page.",
    ].join("\n");
  }

  return [
    "Часть help-card отправил, но следующая страница не доехала.",
    "",
    "Если нужна недостающая часть, просто повтори /help.",
  ].join("\n");
}

function buildGuideGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "/guide works in General only.",
      "",
      "Run it there to receive the beginner PDF guidebook.",
    ].join("\n");
  }

  return [
    "/guide работает только в General.",
    "",
    "Запусти его там, чтобы получить PDF-гайдбук для новичка.",
  ].join("\n");
}

function buildGuideGenerationFailureMessage(
  language = DEFAULT_UI_LANGUAGE,
  error = null,
) {
  const detail = error?.message
    ? `\n\n${isEnglish(language) ? "Error" : "Ошибка"}: ${error.message}`
    : "";
  return isEnglish(language)
    ? `Could not generate the guidebook right now.${detail}`
    : `Сейчас не смог собрать guidebook.${detail}`;
}

function buildGuideDeliveryFailureMessage(
  language = DEFAULT_UI_LANGUAGE,
  delivery = null,
) {
  const reason = String(delivery?.reason || "").trim();
  const detail = reason
    ? `\n\n${isEnglish(language) ? "Reason" : "Причина"}: ${reason}`
    : "";
  return isEnglish(language)
    ? `Could not deliver the guidebook right now.${detail}`
    : `Сейчас не смог доставить guidebook.${detail}`;
}

export async function maybeHandleReferenceSurfaceCommand({
  api,
  command,
  config,
  generalUiLanguage,
  lifecycleManager = null,
  markCommandHandled,
  message,
  serviceState,
  sessionService,
  suffixCommand = null,
  topicId = null,
}) {
  const isSuffixHelpCommand =
    command.name === "suffix" && suffixCommand?.scope === "help";
  if (
    command.name !== "help"
    && command.name !== "guide"
    && !isSuffixHelpCommand
  ) {
    return null;
  }

  if (isSuffixHelpCommand) {
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildPromptSuffixHelpMessage(language)),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }
    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  if (command.name === "help") {
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    const helpCards = getHelpCardAssets(language);

    if (config.omniEnabled === false) {
      const delivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildHelpTextMessage(language, { omniEnabled: false }),
        ),
        handledSession,
        lifecycleManager,
      );
      const parkedResult = await maybeFinalizeParkedDelivery({
        commandName: command.name,
        delivery,
        handledSession,
        markCommandHandled,
        serviceState,
        sessionService,
      });
      if (parkedResult) {
        return parkedResult;
      }
    } else {
      let deliveredPages = 0;
      try {
        for (const helpCard of helpCards) {
          const delivery = await safeSendDocumentToTopic(
            api,
            message,
            {
              filePath: helpCard.filePath,
              fileName: helpCard.fileName,
              contentType: "image/png",
            },
            handledSession,
            lifecycleManager,
          );
          const parkedResult = await maybeFinalizeParkedDelivery({
            commandName: command.name,
            delivery,
            handledSession,
            markCommandHandled,
            serviceState,
            sessionService,
          });
          if (parkedResult) {
            return parkedResult;
          }
          if (!delivery?.delivered) {
            throw new Error(delivery?.reason || "help-card-delivery-failed");
          }
          deliveredPages += 1;
        }
      } catch {
        const delivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            deliveredPages > 0
              ? buildHelpCardPartialFailureMessage(language)
              : buildHelpTextMessage(language, { omniEnabled: true }),
          ),
          handledSession,
          lifecycleManager,
        );
        const parkedResult = await maybeFinalizeParkedDelivery({
          commandName: command.name,
          delivery,
          handledSession,
          markCommandHandled,
          serviceState,
          sessionService,
        });
        if (parkedResult) {
          return parkedResult;
        }
      }
    }

    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  const handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = handledSession
    ? getSessionUiLanguage(handledSession)
    : generalUiLanguage;
  const inGeneralTopic =
    !topicId
    && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "");

  if (!inGeneralTopic) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildGuideGeneralOnlyMessage(language),
      ),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }

    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      reason: "guide-general-only",
      serviceState,
      sessionService,
    });
  }

  try {
    const guidebook = await getGuidebookAsset(language, {
      stateRoot: config.stateRoot,
    });
    const delivery = await safeSendDocumentToTopic(
      api,
      message,
      guidebook,
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }
    if (!delivery?.delivered) {
      const failureDelivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildGuideDeliveryFailureMessage(language, delivery),
        ),
        handledSession,
        lifecycleManager,
      );
      const failureParkedResult = await maybeFinalizeParkedDelivery({
        commandName: command.name,
        delivery: failureDelivery,
        handledSession,
        markCommandHandled,
        serviceState,
        sessionService,
      });
      if (failureParkedResult) {
        return failureParkedResult;
      }
    }
  } catch (error) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildGuideGenerationFailureMessage(language, error),
      ),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }
  }

  return finalizeHandledCommand({
    commandName: command.name,
    handledSession,
    markCommandHandled,
    serviceState,
    sessionService,
  });
}
