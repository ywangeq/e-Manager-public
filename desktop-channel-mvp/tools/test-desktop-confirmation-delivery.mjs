import assert from "node:assert/strict";
import { deliverToolConfirmation, readConfirmationDeliveryResponse } from "../electron/desktop-confirmation-delivery.mjs";
const taskId = `task_${"a".repeat(64)}`;
let sends = 0, reads = 0;
const options = { wait: async () => {}, recovered: state => state.taskId };
const sent = await deliverToolConfirmation({ ...options, send: async () => { sends++; if (sends === 1) throw Error("network_lost"); return "delivered"; },
  lookup: async () => { reads++; return { status: "pending" }; } });
assert.equal(sent, "delivered"); assert.equal(sends, 2); assert.equal(reads, 1);
sends = 0;
const found = await deliverToolConfirmation({ ...options, send: async () => { sends++; throw Error("response_lost"); },
  lookup: async () => ({ status: "submitted", taskId, taskStatus: "completed" }) });
assert.equal(found, taskId); assert.equal(sends, 1, "completed task is followed, never resubmitted");
sends = 0; reads = 0;
await assert.rejects(deliverToolConfirmation({ ...options, send: async () => { sends++; throw Error("network_lost"); },
  lookup: async () => { reads++; throw Error("status_network_lost"); } }));
assert.equal(sends, 1, "unknown receipt only retries lookup"); assert.equal(reads, 4);
sends = 0;
await assert.rejects(deliverToolConfirmation({ ...options, send: async () => { sends++; throw Error("network_lost"); },
  lookup: async () => ({ status: "unavailable" }) }), /tool_confirmation_unavailable/);
assert.equal(sends, 1);
sends = 0;
const controller = new AbortController();
await assert.rejects(deliverToolConfirmation({ ...options, signal: controller.signal,
  send: async () => { sends++; controller.abort(Error("user_canceled")); throw Error("network_lost"); }, lookup: async () => assert.fail("canceled request must not query") }), /user_canceled/);
assert.equal(sends, 1);
let current = true;
await assert.rejects(deliverToolConfirmation({ ...options, canContinue: () => current,
  send: async () => { current = false; throw Error("network_lost"); }, lookup: async () => assert.fail("changed actor must not query") }), /actor_changed/);
console.log("Desktop confirmation delivery: safe resend, submitted-task follow, unknown lookup, expiry, cancellation and actor fences passed");

for (const body of ["", 'event: step\ndata: {"status":"running"}\n\n']) {
  await assert.rejects(readConfirmationDeliveryResponse({ response: { ok: true, status: 200 }, read: async () => body, hasTask: () => false }), /delivery_unresolved/);
}
assert.equal(await readConfirmationDeliveryResponse({ response: { ok: true, status: 200 }, read: async () => "task stream", hasTask: () => true }), "task stream");

for (const status of [429, 500, 502, 503, 504]) {
  await assert.rejects(readConfirmationDeliveryResponse({ response: { ok: false, status }, read: async () => "upstream failure", hasTask: () => false }), /tool_confirmation/);
}
assert.equal(await readConfirmationDeliveryResponse({ response: { ok: false, status: 410 }, read: async () => "expired", hasTask: () => false }), "expired");
