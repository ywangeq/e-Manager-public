import { createProviderRuntimeError } from "./provider-errors.mjs";

function createProviderAdapterRegistry({ adapters = [] } = {}) {
  const registered = adapters.filter((adapter) => (
    adapter?.id && typeof adapter?.matches === "function" &&
    typeof adapter?.requestPayload === "function" && typeof adapter?.requestText === "function"
  ));

  function resolve(lease = {}) {
    const adapter = registered.find((candidate) => candidate.matches(lease));
    if (!adapter) throw createProviderRuntimeError("provider_adapter_not_registered");
    return adapter;
  }

  return {
    adapterIdFor: (lease = {}) => resolve(lease).id,
    describe: () => registered.map((adapter) => ({ id: adapter.id, apiProtocol: adapter.apiProtocol, upstreamDialect: adapter.upstreamDialect })),
    requestPayload: ({ lease = {}, body = {}, canonicalContent = [], onTextDelta = null, signal = null, timeoutController = null } = {}) => resolve(lease).requestPayload({ lease, body, canonicalContent, onTextDelta, signal, timeoutController }),
    requestText: ({ lease = {}, body = {}, canonicalContent = [], onTextDelta = null, signal = null, timeoutController = null } = {}) => resolve(lease).requestText({ lease, body, canonicalContent, onTextDelta, signal, timeoutController }),
  };
}

export { createProviderAdapterRegistry };
