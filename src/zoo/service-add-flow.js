import crypto from "node:crypto";

import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { buildPetIdFromPath } from "./store.js";
import {
  buildPetDisplayBaseName,
  buildZooAddFailureMessage,
  buildZooAddPromptMessage,
  buildZooBindingForPet,
  buildZooLookupBusyMessage,
  buildZooLookupFailureMessage,
  buildZooLookupNotFoundMessage,
  buildZooLookupSearchingMessage,
  buildZooNeedsYesNoMessage,
  buildZooOwnerMismatchMessage,
  buildZooPathLabel,
  buildZooUnsupportedMessage,
  computeCanonicalPetDisplayNames,
  deleteMessagesBestEffort,
  getZooProjectRoot,
  isCurrentLookupRequest,
  isNo,
  isYes,
  normalizeText,
  sortPetsByDisplayName,
  uniquePositiveIntegers,
} from "./service-common.js";

export async function handleZooReply(service, {
  api,
  message,
}) {
  const topicState = await service.zooStore.loadTopic({ force: true });
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
    await service.beginLookup({
      api,
      message,
      description: text,
    });
    return { handled: true, reason: "zoo-lookup-started" };
  }

  if (pendingAdd.stage === "await_confirmation") {
    if (isYes(text)) {
      await service.confirmPendingAdd({
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
      await service.zooStore.patchTopic({
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
      await service.ensureZooMenu(api);
      return { handled: true, reason: "zoo-add-retry" };
    }

    if (text.length > 2) {
      await service.beginLookup({
        api,
        message,
        description: text,
      });
      return { handled: true, reason: "zoo-lookup-restarted" };
    }

    await deleteMessagesBestEffort(api, Number(message.chat.id), [
      Number(message.message_id),
    ]);
    await service.zooStore.patchTopic({
      pending_add: {
        ...pendingAdd,
        prompt_hint_text: buildZooNeedsYesNoMessage(language),
        cleanup_message_ids: [
          ...pendingAdd.cleanup_message_ids,
          Number(message.message_id),
        ],
      },
    });
    await service.ensureZooMenu(api);
    return { handled: true, reason: "zoo-needs-yes-no" };
  }

  return { handled: false };
}

export async function beginLookup(service, {
  api,
  message,
  description,
}) {
  const topicState = await service.zooStore.loadTopic({ force: true });
  const language = normalizeUiLanguage(topicState.ui_language);
  const pendingAdd = topicState.pending_add;
  const lookupRequestId = crypto.randomUUID();
  await service.zooStore.patchTopic({
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
  await service.ensureZooMenu(api);

  const userKey = String(message.from.id);
  void service.runLookup({
    api,
    description,
    requestedByUserId: userKey,
    language,
    lookupRequestId,
  });
}

export async function runLookup(service, {
  api,
  description,
  requestedByUserId,
  language,
  lookupRequestId,
}) {
  try {
    const lookup = await service.lookupRunner({
      codexBinPath: service.config.codexBinPath,
      outputDir: service.zooStore.runsDir,
      workspaceRoot: service.config.atlasWorkspaceRoot,
      description,
    });
    let currentTopicState = await service.zooStore.loadTopic({ force: true });
    if (!isCurrentLookupRequest(currentTopicState, lookupRequestId, requestedByUserId)) {
      return;
    }

    if (!lookup.candidatePath || lookup.needsMoreDetail) {
      await service.zooStore.patchTopic({
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
      await service.ensureZooMenu(api);
      return;
    }

    const binding = await service.sessionService.resolveBindingPath(lookup.candidatePath);
    currentTopicState = await service.zooStore.loadTopic({ force: true });
    if (!isCurrentLookupRequest(currentTopicState, lookupRequestId, requestedByUserId)) {
      return;
    }
    const existingPets = await service.reconcilePetDisplayNames();
    const candidateDisplayNames = computeCanonicalPetDisplayNames([
      ...existingPets,
      {
        key: "__candidate__",
        repo_root: getZooProjectRoot(binding),
        cwd: getZooProjectRoot(binding),
        resolved_path: getZooProjectRoot(binding),
      },
    ], service.config.atlasWorkspaceRoot);
    await service.persistCanonicalPetDisplayNames(existingPets, candidateDisplayNames);
    await service.zooStore.patchTopic({
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
    await service.ensureZooMenu(api);
  } catch (error) {
    const topicState = await service.zooStore.loadTopic({ force: true });
    if (!isCurrentLookupRequest(topicState, lookupRequestId, requestedByUserId)) {
      return;
    }
    await api.sendMessage({
      chat_id: Number(topicState.chat_id),
      message_thread_id: Number(topicState.topic_id),
      text: buildZooLookupFailureMessage(error, language),
    });
    await service.zooStore.patchTopic({
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
    await service.ensureZooMenu(api);
  }
}

export async function confirmPendingAdd(service, {
  api,
  message,
  topicState,
}) {
  const pendingAdd = topicState.pending_add;
  const language = normalizeUiLanguage(topicState.ui_language);

  try {
    const binding = await service.sessionService.resolveBindingPath(pendingAdd.candidate_path);
    const zooBinding = buildZooBindingForPet(binding, service.config.atlasWorkspaceRoot);
    const existingPet = await service.zooStore.findPetByResolvedPath(zooBinding.projectRoot);
    if (existingPet) {
      await service.zooStore.patchTopic({
        active_screen: "pet",
        selected_pet_id: existingPet.pet_id,
        pending_add: null,
      });
      await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
        ...(pendingAdd.cleanup_message_ids || []),
        Number(message.message_id),
      ]);
      await service.ensureZooMenu(api);
      return;
    }

    const existingPets = await service.reconcilePetDisplayNames();
    const petIdentity = service.pickPetIdentity(existingPets);
    const petId = buildPetIdFromPath(zooBinding.projectRoot);
    const displayNames = computeCanonicalPetDisplayNames([
      ...existingPets,
      {
        key: petId,
        repo_root: zooBinding.projectRoot,
        cwd: zooBinding.projectRoot,
        resolved_path: zooBinding.projectRoot,
      },
    ], service.config.atlasWorkspaceRoot);
    await service.persistCanonicalPetDisplayNames(existingPets, displayNames);
    const pet = await service.zooStore.savePet({
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
    await service.zooStore.patchTopic({
      active_screen: "pet",
      selected_pet_id: pet.pet_id,
      pending_add: null,
      last_refresh_error_text: null,
    });
    await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
      ...(pendingAdd.cleanup_message_ids || []),
      Number(message.message_id),
    ]);
    await service.ensureZooMenu(api);
  } catch (error) {
    await deleteMessagesBestEffort(api, Number(topicState.chat_id), [
      Number(message.message_id),
    ]);
    await api.sendMessage({
      chat_id: Number(topicState.chat_id),
      message_thread_id: Number(topicState.topic_id),
      text: buildZooAddFailureMessage(error, language),
    });
    await service.zooStore.patchTopic({
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
    await service.ensureZooMenu(api);
  }
}

export async function persistCanonicalPetDisplayNames(service, pets, displayNames) {
  const nextPets = [];
  for (const pet of pets || []) {
    const displayName = displayNames.get(pet.pet_id) || buildPetDisplayBaseName(pet);
    if (pet.display_name !== displayName) {
      nextPets.push(await service.zooStore.savePet({
        ...pet,
        display_name: displayName,
      }));
      continue;
    }
    nextPets.push(pet);
  }

  return nextPets.sort(sortPetsByDisplayName);
}

export async function reconcilePetDisplayNames(service, pets = null, extraPets = []) {
  const currentPets = Array.isArray(pets) ? pets : await service.zooStore.listPets();
  const displayNames = computeCanonicalPetDisplayNames(
    [
      ...currentPets,
      ...(extraPets || []).filter(Boolean),
    ],
    service.config.atlasWorkspaceRoot,
  );
  return service.persistCanonicalPetDisplayNames(currentPets, displayNames);
}
