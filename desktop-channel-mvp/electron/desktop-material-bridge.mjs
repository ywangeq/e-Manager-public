import crypto from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { attachmentMimeTypeForName } from "../shared/desktop-attachments.mjs";

const MAX_BRIDGE_ITEMS = 8;
const MAX_BRIDGE_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_BRIDGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const SELECTIVE_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".txt", ".md", ".csv", ".tsv", ".xml"]);
const DIRECT_FILE_EXTENSIONS = new Set([...SELECTIVE_EXTENSIONS, ".pdf", ".docx"]);

async function prepareDesktopMaterialBridge({ files = [], materialInputContracts = [], signal } = {}) {
  const contracts = normalizeMaterialInputContracts(materialInputContracts);
  const items = [];
  const skipped = [];
  let totalBytes = 0;

  for (const file of files) {
    throwIfAborted(signal);
    if (items.length >= MAX_BRIDGE_ITEMS || totalBytes >= MAX_BRIDGE_TOTAL_BYTES) break;
    const extension = path.extname(file.name || file.filePath || "").toLowerCase();
    if (extension === ".zip") {
      const archiveItems = await selectedArchiveItems({
        archivePath: file.filePath,
        contracts,
        signal,
      });
      for (const item of archiveItems.items) {
        if (items.length >= MAX_BRIDGE_ITEMS || totalBytes + item.bytes.length > MAX_BRIDGE_TOTAL_BYTES) break;
        items.push(bridgeItem(item.name, item.bytes, item.materialContract));
        totalBytes += item.bytes.length;
      }
      skipped.push(...archiveItems.skipped);
      continue;
    }
    if (!DIRECT_FILE_EXTENSIONS.has(extension)) continue;
    const materialContract = directFileContract(file.name, contracts);
    if (contracts.length && !materialContract && SELECTIVE_EXTENSIONS.has(extension)) continue;
    if (Number(file.size) > MAX_BRIDGE_ITEM_BYTES) {
      skipped.push({ name: path.basename(file.name || "file"), reason: "bridge_item_too_large" });
      continue;
    }
    const bytes = await readFile(file.filePath, { signal });
    if (!bytes.length || bytes.length > MAX_BRIDGE_ITEM_BYTES || totalBytes + bytes.length > MAX_BRIDGE_TOTAL_BYTES) {
      skipped.push({ name: path.basename(file.name || "file"), reason: "bridge_item_too_large" });
      continue;
    }
    items.push(bridgeItem(path.basename(file.name), bytes, materialContract));
    totalBytes += bytes.length;
  }

  return {
    contractVersion: "desktop-material-bridge.v1",
    status: items.length ? "selective_material_ready" : "no_selective_material",
    selectionMode: contracts.length ? "callable_skill_contract" : "direct_selection_only",
    items,
    skipped: skipped.slice(0, 12),
    totalBytes,
  };
}

