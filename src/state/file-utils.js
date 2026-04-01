import fs from "node:fs/promises";
import path from "node:path";

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildTempPath(filePath) {
  return `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildCorruptPath(filePath) {
  return `${filePath}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function quarantineCorruptFile(filePath) {
  try {
    await fs.rename(filePath, buildCorruptPath(filePath));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeTextAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = buildTempPath(filePath);
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}
