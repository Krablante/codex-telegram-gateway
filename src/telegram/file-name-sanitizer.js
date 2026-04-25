import path from "node:path";

const WINDOWS_RESERVED_FILE_STEMS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function sanitizeFileName(fileName, fallback = "attachment") {
  const baseName = path.basename(String(fileName || "").trim());
  const sanitized = baseName
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/[ .]+$/gu, "");
  if (!sanitized) {
    return fallback;
  }

  const extension = path.extname(sanitized);
  const stem = extension
    ? sanitized.slice(0, -extension.length)
    : sanitized;
  const safeStem = WINDOWS_RESERVED_FILE_STEMS.has(stem.toLowerCase())
    ? `${stem}-file`
    : stem;
  return `${safeStem || fallback}${extension}`;
}