async function selectedArchiveItems({ archivePath = "", contracts = [], signal } = {}) {
  let archive;
  try {
    throwIfAborted(signal);
    archive = await open(archivePath, "r");
    const entries = await readZipDirectory(archive, signal);
    const candidates = entries.filter((entry) => SELECTIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
    const contractMatches = archiveContractMatches(candidates, contracts);
    const snapshotMatches = archiveSnapshotContractMatches(entries, contracts, archivePath);
    const selected = [...(contractMatches.length === 1 ? contractMatches : []), ...snapshotMatches];
    const effectiveSelection = selected.length
      ? selected
      : !contracts.length && candidates.length === 1
        ? [{ entry: candidates[0], materialContract: null }]
        : [];
    const skipped = [];
    const items = [];
    for (const selectedItem of effectiveSelection.slice(0, MAX_BRIDGE_ITEMS)) {
      throwIfAborted(signal);
      try {
        if (selectedItem.snapshot) {
          items.push(await createArchiveSnapshotItem({ archive, entries, selectedItem, signal }));
          continue;
        }
        const { entry, materialContract } = selectedItem;
        const bytes = await readZipEntry(archive, entry, signal);
        if (!bytes.length) throw new Error("archive_entry_empty");
        items.push({ name: path.basename(entry.name), bytes, materialContract });
      } catch (error) {
        if (error?.code === "desktop_material_preparation_canceled") throw error;
        const entry = selectedItem.entry;
        skipped.push({
          name: path.basename(entry?.name || archivePath),
          reason: entry?.uncompressedSize > MAX_BRIDGE_ITEM_BYTES ? "bridge_item_too_large" : selectedItem.snapshot ? "archive_snapshot_failed" : "archive_entry_read_failed",
        });
      }
    }
    if (!effectiveSelection.length && contracts.length) {
      skipped.push({ name: path.basename(archivePath), reason: contractMatches.length > 1 ? "material_contract_ambiguous" : "material_contract_not_found" });
    }
    return { items, skipped };
  } catch (error) {
    if (error?.code === "desktop_material_preparation_canceled") throw error;
    return { items: [], skipped: [{ name: path.basename(archivePath), reason: "archive_inspection_failed" }] };
  } finally {
    await archive?.close().catch(() => {});
  }
}

function archiveSnapshotContractMatches(entries = [], contracts = [], archivePath = "") {
  const extension = path.extname(archivePath).toLowerCase();
  const matches = [];
  for (const contract of contracts) {
    const snapshot = contract.archiveSnapshot;
    if (contract.transfer !== "archive_snapshot" || !snapshot?.sourceExtensions.includes(extension)) continue;
    if (entries.length > snapshot.maxEntries) continue;
    const requiredPresent = snapshot.requiredBaseNames.every((requiredName) => (
      entries.filter((entry) => path.basename(entry.name).toLowerCase() === requiredName.toLowerCase()).length === 1
    ));
    if (!requiredPresent) continue;
    matches.push({
      snapshot,
      materialContract: contractProvenance(contract, { selectorId: snapshot.snapshotId }),
    });
  }
  return matches;
}

async function createArchiveSnapshotItem({ archive, entries, selectedItem, signal }) {
  const { snapshot, materialContract } = selectedItem;
  const inventoryExtensions = new Set([...snapshot.inventoryExtensions, ...snapshot.textExtensions]);
  const included = entries.filter((entry) => inventoryExtensions.has(path.extname(entry.name).toLowerCase()));
  const textEntries = included.filter((entry) => snapshot.textExtensions.includes(path.extname(entry.name).toLowerCase()));
  if (textEntries.length > snapshot.maxTextEntries) throw new Error("archive_snapshot_text_entry_limit");
  if (textEntries.reduce((total, entry) => total + entry.uncompressedSize, 0) > snapshot.maxTextBytes) {
    throw new Error("archive_snapshot_text_byte_limit");
  }
  const snapshotEntries = [];
  let textBytes = 0;
  for (const entry of included) {
    throwIfAborted(signal);
    const item = { path: entry.name, sizeBytes: entry.uncompressedSize };
    if (snapshot.textExtensions.includes(path.extname(entry.name).toLowerCase())) {
      try {
        const bytes = await readZipEntry(archive, entry, signal);
        textBytes += bytes.length;
        if (textBytes > snapshot.maxTextBytes) throw new Error("archive_snapshot_text_byte_limit");
        item.text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        if (error?.code === "desktop_material_preparation_canceled") throw error;
        item.readError = "archive_text_entry_unreadable";
      }
    }
    snapshotEntries.push(item);
  }
  const payload = {
    contractVersion: "desktop-archive-snapshot.v1",
    inventoryComplete: true,
    source: {
      kind: "zip",
      fileCount: entries.length,
      includedFileCount: snapshotEntries.length,
      textFileCount: textEntries.length,
    },
    entries: snapshotEntries,
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (!bytes.length || bytes.length > MAX_BRIDGE_ITEM_BYTES) throw new Error("archive_snapshot_too_large");
  return { name: snapshot.snapshotFileName, bytes, materialContract };
}

async function readZipDirectory(archive, signal) {
  const stat = await archive.stat();
  if (!stat.isFile() || stat.size < 22) throw new Error("zip_invalid");
  const tailLength = Math.min(stat.size, 65_557);
  const tail = await readExactly(archive, stat.size - tailLength, tailLength);
  throwIfAborted(signal);
  const eocdOffset = findSignatureBackwards(tail, 0x06054b50);
  if (eocdOffset < 0) throw new Error("zip_eocd_missing");
  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const directoryDisk = tail.readUInt16LE(eocdOffset + 6);
  const diskEntries = tail.readUInt16LE(eocdOffset + 8);
  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const directorySize = tail.readUInt32LE(eocdOffset + 12);
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== entryCount) throw new Error("zip_multidisk_unsupported");
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error("zip64_unsupported");
  if (entryCount > MAX_ZIP_ENTRIES || directorySize > MAX_ZIP_DIRECTORY_BYTES || directoryOffset + directorySize > stat.size) {
    throw new Error("zip_directory_limit");
  }
  const directory = await readExactly(archive, directoryOffset, directorySize);
  const entries = [];
  let offset = 0;
  while (offset < directory.length && entries.length < entryCount) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip_directory_invalid");
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const crc32 = directory.readUInt32LE(offset + 16);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > directory.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("zip_entry_invalid");
    }
    const rawName = decodeZipEntryName(directory.subarray(offset + 46, offset + 46 + nameLength), flags);
    const name = normalizeArchiveEntry(rawName);
    if (name) entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nextOffset;
  }
  if (entries.length !== entryCount && offset !== directory.length) throw new Error("zip_entry_count_invalid");
  return entries;
}

