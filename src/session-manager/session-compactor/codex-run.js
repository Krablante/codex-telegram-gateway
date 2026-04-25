import { buildCompactionPrompt, isContextLengthExceededError } from "./prompt.js";
import { hasRequiredBriefStructure, normalizeBrief } from "./common.js";

const MAX_SUMMARIZER_RETRIES = 1;
const COMPACTION_APP_SERVER_BOOT_TIMEOUT_MS = 60000;
const COMPACTION_ROLLOUT_DISCOVERY_TIMEOUT_MS = 30000;
const COMPACTION_ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 30000;

function isFallbackAppServerBackend(config) {
  const backend = String(config?.codexGatewayBackend || "").trim().toLowerCase();
  return backend === "app-server" || backend === "appserver";
}

export async function generateBriefWithCodex({
  config,
  runtimeProfile,
  reason,
  runTask,
  session,
  primarySource,
  fallbackSource = null,
}) {
  if (!config?.codexBinPath) {
    throw new Error("Session compactor requires codexBinPath");
  }

  let currentSource = primarySource;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_SUMMARIZER_RETRIES; attempt += 1) {
    try {
      let finalAgentMessage = "";
      const warnings = [];
      const prompt = buildCompactionPrompt(session, {
        reason,
        source: currentSource,
      });
      const fallbackAppServerOptions = isFallbackAppServerBackend(config)
        ? {
          appServerBootTimeoutMs: COMPACTION_APP_SERVER_BOOT_TIMEOUT_MS,
          rolloutDiscoveryTimeoutMs: COMPACTION_ROLLOUT_DISCOVERY_TIMEOUT_MS,
          rolloutStallAfterChildExitMs: COMPACTION_ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
        }
        : {};
      const contextWindow = Number.isFinite(config.codexContextWindow)
        ? config.codexContextWindow
        : null;
      const runResult = await runTask({
        codexBinPath: config.codexBinPath,
        cwd: session.workspace_binding.cwd,
        prompt,
        session,
        sessionKey: session.session_key,
        sessionThreadId: null,
        imagePaths: [],
        ...fallbackAppServerOptions,
        model: runtimeProfile?.model ?? null,
        reasoningEffort: runtimeProfile?.reasoningEffort ?? null,
        contextWindow,
        autoCompactTokenLimit: contextWindow
          ? contextWindow + 1
          : null,
        onEvent: async (summary) => {
          if (summary?.kind === "agent_message" && typeof summary.text === "string") {
            finalAgentMessage = summary.text;
          }
        },
        onWarning: (warning) => {
          warnings.push(String(warning || ""));
        },
      });
      const { finished } = runResult ?? {};
      if (!finished || typeof finished.then !== "function") {
        throw new Error("Compaction runner did not return a finished promise");
      }
      const result = await finished;
      if (!result || typeof result !== "object") {
        throw new Error("Compaction summarizer finished without a result");
      }
      if (Array.isArray(result.warnings)) {
        warnings.push(
          ...result.warnings
            .map((warning) => String(warning || "").trim())
            .filter(Boolean),
        );
      }
      const brief = normalizeBrief(finalAgentMessage);

      if (hasRequiredBriefStructure(brief)) {
        return brief;
      }

      if (result.exitCode !== 0) {
        const warningText = warnings.join("\n").trim();
        throw new Error(
          warningText
            ? `Compaction summarizer exited with code ${result.exitCode}: ${warningText}`
            : `Compaction summarizer exited with code ${result.exitCode}`,
        );
      }

      throw new Error("Compaction summarizer returned an invalid brief");
    } catch (error) {
      if (
        fallbackSource
        && currentSource.kind !== fallbackSource.kind
        && isContextLengthExceededError(error)
      ) {
        currentSource = fallbackSource;
        lastError = error;
        continue;
      }
      lastError = error;
    }
  }

  throw lastError;
}
