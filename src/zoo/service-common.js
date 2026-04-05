import path from "node:path";

import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import { ZOO_CALLBACK_PREFIX } from "./render.js";

const YES_WORDS = new Set(["yes", "y", "да", "ага"]);
const NO_WORDS = new Set(["no", "n", "нет", "неа"]);
const ACTIVE_ZOO_OPERATION_CHAINS = new Map();

export const ZOO_REFRESH_FRAME_TICK_MS = 12000;
export const ZOO_IDLE_FRAME_TICK_MS = 20000;

export function normalizeText(value) {
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

export function uniquePositiveIntegers(values) {
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

export function pickRandomUnusedValue(pool, usedValues, randomSource = Math.random) {
  const candidates = uniqueStrings(pool);
  const used = new Set(uniqueStrings(usedValues));
  const unused = candidates.filter((candidate) => !used.has(candidate));
  return pickRandomValue(unused.length > 0 ? unused : candidates, randomSource);
}

export function isYes(text) {
  return YES_WORDS.has(String(text || "").trim().toLowerCase());
}

export function isNo(text) {
  return NO_WORDS.has(String(text || "").trim().toLowerCase());
}

export function buildZooTopicReadyMessage(topicName, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Zoo topic "${topicName}" is ready.`
    : `Zoo topic «${topicName}» готов.`;
}

export function buildZooTopicOnlyCommandMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This topic is reserved for Zoo only. Use /zoo here."
    : "Этот топик зарезервирован только под Zoo. Используй здесь /zoo.";
}

export function buildZooAddPromptMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Tell me what project this is so I can find it."
    : "Скажи, что это за проект, чтобы я смог его найти.";
}

export function buildZooLookupBusyMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Project lookup is already running."
    : "Поиск проекта уже идёт.";
}

export function buildZooLookupSearchingMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Searching the workspace for the project..."
    : "Ищу проект по workspace...";
}

export function buildZooLookupNotFoundMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "I could not confidently find it. Describe it in more detail."
    : "Не смог уверенно найти проект. Опиши его подробнее.";
}

export function buildZooLookupFailureMessage(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Lookup failed: ${error.message}`
    : `Поиск не удался: ${error.message}`;
}

export function buildZooNeedsYesNoMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Reply Yes or No. If No, you can also send a better description right away."
    : "Ответь Да или Нет. Если Нет, можно сразу прислать более точное описание.";
}

export function buildZooRefreshStartedText(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "Analyzing the full project..."
    : "Анализирую весь проект...";
}

export function buildZooRefreshFailureText(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Refresh failed: ${error.message}`
    : `Обновление не удалось: ${error.message}`;
}

export function buildZooAddFailureMessage(error, language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? `Add project failed: ${error.message}`
    : `Добавление проекта не удалось: ${error.message}`;
}

export function buildZooUnsupportedMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This topic is Zoo-only. Use the Zoo menu."
    : "Этот топик только для Zoo. Используй меню Zoo.";
}

export function buildZooOwnerMismatchMessage(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng"
    ? "This Zoo flow belongs to another operator."
    : "Этот Zoo-flow принадлежит другому оператору.";
}

export function buildZooPathLabel(binding) {
  return binding.repo_root || binding.cwd;
}

export function getZooProjectRoot(binding) {
  return binding.repo_root || binding.cwd || binding.resolved_path;
}

export function sortPetsByDisplayName(left, right) {
  return String(left.display_name || left.pet_id).localeCompare(
    String(right.display_name || right.pet_id),
  );
}

export function buildPetDisplayBaseName(value) {
  return path.basename(getZooProjectRoot(value) || "project") || "project";
}

function getPetDisplayVisibility(value, atlasWorkspaceRoot) {
  const projectRoot = normalizeText(getZooProjectRoot(value));
  const workspaceRoot = normalizeText(atlasWorkspaceRoot);
  if (!projectRoot || !workspaceRoot) {
    return "priv";
  }

  const relativePath = path.relative(workspaceRoot, projectRoot);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "priv";
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments[0] === "work" && segments[1] === "public" ? "pub" : "priv";
}

export function computeCanonicalPetDisplayNames(pets, atlasWorkspaceRoot) {
  const entries = (pets || []).map((pet, index) => ({
    key: normalizeText(pet?.key) || normalizeText(pet?.pet_id) || `pet-${index}`,
    baseName: buildPetDisplayBaseName(pet),
    visibility: getPetDisplayVisibility(pet, atlasWorkspaceRoot),
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

export function buildPendingCandidatePet(state) {
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

export function isRecoverableZooMenuEditError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to edit not found")
    || message.includes("message can't be edited")
  );
}

export function isZooMenuNotModifiedError(error) {
  return String(error?.message ?? "").toLowerCase().includes("message is not modified");
}

export function buildZooBindingForPet(binding, atlasWorkspaceRoot) {
  const projectRoot = getZooProjectRoot(binding);
  return {
    projectRoot,
    cwdRelativeToWorkspaceRoot:
      path.relative(atlasWorkspaceRoot, projectRoot) || ".",
  };
}

export function isCurrentLookupRequest(topicState, lookupRequestId, requestedByUserId) {
  return (
    Boolean(lookupRequestId)
    && topicState?.pending_add?.busy === true
    && topicState.pending_add.lookup_request_id === lookupRequestId
    && topicState.pending_add.requested_by_user_id === requestedByUserId
  );
}

export function parseCallbackData(data) {
  const [prefix, action, value] = String(data ?? "").split(":");
  if (prefix !== ZOO_CALLBACK_PREFIX || !action) {
    return null;
  }

  return {
    action,
    value: value || null,
  };
}

export async function answerCallbackQuerySafe(api, callbackQueryId, text = undefined) {
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

export async function deleteMessagesBestEffort(api, chatId, messageIds = []) {
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

export async function pinMessageBestEffort(api, chatId, messageId) {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return;
  }

  try {
    await api.pinChatMessage({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
    await deleteMessagesBestEffort(api, chatId, [messageId + 1]);
  } catch {}
}

export async function runSerializedZooOperation(key, operation) {
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