function decodeZipEntryName(rawName, flags) {
  if ((flags & 0x0800) !== 0) return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    return new TextDecoder("gbk", { fatal: true }).decode(rawName);
  }
}

async function readZipEntry(archive, entry, signal) {
  if ((entry.flags & 0x1) !== 0) throw new Error("zip_encrypted_unsupported");
  if (![0, 8].includes(entry.method)) throw new Error("zip_compression_unsupported");
  if (entry.uncompressedSize > MAX_BRIDGE_ITEM_BYTES || entry.compressedSize > MAX_BRIDGE_ITEM_BYTES * 2) {
    throw new Error("zip_entry_too_large");
  }
  const localHeader = await readExactly(archive, entry.localHeaderOffset, 30);
  if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error("zip_local_header_invalid");
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = await readExactly(archive, dataOffset, entry.compressedSize);
  throwIfAborted(signal);
  const bytes = entry.method === 0
    ? compressed
    : inflateRawSync(compressed, { maxOutputLength: MAX_BRIDGE_ITEM_BYTES });
  if (bytes.length !== entry.uncompressedSize || bytes.length > MAX_BRIDGE_ITEM_BYTES || crc32Of(bytes) !== entry.crc32) {
    throw new Error("zip_entry_integrity_invalid");
  }
  return bytes;
}

async function readExactly(archive, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await archive.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error("zip_unexpected_eof");
    offset += bytesRead;
  }
  return buffer;
}

function findSignatureBackwards(buffer, signature) {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function crc32Of(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeMaterialInputContracts(contracts = []) {
  if (!Array.isArray(contracts)) return [];
  return contracts.slice(0, 20).map((contract) => {
    if (contract?.contractVersion === "skill-material-input.v2") return normalizeArchiveSnapshotContract(contract);
    if (!(
    contract?.contractVersion === "skill-material-input.v1" &&
    /^sha256:[a-f0-9]{64}$/.test(contract.contractDigest || "") &&
    contract.transfer === "minimal_file_only" &&
    Array.isArray(contract.selectors)
    )) return null;
    return {
      skillId: normalizeContractId(contract.skillId),
      contractId: normalizeContractId(contract.contractId),
      contractDigest: contract.contractDigest,
      transfer: "minimal_file_only",
      selectors: contract.selectors.slice(0, 8).map((selector) => ({
      selectorId: normalizeContractId(selector?.selectorId),
      sources: Array.isArray(selector?.sources) ? selector.sources.filter((source) => ["direct_file", "archive_entry"].includes(source)) : [],
      exactBaseNames: Array.isArray(selector?.exactBaseNames) ? selector.exactBaseNames.map((name) => path.basename(String(name))).filter(Boolean) : [],
      extensions: Array.isArray(selector?.extensions) ? selector.extensions.map((value) => String(value).toLowerCase()).filter((value) => DIRECT_FILE_EXTENSIONS.has(value)) : [],
      minimum: Number(selector?.minimum),
      maximum: Number(selector?.maximum),
      archiveMatch: selector?.archiveMatch,
    })).filter((selector) => selector.selectorId && selector.minimum === 1 && selector.maximum === 1 && selector.archiveMatch === "unique_only"),
    };
  }).filter((contract) => contract?.skillId && contract.contractId && (contract.selectors?.length || contract.archiveSnapshot));
}

function normalizeArchiveSnapshotContract(contract = {}) {
  const snapshot = contract.archiveSnapshot;
  if (!/^sha256:[a-f0-9]{64}$/.test(contract.contractDigest || "") || contract.transfer !== "archive_snapshot" || !snapshot) return null;
  const normalized = {
    skillId: normalizeContractId(contract.skillId),
    contractId: normalizeContractId(contract.contractId),
    contractDigest: contract.contractDigest,
    transfer: "archive_snapshot",
    archiveSnapshot: {
      snapshotId: normalizeContractId(snapshot.snapshotId),
      sourceExtensions: normalizeExtensions(snapshot.sourceExtensions, 8),
      requiredBaseNames: Array.isArray(snapshot.requiredBaseNames) ? snapshot.requiredBaseNames.map((name) => path.basename(String(name))).filter(Boolean).slice(0, 16) : [],
      textExtensions: normalizeExtensions(snapshot.textExtensions, 16),
      inventoryExtensions: normalizeExtensions(snapshot.inventoryExtensions, 32),
      snapshotFileName: path.basename(String(snapshot.snapshotFileName || "")),
      maxEntries: Number(snapshot.maxEntries),
      maxTextEntries: Number(snapshot.maxTextEntries),
      maxTextBytes: Number(snapshot.maxTextBytes),
    },
  };
  const value = normalized.archiveSnapshot;
  if (!normalized.skillId || !normalized.contractId || !value.snapshotId || !value.sourceExtensions.length || !value.requiredBaseNames.length || !value.textExtensions.length || !value.inventoryExtensions.length) return null;
  if (!value.snapshotFileName || path.extname(value.snapshotFileName).toLowerCase() !== ".json") return null;
  if (!Number.isInteger(value.maxEntries) || value.maxEntries < 1 || value.maxEntries > MAX_ZIP_ENTRIES) return null;
  if (!Number.isInteger(value.maxTextEntries) || value.maxTextEntries < 1 || value.maxTextEntries > 2_000) return null;
  if (!Number.isInteger(value.maxTextBytes) || value.maxTextBytes < 1 || value.maxTextBytes > 3 * 1024 * 1024) return null;
  return normalized;
}

function normalizeExtensions(values, maximum) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).toLowerCase()).filter((value) => /^\.[a-z0-9]{1,12}$/.test(value)))].slice(0, maximum)
    : [];
}

