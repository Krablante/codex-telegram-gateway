import fs from "node:fs/promises";
import path from "node:path";

export const STATE_SUBDIRECTORIES = [
  "sessions",
  "indexes",
  "settings",
  "logs",
  "tmp",
];

export function getStateLayout(stateRoot) {
  return {
    root: stateRoot,
    sessions: path.join(stateRoot, "sessions"),
    indexes: path.join(stateRoot, "indexes"),
    settings: path.join(stateRoot, "settings"),
    logs: path.join(stateRoot, "logs"),
    tmp: path.join(stateRoot, "tmp"),
  };
}

export async function ensureStateLayout(stateRoot) {
  const layout = getStateLayout(stateRoot);
  await fs.mkdir(layout.root, { recursive: true });

  for (const name of STATE_SUBDIRECTORIES) {
    await fs.mkdir(layout[name], { recursive: true });
  }

  return layout;
}
