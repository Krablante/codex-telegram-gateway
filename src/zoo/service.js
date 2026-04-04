import path from "node:path";
import crypto from "node:crypto";

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
import { runZooProjectAnalysis } from "./analysis.js";
import { runZooProjectLookup } from "./lookup.js";
import {
  buildZooPetMarkup,
  buildZooPetText,
  buildZooRemoveConfirmMarkup,
  buildZooRemoveConfirmText,
  buildZooRootMarkupPage,
  buildZooRootText,
  ZOO_CALLBACK_PREFIX,
  ZOO_COMMAND,
  ZOO_DEFAULT_TOPIC_NAME,
  ZOO_ROOT_PAGE_SIZE,
} from "./render.js";
import {
  getZooPetCharacterName,
  getZooPetTemperamentProfile,
  ZOO_CHARACTER_NAMES,
  ZOO_CREATURE_KINDS,
  ZOO_TEMPERAMENT_IDS,
} from "./creatures.js";
import {
  buildPetIdFromPath,
  ZooStore,
} from "./store.js";

const YES_WORDS = new Set(["yes", "y", "да", "ага"]);
const NO_WORDS = new Set(["no", "n", "нет", "неа"]);
const ACTIVE_ZOO_OPERATION_CHAINS = new Map();
const ZOO_REFRESH_FRAME_TICK_MS = 12000;
const ZOO_IDLE_FRAME_TICK_MS = 20000;

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeRandomSourceValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.random();
  }

  if (parsed <= 0) {
    return 0;
  }
  if (parsed >= 1) {
    return 0.999999999999;
  }
  return parsed;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniquePositiveIntegers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function pickRandomValue(pool, randomSource = Math.random) {
  const candidates = uniqueStrings(pool);
  if (candidates.length === 0) {
    return null;
  }

  const randomValue = normalizeRandomSourceValue(randomSource());
  const index = Math.min(
    candidates.length - 1,
    Math.floor(randomValue * candidates.length),
  );
  return candidates[index];
}

function pickRandomUnusedValue(pool, usedValues, randomSource = Math.random) {
  const candidates = uniqueStrings(pool);
  const used = new Set(uniqueStrings(usedValues));
  const unused = candidates.filter((candidate) => !used.has(candidate));
  return pickRandomValue(unused.length > 0 ? unused : candidates, randomSource);
}

function isYes(text) {
  return YES_WORDS.has(String(text || "").trim().toLowerCase());
}

function isNo(text) {
  return NO_WORDS.has(String(text || "").trim().toLowerCase());
}

function buildZooTopicReadyMessage(topicName, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Zoo topic "${topicName}" is ready.`
    : `Zoo topic «${topicName}» готов.`;
}

function buildZooTopicOnlyCommandMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This topic is reserved for Zoo only. Use /zoo here."
    : "Этот топик зарезервирован только под Zoo. Используй здесь /zoo.";
}

function buildZooAddPromptMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Tell me what project this is so I can find it."
    : "Скажи, что это за проект, чтобы я смог его найти.";
}

function buildZooLookupBusyMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Project lookup is already running."
    : "Поиск проекта уже идёт.";
}

function buildZooLookupSearchingMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Searching the workspace for the project..."
    : "Ищу проект по workspace...";
}

function buildZooLookupNotFoundMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "I could not confidently find it. Describe it in more detail."
    : "Не смог уверенно найти проект. Опиши его подробнее.";
}

function buildZooLookupFailureMessage(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Lookup failed: ${error.message}`
    : `Поиск не удался: ${error.message}`;
}

function buildZooNeedsYesNoMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Reply Yes or No. If No, you can also send a better description right away."
    : "Ответь Да или Нет. Если Нет, можно сразу прислать более точное описание.";
}

function buildZooRefreshStartedText(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Analyzing the full project..."
    : "Анализирую весь проект...";
}

function buildZooRefreshFailureText(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Refresh failed: ${error.message}`
    : `Обновление не удалось: ${error.message}`;
}

function buildZooAddFailureMessage(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Add project failed: ${error.message}`
    : `Добавление проекта не удалось: ${error.message}`;
}

function buildZooUnsupportedMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This topic is Zoo-only. Use the Zoo menu."
    : "Этот топик только для Zoo. Используй меню Zoo.";
}

function buildZooOwnerMismatchMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This Zoo flow belongs to another operator."
    : "Этот Zoo-flow принадлежит другому оператору.";
}

function buildZooPathLabel(binding) {
  return binding.repo_root || binding.cwd;
}

function getZooProjectRoot(binding) {
  return binding.repo_root || binding.cwd || binding.resolved_path;
}

