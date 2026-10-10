import buildContract from "../shared/feishu-read-build.cjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Reviewed upstream archive only; never build the installed/floating CLI tree.
const commit = buildContract.FEISHU_READ_BUILD.upstreamCommit;
const archiveDigest = buildContract.FEISHU_READ_BUILD.archiveDigest;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "desktop-channel-mvp/native/feishu-read");
const output = path.join(root, "data/local/feishu-read-helper", `${process.platform}-${process.arch}`);
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--source-archive" || args[2] !== "--go" ||
  !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error("usage: --source-archive ABSOLUTE_PATH --go ABSOLUTE_PATH");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
if (sha(fs.readFileSync(args[1])) !== archiveDigest) throw new Error("feishu_read_upstream_archive_mismatch");
const goVersion = execFileSync(args[3], ["version"], { encoding: "utf8" }).trim();
if (!goVersion.startsWith(`go version ${buildContract.FEISHU_READ_BUILD.compilerVersion} `)) throw new Error("feishu_read_reviewed_compiler_required");
fs.mkdirSync(output, { recursive: true });
const workspace = fs.mkdtempSync(path.join(output, "build-"));
try {
  execFileSync("tar", ["-xzf", args[1], "--strip-components=1", "-C", workspace], { stdio: "pipe" });
  const helper = path.join(workspace, "cmd/group-studio-feishu-read");
  fs.mkdirSync(helper, { recursive: true });
  const sourceHashes = {};
  for (const filename of ["main.go", "main_test.go", "LICENSE"]) {
    const bytes = fs.readFileSync(path.join(source, filename));
    sourceHashes[filename] = sha(bytes);
    fs.writeFileSync(path.join(helper, filename), bytes);
  }
  if (!fs.readFileSync(path.join(source, "LICENSE")).equals(fs.readFileSync(path.join(workspace, "LICENSE"))))
    throw new Error("feishu_read_upstream_notice_mismatch");
  const goOs = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
  const goArch = { arm64: "arm64", x64: "amd64" }[process.arch];
  if (!goOs || !goArch) throw new Error("feishu_read_build_platform_unsupported");
  const env = { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOOS: goOs, GOARCH: goArch };
  execFileSync(args[3], ["test", "./cmd/group-studio-feishu-read"], { cwd: workspace, env, stdio: "inherit" });
  const filename = process.platform === "win32" ? "group-studio-feishu-read.exe" : "group-studio-feishu-read";
  const temporaryBinary = path.join(workspace, filename);
  execFileSync(args[3], ["build", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", temporaryBinary,
    "./cmd/group-studio-feishu-read"], { cwd: workspace, env, stdio: "inherit" });
  // Seal the final local macOS executable, not Go's initial linker signature.
  // Packaging verifies this digest again; a different release identity must
  // rebuild/reseal explicitly instead of rewriting checksums after packaging.
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", temporaryBinary], { stdio: "pipe" });
    execFileSync("codesign", ["--verify", "--strict", temporaryBinary], { stdio: "pipe" });
  }
  const bytes = fs.readFileSync(temporaryBinary), binaryDigest = sha(bytes);
  const binary = path.join(output, `${binaryDigest}-${filename}`);
  if (fs.existsSync(binary) && sha(fs.readFileSync(binary)) !== binaryDigest) throw new Error("feishu_read_output_integrity_invalid");
  if (!fs.existsSync(binary)) fs.writeFileSync(binary, bytes, { mode: 0o555, flag: "wx" });
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(output, "LICENSE"));
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1,
    contractVersion: buildContract.FEISHU_READ_BUILD.contractVersion, upstreamVersion: buildContract.FEISHU_READ_BUILD.upstreamVersion, upstreamCommit: commit,
    archiveDigest, sourceHashes, compiler: goVersion, platform: process.platform, arch: process.arch,
    binaryFilename: path.basename(binary), binaryDigest }, null, 2) + "\n");
  console.log(`Feishu read helper built from verified pinned archive (${process.platform}-${process.arch})`);
} finally { fs.rmSync(workspace, { recursive: true, force: true }); }
