import process from "node:process";

const ALLOWED_ENV_NAMES = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "CODEX_AUTH_PATH",
  "CODEX_CONFIG_PATH",
  "CODEX_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "Path",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const ALLOWED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "AZURE_OPENAI_",
  "OPENAI_",
];

const BLOCKED_ENV_NAMES = new Set([
  "BOT_TOKEN",
  "ENV_FILE",
  "HOST_REGISTRY_PATH",
  "SERVICE_GENERATION_ID",
  "STATE_ROOT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_FORUM_CHAT_ID",
  "TELEGRAM_OPERATOR_USER_IDS",
  "TELEGRAM_USER_ENV_FILE",
]);

const BLOCKED_ENV_PREFIXES = [
  "CODEX_GATEWAY_",
  "CODEX_LIMITS_",
  "SPIKE_",
  "TELEGRAM_",
];

function shouldBlockEnvName(name) {
  return (
    BLOCKED_ENV_NAMES.has(name)
    || BLOCKED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function shouldAllowEnvName(name) {
  return (
    ALLOWED_ENV_NAMES.has(name)
    || ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function buildCodexChildEnv(sourceEnv = process.env, { extraEnv = {} } = {}) {
  const childEnv = {};
  for (const [name, value] of Object.entries(sourceEnv || {})) {
    if (value === undefined || shouldBlockEnvName(name) || !shouldAllowEnvName(name)) {
      continue;
    }
    childEnv[name] = value;
  }

  for (const [name, value] of Object.entries(extraEnv || {})) {
    if (value === undefined || shouldBlockEnvName(name)) {
      continue;
    }
    childEnv[name] = value;
  }

  return childEnv;
}
