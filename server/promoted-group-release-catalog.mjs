import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import products from "../desktop-channel-mvp/shared/desktop-product.cjs";
import { normalizeReleaseManifest, safeHttpsUrl } from "../desktop-channel-mvp/electron/release-update-model.mjs";

const product = products.GROUP_STUDIO_PRODUCT;
const platforms = { "darwin-arm64": { platform: "darwin", arch: "arm64", suffix: "arm64.dmg" },
  "win32-x64": { platform: "win32", arch: "x64", suffix: "x64.exe" } };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const readAsync = promisify(fs.read);

function trusted(info, directory) {
  assert.ok(info.uid === 0 || info.uid === process.getuid(), "untrusted release owner");
  assert.equal(info.mode & 0o022, 0, "untrusted release mode");
  assert.ok(directory ? info.isDirectory() : info.isFile() && info.nlink === 1, "untrusted release entry");
}

function openTrustedFile(root, segments, limit) {
  const full = path.join(root, ...segments);
  assert.equal(path.resolve(root), root, "release root must be canonical absolute path");
  assert.equal(fs.realpathSync(root), root, "release root alias forbidden");
  assert.ok(segments.every(segment => segment && segment !== "." && segment !== ".." && !/[\\/]/.test(segment)));
  let parent = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const ancestors = [];
  let prefix = "/";
  try {
    for (const segment of path.dirname(full).split(path.sep).filter(Boolean)) {
      prefix = path.join(prefix, segment);
      const reference = process.platform === "linux" ? `/proc/self/fd/${parent}/${segment}` : prefix;
      const next = fs.openSync(reference, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(parent);
      parent = next;
      const info = fs.fstatSync(parent);
      trusted(info, true);
      ancestors.push({ prefix, info });
    }
    const reference = process.platform === "linux" ? `/proc/self/fd/${parent}/${path.basename(full)}` : full;
    const fd = fs.openSync(reference, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd);
      trusted(info, false);
      assert.ok(info.size > 0 && info.size <= limit, "release file exceeds bounds");
      if (process.platform !== "linux") {
        for (const ancestor of ancestors) {
          const current = fs.lstatSync(ancestor.prefix);
          assert.ok(current.isDirectory() && current.dev === ancestor.info.dev && current.ino === ancestor.info.ino,
            "release ancestor changed during open");
        }
      }
      return { fd, info };
    } catch (error) { fs.closeSync(fd); throw error; }
  } finally { fs.closeSync(parent); }
}

function unchanged(fd, before) {
  const after = fs.fstatSync(fd);
  assert.ok(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
    "release content changed during validation");
}

function manifestFile(root, segments) {
  const { fd, info } = openTrustedFile(root, segments, 128 * 1024);
  try {
    const bytes = fs.readFileSync(fd);
    assert.equal(bytes.length, info.size);
    unchanged(fd, info);
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function createPromotedGroupCatalogReader({ directory, publicOrigin, channel }) {
  assert.ok(path.isAbsolute(directory) && path.basename(directory) === "group-studio", "independent absolute Group publication root required");
  const root = path.resolve(directory);
  const origin = safeHttpsUrl(publicOrigin);
  assert.ok(origin && new URL(origin).pathname === "/" && !new URL(origin).search && !new URL(origin).hash,
    "promoted Group catalog requires managed HTTPS origin");
  const base = new URL(`${product.routeBase}/feed/`, origin);
  const digests = new Map();
  function validate(bytes, expectedVersion = "") {
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.product, product.productId);
    assert.equal(channel, "beta", "signed/stable publication needs separate acceptance");
    assert.equal(manifest.channel, channel);
    assert.match(manifest.version || "", /^3\.\d+\.\d+-beta\.\d+$/);
    if (expectedVersion) assert.equal(manifest.version, expectedVersion);
    assert.match(manifest.sourceRevision || "", /^[a-f0-9]{40}$/);
    assert.ok(Number.isFinite(Date.parse(manifest.publishedAt)));
    assert.ok(safeHttpsUrl(manifest.downloadPageUrl) && new URL(manifest.downloadPageUrl).origin === new URL(origin).origin);
    assert.deepEqual(Object.keys(manifest.artifacts).sort(), Object.keys(platforms).sort());
    const normalized = {};
    for (const [id, options] of Object.entries(platforms)) {
      const entry = manifest.artifacts[id];
      const fileName = `SmartMore-Digital-Workforce-${manifest.version}-${options.suffix}`;
      assert.equal(entry.fileName, fileName);
      assert.equal(entry.url, new URL(`${channel}/releases/${manifest.version}/${fileName}`, base).toString());
      assert.ok(!Object.hasOwn(entry, "signed") && !Object.hasOwn(entry, "updateFeedUrl"));
      assert.match(entry.sha256 || "", /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 1024 ** 3);
      const value = normalizeReleaseManifest(manifest, { ...options, channel, product: product.productId });
      assert.ok(value?.artifactUrl && value.artifactSha256 && value.artifactSize);
      normalized[id] = { ...value, fileName };
    }
    return { manifest, normalized };
  }

  async function openArtifact(manifest, platformId, { forceHash = false } = {}) {
    const entry = manifest.artifacts[platformId];
    assert.ok(entry && Object.hasOwn(platforms, platformId));
    const opened = openTrustedFile(root, [channel, "releases", manifest.version, entry.fileName], 1024 ** 3);
    try {
      assert.equal(opened.info.size, entry.size, "published artifact size mismatch");
      const precision = fs.fstatSync(opened.fd, { bigint: true });
      const key = [precision.dev, precision.ino, precision.size, precision.ctimeNs, precision.mtimeNs].join(":");
      let digest = forceHash ? null : digests.get(key);
      if (!digest) {
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await readAsync(opened.fd, buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          assert.ok(position <= entry.size, "published artifact grew during validation");
          hash.update(buffer.subarray(0, bytesRead));
        }
        assert.equal(position, entry.size);
        digest = hash.digest("hex");
      }
      unchanged(opened.fd, opened.info);
      assert.equal(digest, entry.sha256, "published artifact digest mismatch");
      if (digests.size >= 4) digests.clear();
      digests.set(key, digest);
      return { ...opened, fileName: entry.fileName };
    } catch (error) { fs.closeSync(opened.fd); throw error; }
  }

  async function read(version = "") {
    if (version) assert.match(version, /^3\.\d+\.\d+-beta\.\d+$/);
    const bytes = manifestFile(root, [channel, "latest.json"]);
    const { manifest, normalized } = validate(bytes);
    assert.ok(bytes.equals(manifestFile(root, [channel, "releases", manifest.version, "latest.json"])),
      "promoted head differs from immutable manifest");
    for (const id of Object.keys(platforms)) {
      const { fd } = await openArtifact(manifest, id);
      fs.closeSync(fd);
    }
    if (version && manifest.version !== version) throw Object.assign(new Error("desktop_release_version_changed"), { code: "desktop_release_version_changed" });
    return { ok: true, source: "published_manifest", channel, version: manifest.version, publishedAt: manifest.publishedAt,
      downloadPageUrl: manifest.downloadPageUrl, mandatory: manifest.mandatory === true,
      releaseNotes: normalized["darwin-arm64"].releaseNotes, distributionNotice: "企业内测发布：未签名或未公证，需手动安装。",
      manifestRevision: `sha256:${sha256(bytes)}`, platforms: normalized, manifest, manifestBytes: bytes };
  }
  return { read, openArtifact };
}
