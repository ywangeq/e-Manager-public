import assert from "node:assert/strict";
import { createDeviceReadClient } from "../electron/device-read-client.mjs";
import { FEISHU_CALENDAR_READ_DESCRIPTOR as descriptor } from "../shared/feishu-calendar-read-contract.mjs";
import { DEVICE_READ_OPERATION_VERSION, deviceReadAdapterDigest, deviceReadOperationDigest } from "../shared/device-read-operation-v1.mjs";
import { createDeviceReadTransport } from "../../server/agent-runtime/device-read-transport.mjs";
import { createDeviceReadSessionRegistry } from "../../server/agent-runtime/device-read-session-registry.mjs";
const session = { tenantScope: "synthetic-tenant", actorDigest: "a".repeat(64) };
const sessions = createDeviceReadSessionRegistry({ resolveActor: value => value, adapterDigests: [deviceReadAdapterDigest(descriptor)] });
let actor = { key: "synthetic-actor", version: 1 }, claimed = false, completed = 0, reads = 0, validateAllowed = true, networkLoss = false, duringRead = () => {};
let postedResult, projected=0, failures=0;
const attemptId = `device_read_${"b".repeat(64)}`;
const input = { start: "2026-10-09T00:00:00Z", end: "2026-10-10T00:00:00Z" };
const facts = { events: [{ eventRef: "synthetic-event", title: "private_meeting_sentinel", start: input.start, end: input.end }] };
const dispatch = {
  async claimNext(identity) {
    if (claimed) return null;
    claimed = true;
    const body = { contractVersion: DEVICE_READ_OPERATION_VERSION, taskId: "synthetic-task", toolCallId: "synthetic-call",
      toolId: descriptor.toolId, operationId: descriptor.operationId, adapterDigest: deviceReadAdapterDigest(descriptor),
      taskInputDigest: "c".repeat(64), actorDigest: identity.actorDigest, deviceSessionDigest: identity.deviceSessionDigest,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), input };
    return { attemptId, claim: { ...body, operationDigest: deviceReadOperationDigest(body) } };
  },
  async validateClaim() { return validateAllowed; },
  async complete(identity, body) { completed++; postedResult = body; return { ok: true, status: body.status }; },
};
const transport = createDeviceReadTransport({ sessions, dispatch, isManagedHttpsRequest: ({ requestContext }) => requestContext.https === true });
const calls = [];
const request = async (url, options) => {
  calls.push({ url, method: options.method });
  const requestContext = { session, https: true, req: { headers: options.headers } };
  const body = options.body === undefined ? undefined : JSON.parse(options.body);
  let response;
  if (url.endsWith("/session")) response = options.method === "DELETE" ? transport.revoke({ requestContext }) : transport.register({ body, requestContext });
  else if (url.endsWith("/claim")) response = await transport.claim({ requestContext });
  else if (url.endsWith("/validate")) response = await transport.validate({ attemptId, body, requestContext });
  else if (url.endsWith("/result")) {
    if (networkLoss) throw Error("private_transport_failure");
    response = await transport.complete({ attemptId, body, requestContext });
  } else throw Error("unexpected endpoint");
  return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
};
let scheduled;
const makeClient = () => createDeviceReadClient({ request, adapters: [{ ...descriptor, async execute() { reads++; duringRead(); return structuredClone(facts); } }],
  onCompleted: value => {projected++;assert.deepEqual(value.result,facts);value.result.events[0].title="changed observer copy";}, onFailed:()=>{failures++;},
  actorContext: () => actor, isExpectedActor: (key, version) => key === actor.key && version === actor.version,
  setTimeoutFn: callback => { scheduled = callback; return {}; }, clearTimeoutFn: () => { scheduled = null; } });
let client = makeClient();
await client.start();
assert.equal(projected,1);assert.equal(reads, 1); assert.equal(completed, 1); assert.deepEqual(postedResult.result, facts);
assert.ok(calls.every(call => !call.url.includes("private_meeting_sentinel")));
assert.ok(calls.filter(call => call.url.endsWith("/validate")).length === 2);
await scheduled(); assert.equal(reads, 1, "polling does not replay a consumed claim"); await client.stop();
assert.equal(calls.at(-1).method, "DELETE");
claimed = false; validateAllowed = false; client = makeClient(); await client.start();
assert.equal(reads, 1, "revoked live claim never starts local read"); assert.equal(postedResult.status, "failed"); await client.stop();
claimed = false; validateAllowed = true; networkLoss = true; client = makeClient(); await client.start();
assert.ok(failures >= 2);assert.equal(projected,1,"failed/unknown delivery cannot publish meetings");
const afterLoss = reads; await scheduled(); assert.equal(reads, afterLoss, "failed result transport never queues/replays the read"); await client.stop(); networkLoss = false;
claimed = false; duringRead = () => { actor = { key: "synthetic-other", version: 2 }; };
client = makeClient(); const beforeSwap = completed; await client.start();
assert.equal(completed, beforeSwap, "actor switch drops old body before result transport"); await client.stop();
const badContext = { session, https: false, req: { headers: client.headers() } };
assert.equal(transport.register({ body: { capabilities: [deviceReadAdapterDigest(descriptor)] }, requestContext: badContext }).ok, false);
assert.equal(transport.register({ body: { capabilities: [deviceReadAdapterDigest(descriptor)], actorDigest: session.actorDigest }, requestContext: { ...badContext, https: true } }).ok, false);
assert.equal((await transport.complete({ attemptId, body: { status: "failed", operationDigest: "c".repeat(64), result: facts }, requestContext: { ...badContext, https: true } })).ok, false);
console.log("Main Device client fixed transport, live checks, private delivery, actor change and no replay checks passed");
