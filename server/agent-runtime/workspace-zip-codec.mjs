import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_DIRECTORY = 0o040000;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const decoder = new TextDecoder("utf-8", { fatal: true });

function inspectZipArchive(bytes, limits) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw archiveError("workspace_archive_format_rejected");
  if (bytes.length > limits.maxArchiveBytes) throw archiveError("workspace_archive_source_size_exceeded");

  const endOffset = findEndRecord(bytes);
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32 ||
    endOffset + 22 + commentLength !== bytes.length || centralOffset + centralSize !== endOffset
  ) throw archiveError("workspace_archive_format_rejected");
  if (entryCount > limits.maxEntries) throw archiveError("workspace_archive_entry_limit_exceeded");

  const entries = [];
  const collisionKeys = new Set();
  let cursor = centralOffset;
  let totalBytes = 0;
  let totalCompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw archiveError("workspace_archive_format_rejected");
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const entryDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (
      recordEnd > endOffset || entryDisk !== 0 || compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 || localOffset === ZIP64_SENTINEL_32
    ) throw archiveError("workspace_archive_format_rejected");
    if (flags & ENCRYPTED_FLAG) throw archiveError("workspace_archive_encrypted_rejected");
    if (method !== 0 && method !== 8) throw archiveError("workspace_archive_compression_rejected");

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = decodeEntryName(nameBytes);
    const normalized = normalizeArchivePath(rawName);
    const hostSystem = versionMadeBy >>> 8;
    const unixMode = hostSystem === 3 ? externalAttributes >>> 16 : 0;
    const unixType = unixMode & UNIX_FILE_TYPE_MASK;
    if (unixType === UNIX_SYMBOLIC_LINK) throw archiveError("workspace_archive_link_rejected");
    if (unixType && unixType !== UNIX_DIRECTORY && unixType !== UNIX_REGULAR_FILE) {
      throw archiveError("workspace_archive_link_rejected");
    }
    const directoryByMode = unixType === UNIX_DIRECTORY || (externalAttributes & 0x10) === 0x10;
    const directoryByName = rawName.endsWith("/");
    if (directoryByMode !== directoryByName && unixType) throw archiveError("workspace_archive_format_rejected");
    const isDirectory = directoryByMode || directoryByName;
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw archiveError("workspace_archive_format_rejected");
    }
    if (!isDirectory && uncompressedSize > limits.maxFileBytes) {
      throw archiveError("workspace_archive_file_size_exceeded");
    }
    if (!isDirectory && exceedsRatio(uncompressedSize, compressedSize, limits.maxCompressionRatio)) {
      throw archiveError("workspace_archive_compression_ratio_exceeded");
    }

    const collisionKey = normalized.toLocaleLowerCase("en-US").normalize("NFC");
    if (collisionKeys.has(collisionKey)) throw archiveError("workspace_archive_entry_conflict");
    collisionKeys.add(collisionKey);

    const local = inspectLocalRecord(bytes, {
      centralOffset,
      compressedSize,
      flags,
      localOffset,
      method,
      nameBytes,
    });
    if (!isDirectory) {
      totalBytes += uncompressedSize;
      totalCompressedBytes += compressedSize;
      if (totalBytes > limits.maxTotalBytes) throw archiveError("workspace_archive_total_size_exceeded");
    }
    entries.push({
      compressedSize,
      dataOffset: local.dataOffset,
      expectedCrc,
      isDirectory,
      method,
      relativePath: normalized,
      uncompressedSize,
    });
    cursor = recordEnd;
  }
  if (cursor !== endOffset) throw archiveError("workspace_archive_format_rejected");
  assertNoFileParentConflicts(entries);
  if (exceedsRatio(totalBytes, totalCompressedBytes, limits.maxCompressionRatio)) {
    throw archiveError("workspace_archive_compression_ratio_exceeded");
  }
  return {
    archiveBytes: bytes.length,
    directoryCount: entries.filter((entry) => entry.isDirectory).length,
    entries,
    fileCount: entries.filter((entry) => !entry.isDirectory).length,
    totalBytes,
  };
}

