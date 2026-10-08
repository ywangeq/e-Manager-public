function createRuntimeAdapterRegistry({ adapters = [], defaultAdapterId = "" } = {}) {
  const adapterById = new Map();
  for (const adapter of adapters) {
    const id = cleanId(adapter?.id);
    if (!id || typeof adapter?.runTurn !== "function") continue;
    adapterById.set(id, adapter);
  }

  const fallbackId = cleanId(defaultAdapterId) || adapterById.keys().next().value || "";

  async function runTurn({ adapterId = fallbackId, ...input } = {}) {
    const id = cleanId(adapterId) || fallbackId;
    const adapter = adapterById.get(id);
    if (!adapter) {
      const error = new Error("runtime_adapter_not_registered");
      error.code = "runtime_adapter_not_registered";
      error.adapterId = id;
      throw error;
    }
    return adapter.runTurn(input);
  }

  function describe() {
    return [...adapterById.values()].map((adapter) => ({
      id: cleanId(adapter.id),
      kind: cleanId(adapter.kind || "agent_runtime"),
      status: cleanId(adapter.status || "registered"),
    }));
  }

  return {
    defaultAdapterId: fallbackId,
    describe,
    has: (adapterId = "") => adapterById.has(cleanId(adapterId)),
    runTurn,
  };
}

function cleanId(value = "") {
  return String(value || "").trim().slice(0, 120);
}

export { createRuntimeAdapterRegistry };
