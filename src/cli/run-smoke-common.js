import process from "node:process";

export function resolveSmokeVariant(argv = process.argv) {
  return argv.includes("--omni") ? "omni" : "spike";
}

function isInactiveUserServiceError(error) {
  return Number(error?.code) === 3 || Number(error?.code) === 4;
}

export async function assertSmokeSupported(
  serviceName,
  {
    platform = process.platform,
    execFileAsync,
  } = {},
) {
  if (platform !== "linux") {
    throw new Error(
      "Smoke scripts are Linux/operator-only. On native Windows use the direct scripts/windows/*.cmd wrappers instead.",
    );
  }

  try {
    await execFileAsync("systemctl", ["--user", "is-active", "--quiet", serviceName]);
    throw new Error(
      `${serviceName} is active; refuse smoke run to avoid Telegram poll conflict`,
    );
  } catch (error) {
    if (
      error?.message?.includes("refuse smoke run to avoid Telegram poll conflict")
    ) {
      throw error;
    }
    if (isInactiveUserServiceError(error)) {
      return;
    }

    throw new Error(
      `Unable to confirm ${serviceName} is inactive via systemctl --user; fix the user service state first. ${error?.stderr?.trim() || error?.stdout?.trim() || error?.message || ""}`.trim(),
    );
  }
}