function sortPetsByDisplayName(left, right) {
  return String(left.display_name || left.pet_id).localeCompare(
    String(right.display_name || right.pet_id),
  );
}

function buildPetDisplayBaseName(value) {
  return path.basename(getZooProjectRoot(value) || "project") || "project";
}

function getPetDisplayVisibility(value, workspaceRoot) {
  const projectRoot = normalizeText(getZooProjectRoot(value));
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!projectRoot || !normalizedWorkspaceRoot) {
    return "priv";
  }

  const relativePath = path.relative(normalizedWorkspaceRoot, projectRoot);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "priv";
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments[0] === "work" && segments[1] === "public" ? "pub" : "priv";
}

function computeCanonicalPetDisplayNames(pets, workspaceRoot) {
  const entries = (pets || []).map((pet, index) => ({
    key: normalizeText(pet?.key) || normalizeText(pet?.pet_id) || `pet-${index}`,
    baseName: buildPetDisplayBaseName(pet),
    visibility: getPetDisplayVisibility(pet, workspaceRoot),
  }));

  const countsByBaseName = new Map();
  for (const entry of entries) {
    countsByBaseName.set(
      entry.baseName,
      (countsByBaseName.get(entry.baseName) || 0) + 1,
    );
  }

  return new Map(entries.map((entry) => [
    entry.key,
    countsByBaseName.get(entry.baseName) > 1
      ? `${entry.baseName} [${entry.visibility}]`
      : entry.baseName,
  ]));
}

function buildPendingCandidatePet(state) {
  const candidatePath = normalizeText(state?.pending_add?.candidate_path);
  if (state?.pending_add?.stage !== "await_confirmation" || !candidatePath) {
    return null;
  }

  return {
    key: "__candidate__",
    repo_root: candidatePath,
    cwd: candidatePath,
    resolved_path: candidatePath,
  };
}

function isRecoverableZooMenuEditError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to edit not found")
    || message.includes("message can't be edited")
  );
}

function isZooMenuNotModifiedError(error) {
  return String(error?.message ?? "").toLowerCase().includes("message is not modified");
}

function buildZooBindingForPet(binding, workspaceRoot) {
  const projectRoot = getZooProjectRoot(binding);
  return {
    projectRoot,
    cwdRelativeToWorkspaceRoot:
      path.relative(workspaceRoot, projectRoot) || ".",
  };
}

function isCurrentLookupRequest(topicState, lookupRequestId, requestedByUserId) {
  return (
    Boolean(lookupRequestId)
    && topicState?.pending_add?.busy === true
    && topicState.pending_add.lookup_request_id === lookupRequestId
    && topicState.pending_add.requested_by_user_id === requestedByUserId
  );
}

function parseCallbackData(data) {
  const [prefix, action, value] = String(data ?? "").split(":");
  if (prefix !== ZOO_CALLBACK_PREFIX || !action) {
    return null;
  }

  return {
    action,
    value: value || null,
  };
}

async function answerCallbackQuerySafe(api, callbackQueryId, text = undefined) {
  if (!callbackQueryId) {
    return;
  }

  try {
    await api.answerCallbackQuery(
      text
        ? {
            callback_query_id: callbackQueryId,
            text,
          }
        : {
            callback_query_id: callbackQueryId,
          },
    );
  } catch {}
}

