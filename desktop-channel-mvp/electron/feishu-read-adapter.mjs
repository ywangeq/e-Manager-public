// Shared vendor boundary for declared read operations. Identity is owned by the connection.
export function createFeishuReadAdapter({ connection, read, descriptor } = {}) {
  if (typeof connection?.executeAssociatedRead !== "function" || typeof read !== "function")
    throw new TypeError("feishu_read_private_helper_required");
  return Object.freeze({ ...descriptor,
    async execute(input, { signal, onDiagnostic } = {}) {
      const normalized = descriptor.normalizeInput(input);
      return connection.executeAssociatedRead(async ({ account }) =>
        descriptor.normalizeResult(await read({ ...normalized, account }, { signal })), { signal, onDiagnostic });
    },
  });
}