function archiveContractMatches(candidates = [], contracts = []) {
  const matches = [];
  for (const contract of contracts) {
    for (const selector of contract.selectors || []) {
      if (!selector.sources.includes("archive_entry")) continue;
      const selected = candidates.filter((entry) => selectorMatchesName(selector, entry.name));
      if (selected.length !== 1) continue;
      matches.push({ entry: selected[0], materialContract: contractProvenance(contract, selector) });
    }
  }
  const unique = new Map();
  for (const match of matches) unique.set(`${match.entry.name}\0${match.materialContract.skillId}\0${match.materialContract.contractDigest}\0${match.materialContract.selectorId}`, match);
  return [...unique.values()];
}

function directFileContract(name = "", contracts = []) {
  const matches = [];
  for (const contract of contracts) {
    for (const selector of contract.selectors || []) {
      if (selector.sources.includes("direct_file") && selectorMatchesName(selector, name)) matches.push(contractProvenance(contract, selector));
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function selectorMatchesName(selector, name = "") {
  const baseName = path.basename(String(name));
  const extension = path.extname(baseName).toLowerCase();
  return selector.extensions.includes(extension) && selector.exactBaseNames.some((expected) => expected.toLowerCase() === baseName.toLowerCase());
}

function contractProvenance(contract, selector) {
  return {
    contractVersion: "desktop-material-contract-provenance.v1",
    skillId: contract.skillId,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    selectorId: selector.selectorId,
  };
}

function normalizeContractId(value = "") {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(id) ? id : "";
}

function normalizeRequestedName(value = "") {
  const normalized = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return "";
  return normalized.slice(0, 240);
}

function normalizeArchiveEntry(value = "") {
  const normalized = normalizeRequestedName(value);
  if (!normalized || normalized.endsWith("/")) return "";
  return normalized;
}

function bridgeItem(name, bytes, materialContract = null) {
  return {
    contractVersion: "desktop-material-bridge-item.v1",
    itemId: crypto.randomUUID(),
    name: path.basename(name).slice(0, 160),
    mimeType: attachmentMimeTypeForName(name),
    sizeBytes: bytes.length,
    contentDigest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    ...(materialContract ? { materialContract } : {}),
    base64: bytes.toString("base64"),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("desktop_material_preparation_canceled");
  error.code = "desktop_material_preparation_canceled";
  throw error;
}

export {
  MAX_BRIDGE_ITEM_BYTES,
  MAX_BRIDGE_TOTAL_BYTES,
  prepareDesktopMaterialBridge,
};
