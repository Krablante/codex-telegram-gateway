function escapeTomlString(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
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
  } = {},
) {
  const nextArgs = Array.isArray(args) ? args : [];

  if (model) {
    nextArgs.push("-c", `model="${escapeTomlString(model)}"`);
  }

  if (reasoningEffort) {
    nextArgs.push(
      "-c",
      `model_reasoning_effort="${escapeTomlString(reasoningEffort)}"`,
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
      `sandbox_mode="${escapeTomlString(sandboxMode)}"`,
    );
  }

  if (approvalPolicy) {
    nextArgs.push(
      "-c",
      `approval_policy="${escapeTomlString(approvalPolicy)}"`,
    );
  }

  return nextArgs;
}
