function escapeTomlString(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

export function appendCodexRuntimeConfigArgs(
  args,
  {
    model = null,
    reasoningEffort = null,
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
