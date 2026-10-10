const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const FEISHU_READ_BUILD = Object.freeze({ contractVersion: "group-feishu-read.v3", upstreamVersion: "1.0.70",
  upstreamCommit: "80b36453621b6b5cb205ba4013244a87b340fed7",
  archiveDigest: "ead170a5b065e7db5e9183c754b227de9b41f633e6c3c34e5e7c7798a9d7147d", compilerVersion: "go1.27.2" });

// One package provenance contract for the builder, verifier and main loader.
function verifyFeishuReadResources(directory, platform = process.platform, arch = process.arch) {
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("group_feishu_read_resource_invalid");
  const manifestPath = path.join(directory, "manifest.json"), manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 4096) throw new Error("group_feishu_read_manifest_invalid");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const fields = ["schemaVersion", "contractVersion", "upstreamVersion", "upstreamCommit", "archiveDigest", "sourceHashes", "compiler", "platform", "arch", "binaryFilename", "binaryDigest"];
  if (Object.keys(manifest).length !== fields.length || fields.some(key => !Object.hasOwn(manifest, key)) || manifest.schemaVersion !== 1 ||
    ["contractVersion", "upstreamVersion", "upstreamCommit", "archiveDigest"].some(key => manifest[key] !== FEISHU_READ_BUILD[key]) ||
    manifest.platform !== platform || manifest.arch !== arch || !String(manifest.compiler || "").startsWith(`go version ${FEISHU_READ_BUILD.compilerVersion} `) ||
    !/^[a-f0-9]{64}$/.test(manifest.binaryDigest || "") ||
    manifest.binaryFilename !== `${manifest.binaryDigest}-group-studio-feishu-read${platform === "win32" ? ".exe" : ""}` ||
    !manifest.sourceHashes || Object.keys(manifest.sourceHashes).sort().join(",") !== "LICENSE,main.go,main_test.go" ||
    Object.values(manifest.sourceHashes).some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
    throw new Error("group_feishu_read_build_manifest_invalid");
  const binaryPath = path.join(directory, manifest.binaryFilename), stat = fs.lstatSync(binaryPath);
  const licensePath = path.join(directory, "LICENSE"), licenseStat = fs.lstatSync(licensePath);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024 || (platform !== "win32" && !(stat.mode & 0o111)) ||
    sha(fs.readFileSync(binaryPath)) !== manifest.binaryDigest || !licenseStat.isFile() || licenseStat.size > 4096 ||
    sha(fs.readFileSync(licensePath)) !== manifest.sourceHashes.LICENSE) throw new Error("group_feishu_read_build_binary_invalid");
  return Object.freeze({ directory, binaryPath, manifest: Object.freeze(manifest), resources: [
    { from: binaryPath, to: `feishu-read/${manifest.binaryFilename}` },
    { from: manifestPath, to: "feishu-read/manifest.json" },
    { from: licensePath, to: "feishu-read/LICENSE" },
  ] });
}
function assertFeishuReadBuild(root, platform = process.platform, arch = process.arch) {
  const verified = verifyFeishuReadResources(path.join(root, "data/local/feishu-read-helper", `${platform}-${arch}`), platform, arch);
  for (const filename of ["main.go", "main_test.go", "LICENSE"]) {
    if (sha(fs.readFileSync(path.join(root, "desktop-channel-mvp/native/feishu-read", filename))) !== verified.manifest.sourceHashes[filename])
      throw new Error("group_feishu_read_build_source_changed");
  }
  return verified;
}
module.exports = { FEISHU_READ_BUILD, verifyFeishuReadResources, assertFeishuReadBuild };
