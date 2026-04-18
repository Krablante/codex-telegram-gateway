import crypto from "node:crypto";
import process from "node:process";

export function resolveCurrentGenerationId({
  env = process.env,
  pid = process.pid,
  randomUUID = crypto.randomUUID,
} = {}) {
  const explicit = String(env?.SERVICE_GENERATION_ID ?? "").trim();
  if (explicit) {
    return explicit;
  }

  return `spike-${pid}-${randomUUID()}`;
}

export function createReplacementGenerationId({
  pid = process.pid,
  randomUUID = crypto.randomUUID,
} = {}) {
  return `spike-${pid}-${randomUUID()}`;
}
