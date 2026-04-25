import { startCodexExecRun } from "../codex-exec/exec-runner.js";
import { parseJsonObjectResponse } from "./model-response.js";

const ZOO_LOOKUP_MODEL = "gpt-5.4-mini";
const ZOO_LOOKUP_REASONING = "high";

function buildLookupPrompt({
  workspaceRoot,
  description,
}) {
  return [
    "You are resolving a natural-language project description to one best project path inside the current workspace.",
    "",
    "Requirements:",
    "- Search the workspace autonomously with available shell tools.",
    "- Pick exactly one best candidate path if there is a credible match.",
    "- The path must exist inside the current workspace root.",
    "- Prefer the project root directory, not a random nested file.",
    "- If the description is too vague, say that more detail is needed.",
    "- Output JSON only. No markdown, no explanation outside JSON.",
    "",
    "JSON contract:",
    '{',
    '  "candidate_path": "absolute path or null",',
    '  "reason": "short reason",',
    '  "needs_more_detail": true or false,',
    '  "question": "short confirmation question for the operator"',
    '}',
    "",
    `Workspace root: ${workspaceRoot}`,
    "",
    "Operator description:",
    description,
  ].join("\n");
}

function normalizeLookupResult(value) {
  const candidatePath =
    typeof value?.candidate_path === "string" && value.candidate_path.trim()
      ? value.candidate_path.trim()
      : null;
  const reason =
    typeof value?.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : null;
  const question =
    typeof value?.question === "string" && value.question.trim()
      ? value.question.trim()
      : candidatePath
        ? "Is this the right project?"
        : "Can you describe it in more detail?";
  const needsMoreDetail = Boolean(value?.needs_more_detail) || !candidatePath;

  return {
    candidatePath,
    reason,
    question,
    needsMoreDetail,
  };
}

export async function runZooProjectLookup({
  codexBinPath,
  outputDir,
  workspaceRoot,
  description,
}) {
  const run = startCodexExecRun({
    codexBinPath,
    repoRoot: workspaceRoot,
    outputDir,
    outputPrefix: "zoo-lookup",
    prompt: buildLookupPrompt({
      workspaceRoot,
      description,
    }),
    model: ZOO_LOOKUP_MODEL,
    reasoningEffort: ZOO_LOOKUP_REASONING,
  });
  const result = await run.done;
  if (!result.ok) {
    throw new Error(
      result.stderr
        || result.finalReply
        || `zoo lookup failed (code=${result.exitCode ?? "null"})`,
    );
  }

  return normalizeLookupResult(parseJsonObjectResponse(result.finalReply));
}