function extractZipEntry(bytes, entry) {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let content;
  try {
    content = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch {
    throw archiveError("workspace_archive_integrity_failed");
  }
  if (content.length !== entry.uncompressedSize || crc32(content) !== entry.expectedCrc) {
    throw archiveError("workspace_archive_integrity_failed");
  }
  return content;
}

function createZipArchive(entries, limits) {
  if (!Array.isArray(entries) || entries.length > limits.maxEntries) {
    throw archiveError("workspace_archive_entry_limit_exceeded");
  }
  const collisionKeys = new Set();
  let totalBytes = 0;
  const safeEntries = entries.map((entry) => {
    const relativePath = normalizeArchivePath(entry.relativePath);
    if (relativePath !== entry.relativePath) throw archiveError("workspace_archive_path_rejected");
    const collisionKey = relativePath.toLowerCase().normalize("NFC");
    if (collisionKeys.has(collisionKey)) throw archiveError("workspace_archive_entry_conflict");
    collisionKeys.add(collisionKey);
    const size = entry.isDirectory ? 0 : Buffer.byteLength(entry.content);
    if (size > limits.maxFileBytes) throw archiveError("workspace_archive_file_size_exceeded");
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw archiveError("workspace_archive_total_size_exceeded");
    return { ...entry, relativePath };
  });
  assertNoFileParentConflicts(safeEntries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of safeEntries) {
    const name = Buffer.from(entry.isDirectory ? `${entry.relativePath}/` : entry.relativePath, "utf8");
    const content = entry.isDirectory ? Buffer.alloc(0) : Buffer.from(entry.content);
    const deflated = entry.isDirectory ? content : deflateRawSync(content, { level: 6 });
    const useDeflate = !entry.isDirectory && deflated.length < content.length &&
      !exceedsRatio(content.length, deflated.length, limits.maxCompressionRatio);
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.isDirectory ? 0o040700 : 0o100600;
    central.writeUInt32LE((((mode << 16) >>> 0) | (entry.isDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(safeEntries.length, 8);
  end.writeUInt16LE(safeEntries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function inspectLocalRecord(bytes, { centralOffset, compressedSize, flags, localOffset, method, nameBytes }) {
  if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw archiveError("workspace_archive_format_rejected");
  }
  const localFlags = bytes.readUInt16LE(localOffset + 6);
  const localMethod = bytes.readUInt16LE(localOffset + 8);
  const localNameLength = bytes.readUInt16LE(localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (
    localFlags !== flags || localMethod !== method || dataEnd > centralOffset ||
    localNameLength !== nameBytes.length ||
    !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)
  ) throw archiveError("workspace_archive_format_rejected");
  return { dataOffset };
}

function findEndRecord(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw archiveError("workspace_archive_format_rejected");
}

function decodeEntryName(bytes) {
  if (!bytes.length) throw archiveError("workspace_archive_path_rejected");
  try {
    return decoder.decode(bytes);
  } catch {
    throw archiveError("workspace_archive_path_rejected");
  }
}

function normalizeArchivePath(value) {
  const raw = String(value || "");
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (
    !withoutTrailingSlash || raw.length > 500 || raw.includes("\\") || raw.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
  ) throw archiveError("workspace_archive_path_rejected");
  const segments = withoutTrailingSlash.split("/");
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes(":") || /[. ]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  )) {
    throw archiveError("workspace_archive_path_rejected");
  }
  return segments.join("/");
}

function assertNoFileParentConflicts(entries) {
  const filePaths = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath.toLocaleLowerCase("en-US").normalize("NFC")));
  for (const entry of entries) {
    const segments = entry.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/").toLocaleLowerCase("en-US").normalize("NFC");
      if (filePaths.has(parent)) throw archiveError("workspace_archive_entry_conflict");
    }
  }
}

function exceedsRatio(uncompressedBytes, compressedBytes, limit) {
  return uncompressedBytes > 0 && uncompressedBytes / Math.max(1, compressedBytes) > limit;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function archiveError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { createZipArchive, extractZipEntry, inspectZipArchive };
