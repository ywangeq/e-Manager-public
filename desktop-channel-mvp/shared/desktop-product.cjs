const DESKTOP_PRODUCT = Object.freeze({
  productId: "e-manager-local-desktop",
  routeBase: "/api/desktop-releases",
});
const GROUP_STUDIO_PRODUCT = Object.freeze({
  productId: "e-manager-local-group-studio",
  routeBase: "/api/desktop-releases/group-studio",
  version: "3.0.0-beta.32",
  appId: "com.emanager.local.groupstudio",
  productName: "Group Studio 3.0",
  output: "release-group-studio",
  tagPrefix: "group-studio-v",
});

function productById(id) {
  if (id === DESKTOP_PRODUCT.productId) return DESKTOP_PRODUCT;
  if (id === GROUP_STUDIO_PRODUCT.productId) return GROUP_STUDIO_PRODUCT;
  return null;
}

function buildProduct(selection = "desktop") {
  if (selection === "desktop") return DESKTOP_PRODUCT;
  if (selection === "group-studio") return GROUP_STUDIO_PRODUCT;
  throw new Error("unknown Desktop build product");
}

function packagedProduct(metadata) {
  const declared = metadata?.digitalWorkforceProduct;
  const product = productById(declared === undefined ? DESKTOP_PRODUCT.productId : declared);
  if (!product || metadata?.name !== product.productId
    || (product === GROUP_STUDIO_PRODUCT && !/^3\.\d+\.\d+(?:-beta\.\d+)?$/.test(metadata.version))) {
    throw new Error("invalid packaged Desktop product identity");
  }
  return product;
}

function groupFeedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.split("/").includes("group-studio");
  } catch { return false; }
}

// The 2.x transition catalog must never offer a Group installer to old clients.
function supportsVersion(product, version) {
  if (product === GROUP_STUDIO_PRODUCT) return /^3\.\d+\.\d+(?:-beta\.\d+)?$/.test(String(version));
  return product === DESKTOP_PRODUCT && /^[012]\./.test(String(version));
}

module.exports = { DESKTOP_PRODUCT, GROUP_STUDIO_PRODUCT, buildProduct, packagedProduct, productById, groupFeedUrl, supportsVersion };
