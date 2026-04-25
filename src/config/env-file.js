import fs from "node:fs/promises";
import process from "node:process";
import { getDefaultEnvFilePath } from "./default-paths.js";

const DEFAULT_ENV_FILE = getDefaultEnvFilePath();
const PRIVATE_ENV_FILE_MODE = 0o600;

function normalizeEnvText(text) {
  return String(text ?? "").replace(/^\uFEFF/u, "");
}

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

  for (const rawLine of normalizeEnvText(text).split(/\r?\n/u)) {
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

async function ensureEnvFilePrivateMode(
  envFilePath,
  { platform = process.platform } = {},
) {
  if (platform === "win32") {
    return;
  }

  await fs.chmod(envFilePath, PRIVATE_ENV_FILE_MODE);
}

export async function loadEnvFile(envFilePath = DEFAULT_ENV_FILE, options = {}) {
  await ensureEnvFilePrivateMode(envFilePath, options);
  const text = await fs.readFile(envFilePath, "utf8");
  return parseEnvText(text);
}
