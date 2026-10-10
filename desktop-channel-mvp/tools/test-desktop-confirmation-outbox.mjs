import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createDesktopConfirmationOutbox} from "../electron/desktop-confirmation-outbox.mjs";
import {deliverToolConfirmation} from "../electron/desktop-confirmation-delivery.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(),"desktop-confirmation-outbox-"));
const filePath = path.join(directory,"intent.enc.json");
const key = crypto.randomBytes(32);
const encryption = {isAvailable:() => true,encrypt:value => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm",key,iv);
  return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString("base64");
},decrypt:value => {
  const buffer = Buffer.from(value,"base64"), decipher = crypto.createDecipheriv("aes-256-gcm",key,buffer.subarray(0,12));
  decipher.setAuthTag(buffer.subarray(-16));return Buffer.concat([decipher.update(buffer.subarray(12,-16)),decipher.final()]).toString();
}};
let clock = Date.now();
const create = extra => createDesktopConfirmationOutbox({filePath,encryption,now:() => clock,...extra});
const identity = {actorKey:"fixture-actor",centerOrigin:"https://fixture.invalid",employeeId:"fixture-employee",sessionId:"fixture-session",confirmationId:"fixture-confirmation"};
const scope = {actorKey:identity.actorKey,centerOrigin:identity.centerOrigin};
try {
  const unavailable = create({encryption:{isAvailable:()=>assert.fail("missing outbox must not touch OS Keychain")}});
  assert.deepEqual(await unavailable.pending(scope),[]);
  await unavailable.forget({...scope,confirmationId:identity.confirmationId});
  await unavailable.clearActor(identity.actorKey);
  await assert.rejects(fs.stat(filePath),{code:"ENOENT"},"no-op reads/removals cannot create an empty encrypted file");
  let outbox = create();
  assert.deepEqual(await outbox.pending(scope),[]);
  const saved = await outbox.remember({...identity,arguments:{secret:"must-not-store"},toolCredentials:{token:"must-not-store"},message:"must-not-store"});
  const file = await fs.readFile(filePath,"utf8");
  assert(!file.includes(identity.confirmationId) && !file.includes("must-not-store"));
  assert.equal((await fs.stat(filePath)).mode & 0o077,0);
  outbox = create();
  assert.deepEqual(await outbox.pending(scope),[saved],"a new owner reopens durable clicked intent");
  clock += 6*60_000;
  assert.equal((await outbox.remember(identity)).clickedAt,saved.clickedAt,"retry cannot extend local retention");
  let posts = 0, lookups = 0;
  const state = await deliverToolConfirmation({lookupFirst:true,wait:async () => {},
    lookup:async () => {lookups++;return {status:"accepted"};},
    send:async () => {posts++;return "same-confirmation-delivered";},recovered:async () => assert.fail("accepted is not a task")});
  assert.equal(state,"same-confirmation-delivered");assert.equal(lookups,1);assert.equal(posts,1);
  posts = 0;
  await assert.rejects(deliverToolConfirmation({lookupFirst:true,wait:async () => {},lookup:async () => {throw Error("status unavailable");},
    send:async () => {posts++;},recovered:async () => {}}));
  assert.equal(posts,0,"unknown status after restart must not POST");
  const taskId = `task_${"a".repeat(64)}`;
  assert.equal(await deliverToolConfirmation({lookupFirst:true,lookup:async () => ({status:"submitted",taskId}),
    send:async () => assert.fail("submitted task cannot POST"),recovered:state => state.taskId}),taskId);
  assert.deepEqual(await outbox.pending({actorKey:"another-actor",centerOrigin:identity.centerOrigin}),[]);
  await assert.rejects(outbox.remember({...identity,sessionId:"changed-session"}));
  await outbox.pending({...scope,centerOrigin:"https://changed.invalid"});
  assert.deepEqual(await outbox.pending(scope),[],"changing Center closes old intent");
  await outbox.remember(identity);await outbox.clearActor(identity.actorKey);
  assert.deepEqual(await outbox.pending(scope),[]);
  await outbox.remember(identity);await outbox.forget({...scope,confirmationId:identity.confirmationId});
  assert.deepEqual(await outbox.pending(scope),[]);
  await outbox.remember(identity);clock += 8*86400000;
  assert.deepEqual(await outbox.pending(scope),[],"bounded privacy retention is separate from Center approval expiry");
  await assert.rejects(create({encryption:{...encryption,isAvailable:() => false}}).remember(identity),/outbox_unavailable/);
  const platform = Object.getOwnPropertyDescriptor(process,"platform"), open = fs.open;
  let flushed = 0;
  try {
    Object.defineProperty(process,"platform",{...platform,value:"win32"});
    fs.open = async (target,...options) => {
      assert.notEqual(target,directory,"Windows must not open its parent for directory fsync");
      const handle = await open(target,...options), sync = handle.sync.bind(handle);
      handle.sync = async () => {flushed++;return sync();};return handle;
    };
    await create().remember(identity);
    assert.equal(flushed,1,"Windows path still flushes the file before rename");
    assert.equal((await create().pending(scope)).length,1);
  } finally {Object.defineProperty(process,"platform",platform);fs.open=open;}
  await fs.writeFile(filePath,"corrupt",{mode:0o600});
  await assert.rejects(create().pending(scope),/outbox_unavailable/);
  assert.equal(await fs.readFile(filePath,"utf8"),"corrupt","corruption cannot silently reset pending intent");
  console.log("Desktop confirmation outbox passed: encrypted reopen, strict fields, once-only reference, status-first delivery, unknown zero POST, actor/Center/session isolation and retention.");
} finally {await fs.rm(directory,{recursive:true,force:true});}
