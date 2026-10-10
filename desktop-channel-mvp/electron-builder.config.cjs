const packageJson = require("./package.json");
const path = require("node:path");
const { assertFeishuReadBuild, verifyFeishuReadResources } = require("./shared/feishu-read-build.cjs");
const helper = assertFeishuReadBuild(path.resolve(__dirname, ".."));
function verifyHelper(context) {
  const targetArch = typeof context.arch === "string" ? context.arch : ["ia32", "x64", "arm", "arm64", "universal"][context.arch];
  if (context.electronPlatformName !== process.platform || targetArch !== process.arch)
    throw new Error("Local Group Studio helper requires a verified native target build");
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  verifyFeishuReadResources(path.join(resources, "feishu-read"));
}
module.exports = {
  ...packageJson.build,
  publish: null,
  extraResources: [...packageJson.build.extraResources, ...helper.resources, { from: "../LICENSE", to: "LICENSE" }, { from: "../NOTICE", to: "NOTICE" }],
  afterPack: verifyHelper,
  afterSign: verifyHelper,
  mac: { ...packageJson.build.mac, extraResources: [{ from: "native/managed-sandbox-helper/target/release/managed-sandbox-helper", to: "managed-sandbox-helper" }] },
};
