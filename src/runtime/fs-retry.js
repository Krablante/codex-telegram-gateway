import process from "node:process";

const RETRYABLE_WINDOWS_FS_CODES = new Set([
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableFilesystemError(
  error,
  { platform = process.platform } = {},
) {
  return platform === "win32" && RETRYABLE_WINDOWS_FS_CODES.has(error?.code);
}

export async function retryFilesystemOperation(
  operation,
  {
    platform = process.platform,
    attempts = 4,
    delayMs = 50,
  } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt >= attempts
        || !isRetryableFilesystemError(error, { platform })
      ) {
        throw error;
      }
      await sleep(delayMs * attempt);
    }
  }

  throw lastError;
}
