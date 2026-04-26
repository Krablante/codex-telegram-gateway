import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveExecutablePath } from "./executable-path.js";
import {
  SYSTEMD_USER_SERVICE_NAME,
  buildServicePathEntries,
  buildUserServiceUnit,
  getUserServiceUnitPath,
  isSystemdUserSupported,
} from "./systemd-user-service.js";

const OBSOLETE_GATEWAY_USER_SERVICE_NAMES = [
  "codex-telegram-gateway-omni.service",
];

const GATEWAY_USER_SERVICE_RE = /^codex-telegram-gateway.*\.service$/u;
const MAIN_UNIT_DIRECTIVES = [
  ["Unit", "Description"],
  ["Service", "WorkingDirectory"],
  ["Service", "UMask"],
  ["Service", "ExitType"],
  ["Service", "ExecStart"],
  ["Service", "Restart"],
  ["Service", "RestartSec"],
  ["Service", "KillMode"],
  ["Service", "KillSignal"],
  ["Service", "SuccessExitStatus"],
  ["Service", "TimeoutStopSec"],
];
const MAIN_UNIT_ENV_KEYS = [
  "ENV_FILE",
  "NODE",
  "CODEX_BIN_PATH",
  "CODEX_CONFIG_PATH",
];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readDirectiveValues(unitText, sectionName, directiveName) {
  const values = [];
  let currentSection = null;
  for (const rawLine of String(unitText || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (currentSection !== sectionName) {
      continue;
    }
    const splitAt = line.indexOf("=");
    if (splitAt === -1) {
      continue;
    }
    const key = line.slice(0, splitAt).trim();
    if (key === directiveName) {
      values.push(line.slice(splitAt + 1));
    }
  }
  return values;
}

function readDirectiveValue(unitText, sectionName, directiveName) {
  return readDirectiveValues(unitText, sectionName, directiveName).at(0) ?? null;
}

function unescapeQuotedSystemdValue(value) {
  return String(value)
    .replace(/\\\\/gu, "\\")
    .replace(/\\"/gu, "\"");
}

function parseEnvironmentEntries(unitText) {
  const entries = {};
  for (const rawValue of readDirectiveValues(unitText, "Service", "Environment")) {
    const trimmed = rawValue.trim();
    const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"$/u);
    const value = quoted
      ? unescapeQuotedSystemdValue(quoted[1])
      : trimmed;
    const splitAt = value.indexOf("=");
    if (splitAt > 0) {
      entries[value.slice(0, splitAt)] = value.slice(splitAt + 1);
    }
  }
  return entries;
}

function summarizeUnit(unitText) {
  const directives = {};
  for (const [sectionName, directiveName] of MAIN_UNIT_DIRECTIVES) {
    directives[`${sectionName}.${directiveName}`] = readDirectiveValue(
      unitText,
      sectionName,
      directiveName,
    );
  }

  return {
    directives,
    environment: parseEnvironmentEntries(unitText),
  };
}

function compareMainUnit(actualText, expectedText) {
  const actual = summarizeUnit(actualText);
  const expected = summarizeUnit(expectedText);
  const mismatches = [];

  for (const key of Object.keys(expected.directives)) {
    if (actual.directives[key] !== expected.directives[key]) {
      mismatches.push(key);
    }
  }
  for (const key of MAIN_UNIT_ENV_KEYS) {
    if (actual.environment[key] !== expected.environment[key]) {
      mismatches.push(`Service.Environment.${key}`);
    }
  }

  return {
    fresh: mismatches.length === 0,
    mismatches,
  };
}

function splitExecStartCommand(value) {
  const tokens = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of String(value || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function extractExecStartAbsolutePaths(unitText) {
  return [
    ...new Set(
      readDirectiveValues(unitText, "Service", "ExecStart")
        .flatMap((value) => splitExecStartCommand(value))
        .filter((token) => path.posix.isAbsolute(token)),
    ),
  ];
}

async function listGatewayUserServiceFiles(unitDir) {
  try {
    const entries = await fs.readdir(unitDir, { withFileTypes: true });
    return entries
      .filter((entry) => GATEWAY_USER_SERVICE_RE.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: path.join(unitDir, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function auditSystemdUserGateway({
  config,
  homeDirectory = os.homedir(),
  nodePath = process.execPath,
  platform = process.platform,
} = {}) {
  const supported = isSystemdUserSupported(platform);
  const unitDir = path.join(homeDirectory, ".config", "systemd", "user");
  const mainUnitPath = getUserServiceUnitPath(homeDirectory, SYSTEMD_USER_SERVICE_NAME);
  const report = {
    supported,
    unit_dir: unitDir,
    main_unit: {
      name: SYSTEMD_USER_SERVICE_NAME,
      path: mainUnitPath,
      installed: false,
      fresh: null,
      mismatches: [],
      error: null,
    },
    stale_units: [],
  };

  if (!supported || !config) {
    return report;
  }

  const mainUnitText = await readTextIfExists(mainUnitPath);
  report.main_unit.installed = mainUnitText !== null;

  if (mainUnitText !== null) {
    try {
      const codexBinPath = await resolveExecutablePath(config.codexBinPath, {
        cwd: config.repoRoot,
        preferredDirectories: [path.dirname(nodePath)],
      });
      const expectedMainUnitText = buildUserServiceUnit({
        repoRoot: config.repoRoot,
        envFilePath: config.envFilePath,
        nodePath,
        codexBinPath,
        codexConfigPath: config.codexConfigPath,
        pathEntries: buildServicePathEntries({ nodePath }),
        description: "Codex Telegram Gateway",
        scriptPath: "src/cli/run.js",
        exitType: "cgroup",
      });
      const comparison = compareMainUnit(mainUnitText, expectedMainUnitText);
      report.main_unit.fresh = comparison.fresh;
      report.main_unit.mismatches = comparison.mismatches;
    } catch (error) {
      report.main_unit.fresh = false;
      report.main_unit.error = String(error?.message || error);
    }
  }

  const unitFiles = await listGatewayUserServiceFiles(unitDir);
  for (const unitFile of unitFiles) {
    const unitText = unitFile.path === mainUnitPath && mainUnitText !== null
      ? mainUnitText
      : await readTextIfExists(unitFile.path);
    const reasons = [];

    if (OBSOLETE_GATEWAY_USER_SERVICE_NAMES.includes(unitFile.name)) {
      reasons.push("obsolete-unit");
    }
    if (unitFile.name === SYSTEMD_USER_SERVICE_NAME && report.main_unit.fresh === false) {
      reasons.push("outdated-unit-file");
    }
    for (const execPath of extractExecStartAbsolutePaths(unitText)) {
      if (!(await pathExists(execPath))) {
        reasons.push(`missing-exec-target:${execPath}`);
      }
    }

    if (reasons.length > 0) {
      report.stale_units.push({
        name: unitFile.name,
        path: unitFile.path,
        reasons,
      });
    }
  }

  return report;
}
