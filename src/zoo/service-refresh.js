import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { isAuthorizedMessage } from "../telegram/command-parsing.js";
import {
  answerCallbackQuerySafe,
  buildZooAddPromptMessage,
  buildZooRefreshFailureText,
  buildZooRefreshStartedText,
  deleteMessagesBestEffort,
  parseCallbackData,
  runSerializedZooOperation,
  ZOO_IDLE_FRAME_TICK_MS,
  ZOO_REFRESH_FRAME_TICK_MS,
} from "./service-common.js";

export async function clearMissingPetRefreshState(service, api, petId) {
  const topicState = await service.zooStore.loadTopic({ force: true });
  if (
    topicState.refreshing_pet_id !== petId
    && topicState.selected_pet_id !== petId
  ) {
    return;
  }

  await service.zooStore.patchTopic({
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
  await service.ensureZooMenu(api);
}

export async function handleCallbackQuery(service, {
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
  }, service.config)) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return { handled: true, reason: "unauthorized" };
  }

  await answerCallbackQuerySafe(api, callbackQuery.id);
  return runSerializedZooOperation("zoo", async () => {
    const topicState = await service.zooStore.loadTopic({ force: true });
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
      await service.zooStore.patchTopic({
        menu_message_id: null,
      });
      await service.ensureZooMenu(api, {
        forceNew: true,
      });
      return { handled: true, reason: "zoo-menu-respawned" };
    }

    if (parsed.action === "n" && parsed.value === "root") {
      await service.zooStore.patchTopic({
        active_screen: "root",
        selected_pet_id: null,
      });
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-root-opened" };
    }

    if (parsed.action === "p" && parsed.value) {
      const requestedPage = Math.max(0, Number.parseInt(parsed.value, 10) || 0);
      await service.zooStore.patchTopic({
        active_screen: "root",
        selected_pet_id: null,
        root_page: requestedPage,
      });
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-root-page-opened" };
    }

    if (parsed.action === "a" && parsed.value === "start") {
      if (topicState.pending_add?.busy) {
        await service.ensureZooMenu(api);
        return { handled: true, reason: "zoo-add-busy" };
      }
      await deleteMessagesBestEffort(
        api,
        Number(topicState.chat_id),
        topicState.pending_add?.cleanup_message_ids || [],
      );
      await service.zooStore.patchTopic({
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
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-add-started" };
    }

    if (parsed.action === "v" && parsed.value) {
      const pet = await service.zooStore.loadPet(parsed.value);
      if (!pet) {
        await service.zooStore.patchTopic({
          active_screen: "root",
          selected_pet_id: null,
        });
      } else {
        await service.zooStore.patchTopic({
          active_screen: "pet",
          selected_pet_id: pet.pet_id,
          last_refresh_error_text:
            topicState.selected_pet_id === pet.pet_id
              ? topicState.last_refresh_error_text
              : null,
        });
      }
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-pet-opened" };
    }

    if (parsed.action === "d" && parsed.value) {
      if (service.activeRefreshByPetId.has(parsed.value)) {
        return { handled: true, reason: "zoo-remove-blocked-during-refresh" };
      }
      await service.zooStore.patchTopic({
        active_screen: "remove_confirm",
        selected_pet_id: parsed.value,
      });
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-remove-confirm" };
    }

    if (parsed.action === "x" && parsed.value) {
      if (service.activeRefreshByPetId.has(parsed.value)) {
        return { handled: true, reason: "zoo-remove-blocked-during-refresh" };
      }
      const pet = await service.zooStore.loadPet(parsed.value);
      if (pet) {
        await service.zooStore.deletePet(parsed.value);
        await service.zooStore.patchTopic({
          active_screen: "root",
          selected_pet_id: null,
          last_refresh_error_text: null,
        });
        await service.ensureZooMenu(api);
      }
      return { handled: true, reason: "zoo-removed" };
    }

    if (parsed.action === "r" && parsed.value) {
      if (service.activeRefreshByPetId.has(parsed.value)) {
        return { handled: true, reason: "zoo-refresh-already-running" };
      }
      const pet = await service.zooStore.loadPet(parsed.value);
      if (!pet) {
        return { handled: true, reason: "zoo-refresh-missing-pet" };
      }
      await service.zooStore.patchTopic({
        active_screen: "pet",
        selected_pet_id: pet.pet_id,
        refreshing_pet_id: pet.pet_id,
        refresh_status_text: buildZooRefreshStartedText(language),
        last_refresh_error_text: null,
      });
      service.petFrameIndexByPetId.set(pet.pet_id, 0);
      await service.ensureZooMenu(api);
      const refreshPromise = service.runRefresh({
        api,
        pet,
        language,
      }).finally(() => {
        service.activeRefreshByPetId.delete(pet.pet_id);
      });
      service.activeRefreshByPetId.set(pet.pet_id, refreshPromise);
      return { handled: true, reason: "zoo-refresh-started" };
    }

    return { handled: true, reason: "zoo-unsupported-callback" };
  });
}

