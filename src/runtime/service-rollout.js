import process from "node:process";

import { spawnRuntimeCommand } from "./spawn-command.js";

const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isGenerationRecordUsable(generationStore, record) {
  if (typeof generationStore?.isGenerationRecordVerifiablyLive === "function") {
    return generationStore.isGenerationRecordVerifiablyLive(record);
  }

  return generationStore?.isGenerationRecordLive?.(record) ?? false;
}

export function collectOwnedSessionKeys(workerPool) {
  const sessionKeys = new Set();

  for (const run of workerPool?.activeRuns?.values?.() ?? []) {
    if (run?.session?.session_key) {
      sessionKeys.add(run.session.session_key);
    }
  }

  for (const sessionKey of workerPool?.startingRuns ?? []) {
    if (sessionKey) {
      sessionKeys.add(String(sessionKey));
    }
  }

  return [...sessionKeys].sort();
}

export async function markOwnedSessionsRetiring({
  workerPool,
  sessionStore,
  generationId,
}) {
  const updatedSessions = [];
  const seenSessionKeys = new Set();

  const claimRetiring = async (session, assign) => {
    if (!session?.chat_id || !session?.topic_id || seenSessionKeys.has(session.session_key)) {
      return;
    }

    seenSessionKeys.add(session.session_key);
    const current =
      (await sessionStore.load(session.chat_id, session.topic_id)) || session;
    const updated = await sessionStore.claimSessionOwner(current, {
      generationId,
      mode: "retiring",
    });
    assign?.(updated);
    updatedSessions.push(updated);
  };

  for (const run of workerPool?.activeRuns?.values?.() ?? []) {
    await claimRetiring(run?.session, (updated) => {
      run.session = updated;
    });
  }

  for (const session of workerPool?.startingRunSessions?.values?.() ?? []) {
    await claimRetiring(session);
  }

  return updatedSessions;
}

export async function waitForGenerationReady({
  generationStore,
  generationId,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const record = await generationStore.loadGeneration(generationId);
    if (record?.ipc_endpoint && await isGenerationRecordUsable(generationStore, record)) {
      return record;
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

export function spawnReplacementGeneration({
  config,
  generationId,
  parentGenerationId = null,
  scriptPath,
  spawnCommand = spawnRuntimeCommand,
  execPath = process.execPath,
  execArgv = process.execArgv,
  env = process.env,
  stdio = "inherit",
}) {
  return spawnCommand(
    execPath,
    [...execArgv, scriptPath],
    {
      cwd: config.repoRoot,
      env: {
        ...env,
        ENV_FILE: config.envFilePath,
        SERVICE_GENERATION_ID: generationId,
        SERVICE_ROLLOUT_PARENT_GENERATION_ID:
          parentGenerationId ? String(parentGenerationId) : "",
      },
      stdio,
    },
  );
}
