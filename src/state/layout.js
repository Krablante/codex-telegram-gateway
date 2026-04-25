import path from "node:path";

import { ensurePrivateDirectory } from "./file-utils.js";

const STATE_SUBDIRECTORIES = [
  "sessions",
  "indexes",
  "settings",
  "hosts",
  "codexSpace",
  "zoo",
  "emergency",
  "logs",
  "tmp",
];

export function getStateLayout(stateRoot) {
  return {
    root: stateRoot,
    sessions: path.join(stateRoot, "sessions"),
    indexes: path.join(stateRoot, "indexes"),
    settings: path.join(stateRoot, "settings"),
    hosts: path.join(stateRoot, "hosts"),
    codexSpace: path.join(stateRoot, "codex-space"),
    zoo: path.join(stateRoot, "zoo"),
    emergency: path.join(stateRoot, "emergency"),
    logs: path.join(stateRoot, "logs"),
    tmp: path.join(stateRoot, "tmp"),
  };
}

export async function ensureStateLayout(stateRoot) {
  const layout = getStateLayout(stateRoot);
  await ensurePrivateDirectory(layout.root);

  for (const name of STATE_SUBDIRECTORIES) {
    await ensurePrivateDirectory(layout[name]);
  }

  return layout;
}