export async function runRefresh(service, {
  api,
  pet,
  language,
}) {
  try {
    const previousSnapshot = await service.zooStore.loadLatestSnapshot(pet.pet_id);
    const snapshot = await service.analysisRunner({
      codexBinPath: service.config.codexBinPath,
      outputDir: service.zooStore.runsDir,
      pet,
      previousSnapshot,
      language,
    });
    const currentPet = await service.zooStore.loadPet(pet.pet_id);
    if (!currentPet) {
      await service.clearMissingPetRefreshState(api, pet.pet_id);
      return;
    }
    await service.zooStore.saveLatestSnapshot(pet.pet_id, snapshot);
    await service.zooStore.patchTopic({
      active_screen: "pet",
      selected_pet_id: pet.pet_id,
      refreshing_pet_id: null,
      refresh_status_text: null,
      last_refresh_error_text: null,
    });
    await service.ensureZooMenu(api);
  } catch (error) {
    const currentPet = await service.zooStore.loadPet(pet.pet_id);
    if (!currentPet) {
      await service.clearMissingPetRefreshState(api, pet.pet_id);
      return;
    }
    await service.zooStore.patchTopic({
      active_screen: "pet",
      selected_pet_id: pet.pet_id,
      refreshing_pet_id: null,
      refresh_status_text: null,
      last_refresh_error_text: buildZooRefreshFailureText(error, language),
    });
    await service.ensureZooMenu(api);
  }
}

export function syncPetAnimationTicker(service, api, payload) {
  const desiredPetId = payload?.animationPetId || null;
  const state = payload?.state;
  const desiredIntervalMs = desiredPetId
    ? (state?.refreshing_pet_id === desiredPetId
        ? ZOO_REFRESH_FRAME_TICK_MS
        : ZOO_IDLE_FRAME_TICK_MS)
    : null;

  for (const petId of service.petTickerByPetId.keys()) {
    if (petId !== desiredPetId) {
      service.stopPetTicker(petId);
    }
  }

  if (!desiredPetId || !Number.isInteger(desiredIntervalMs)) {
    return;
  }

  if (
    service.petTickerByPetId.has(desiredPetId)
    && service.petTickerIntervalByPetId.get(desiredPetId) === desiredIntervalMs
  ) {
    return;
  }

  service.startPetTicker(api, desiredPetId, desiredIntervalMs);
}

export function startPetTicker(service, api, petId, intervalMs) {
  service.stopPetTicker(petId);
  service.petTickerIntervalByPetId.set(petId, intervalMs);
  service.petFrameIndexByPetId.set(petId, service.petFrameIndexByPetId.get(petId) || 0);
  const timer = setInterval(() => {
    const topicState = service.zooStore.readTopicState();
    if (
      topicState?.active_screen !== "pet"
      || topicState?.selected_pet_id !== petId
    ) {
      service.stopPetTicker(petId);
      return;
    }
    const nextIndex = (service.petFrameIndexByPetId.get(petId) || 0) + 1;
    service.petFrameIndexByPetId.set(petId, nextIndex);
    void service.ensureZooMenu(api).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  service.petTickerByPetId.set(petId, timer);
}

export function stopPetTicker(service, petId) {
  const timer = service.petTickerByPetId.get(petId);
  if (timer) {
    clearInterval(timer);
    service.petTickerByPetId.delete(petId);
  }
  service.petTickerIntervalByPetId.delete(petId);
  service.petFrameIndexByPetId.delete(petId);
}
