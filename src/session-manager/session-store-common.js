export const META_LOCK_DIR_NAME = ".meta.lock";
export const META_LOCK_RETRY_MS = 10;
export const META_LOCK_TIMEOUT_MS = 5000;
export const META_LOCK_STALE_MS = 30000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  buildPurgedStub,
  buildRuntimeStateFields,
  normalizeOwnershipPatch,
  normalizeStoredSessionMeta,
  stripLegacyMetaFields,
} from "./session-store-meta.js";
export {
  buildArtifactFileName,
  CorruptSessionMetaError,
  getCorruptSessionMetaMarkerPath,
  hasCorruptSessionMetaMarker,
  isCorruptSessionMetaError,
  normalizeExchangeLogEntry,
  readMetaJson,
  readOptionalText,
} from "./session-store-io.js";
export {
  AUTO_LAST_SPIKE_FINAL_FILE_NAME,
} from "./auto-mode.js";
