import assert from "node:assert/strict";
import { readAutomationRunHistory } from "../src/lib/automationRunHistory.js";

const rules = Array.from({length:9}, (_,i) => ({automationId:`rule-${i}`,employeeId:"worker"}));
let active = 0, peak = 0;
const calls = [];
const result = await readAutomationRunHistory(rules, {async personalAutomations(request) {
  calls.push(request); peak = Math.max(peak,++active);
  await new Promise(setImmediate); active--;
  const rule = rules.find(rule => rule.automationId === request.automationId);
  if (rule.automationId === "rule-2") throw new Error("private error must not escape");
  return {ok:true,automation:rule,runs:[{taskId:"task",scheduledFor:"2026-10-08T01:00:00Z",status:"completed",privatePayload:"excluded"}]};
}});
assert.equal(peak,4,"read concurrency is bounded");
assert.deepEqual(result.failedIds,["rule-2"]);
assert.equal(Object.keys(result.runs).length,8,"partial failure retains successful histories");
assert.ok(calls.every(request => request.action === "detail" && rules.some(rule => rule.automationId === request.automationId)));
assert.equal(JSON.stringify(result).includes("private"),false);

for (const value of [{ok:false},{ok:true,automation:{...rules[0],employeeId:"other"},runs:[]},{ok:true,automation:{...rules[0],automationId:"other"},runs:[]},{ok:true,automation:rules[0],runs:null}]) {
  const rejected = await readAutomationRunHistory([rules[0]],{personalAutomations:async()=>value});
  assert.deepEqual(rejected,{runs:{},failedIds:["rule-0"]},"wrong scope/malformed history cannot look like an empty success");
}
let current = true, dispatched = 0;
const cancelled = await readAutomationRunHistory(rules,{async personalAutomations(request) {
  dispatched++; current=false;
  return {ok:true,automation:rules.find(rule=>rule.automationId===request.automationId),runs:[]};
}},()=>current);
assert.equal(cancelled,null,"stale response cannot be published after scope change/unmount");
assert.equal(dispatched,4,"cancellation stops subsequent batches");
console.log("Automation history scope, partial failure, bounded reads and cancellation passed");
