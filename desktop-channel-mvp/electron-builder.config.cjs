const packageJson = require("./package.json");
const path = require("node:path");
module.exports = {
  ...packageJson.build,
  publish: null,
  extraResources: [...packageJson.build.extraResources, { from: "../LICENSE", to: "LICENSE" }, { from: "../NOTICE", to: "NOTICE" }],
  mac: { ...packageJson.build.mac, extraResources: [{ from: "native/managed-sandbox-helper/target/release/managed-sandbox-helper", to: "managed-sandbox-helper" }] },
};
