export const DEFAULT_UI_LANGUAGE = "rus";

const UI_LANGUAGE_ALIASES = new Map([
  ["ru", "rus"],
  ["rus", "rus"],
  ["russian", "rus"],
  ["рус", "rus"],
  ["русский", "rus"],
  ["en", "eng"],
  ["eng", "eng"],
  ["english", "eng"],
  ["анг", "eng"],
  ["английский", "eng"],
]);

export function normalizeUiLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UI_LANGUAGE_ALIASES.get(normalized) || DEFAULT_UI_LANGUAGE;
}

export function parseUiLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UI_LANGUAGE_ALIASES.get(normalized) || null;
}

export function getSessionUiLanguage(session) {
  return normalizeUiLanguage(session?.ui_language);
}

export function formatUiLanguageLabel(language) {
  return normalizeUiLanguage(language) === "eng" ? "ENG" : "RUS";
}

export function isWaitFlushWord(text) {
  return /^(?:все|всё|all)$/iu.test(String(text || "").trim());
}
