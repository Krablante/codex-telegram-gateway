import { startCodexExecRun } from "../codex-exec/exec-runner.js";
import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage } from "../i18n/ui-language.js";
import { parseJsonObjectResponse } from "./model-response.js";
import { normalizeSnapshot } from "./store.js";
import {
  getZooCreatureLabel,
  getZooPetCharacterName,
  getZooPetTemperamentLabel,
  getZooPetTemperamentPrompt,
  getZooCreatureVoicePrompt,
} from "./creatures.js";

const ZOO_ANALYSIS_MODEL = "gpt-5.4-mini";
const ZOO_ANALYSIS_REASONING = "high";
const REQUIRED_STAT_KEYS = [
  "security",
  "shitcode",
  "junk",
  "tests",
  "structure",
  "docs",
  "operability",
];

function getAnalysisLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng" ? "English" : "Russian";
}

export function buildAnalysisPrompt({
  pet,
  previousSnapshot,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const normalizedLanguage = getAnalysisLanguageLabel(language);
  const characterName = getZooPetCharacterName(pet);
  const creatureLabel = getZooCreatureLabel(pet.creature_kind, language);
  const creatureVoicePrompt = getZooCreatureVoicePrompt(pet.creature_kind, language);
  const temperamentLabel = getZooPetTemperamentLabel(pet, language);
  const temperamentPrompt = getZooPetTemperamentPrompt(pet, language);

  return [
    "You are analyzing the full current project and producing a compact tamagotchi-style quality snapshot.",
    "",
    "Requirements:",
    "- Inspect the whole project rooted at the current working directory.",
    "- Use your tools autonomously. Do not ask for clarification.",
    "- Be concrete and practical. Character flavor is welcome, but usefulness comes first.",
    "- Required stats are: security, shitcode, junk, tests, structure, docs, operability.",
    "- Each stat must be an integer 0-100.",
    "- Higher shitcode means worse code quality.",
    "- Higher junk means more clutter, dead files, generated trash, unused leftovers, or repo mess.",
    `- All human-readable fields must be written in ${normalizedLanguage}.`,
    "- Do not mix English and Russian unless a code identifier or file path requires it.",
    "- Keep findings short and useful even if they are not all shown in chat.",
    "- You are literally the project pet described below. Keep the mood and flavor line in that creature voice and temperament.",
    "- The temperament must be noticeable in the wording. Avoid generic assistant tone.",
    "- mood should be very short, usually 1-3 words.",
    "- flavor_line should be one short first-person line in the pet voice, without quotation marks.",
    "- project_summary should be a separate concise summary of what the project is and what shape it is in. Do not just repeat flavor_line.",
    "- next_focus should be one concrete next improvement, not a slogan.",
    "- Output JSON only. No markdown, no extra text.",
    "",
    "JSON contract:",
    '{',
    '  "mood": "short mood",',
    '  "flavor_line": "short flavor line",',
    '  "project_summary": "short project summary",',
    '  "next_focus": "one next focus",',
    '  "findings": ["finding 1", "finding 2"],',
    '  "stats": {',
    '    "security": 0,',
    '    "shitcode": 0,',
    '    "junk": 0,',
    '    "tests": 0,',
    '    "structure": 0,',
    '    "docs": 0,',
    '    "operability": 0',
    "  }",
    "}",
    "",
    "Pet profile:",
    JSON.stringify(
      {
        pet_id: pet.pet_id,
        character_name: characterName,
        display_name: pet.display_name,
        creature_kind: pet.creature_kind,
        creature_label: creatureLabel,
        creature_personality: creatureVoicePrompt,
        temperament_label: temperamentLabel,
        temperament_prompt: temperamentPrompt,
        resolved_path: pet.cwd || pet.resolved_path,
      },
      null,
      2,
    ),
    "",
    "Previous snapshot:",
    previousSnapshot ? JSON.stringify(previousSnapshot, null, 2) : "null",
  ].join("\n");
}

export function computeTrend(nextValue, previousValue) {
  if (previousValue === null || previousValue === undefined) {
    return "same";
  }

  const normalizedNextValue = Number(nextValue);
  const normalizedPreviousValue = Number(previousValue);

  if (!Number.isFinite(normalizedNextValue) || !Number.isFinite(normalizedPreviousValue)) {
    return "same";
  }

  if (normalizedNextValue > normalizedPreviousValue) {
    return "up";
  }
  if (normalizedNextValue < normalizedPreviousValue) {
    return "down";
  }
  return "same";
}

function addTrends(snapshot, previousSnapshot = null) {
  const trends = {};
  for (const [key, value] of Object.entries(snapshot.stats || {})) {
    trends[key] = computeTrend(value, Number(previousSnapshot?.stats?.[key]));
  }

  return {
    ...snapshot,
    trends,
  };
}

export function validateAnalysisPayload(payload) {
  const stats = payload?.stats;
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    throw new Error("zoo analysis payload is missing stats");
  }

  for (const key of REQUIRED_STAT_KEYS) {
    if (!Number.isFinite(Number(stats[key]))) {
      throw new Error(`zoo analysis payload is missing numeric stat: ${key}`);
    }
  }

  return payload;
}

export async function runZooProjectAnalysis({
  codexBinPath,
  outputDir,
  pet,
  previousSnapshot = null,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const run = startCodexExecRun({
    codexBinPath,
    repoRoot: pet.cwd || pet.resolved_path || pet.repo_root,
    outputDir,
    outputPrefix: `zoo-analysis-${pet.pet_id}`,
    prompt: buildAnalysisPrompt({
      pet,
      previousSnapshot,
      language,
    }),
    model: ZOO_ANALYSIS_MODEL,
    reasoningEffort: ZOO_ANALYSIS_REASONING,
  });
  const result = await run.done;
  if (!result.ok) {
    throw new Error(
      result.stderr
        || result.finalReply
        || `zoo analysis failed (code=${result.exitCode ?? "null"})`,
    );
  }

  const parsed = validateAnalysisPayload(parseJsonObjectResponse(result.finalReply));
  const snapshot = normalizeSnapshot({
    pet_id: pet.pet_id,
    display_name: pet.display_name,
    resolved_path: pet.cwd || pet.resolved_path,
    creature_kind: pet.creature_kind,
    ...parsed,
  });
  if (!snapshot) {
    throw new Error("zoo analysis returned an invalid snapshot");
  }

  return addTrends(snapshot, previousSnapshot);
}
