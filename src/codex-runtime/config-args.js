function formatTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function normalizePositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return null;
}

export function appendCodexRuntimeConfigArgs(
  args,
  {
    model = null,
    reasoningEffort = null,
    contextWindow = null,
    autoCompactTokenLimit = null,
    sandboxMode = null,
    approvalPolicy = null,
    developerInstructions = null,
  } = {},
) {
  const nextArgs = Array.isArray(args) ? args : [];

  if (model) {
    nextArgs.push("-c", `model=${formatTomlString(model)}`);
  }

  if (reasoningEffort) {
    nextArgs.push(
      "-c",
      `model_reasoning_effort=${formatTomlString(reasoningEffort)}`,
    );
  }

  const normalizedContextWindow = normalizePositiveInteger(contextWindow);
  if (normalizedContextWindow !== null) {
    nextArgs.push("-c", `model_context_window=${normalizedContextWindow}`);
  }

  const normalizedAutoCompactTokenLimit =
    normalizePositiveInteger(autoCompactTokenLimit);
  if (normalizedAutoCompactTokenLimit !== null) {
    nextArgs.push(
      "-c",
      `model_auto_compact_token_limit=${normalizedAutoCompactTokenLimit}`,
    );
  }

  if (sandboxMode) {
    nextArgs.push(
      "-c",
      `sandbox_mode=${formatTomlString(sandboxMode)}`,
    );
  }

  if (approvalPolicy) {
    nextArgs.push(
      "-c",
      `approval_policy=${formatTomlString(approvalPolicy)}`,
    );
  }

  const normalizedDeveloperInstructions =
    typeof developerInstructions === "string"
      ? developerInstructions.trim()
      : "";
  if (normalizedDeveloperInstructions) {
    nextArgs.push(
      "-c",
      `developer_instructions=${formatTomlString(normalizedDeveloperInstructions)}`,
    );
  }

  return nextArgs;
}
