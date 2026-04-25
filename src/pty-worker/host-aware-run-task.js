import { runCodexTask } from "./codex-runner.js";
import { runRemoteCodexTask } from "./remote-executor.js";
import {
  CODEX_EXEC_BACKEND,
  runCodexExecTask,
  runRemoteCodexExecTask,
} from "../codex-exec/telegram-exec-runner.js";

const CODEX_APP_SERVER_BACKEND = "app-server";

function normalizeCodexGatewayBackend(
  value,
  { legacyAppServerEnabled = false } = {},
) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return CODEX_EXEC_BACKEND;
  }
  if (normalized === CODEX_EXEC_BACKEND || normalized === "exec") {
    return CODEX_EXEC_BACKEND;
  }
  if (normalized === CODEX_APP_SERVER_BACKEND || normalized === "appserver") {
    if (!legacyAppServerEnabled) {
      throw new Error(
        "CODEX_GATEWAY_BACKEND=app-server requires CODEX_ENABLE_LEGACY_APP_SERVER=1.",
      );
    }
    return CODEX_APP_SERVER_BACKEND;
  }

  throw new Error(`Unsupported Codex gateway backend: ${value}`);
}

export function createHostAwareRunTask({
  config,
  hostRegistryService,
  runLocalTask = runCodexTask,
  runRemoteTask = runRemoteCodexTask,
  runLocalExecTask = runCodexExecTask,
  runRemoteExecTask = runRemoteCodexExecTask,
} = {}) {
  const backend = normalizeCodexGatewayBackend(
    config?.codexGatewayBackend || CODEX_EXEC_BACKEND,
    {
      legacyAppServerEnabled:
        config?.codexEnableLegacyAppServer === true
        || config?.enableLegacyAppServerBackend === true,
    },
  );
  const localTask = backend === CODEX_EXEC_BACKEND
    ? runLocalExecTask
    : runLocalTask;
  const remoteTask = backend === CODEX_EXEC_BACKEND
    ? runRemoteExecTask
    : runRemoteTask;

  return async function hostAwareRunTask(args = {}) {
    const executionHost = args.executionHost
      || (typeof hostRegistryService?.resolveSessionExecution === "function" && args.session
        ? await hostRegistryService.resolveSessionExecution(args.session)
        : null);
    if (executionHost?.ok === false) {
      const hostLabel = executionHost.hostLabel || executionHost.hostId || "unknown";
      const error = new Error(`Execution host unavailable: ${hostLabel}`);
      error.code = "EXECUTION_HOST_UNAVAILABLE";
      error.hostId = executionHost.hostId || null;
      error.hostLabel = hostLabel;
      error.failureReason = executionHost.failureReason || "host-unavailable";
      throw error;
    }
    const isLocal = executionHost?.isLocal !== false;

    if (!executionHost || isLocal) {
      return localTask(args);
    }

    return remoteTask({
      ...args,
      connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
      currentHostId: config.currentHostId,
      executionHost,
    });
  };
}
