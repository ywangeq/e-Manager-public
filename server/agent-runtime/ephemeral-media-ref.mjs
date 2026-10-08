import crypto from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isSupportedEphemeralMimeType, normalizeMimeType } from "./canonical-input-types.mjs";

const records = new WeakMap();

async function createEphemeralMediaRef({ fileName = "", filePath = "", mimeType = "", root = "", maxBytes = 2_000_000 } = {}) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!isSupportedEphemeralMimeType(normalizedMimeType)) throw new Error("ephemeral_media_type_rejected");
  const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)]);
  if (!isInside(resolvedRoot, resolvedFile)) throw new Error("ephemeral_media_path_rejected");
  const metadata = await stat(resolvedFile);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) throw new Error("ephemeral_media_size_rejected");
  const ref = Object.freeze({
    contractVersion: "ephemeral-media-ref.v1",
    id: `ephemeral-media://${crypto.randomUUID()}`,
  });
  records.set(ref, { fileName: path.basename(String(fileName || resolvedFile)), filePath: resolvedFile, maxBytes, mimeType: normalizedMimeType, root: resolvedRoot });
  return ref;
}

async function resolveEphemeralMediaRef(ref) {
  const record = records.get(ref);
  if (!record) throw new Error("ephemeral_media_ref_invalid");
  const resolvedFile = await realpath(record.filePath);
  if (!isInside(record.root, resolvedFile)) throw new Error("ephemeral_media_path_rejected");
  const metadata = await stat(resolvedFile);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > record.maxBytes) throw new Error("ephemeral_media_size_rejected");
  return { bytes: await readFile(resolvedFile), fileName: record.fileName, mimeType: record.mimeType };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export { createEphemeralMediaRef, resolveEphemeralMediaRef };
