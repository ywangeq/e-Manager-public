import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";
import { FEISHU_READ_PERMISSIONS } from "../shared/feishu-authorization-scopes.mjs";
const source = await fs.readFile(new URL("../src/components/FeishuAuthorization.jsx", import.meta.url),"utf8");
const {code} = await transformWithEsbuild(source,"FeishuAuthorization.jsx",{loader:"jsx",format:"cjs",jsx:"automatic"});
function render(setup) {
 let index=0;
 const module={exports:{}};
 const react={useEffect:()=>{},useRef:value=>({current:value}),useState:value=>[index++===0?{phase:"idle",setup,permissions:{items:[]}}:value,()=>{}]};
 vm.runInNewContext(code,{module,require:name=>name==="react"?react:name==="react/jsx-runtime"?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:"fragment"}:{FEISHU_READ_PERMISSIONS},Date});
 return module.exports.FeishuAuthorization({desktopApi:{feishuAuthorization:()=>{}},onAssociate:()=>{}});
}
function nodes(node,out=[]) {if(!node||typeof node!=="object")return out;if(Array.isArray(node)){node.forEach(n=>nodes(n,out));return out;}out.push(node);nodes(node.props?.children,out);return out;}
for(const [setup,expected,forbidden] of [
 [{cli:"missing",app:"unknown"},"开始配置 · 安装 CLI","浏览器创建并配置应用"],
 [{cli:"installed",app:"missing"},"浏览器创建并配置应用","生成二维码 / 授权四项权限"],
 [{cli:"installed",app:"unknown"},"重新检测配置","生成二维码 / 授权四项权限"],
 [{cli:"installed",app:"configured"},"生成二维码 / 授权四项权限","浏览器创建并配置应用"],
]) {
 const all=nodes(render(setup));const buttons=all.filter(n=>n.type==="button").map(n=>n.props.children);
 assert.ok(buttons.includes(expected));assert.ok(!buttons.includes(forbidden));
 assert.equal(all.filter(n=>n.type==="ol").length,1);
 assert.equal(all.filter(n=>n.type==="i"&&n.props.title).length,setup.app==="configured"?7:3);
 const permissionInputs=all.filter(n=>n.type==="input"&&n.props.type==="checkbox");assert.ok(permissionInputs.length<=1,"only QR refresh checkbox; no permission selection");
}
console.log("Feishu step UI: one current step, unknown stays blocked, status lamps accessible, four fixed grants passed");
