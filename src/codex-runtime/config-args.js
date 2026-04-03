function escapeTomlString(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

export function appendCodexRuntimeConfigArgs(
  args,
  {
    model = null,
    reasoningEffort = null,
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

  return nextArgs;
}
