import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  extractBotCommand,
  isAuthorizedMessage,
  isForeignBotCommand,
} from "../telegram/command-parsing.js";
import {
  getZooPetCharacterName,
  getZooPetTemperamentProfile,
  ZOO_CHARACTER_NAMES,
  ZOO_CREATURE_KINDS,
  ZOO_TEMPERAMENT_IDS,
} from "./creatures.js";
import {
  buildZooPetMarkup,
  buildZooPetText,
  buildZooRemoveConfirmMarkup,
  buildZooRemoveConfirmText,
  buildZooRootMarkupPage,
  buildZooRootText,
  ZOO_COMMAND,
  ZOO_DEFAULT_TOPIC_NAME,
  ZOO_ROOT_PAGE_SIZE,
} from "./render.js";
import {
  buildPendingCandidatePet,
  buildZooTopicOnlyCommandMessage,
  buildZooTopicReadyMessage,
  buildZooUnsupportedMessage,
  deleteMessagesBestEffort,
  isRecoverableZooMenuEditError,
  isZooMenuNotModifiedError,
  pickRandomUnusedValue,
  pinMessageBestEffort,
} from "./service-common.js";

export async function resolveUiLanguage(service, message = null) {
  const topicId = String(message?.message_thread_id ?? "").trim() || null;
  const topicState = await service.zooStore.loadTopic();
  if (topicState.topic_id && topicId === topicState.topic_id) {
    return normalizeUiLanguage(topicState.ui_language);
  }

  if (topicId) {
    const session = await service.sessionService.ensureSessionForMessage(message);
    if (session) {
      return getSessionUiLanguage(session);
    }
  }

  if (service.globalControlPanelStore) {
    try {
      const state = await service.globalControlPanelStore.load({ force: true });
      return normalizeUiLanguage(state?.ui_language);
    } catch {}
  }

  return DEFAULT_UI_LANGUAGE;
}

export function pickPetIdentity(service, existingPets = []) {
  return {
    creature_kind: pickRandomUnusedValue(
      ZOO_CREATURE_KINDS,
      existingPets.map((pet) => pet.creature_kind),
      service.randomSource,
    ),
    temperament_id: pickRandomUnusedValue(
      ZOO_TEMPERAMENT_IDS,
      existingPets.map((pet) => getZooPetTemperamentProfile(pet)?.id),
      service.randomSource,
    ),
    character_name: pickRandomUnusedValue(
      ZOO_CHARACTER_NAMES,
      existingPets.map((pet) => getZooPetCharacterName(pet)),
      service.randomSource,
    ),
  };
}

export async function isZooTopicMessage(service, message) {
  const topicState = await service.zooStore.loadTopic();
  return (
    Boolean(topicState.topic_id)
    && String(message?.chat?.id ?? "") === String(topicState.chat_id || service.config.telegramForumChatId)
    && String(message?.message_thread_id ?? "") === String(topicState.topic_id)
  );
}

function normalizePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function recoverZooTopicFromMessageContext(service, message, {
  menuMessageId = null,
} = {}) {
  const chatId = String(message?.chat?.id ?? "").trim() || null;
  const topicId = String(message?.message_thread_id ?? "").trim() || null;
  const normalizedMenuMessageId = normalizePositiveInteger(menuMessageId);
  const topicState = await service.zooStore.loadTopic({ force: true });
  if (!chatId || !topicId) {
    return topicState;
  }

  const storedChatId = String(topicState.chat_id ?? "").trim() || null;
  const storedTopicId = String(topicState.topic_id ?? "").trim() || null;
  const patch = {};

  if (!storedTopicId) {
    patch.chat_id = chatId;
    patch.topic_id = topicId;
  } else if (storedTopicId === topicId && storedChatId !== chatId) {
    patch.chat_id = chatId;
  } else if (storedTopicId !== topicId) {
    return topicState;
  }

  if (
    normalizedMenuMessageId
    && normalizePositiveInteger(topicState.menu_message_id) === null
  ) {
    patch.menu_message_id = normalizedMenuMessageId;
  }

  if (Object.keys(patch).length === 0) {
    return topicState;
  }

  return service.zooStore.patchTopic(patch);
}

