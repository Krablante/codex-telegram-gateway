import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function mkdtempForTest(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  if (t && typeof t.after === "function") {
    t.after(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }
  return dir;
}
