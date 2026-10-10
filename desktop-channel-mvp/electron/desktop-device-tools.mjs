import { createDeviceReadClient } from "./device-read-client.mjs";

// Main owns one current-identity client. No credentials, business queue or IPC.
export function createDesktopDeviceTools({ context, available, createAdapters, request,
  onCompleted, onFailed, onDiagnostic, createClient = createDeviceReadClient } = {}) {
  let active = null, generation = 0, starting = null;
  const same = value => JSON.stringify(value) === JSON.stringify(context());
  async function stop() {
    generation++;
    const previous = active; active = null;
    await previous?.client.stop();
  }
  async function ensure() {
    if (active && same(active.context)) return active.client;
    if (starting) { await starting; return ensure(); }
    starting = (async () => {
      await stop();
      const current = context(), revision = generation;
      if (!current?.actorKey || !await available() || revision !== generation || !same(current)) return null;
      const adapters = createAdapters();
      if (!adapters?.length) return null;
      const client = createClient({ request, adapters,
        actorContext: () => ({ key: current.actorKey, version: current.actorVersion }),
        isExpectedActor: () => revision === generation && same(current),
        onCompleted: value => { if (revision === generation && same(current)) onCompleted?.(current, value); },
        onFailed: claim => { if (revision === generation && same(current)) onFailed?.(current, claim); },
        onDiagnostic,
      });
      active = { context: current, client };
      await client.start();
      return revision === generation && same(current) ? client : null;
    })();
    try { return await starting; } finally { starting = null; }
  }
  return Object.freeze({ ensure, stop, headers: () => active && same(active.context) ? active.client.headers() : {} });
}