export async function ensureZooTopic(service, api, {
  uiLanguage = DEFAULT_UI_LANGUAGE,
} = {}) {
  let topicState = await service.zooStore.loadTopic({ force: true });
  if (topicState.topic_id) {
    return topicState;
  }

  const forumTopic = await api.createForumTopic({
    chat_id: service.config.telegramForumChatId,
    name: ZOO_DEFAULT_TOPIC_NAME,
  });
  topicState = await service.zooStore.saveTopic({
    ...topicState,
    chat_id: String(service.config.telegramForumChatId),
    topic_id: String(forumTopic.message_thread_id),
    topic_name: forumTopic.name || ZOO_DEFAULT_TOPIC_NAME,
    ui_language: uiLanguage,
  });
  return topicState;
}

export async function buildMenuPayload(service) {
  let state = await service.zooStore.loadTopic({ force: true });
  const language = normalizeUiLanguage(state.ui_language);
  let selectedPet =
    state.selected_pet_id ? await service.zooStore.loadPet(state.selected_pet_id) : null;

  if (state.active_screen !== "root" && state.selected_pet_id && !selectedPet) {
    state = await service.zooStore.patchTopic({
      active_screen: "root",
      selected_pet_id: null,
      refreshing_pet_id:
        state.refreshing_pet_id === state.selected_pet_id
          ? null
          : state.refreshing_pet_id,
      refresh_status_text:
        state.refreshing_pet_id === state.selected_pet_id
          ? null
          : state.refresh_status_text,
      last_refresh_error_text: null,
    });
  }

  if (state.active_screen === "pet" && selectedPet) {
    const selectedSnapshot = await service.zooStore.loadLatestSnapshot(selectedPet.pet_id);
    return {
      state,
      animationPetId: selectedPet.pet_id,
      text: buildZooPetText({
        language,
        pet: selectedPet,
        snapshot: selectedSnapshot,
        state,
        poseFrameIndex: service.petFrameIndexByPetId.get(selectedPet.pet_id) || 0,
      }),
      reply_markup: buildZooPetMarkup(selectedPet.pet_id, {
        canRefresh: state.refreshing_pet_id !== selectedPet.pet_id,
        canRemove: state.refreshing_pet_id !== selectedPet.pet_id,
        language,
      }),
    };
  }

  if (state.active_screen === "remove_confirm" && selectedPet) {
    return {
      state,
      animationPetId: null,
      text: buildZooRemoveConfirmText({
        language,
        pet: selectedPet,
      }),
      reply_markup: buildZooRemoveConfirmMarkup(selectedPet.pet_id, language),
    };
  }

  const pets = await service.reconcilePetDisplayNames(null, [
    buildPendingCandidatePet(state),
  ]);
  selectedPet =
    state.selected_pet_id ? await service.zooStore.loadPet(state.selected_pet_id) : null;
  const selectedSnapshot =
    selectedPet ? await service.zooStore.loadLatestSnapshot(state.selected_pet_id) : null;
  const totalPages = Math.max(1, Math.ceil(pets.length / ZOO_ROOT_PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(state.root_page || 0, totalPages - 1));
  if (currentPage !== (state.root_page || 0)) {
    state = await service.zooStore.patchTopic({
      root_page: currentPage,
    });
  }
  const pagePets = pets.slice(
    currentPage * ZOO_ROOT_PAGE_SIZE,
    (currentPage + 1) * ZOO_ROOT_PAGE_SIZE,
  );

  return {
    state,
    animationPetId: null,
    text: buildZooRootText({
      language,
      pets: pagePets,
      totalPetCount: pets.length,
      state,
      selectedPet,
      selectedSnapshot,
      currentPage,
      totalPages,
    }),
    reply_markup: buildZooRootMarkupPage(pagePets, language, {
      currentPage,
      totalPages,
    }),
  };
}

export async function ensureZooMenu(service, api, {
  forceNew = false,
} = {}) {
  let topicState = await service.zooStore.loadTopic({ force: true });
  if (!topicState.topic_id) {
    topicState = await ensureZooTopic(service, api, {
      uiLanguage: topicState.ui_language,
    });
  }

  const payload = await buildMenuPayload(service);
  const previousMessageId = Number(topicState.menu_message_id);
  const existingMessageId = forceNew ? null : topicState.menu_message_id;
  if (existingMessageId) {
    try {
      await api.editMessageText({
        chat_id: Number(topicState.chat_id),
        message_id: existingMessageId,
        text: payload.text,
        reply_markup: payload.reply_markup,
      });
      service.syncPetAnimationTicker(api, payload);
      return {
        topicState: await service.zooStore.patchTopic({
          menu_message_id: existingMessageId,
        }),
        created: false,
        messageId: existingMessageId,
      };
    } catch (error) {
      if (isZooMenuNotModifiedError(error)) {
        service.syncPetAnimationTicker(api, payload);
        return {
          topicState,
          created: false,
          messageId: existingMessageId,
        };
      }

      if (!isRecoverableZooMenuEditError(error)) {
        throw error;
      }
    }
  }

  if (forceNew && Number.isInteger(previousMessageId) && previousMessageId > 0) {
    await deleteMessagesBestEffort(api, Number(topicState.chat_id), [previousMessageId]);
  }

  const sent = await api.sendMessage({
    chat_id: Number(topicState.chat_id),
    message_thread_id: Number(topicState.topic_id),
    text: payload.text,
    reply_markup: payload.reply_markup,
  });
  const messageId =
    Number.isInteger(sent?.message_id) && sent.message_id > 0
      ? sent.message_id
      : null;
  await service.zooStore.patchTopic({
    menu_message_id: messageId,
  });
  await pinMessageBestEffort(api, Number(topicState.chat_id), messageId);
  service.syncPetAnimationTicker(api, payload);
  return {
    topicState: await service.zooStore.loadTopic({ force: true }),
    created: true,
    messageId,
  };
}

export async function handleZooCommand(service, {
  api,
  message,
}) {
  const language = await service.resolveUiLanguage(message);
  let topicState = await service.ensureZooTopic(api, {
    uiLanguage: language,
  });
  if (normalizeUiLanguage(topicState.ui_language) !== language) {
    topicState = await service.zooStore.patchTopic({
      ui_language: language,
    });
  }
  await service.ensureZooMenu(api);
  const sourceIsZooTopic =
    String(message?.message_thread_id ?? "") === String(topicState.topic_id);

  return {
    handled: true,
    command: ZOO_COMMAND,
    reason: sourceIsZooTopic ? "zoo-menu-refreshed" : "zoo-topic-opened",
    ackText: buildZooTopicReadyMessage(topicState.topic_name, language),
    suppressAck: sourceIsZooTopic,
  };
}

export async function maybeHandleIncomingMessage(service, {
  api,
  botUsername,
  message,
}) {
  if (!isAuthorizedMessage(message, service.config)) {
    return { handled: false };
  }

  const command = extractBotCommand(message, botUsername);
  if (command?.name === ZOO_COMMAND) {
    return service.handleZooCommand({
      api,
      message,
    });
  }

  const inZooTopic = await service.isZooTopicMessage(message);
  if (!inZooTopic) {
    return { handled: false };
  }

  if (!message.text && !message.caption) {
    await deleteMessagesBestEffort(api, Number(message.chat.id), [
      Number(message.message_id),
    ]);
    await api.sendMessage({
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: buildZooUnsupportedMessage(await service.resolveUiLanguage(message)),
    });
    return { handled: true, reason: "zoo-unsupported-message" };
  }

  if (command || isForeignBotCommand(message, botUsername)) {
    await deleteMessagesBestEffort(api, Number(message.chat.id), [
      Number(message.message_id),
    ]);
    await api.sendMessage({
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: buildZooTopicOnlyCommandMessage(await service.resolveUiLanguage(message)),
    });
    return { handled: true, reason: "zoo-topic-rejected-command" };
  }

  return service.handleZooReply({
    api,
    message,
  });
}
