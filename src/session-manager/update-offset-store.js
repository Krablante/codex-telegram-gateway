import fs from "node:fs/promises";
import path from "node:path";
import {
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const OFFSET_FILE_NAME = "telegram-update-offset.json";

export class UpdateOffsetStore {
  constructor(indexesRoot) {
    this.filePath = path.join(indexesRoot, OFFSET_FILE_NAME);
  }

  async load() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      const offset = payload?.next_update_offset;
      if (Number.isInteger(offset)) {
        return offset;
      }

      await quarantineCorruptFile(this.filePath);
      return 0;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        return 0;
      }

      throw error;
    }
  }

  async save(nextUpdateOffset) {
    const payload = {
      next_update_offset: nextUpdateOffset,
      updated_at: new Date().toISOString(),
    };

    await writeTextAtomic(
      this.filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}
