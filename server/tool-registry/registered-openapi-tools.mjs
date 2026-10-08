// The connection registry is the existing system/credential-reference authority.
// Registry assets never supply environment variable names or raw secrets.
export function createToolConnectionAuthority({ getConnections }) {
  function connection(asset) {
    const { systems, credentials } = getConnections();
    const system = systems.find(item => item.sourceSystemId === asset.sourceSystemId);
    const credential = credentials.find(item => item.credentialRef === asset.credentialRef);
    if (!system || system.status !== "active" || !credential || credential.status !== "active" ||
      credential.sourceSystemId !== asset.sourceSystemId || credential.credentialType !== "service_api_key" ||
      credential.secretAuthority !== "server_environment" || !credential.secretLocator) return null;
    try {
      if (new URL(system.homepageUrl).origin !== new URL(asset.baseUrl).origin) return null;
    } catch { return null; }
    return credential;
  }
  function validateReferences(asset) { return Boolean(connection(asset)); }
  function options() {
    const { systems, credentials } = getConnections();
    return { systems: systems.filter(item => item.status === "active").map(item => ({
      sourceSystemId: item.sourceSystemId, displayName: item.displayName, homepageUrl: item.homepageUrl })),
    credentials: credentials.filter(item => item.status === "active" && item.credentialType === "service_api_key" && item.secretAuthority === "server_environment")
      .map(item => ({ credentialRef: item.credentialRef, sourceSystemId: item.sourceSystemId, displayName: item.displayName })) };
  }
  return { connection, validateReferences, options };
}

export function createRegisteredOpenApiTools({ repository, connectionAuthority, environment = process.env }) {
  const { connection } = connectionAuthority;
  function descriptors() {
    return repository.publishedAssets().filter(asset => asset.kind === "managed_openapi").flatMap(asset => {
      const current = repository.resolvePublished(asset.toolId);
      const credential = current && connection(current); if (!credential) return [];
      const secret = environment[credential.secretLocator] || "";
      return [{ toolId: asset.toolId, toolNamePrefix: asset.toolId.replace(/-/g, "_"),
        baseUrl: asset.baseUrl, openApiDocument: asset.openApiDocument,
        managedCredentialHeader: asset.credentialHeader,
        managedRequestHeaders: [{ name: asset.credentialHeader, value: secret }],
        isCurrent: () => {
          const current = repository.resolvePublished(asset.toolId);
          const liveCredential = current && connection(current);
          return Boolean(current && current.assetRevision === asset.assetRevision && liveCredential &&
            liveCredential.secretLocator === credential.secretLocator && environment[liveCredential.secretLocator] === secret);
        },
      }];
    });
  }
  return { descriptors };
}
