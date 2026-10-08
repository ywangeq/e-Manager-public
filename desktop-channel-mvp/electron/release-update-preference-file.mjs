import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PREFERENCE_FILE_BYTES = 512 * 1024;

function createDesktopUpdatePreferenceFilePersistence({ filePath } = {}) {
  const targetPath = path.resolve(requiredPath(filePath));
  return {
    async load() {
      try {
        const metadata = await stat(targetPath);
        if (!metadata.isFile() || metadata.size > MAX_PREFERENCE_FILE_BYTES) throw preferenceFileError("desktop_update_preferences_too_large");
        return JSON.parse(await readFile(targetPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(value) {
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${targetPath}.tmp`;
      const serialized = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_PREFERENCE_FILE_BYTES) throw preferenceFileError("desktop_update_preferences_too_large");
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, targetPath);
    },
  };
}

function preferenceFileError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredPath(value) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError("desktop update preference persistence requires filePath");
  return result;
}

export { createDesktopUpdatePreferenceFilePersistence };