async function deleteMessagesBestEffort(api, chatId, messageIds = []) {
  for (const messageId of messageIds) {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      continue;
    }
    try {
      await api.deleteMessage({
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {}
  }
}

async function pinMessageBestEffort(api, chatId, messageId) {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return;
  }

  try {
    await api.pinChatMessage({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
    // In forum topics Telegram emits a separate pin service message right after the pinned menu.
    await deleteMessagesBestEffort(api, chatId, [messageId + 1]);
  } catch {}
}

async function runSerializedZooOperation(key, operation) {
  const previous = ACTIVE_ZOO_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  ACTIVE_ZOO_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (ACTIVE_ZOO_OPERATION_CHAINS.get(key) === current) {
      ACTIVE_ZOO_OPERATION_CHAINS.delete(key);
    }
  }
}

export class ZooService {
  constructor({
    config,
    sessionService,
    globalControlPanelStore = null,
    zooStore = null,
    lookupRunner = runZooProjectLookup,
    analysisRunner = runZooProjectAnalysis,
    randomSource = Math.random,
  }) {
    this.config = config;
    this.sessionService = sessionService;
    this.globalControlPanelStore = globalControlPanelStore;
    this.zooStore = zooStore || new ZooStore(config.stateRoot);
    this.lookupRunner = lookupRunner;
    this.analysisRunner = analysisRunner;
    this.randomSource = randomSource;
    this.activeRefreshByPetId = new Map();
    this.petFrameIndexByPetId = new Map();
    this.petTickerByPetId = new Map();
    this.petTickerIntervalByPetId = new Map();
  }

  async resolveUiLanguage(message = null) {
    const topicId = normalizeText(message?.message_thread_id);
    const topicState = await this.zooStore.loadTopic();
    if (topicState.topic_id && topicId === topicState.topic_id) {
      return normalizeUiLanguage(topicState.ui_language);
    }

    if (topicId) {
      const session = await this.sessionService.ensureSessionForMessage(message);
      if (session) {
        return getSessionUiLanguage(session);
      }
    }

    if (this.globalControlPanelStore) {
      try {
        const state = await this.globalControlPanelStore.load({ force: true });
        return normalizeUiLanguage(state?.ui_language);
      } catch {}
    }

    return DEFAULT_UI_LANGUAGE;
  }

  pickPetIdentity(existingPets = []) {
    return {
      creature_kind: pickRandomUnusedValue(
        ZOO_CREATURE_KINDS,
        existingPets.map((pet) => pet.creature_kind),
        this.randomSource,
      ),
      temperament_id: pickRandomUnusedValue(
        ZOO_TEMPERAMENT_IDS,
        existingPets.map((pet) => getZooPetTemperamentProfile(pet)?.id),
        this.randomSource,
      ),
      character_name: pickRandomUnusedValue(
        ZOO_CHARACTER_NAMES,
        existingPets.map((pet) => getZooPetCharacterName(pet)),
        this.randomSource,
      ),
    };
  }

  async isZooTopicMessage(message) {
    const topicState = await this.zooStore.loadTopic();
    return (
      Boolean(topicState.topic_id)
      && String(message?.chat?.id ?? "") === String(topicState.chat_id || this.config.telegramForumChatId)
      && String(message?.message_thread_id ?? "") === String(topicState.topic_id)
    );
  }

  async ensureZooTopic(api, {
    uiLanguage = DEFAULT_UI_LANGUAGE,
  } = {}) {
    let topicState = await this.zooStore.loadTopic({ force: true });
    if (topicState.topic_id) {
      return topicState;
    }

    const forumTopic = await api.createForumTopic({
      chat_id: this.config.telegramForumChatId,
      name: ZOO_DEFAULT_TOPIC_NAME,
    });
    topicState = await this.zooStore.saveTopic({
      ...topicState,
      chat_id: String(this.config.telegramForumChatId),
      topic_id: String(forumTopic.message_thread_id),
      topic_name: forumTopic.name || ZOO_DEFAULT_TOPIC_NAME,
      ui_language: uiLanguage,
    });
    return topicState;
  }

  async buildMenuPayload() {
    let state = await this.zooStore.loadTopic({ force: true });
    const language = normalizeUiLanguage(state.ui_language);
    let selectedPet =
      state.selected_pet_id ? await this.zooStore.loadPet(state.selected_pet_id) : null;

    if (state.active_screen !== "root" && state.selected_pet_id && !selectedPet) {
      state = await this.zooStore.patchTopic({
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
      const selectedSnapshot = await this.zooStore.loadLatestSnapshot(selectedPet.pet_id);
      return {
        state,
        animationPetId: selectedPet.pet_id,
        text: buildZooPetText({
          language,
          pet: selectedPet,
          snapshot: selectedSnapshot,
          state,
          poseFrameIndex: this.petFrameIndexByPetId.get(selectedPet.pet_id) || 0,
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

    const pets = await this.reconcilePetDisplayNames(null, [
      buildPendingCandidatePet(state),
    ]);
    selectedPet =
      state.selected_pet_id ? await this.zooStore.loadPet(state.selected_pet_id) : null;
    const selectedSnapshot =
      selectedPet ? await this.zooStore.loadLatestSnapshot(selectedPet.pet_id) : null;
    const totalPages = Math.max(1, Math.ceil(pets.length / ZOO_ROOT_PAGE_SIZE));
    const currentPage = Math.max(0, Math.min(state.root_page || 0, totalPages - 1));
    if (currentPage !== (state.root_page || 0)) {
      state = await this.zooStore.patchTopic({
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

  async ensureZooMenu(api, {
    forceNew = false,
  } = {}) {
    let topicState = await this.zooStore.loadTopic({ force: true });
    if (!topicState.topic_id) {
      topicState = await this.ensureZooTopic(api, {
        uiLanguage: topicState.ui_language,
      });
    }

    const payload = await this.buildMenuPayload();
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
        this.syncPetAnimationTicker(api, payload);
        return {
          topicState: await this.zooStore.patchTopic({
            menu_message_id: existingMessageId,
          }),
          created: false,
          messageId: existingMessageId,
        };
      } catch (error) {
        if (isZooMenuNotModifiedError(error)) {
          this.syncPetAnimationTicker(api, payload);
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
    await this.zooStore.patchTopic({
      menu_message_id: messageId,
    });
    await pinMessageBestEffort(api, Number(topicState.chat_id), messageId);
    this.syncPetAnimationTicker(api, payload);
    return {
      topicState: await this.zooStore.loadTopic({ force: true }),
      created: true,
      messageId,
    };
  }

  async handleZooCommand({
    api,
    message,
  }) {
    const language = await this.resolveUiLanguage(message);
    let topicState = await this.ensureZooTopic(api, {
      uiLanguage: language,
    });
    if (normalizeUiLanguage(topicState.ui_language) !== language) {
      topicState = await this.zooStore.patchTopic({
        ui_language: language,
      });
    }
    await this.ensureZooMenu(api);
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

  async maybeHandleIncomingMessage({
    api,
    botUsername,
    message,
  }) {
    if (!isAuthorizedMessage(message, this.config)) {
      return { handled: false };
    }

    const command = extractBotCommand(message, botUsername);
    if (command?.name === ZOO_COMMAND) {
      return this.handleZooCommand({
        api,
        message,
      });
    }

    const inZooTopic = await this.isZooTopicMessage(message);
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
        text: buildZooUnsupportedMessage(await this.resolveUiLanguage(message)),
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
        text: buildZooTopicOnlyCommandMessage(await this.resolveUiLanguage(message)),
      });
      return { handled: true, reason: "zoo-topic-rejected-command" };
    }

    return this.handleZooReply({
      api,
      message,
    });
  }

  async handleZooReply({
    api,
    message,
  }) {
    const topicState = await this.zooStore.loadTopic({ force: true });
    const language = normalizeUiLanguage(topicState.ui_language);
    const pendingAdd = topicState.pending_add;
    const text = normalizeText(message.text ?? message.caption);

    if (!pendingAdd || !text) {
      await deleteMessagesBestEffort(api, Number(message.chat.id), [
        Number(message.message_id),
      ]);
      await api.sendMessage({
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: buildZooUnsupportedMessage(language),
      });
      return { handled: true, reason: "zoo-topic-unsupported-prompt" };
    }

    if (
      pendingAdd.requested_by_user_id
      && String(message.from?.id ?? "") !== pendingAdd.requested_by_user_id
    ) {
      await deleteMessagesBestEffort(api, Number(message.chat.id), [
        Number(message.message_id),
      ]);
      await api.sendMessage({
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: buildZooOwnerMismatchMessage(language),
      });
      return { handled: true, reason: "zoo-owner-mismatch" };
    }

    if (pendingAdd.busy) {
      await deleteMessagesBestEffort(api, Number(message.chat.id), [
        Number(message.message_id),
      ]);
      await api.sendMessage({
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        text: buildZooLookupBusyMessage(language),
      });
      return { handled: true, reason: "zoo-lookup-busy" };
    }

    if (pendingAdd.stage === "await_description") {
      await this.beginLookup({
        api,
        message,
        description: text,
      });
      return { handled: true, reason: "zoo-lookup-started" };
    }

    if (pendingAdd.stage === "await_confirmation") {
      if (isYes(text)) {
        await this.confirmPendingAdd({
          api,
          message,
          topicState,
        });
        return { handled: true, reason: "zoo-add-confirmed" };
      }

      if (isNo(text)) {
        await deleteMessagesBestEffort(api, Number(message.chat.id), [
          Number(message.message_id),
        ]);
        await this.zooStore.patchTopic({
          pending_add: {
            ...pendingAdd,
            stage: "await_description",
            prompt_message_id: null,
            candidate_message_id: null,
            candidate_path: null,
            candidate_display_name: null,
            candidate_reason: null,
            candidate_question: null,
            lookup_request_id: null,
            prompt_hint_text: buildZooAddPromptMessage(language),
            cleanup_message_ids: [
              ...pendingAdd.cleanup_message_ids,
              Number(message.message_id),
            ],
          },
        });
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-add-retry" };
      }

      if (text.length > 2) {
        await this.beginLookup({
          api,
          message,
          description: text,
        });
        return { handled: true, reason: "zoo-lookup-restarted" };
      }

      await deleteMessagesBestEffort(api, Number(message.chat.id), [
        Number(message.message_id),
      ]);
      await this.zooStore.patchTopic({
        pending_add: {
          ...pendingAdd,
          prompt_hint_text: buildZooNeedsYesNoMessage(language),
          cleanup_message_ids: [
            ...pendingAdd.cleanup_message_ids,
            Number(message.message_id),
          ],
        },
      });
      await this.ensureZooMenu(api);
      return { handled: true, reason: "zoo-needs-yes-no" };
    }

    return { handled: false };
  }

  async beginLookup({
    api,
    message,
    description,
  }) {
    const topicState = await this.zooStore.loadTopic({ force: true });
    const language = normalizeUiLanguage(topicState.ui_language);
    const pendingAdd = topicState.pending_add;
    const lookupRequestId = crypto.randomUUID();
    await this.zooStore.patchTopic({
      pending_add: {
        ...pendingAdd,
        stage: "await_description",
        busy: true,
        description,
        requested_by_user_id: String(message.from.id),
        lookup_request_id: lookupRequestId,
        prompt_hint_text: buildZooLookupSearchingMessage(language),
        cleanup_message_ids: [
          ...(pendingAdd?.cleanup_message_ids || []),
          Number(message.message_id),
        ],
      },
      last_refresh_error_text: null,
    });
    await deleteMessagesBestEffort(api, Number(message.chat.id), [
      Number(message.message_id),
    ]);
    await this.ensureZooMenu(api);

    const userKey = String(message.from.id);
    void this.runLookup({
      api,
      description,
      requestedByUserId: userKey,
      language,
      lookupRequestId,
    });
  }

  async runLookup({
    api,
    description,
    requestedByUserId,
    language,
    lookupRequestId,
  }) {
    try {
      const lookup = await this.lookupRunner({
        codexBinPath: this.config.codexBinPath,
        outputDir: this.zooStore.runsDir,
        workspaceRoot: this.config.workspaceRoot,
        description,
      });
      let currentTopicState = await this.zooStore.loadTopic({ force: true });
      if (!isCurrentLookupRequest(currentTopicState, lookupRequestId, requestedByUserId)) {
        return;
      }

      if (!lookup.candidatePath || lookup.needsMoreDetail) {
        await this.zooStore.patchTopic({
          pending_add: {
            ...currentTopicState.pending_add,
            stage: "await_description",
            busy: false,
            candidate_path: null,
            candidate_display_name: null,
            candidate_reason: null,
            candidate_question: null,
            prompt_hint_text: buildZooLookupNotFoundMessage(language),
            cleanup_message_ids: [
              ...(currentTopicState.pending_add?.cleanup_message_ids || []),
            ],
          },
        });
        await this.ensureZooMenu(api);
        return;
      }

      const binding = await this.sessionService.resolveBindingPath(lookup.candidatePath);
      currentTopicState = await this.zooStore.loadTopic({ force: true });
      if (!isCurrentLookupRequest(currentTopicState, lookupRequestId, requestedByUserId)) {
        return;
      }
      const existingPets = await this.reconcilePetDisplayNames();
      const candidateDisplayNames = computeCanonicalPetDisplayNames([
        ...existingPets,
        {
          key: "__candidate__",
          repo_root: getZooProjectRoot(binding),
          cwd: getZooProjectRoot(binding),
          resolved_path: getZooProjectRoot(binding),
        },
      ], this.config.workspaceRoot);
      await this.persistCanonicalPetDisplayNames(existingPets, candidateDisplayNames);
      await this.zooStore.patchTopic({
        pending_add: {
          ...currentTopicState.pending_add,
          stage: "await_confirmation",
          busy: false,
          requested_by_user_id: requestedByUserId,
          candidate_message_id: null,
          candidate_path: buildZooPathLabel(binding),
          candidate_display_name:
            candidateDisplayNames.get("__candidate__") || buildPetDisplayBaseName(binding),
          candidate_reason: normalizeText(lookup.reason),
          candidate_question: normalizeText(lookup.question),
          prompt_hint_text: null,
          cleanup_message_ids: [
            ...(currentTopicState.pending_add?.cleanup_message_ids || []),
          ],
        },
      });
      await this.ensureZooMenu(api);
    } catch (error) {
      const topicState = await this.zooStore.loadTopic({ force: true });
      if (!isCurrentLookupRequest(topicState, lookupRequestId, requestedByUserId)) {
        return;
      }
      await api.sendMessage({
        chat_id: Number(topicState.chat_id),
        message_thread_id: Number(topicState.topic_id),
        text: buildZooLookupFailureMessage(error, language),
      });
      await this.zooStore.patchTopic({
        pending_add: {
          ...topicState.pending_add,
          stage: "await_description",
          busy: false,
          candidate_message_id: null,
          candidate_path: null,
          candidate_display_name: null,
          candidate_reason: null,
          candidate_question: null,
          prompt_hint_text: buildZooAddPromptMessage(language),
          cleanup_message_ids: [
            ...(topicState.pending_add?.cleanup_message_ids || []),
          ],
        },
      });
      await this.ensureZooMenu(api);
    }
  }

  async confirmPendingAdd({
    api,
    message,
    topicState,
  }) {
    const pendingAdd = topicState.pending_add;
    const language = normalizeUiLanguage(topicState.ui_language);

    try {
      const binding = await this.sessionService.resolveBindingPath(pendingAdd.candidate_path);
      const zooBinding = buildZooBindingForPet(binding, this.config.workspaceRoot);
      const existingPet = await this.zooStore.findPetByResolvedPath(zooBinding.projectRoot);
      if (existingPet) {
        await this.zooStore.patchTopic({
          active_screen: "pet",
          selected_pet_id: existingPet.pet_id,
          pending_add: null,
        });
        await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
          ...(pendingAdd.cleanup_message_ids || []),
          Number(message.message_id),
        ]);
        await this.ensureZooMenu(api);
        return;
      }

      const existingPets = await this.reconcilePetDisplayNames();
      const petIdentity = this.pickPetIdentity(existingPets);
      const petId = buildPetIdFromPath(zooBinding.projectRoot);
      const displayNames = computeCanonicalPetDisplayNames([
        ...existingPets,
        {
          key: petId,
          repo_root: zooBinding.projectRoot,
          cwd: zooBinding.projectRoot,
          resolved_path: zooBinding.projectRoot,
        },
      ], this.config.workspaceRoot);
      await this.persistCanonicalPetDisplayNames(existingPets, displayNames);
      const pet = await this.zooStore.savePet({
        pet_id: petId,
        display_name: displayNames.get(petId) || buildPetDisplayBaseName(binding),
        resolved_path: zooBinding.projectRoot,
        repo_root: zooBinding.projectRoot,
        cwd: zooBinding.projectRoot,
        cwd_relative_to_workspace_root: zooBinding.cwdRelativeToWorkspaceRoot,
        creature_kind: petIdentity.creature_kind,
        temperament_id: petIdentity.temperament_id,
        character_name: petIdentity.character_name,
      });
      await this.zooStore.patchTopic({
        active_screen: "pet",
        selected_pet_id: pet.pet_id,
        pending_add: null,
        last_refresh_error_text: null,
      });
      await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
        ...(pendingAdd.cleanup_message_ids || []),
        Number(message.message_id),
      ]);
      await this.ensureZooMenu(api);
    } catch (error) {
      await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
        Number(message.message_id),
      ]);
      await api.sendMessage({
        chat_id: Number(topicState.chat_id),
        message_thread_id: Number(topicState.topic_id),
        text: buildZooAddFailureMessage(error, language),
      });
      await this.zooStore.patchTopic({
        pending_add: {
          ...pendingAdd,
          stage: "await_description",
          busy: false,
          prompt_message_id: null,
          candidate_message_id: null,
          candidate_path: null,
          candidate_display_name: null,
          candidate_reason: null,
          candidate_question: null,
          lookup_request_id: null,
          prompt_hint_text: buildZooAddPromptMessage(language),
          cleanup_message_ids: uniquePositiveIntegers([
            ...(pendingAdd.cleanup_message_ids || []),
            Number(message.message_id),
          ]),
        },
      });
      await this.ensureZooMenu(api);
    }
  }

  async persistCanonicalPetDisplayNames(pets, displayNames) {
    const nextPets = [];
    for (const pet of pets || []) {
      const displayName = displayNames.get(pet.pet_id) || buildPetDisplayBaseName(pet);
      if (pet.display_name !== displayName) {
        nextPets.push(await this.zooStore.savePet({
          ...pet,
          display_name: displayName,
        }));
        continue;
      }
      nextPets.push(pet);
    }

    return nextPets.sort(sortPetsByDisplayName);
  }

  async reconcilePetDisplayNames(pets = null, extraPets = []) {
    const currentPets = Array.isArray(pets) ? pets : await this.zooStore.listPets();
    const displayNames = computeCanonicalPetDisplayNames(
      [
        ...currentPets,
        ...(extraPets || []).filter(Boolean),
      ],
      this.config.workspaceRoot,
    );
    return this.persistCanonicalPetDisplayNames(currentPets, displayNames);
  }

  async clearMissingPetRefreshState(api, petId) {
    const topicState = await this.zooStore.loadTopic({ force: true });
    if (
      topicState.refreshing_pet_id !== petId
      && topicState.selected_pet_id !== petId
    ) {
      return;
    }

    await this.zooStore.patchTopic({
      active_screen:
        topicState.selected_pet_id === petId
          ? "root"
          : topicState.active_screen,
      selected_pet_id:
        topicState.selected_pet_id === petId
          ? null
          : topicState.selected_pet_id,
      refreshing_pet_id:
        topicState.refreshing_pet_id === petId
          ? null
          : topicState.refreshing_pet_id,
      refresh_status_text:
        topicState.refreshing_pet_id === petId
          ? null
          : topicState.refresh_status_text,
      last_refresh_error_text: null,
    });
    await this.ensureZooMenu(api);
  }

  async handleCallbackQuery({
    api,
    callbackQuery,
  }) {
    const parsed = parseCallbackData(callbackQuery?.data);
    if (!parsed) {
      return { handled: false };
    }

    if (!isAuthorizedMessage({
      from: callbackQuery?.from,
      chat: callbackQuery?.message?.chat,
    }, this.config)) {
      await answerCallbackQuerySafe(api, callbackQuery.id);
      return { handled: true, reason: "unauthorized" };
    }

    await answerCallbackQuerySafe(api, callbackQuery.id);
    return runSerializedZooOperation("zoo", async () => {
      const topicState = await this.zooStore.loadTopic({ force: true });
      const language = normalizeUiLanguage(topicState.ui_language);
      if (
        String(callbackQuery?.message?.message_thread_id ?? "") !== String(topicState.topic_id)
      ) {
        return { handled: true, reason: "zoo-callback-foreign-topic" };
      }

      if (parsed.action === "noop") {
        return { handled: true, reason: "zoo-noop" };
      }

      if (parsed.action === "m" && parsed.value === "respawn") {
        const previousMenuMessageId = Number(topicState.menu_message_id);
        await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
          previousMenuMessageId,
          previousMenuMessageId + 1,
        ]);
        await this.zooStore.patchTopic({
          menu_message_id: null,
        });
        await this.ensureZooMenu(api, {
          forceNew: true,
        });
        return { handled: true, reason: "zoo-menu-respawned" };
      }

      if (parsed.action === "n" && parsed.value === "root") {
        await this.zooStore.patchTopic({
          active_screen: "root",
          selected_pet_id: null,
        });
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-root-opened" };
      }

      if (parsed.action === "p" && parsed.value) {
        const requestedPage = Math.max(0, Number.parseInt(parsed.value, 10) || 0);
        await this.zooStore.patchTopic({
          active_screen: "root",
          selected_pet_id: null,
          root_page: requestedPage,
        });
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-root-page-opened" };
      }

      if (parsed.action === "a" && parsed.value === "start") {
        if (topicState.pending_add?.busy) {
          await this.ensureZooMenu(api);
          return { handled: true, reason: "zoo-add-busy" };
        }
        await deleteMessagesBestEffort(
          api,
          Number(topicState.chat_id),
          topicState.pending_add?.cleanup_message_ids || [],
        );
        await this.zooStore.patchTopic({
          active_screen: "root",
          pending_add: {
            kind: "add_project",
            stage: "await_description",
            busy: false,
            requested_at: new Date().toISOString(),
            requested_by_user_id: String(callbackQuery.from.id),
            lookup_request_id: null,
            prompt_message_id: null,
            candidate_message_id: null,
            description: null,
            candidate_path: null,
            candidate_display_name: null,
            candidate_reason: null,
            candidate_question: null,
            prompt_hint_text: buildZooAddPromptMessage(language),
            cleanup_message_ids: [],
          },
        });
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-add-started" };
      }

      if (parsed.action === "v" && parsed.value) {
        const pet = await this.zooStore.loadPet(parsed.value);
        if (!pet) {
          await this.zooStore.patchTopic({
            active_screen: "root",
            selected_pet_id: null,
          });
        } else {
          await this.zooStore.patchTopic({
            active_screen: "pet",
            selected_pet_id: pet.pet_id,
            last_refresh_error_text:
              topicState.selected_pet_id === pet.pet_id
                ? topicState.last_refresh_error_text
                : null,
          });
        }
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-pet-opened" };
      }

      if (parsed.action === "d" && parsed.value) {
        if (this.activeRefreshByPetId.has(parsed.value)) {
          return { handled: true, reason: "zoo-remove-blocked-during-refresh" };
        }
        await this.zooStore.patchTopic({
          active_screen: "remove_confirm",
          selected_pet_id: parsed.value,
        });
        await this.ensureZooMenu(api);
        return { handled: true, reason: "zoo-remove-confirm" };
      }

      if (parsed.action === "x" && parsed.value) {
        if (this.activeRefreshByPetId.has(parsed.value)) {
          return { handled: true, reason: "zoo-remove-blocked-during-refresh" };
        }
        const pet = await this.zooStore.loadPet(parsed.value);
        if (pet) {
          await this.zooStore.deletePet(parsed.value);
          await this.zooStore.patchTopic({
            active_screen: "root",
            selected_pet_id: null,
            last_refresh_error_text: null,
          });
          await this.ensureZooMenu(api);
        }
        return { handled: true, reason: "zoo-removed" };
      }

      if (parsed.action === "r" && parsed.value) {
        if (this.activeRefreshByPetId.has(parsed.value)) {
          return { handled: true, reason: "zoo-refresh-already-running" };
        }
        const pet = await this.zooStore.loadPet(parsed.value);
        if (!pet) {
          return { handled: true, reason: "zoo-refresh-missing-pet" };
        }
        await this.zooStore.patchTopic({
          active_screen: "pet",
          selected_pet_id: pet.pet_id,
          refreshing_pet_id: pet.pet_id,
          refresh_status_text: buildZooRefreshStartedText(language),
          last_refresh_error_text: null,
        });
        this.petFrameIndexByPetId.set(pet.pet_id, 0);
        await this.ensureZooMenu(api);
        const refreshPromise = this.runRefresh({
          api,
          pet,
          language,
        }).finally(() => {
          this.activeRefreshByPetId.delete(pet.pet_id);
        });
        this.activeRefreshByPetId.set(pet.pet_id, refreshPromise);
        return { handled: true, reason: "zoo-refresh-started" };
      }

      return { handled: true, reason: "zoo-unsupported-callback" };
    });
  }

  async runRefresh({
    api,
    pet,
    language,
  }) {
    try {
      const previousSnapshot = await this.zooStore.loadLatestSnapshot(pet.pet_id);
      const snapshot = await this.analysisRunner({
        codexBinPath: this.config.codexBinPath,
        outputDir: this.zooStore.runsDir,
        pet,
        previousSnapshot,
        language,
      });
      const currentPet = await this.zooStore.loadPet(pet.pet_id);
      if (!currentPet) {
        await this.clearMissingPetRefreshState(api, pet.pet_id);
        return;
      }
      await this.zooStore.saveLatestSnapshot(pet.pet_id, snapshot);
      await this.zooStore.patchTopic({
        active_screen: "pet",
        selected_pet_id: pet.pet_id,
        refreshing_pet_id: null,
        refresh_status_text: null,
        last_refresh_error_text: null,
      });
      await this.ensureZooMenu(api);
    } catch (error) {
      const currentPet = await this.zooStore.loadPet(pet.pet_id);
      if (!currentPet) {
        await this.clearMissingPetRefreshState(api, pet.pet_id);
        return;
      }
      await this.zooStore.patchTopic({
        active_screen: "pet",
        selected_pet_id: pet.pet_id,
        refreshing_pet_id: null,
        refresh_status_text: null,
        last_refresh_error_text: buildZooRefreshFailureText(error, language),
      });
      await this.ensureZooMenu(api);
    }
  }

  syncPetAnimationTicker(api, payload) {
    const desiredPetId = payload?.animationPetId || null;
    const state = payload?.state;
    const desiredIntervalMs = desiredPetId
      ? (state?.refreshing_pet_id === desiredPetId
          ? ZOO_REFRESH_FRAME_TICK_MS
          : ZOO_IDLE_FRAME_TICK_MS)
      : null;

    for (const petId of this.petTickerByPetId.keys()) {
      if (petId !== desiredPetId) {
        this.stopPetTicker(petId);
      }
    }

    if (!desiredPetId || !Number.isInteger(desiredIntervalMs)) {
      return;
    }

    if (
      this.petTickerByPetId.has(desiredPetId)
      && this.petTickerIntervalByPetId.get(desiredPetId) === desiredIntervalMs
    ) {
      return;
    }

    this.startPetTicker(api, desiredPetId, desiredIntervalMs);
  }

  startPetTicker(api, petId, intervalMs) {
    this.stopPetTicker(petId);
    this.petTickerIntervalByPetId.set(petId, intervalMs);
    this.petFrameIndexByPetId.set(petId, this.petFrameIndexByPetId.get(petId) || 0);
    const timer = setInterval(() => {
      const topicState = this.zooStore.readTopicState();
      if (
        topicState?.active_screen !== "pet"
        || topicState?.selected_pet_id !== petId
      ) {
        this.stopPetTicker(petId);
        return;
      }
      const nextIndex = (this.petFrameIndexByPetId.get(petId) || 0) + 1;
      this.petFrameIndexByPetId.set(petId, nextIndex);
      void this.ensureZooMenu(api).catch(() => {});
    }, intervalMs);
    timer.unref?.();
    this.petTickerByPetId.set(petId, timer);
  }

  stopPetTicker(petId) {
    const timer = this.petTickerByPetId.get(petId);
    if (timer) {
      clearInterval(timer);
      this.petTickerByPetId.delete(petId);
    }
    this.petTickerIntervalByPetId.delete(petId);
    this.petFrameIndexByPetId.delete(petId);
  }
}
