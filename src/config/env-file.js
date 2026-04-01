import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ENV_FILE =
  process.env.ENV_FILE?.trim() ||
  process.env.CODEX_TELEGRAM_GATEWAY_ENV_FILE?.trim() ||
  path.join(process.cwd(), ".env");

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseEnvText(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
    const separatorIndex = normalizedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = normalizedLine.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    env[key] = stripWrappingQuotes(value);
  }

  return env;
}

export async function loadEnvFile(envFilePath = DEFAULT_ENV_FILE) {
  const text = await fs.readFile(envFilePath, "utf8");
  return parseEnvText(text);
}
