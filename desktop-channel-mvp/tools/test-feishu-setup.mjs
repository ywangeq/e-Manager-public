import assert from "node:assert/strict";
import { inspectFeishuSetup } from "../electron/desktop-feishu-setup.mjs";
import { createDesktopFeishuAuthorization, validFeishuSetupUrl } from "../electron/desktop-feishu-authorization.mjs";
import products from "../shared/desktop-product.cjs";
assert.equal(products.displayVersion(products.GROUP_STUDIO_PRODUCT, "3.0.0-beta.46"), "beta.1.46");
assert.equal(products.displayVersion(products.DESKTOP_PRODUCT, "2.1.0-beta.18"), "2.1.0-beta.18");
assert.deepEqual(await inspectFeishuSetup(async () => ({value:[],failed:false})), {cli:"installed",app:"missing"});
assert.equal((await inspectFeishuSetup(async () => ({value:[],failed:true}))).app,"unknown");
assert.equal((await inspectFeishuSetup(async () => ({value:{},failed:false}))).app,"unknown");
assert.equal((await inspectFeishuSetup(async () => {throw Object.assign(new Error(),{code:"feishu_cli_missing"});})).cli,"missing");
assert.equal(validFeishuSetupUrl("https://open.feishu.cn/page/cli?user_code=synthetic"),true);
assert.equal(validFeishuSetupUrl("https://open.feishu.cn/app?user_code=synthetic"),false);
assert.equal(validFeishuSetupUrl("https://open.feishu.cn.evil.test/page/cli"),false);
let actor = { key:"synthetic", version:1 }, installed = false, profiles = [], configureCount = 0;
let finishConfig;
let installCount = 0;
const service = createDesktopFeishuAuthorization({actorContext:()=>({...actor}),isExpectedActor:(key,version)=>key===actor.key&&version===actor.version,
 connection:{check:async()=>{},status:async()=>({state:"disconnected"})},
 run:async(args)=>{
  if(!installed) throw Object.assign(new Error(),{code:"feishu_cli_missing"});
  if(args[0]==="profile") return {value:profiles};
  if(args[1]==="status") return {value:{identities:{}}};
  if(args[1]==="scopes") return {value:{userScopes:[]}};
 },
 install:async()=>{installCount++;installed=true;},
 configure:async({onUrl,signal})=>{configureCount++;onUrl("https://open.feishu.cn/page/cli?user_code=synthetic-private");await new Promise(resolve=>{finishConfig=()=>{profiles=[{}];resolve();};signal.addEventListener("abort",resolve,{once:true});});},
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let state=await service.request({action:"inspect"});
assert.equal(state.setup.cli,"missing");
await service.request({action:"install"});await tick();
state=await service.request({action:"status"});assert.equal(installCount,1);assert.equal(state.setup.cli,"installed");assert.equal(state.setup.app,"missing");
await service.request({action:"configure"});await tick();
state=await service.request({action:"status"});assert.equal(state.phase,"configuring_browser");assert.equal(configureCount,1);
finishConfig();await tick();assert.equal((await service.request({action:"status"})).setup.app,"configured");
await service.request({action:"configure"});await tick();assert.equal(configureCount,1,"never replace existing profiles");
assert.equal((await service.request({action:"status"})).phase,"configuration_blocked");
profiles=[];await service.request({action:"configure"});await tick();
actor={key:"other",version:2};service.clear();finishConfig();await tick();
state=await service.request({action:"status"});assert.equal(state.phase,"idle");assert.equal(state.verificationUrl,"");assert.equal(state.setup.app,"unknown");
console.log("Feishu setup: absence, install, browser creation, overwrite guard, actor fence and version display passed");
