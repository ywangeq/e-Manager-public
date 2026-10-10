import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";
import { activityStates, cockpitSentinelActivity, completionSnapshot, hasNewCompletion, sentinelVisualState, sentinelOrbitalColor, sentinelOrbitalTreatment } from "../src/lib/cockpitSentinelState.js";
import { createOrbitExpansion } from "../src/lib/cockpitOrbitExpansion.js";

const ready = { authenticated: true, taskPhase: "ready", goalPhase: "ready", automationPhase: "ready" };
assert.equal(sentinelVisualState('unknown','listening').voice,'off');
for(const status of ['waiting','pending_file_intake','pending_remote_resource','pending_invocation_check'])assert.equal(cockpitSentinelActivity({...ready,tasks:[{status}]}),'working');
assert.deepEqual(sentinelOrbitalColor('idle'),[37,173,241]);
assert.deepEqual(sentinelOrbitalColor('success'),activityStates.success.particleColor);
assert.deepEqual(sentinelOrbitalColor('unknown'),activityStates.unavailable.color);
assert.deepEqual(sentinelOrbitalTreatment('blocked'),{coverage:.16,energy:.55});
for(const activity of Object.keys(activityStates).filter(key=>key!=='blocked'))assert.deepEqual(sentinelOrbitalTreatment(activity),{coverage:1,energy:1});
assert.equal(cockpitSentinelActivity(ready), "idle");
assert.equal(cockpitSentinelActivity({ ...ready, authenticated: false }), "waiting");
for (const field of ["taskPhase", "goalPhase", "automationPhase"]) {
  assert.equal(cockpitSentinelActivity({ ...ready, [field]: "error", tasks: [{status:"running"}] }), "unavailable");
  assert.equal(cockpitSentinelActivity({ ...ready, [field]: "loading" }), "loading");
}
for (const [status, expected] of Object.entries({ running:"working", planning:"working", starting:"working", queued:"queued", pending:"queued", failed:"idle", timed_out:"idle", awaiting_review:"idle", awaiting_acceptance:"attention", execution_completed:"idle", accepted:"idle", rejected:"idle", draft:"attention", reconcile_required:"idle", resume_required:"idle", completed:"idle", canceled:"idle", unknown:"unavailable" })) {
  assert.equal(cockpitSentinelActivity({ ...ready, goals: [{ projection: {status} }] }), expected, status);
}
assert.equal(cockpitSentinelActivity({...ready, tasks:[{status:"running"}, {status:"queued"}]}), "working");
for(const historical of ['failed','timeout','timed_out','lost','rejected']) {
  assert.equal(cockpitSentinelActivity({...ready,tasks:[{status:historical},{status:'running'}]}),'working');
  assert.equal(cockpitSentinelActivity({...ready,tasks:[{status:historical},{status:'queued'}]}),'queued');
  assert.equal(cockpitSentinelActivity({...ready,goals:[{status:historical}],tasks:[{status:'running'}]}),'working');
}
assert.equal(cockpitSentinelActivity({...ready,tasks:[{status:'blocked'},{status:'running'}]}),'blocked','live blocked work must remain urgent');
assert.equal(cockpitSentinelActivity({...ready, automations:[{state:"active"}]}), "idle", "scheduled automation is not a running task");
assert.equal(cockpitSentinelActivity({...ready, automations:[{state:"attention_required"}]}), "idle");
assert.equal(cockpitSentinelActivity({...ready, goals:[{projection:{status:"completed",steps:[{status:"failed"}]}}]}), "idle", "terminal parent projection owns completion");
assert.equal(cockpitSentinelActivity({...ready, goals:[{projection:{status:"running",steps:[{status:"blocked"}]}}]}), "blocked");
assert.equal(hasNewCompletion(completionSnapshot([], [{goalId:"delivery",status:"awaiting_acceptance"}]), completionSnapshot([], [{goalId:"delivery",status:"accepted"}])), true);
assert.equal(hasNewCompletion(completionSnapshot([], [{goalId:"delivery",status:"running"}]), completionSnapshot([], [{goalId:"delivery",status:"completed"}])), false, "execution completion is not acceptance");
const done = completionSnapshot([{id:"one",status:"completed"}], []);
assert.equal(hasNewCompletion(new Map(), done), false, "historic completed list never celebrates");
assert.equal(hasNewCompletion(done, done), false);
assert.equal(hasNewCompletion(completionSnapshot([{id:"one",status:"running"}], []), done), true);
assert.equal(hasNewCompletion(completionSnapshot([], [{goalId:"one",status:"running"}]), done), false, "identities are namespaced");
for (const activity of ["idle", "working", "blocked", "success"]) assert.equal(sentinelVisualState(activity).audioVisible, false);
assert.equal(sentinelVisualState("working", "listening").audioVisible, true);
assert.equal(sentinelVisualState("unavailable", "speaking").audioVisible, false);

// Exercise the real scheduler without a browser: offscreen/hidden/unmount leave no work queued.
let nextId = 0, now = 100;
const pending = new Map(), listeners = new Map(), canvasListeners = new Map();
const observers = [];
const context = new Proxy({createRadialGradient:()=>({addColorStop(){}})}, {get:(obj,key)=>obj[key] || (()=>{})});
const canvas = {getContext:()=>context, getBoundingClientRect:()=>({width:300,height:290}), addEventListener:(key,value)=>canvasListeners.set(key,value), removeEventListener:(key)=>canvasListeners.delete(key)};
let canvasAllocations = 0, spriteDraws = 0, pigmentArcs = 0;
context.arc = () => { pigmentArcs++; };
context.drawImage = (image, x, y, width) => {if (image.width === 48) {spriteDraws++;assert(width > 0 && width <= 12,"light sprites are bounded, not full-canvas bloom");}};
const document = {hidden:false, createElement:()=>{canvasAllocations++;return {...canvas};}, addEventListener:(key,value)=>listeners.set(key,value), removeEventListener:(key)=>listeners.delete(key)};
const reducedListeners = new Map();
const mediaQuery = {matches:false,addEventListener:(key,cb)=>reducedListeners.set(key,cb),removeEventListener:(key)=>reducedListeners.delete(key)};
class Observer { constructor(callback) {this.callback=callback;this.disconnected=false;observers.push(this);} observe(){} disconnect(){this.disconnected=true;} }
const schedule = (callback) => {pending.set(++nextId,callback);return nextId;};
const module = {exports:{}};
const source = await readFile(new URL("../src/lib/cockpitCore.js", import.meta.url), "utf8");
const transformed = await transformWithEsbuild(source, "cockpitCore.js", {format:"cjs",loader:"js"});
let gpuAvailable = false, gpuLost = false, gpuCreations = 0, gpuDestroyed = 0, gpuFrame;
let gpuContextChange;
const rendererFactory = (count, coreCount, onContextChange) => {
  if (!gpuAvailable) return null;
  assert.equal(count,5000); assert.equal(coreCount,1200);
  gpuCreations++; gpuContextChange = onContextChange;
  return {resize:(width,height,dpr)=>assert.equal(dpr,1.35),render:(x,y,depth,time,opacity,radius,supplement,color,treatment)=>{
    gpuFrame={x:[...x],y:[...y],depth:[...depth],time,opacity:[...opacity],radius,color:color?[...color]:null,extraCount:supplement?.count??0,extraVisible:supplement?[...supplement.opacity.subarray(0,supplement.count)].filter(alpha=>alpha>.015).length:0};
    gpuFrame.treatment=treatment;
    return gpuLost?null:{width:405};
  },destroy:()=>gpuDestroyed++};
};
vm.runInNewContext(transformed.code, {module,exports:module.exports,require:id=>id.endsWith("cockpitOrbitExpansion.js")?{createOrbitExpansion}:id.endsWith("cockpitParticleRenderer.js")?{createCockpitParticleRenderer:rendererFactory}:{sentinelVisualState,sentinelOrbitalColor,sentinelOrbitalTreatment},document,devicePixelRatio:2,performance:{now:()=>now},matchMedia:()=>mediaQuery,ResizeObserver:Observer,IntersectionObserver:Observer,setTimeout:schedule,clearTimeout:(id)=>pending.delete(id),requestAnimationFrame:schedule,cancelAnimationFrame:(id)=>pending.delete(id)});
const core = module.exports.createCockpitCore(canvas);
assert.equal(canvas.width, 405, "DPR is bounded");
assert.equal(pending.size, 1);
assert.equal(canvasAllocations,6,"trail, core light and four cached sprites allocate once");
assert.equal(spriteDraws,0,"default activity renderer is unchanged");
core.configure({palette:"blue"});assert.equal(spriteDraws,5000,"every original cockpit point receives one light sprite");
assert.equal(context.globalAlpha,1,"sprite alpha must not leak into later layers");
core.configure({palette:"activity"});
core.configure({paused:true}); assert.equal(pending.size, 0);
core.configure({paused:false}); assert.equal(pending.size, 1);
document.hidden=true; listeners.get("visibilitychange")(); assert.equal(pending.size, 0);
document.hidden=false; listeners.get("visibilitychange")(); assert.equal(pending.size, 1);
observers[1].callback([{isIntersecting:false}]); assert.equal(pending.size, 0);
observers[1].callback([{isIntersecting:true}]); assert.equal(pending.size, 1);
core.pulse();
for(let n=0;n<4;n++){const [id,callback]=pending.entries().next().value;pending.delete(id);now+=34;callback(now);}
assert.equal(canvasAllocations,6,"no per-frame sprite allocation");
core.destroy(); assert.equal(pending.size, 0); assert.equal(listeners.size,0); assert.equal(canvasListeners.size,0); assert.equal(reducedListeners.size,0); assert.ok(observers.every(item=>item.disconnected));
gpuAvailable = true;
const backendReports = [];
const enhanced = module.exports.createCockpitCore(canvas,report=>{if(report.renderer)backendReports.push(report.renderer);},rendererFactory);
const oldSpriteDraws = spriteDraws;
const oldPigmentArcs = pigmentArcs;
enhanced.configure({palette:"blue",material:"gpu",paused:true});
assert.equal(gpuCreations,1);assert.equal(gpuFrame.x.length,5000);
assert.equal(spriteDraws,oldSpriteDraws,"GPU success must not also draw compatibility points");
assert.equal(pigmentArcs,oldPigmentArcs,"GPU path must skip unused pigment rasterization");
assert(backendReports.includes("webgl"));
const thinFrame = gpuFrame;
enhanced.configure({orbitThickness:.1});gpuContextChange();
assert.deepEqual(gpuFrame.x.slice(0,1200),thinFrame.x.slice(0,1200),"thickness must not move the core");
assert.deepEqual(gpuFrame.y.slice(0,1200),thinFrame.y.slice(0,1200));
assert.deepEqual(gpuFrame.depth.slice(0,1200),thinFrame.depth.slice(0,1200));
let moved = 0;
for (let i=1200;i<5000;i++) {
  const displacement=Math.hypot(gpuFrame.x[i]-thinFrame.x[i],gpuFrame.y[i]-thinFrame.y[i]);
  if(displacement>.01)moved++;
  assert(displacement<12,"normal offsets must remain bounded after projection");
  assert(Math.abs(gpuFrame.depth[i]-thinFrame.depth[i])<.06);
}
assert(moved>3500,"thickness must spread actual orbital positions, not sprite sizes");
enhanced.configure({orbitThickness:0});gpuContextChange();
assert.equal(JSON.stringify(gpuFrame),JSON.stringify(thinFrame),"removing thickness restores original geometry without phase drift");
enhanced.configure({orbitThickness:.1});gpuContextChange();
const frozen = JSON.stringify(gpuFrame);
enhanced.configure({radiusLimit:50});gpuContextChange();assert.equal(gpuFrame.radius,50,"GPU core must receive the same capped radius as orbital projection");
enhanced.configure({radiusLimit:undefined});gpuContextChange();assert.equal(JSON.stringify(gpuFrame),frozen);
observers.at(-2).callback();assert.equal(JSON.stringify(gpuFrame),frozen,"resize must preserve paused orbital phase");
gpuLost = true;gpuContextChange();assert.equal(pending.size,0);assert.equal(backendReports.at(-1),"fallback");
gpuLost = false;gpuContextChange();assert.equal(pending.size,0);assert.equal(backendReports.at(-1),"webgl");
assert.equal(JSON.stringify(gpuFrame),frozen,"context restoration must not advance paused motion");
for (const activity of ["waiting","loading","unavailable","queued","attention","working","success","blocked","idle"]) enhanced.configure({activity});
assert.equal(gpuCreations,1,"state changes must not create new renderers");
enhanced.configure({orbitExpansion:true,paused:false});
for(let n=0;n<900;n++) {
  const [id,callback]=pending.entries().next().value;pending.delete(id);now+=34;callback(now);
  assert(gpuFrame.opacity.every(alpha=>alpha===1),'idle must not automatically expand');
  assert.equal(gpuFrame.extraCount,0);
}
assert.equal(enhanced.expand(),true);
assert.equal(enhanced.expand(),false,'repeated actions must not queue more waves');
let observedExpansion=false, supplementalFallback=false;
for(let n=0;n<340;n++) {
  const [id,callback]=pending.entries().next().value;pending.delete(id);now+=34;callback(now);
  if(gpuFrame.opacity.some(alpha=>alpha<.99))observedExpansion=true;
  if(gpuFrame.extraVisible>10&&!supplementalFallback) {
    gpuLost=true;const before=spriteDraws;gpuContextChange();
    assert(spriteDraws-before>5000,"Canvas fallback must draw visible supplementary peel particles");
    gpuLost=false;gpuContextChange();supplementalFallback=true;
  }
  assert(gpuFrame.opacity.slice(0,1200).every(alpha=>alpha===1));
}
assert(observedExpansion,"engine must pass expansion opacity to the GPU adapter");
assert(supplementalFallback,"transient density must reach both render paths");
mediaQuery.matches=true;reducedListeners.get("change")();
for(let n=0;n<4;n++){const [id,callback]=pending.entries().next().value;pending.delete(id);now+=55;callback(now);}
assert(gpuFrame.opacity.every(alpha=>alpha===1),"reduced motion disables expansion and clears its fade");
assert.equal(gpuFrame.extraCount,0,"reduced motion must clear transient particles");
mediaQuery.matches=false;enhanced.configure({paused:true});
const beforeWake=gpuFrame;
enhanced.wake();assert(gpuFrame.opacity.slice(1200).every(alpha=>alpha===0));
assert.deepEqual(gpuFrame.x.slice(0,1200),beforeWake.x.slice(0,1200));
assert.equal(pending.size,0,'paused wake must not start a timer');
gpuLost=true;gpuContextChange();gpuLost=false;gpuContextChange();
assert(gpuFrame.opacity.slice(1200).every(alpha=>alpha===0),'backend switch must preserve wake');
enhanced.configure({orbitExpansion:false});
assert(gpuFrame.opacity.every(alpha=>alpha===1),'paused disable must restore rings immediately');
enhanced.configure({orbitExpansion:true});enhanced.wake();
mediaQuery.matches=true;reducedListeners.get('change')();
assert(gpuFrame.opacity.every(alpha=>alpha===1),'paused reduced-motion must clear wake immediately');
assert.equal(pending.size,0);
mediaQuery.matches=false;
enhanced.configure({stateColors:true});
const colorFrame=gpuFrame;
for(const activity of Object.keys(activityStates)) {
  enhanced.configure({activity});
  assert.deepEqual(gpuFrame.color,sentinelOrbitalColor(activity));
  assert.deepEqual(gpuFrame.treatment,sentinelOrbitalTreatment(activity));
  assert.deepEqual(gpuFrame.x.slice(0,1200),colorFrame.x.slice(0,1200),'paused state recolor must not move core');
  assert.equal(gpuFrame.time,colorFrame.time);
}
enhanced.configure({palette:"activity"});assert.equal(backendReports.at(-1),"canvas");
assert(pigmentArcs>oldPigmentArcs,"normal Canvas pigment drawing must resume");
enhanced.destroy();assert.equal(gpuDestroyed,1);assert.equal(pending.size,0);
console.log("cockpit sentinel state, completion identity, voice gate and animation lifecycle checks passed");

// Peeling preserves the captured shape under uniform scaling and fades only at viewport edges.
const expansion = createOrbitExpansion(192,2,.42);
const opacity = new Float32Array(192).fill(1);
const frame = (time,enabled=true,width=600,height=520,limit=Infinity) => {
  const scale=Math.min(Math.min(width,height)*.39,limit);
  const x=Float32Array.from({length:192},(_,i)=>width/2+Math.cos(i)*scale*(.4+(i%7)*.05));
  const y=Float32Array.from({length:192},(_,i)=>height*.47+Math.sin(i)*scale*(.4+(i%7)*.05));
  x[5]=width/2+scale*.05;y[5]=height*.47;
  expansion.update(time,enabled,x,y,opacity,width,height,scale);
  return {x:[...x],y:[...y],opacity:[...opacity]};
};
const initial=frame(0);
assert.deepEqual(frame(120),initial,'elapsed idle time must not launch a wave');
assert.equal(expansion.expand(),true);
assert.equal(expansion.expand(),false,'pending action must coalesce');
const launched=frame(121), moving=frame(122);
assert.equal(expansion.expand(),false,'busy action must not queue a later wave');
const selected=moving.x.map((value,i)=>Math.abs(value-initial.x[i])>.001?i:-1).filter(i=>i>=0);
assert(selected.length>0&&selected.length<192-2,"a wave must leave some of the ring in place");
assert.equal(new Set(selected.map(i=>(i-2)%19)).size,19,"peeled layer samples the whole orbital shape");
assert.equal(moving.x[5],initial.x[5],"core-covered projections must not linger in a peel");
assert.deepEqual(moving.x.slice(0,2),initial.x.slice(0,2));
assert.deepEqual(moving.opacity.slice(0,2),[1,1]);
for(const i of selected) {
  const ratio=Math.hypot(moving.x[i]-300,moving.y[i]-244.4)/Math.hypot(launched.x[i]-300,launched.y[i]-244.4);
  assert(Math.abs(ratio-Math.exp(.65))<.00001,"different starting radii must receive exactly the same scale");
  const edgeDistance=Math.min(moving.x[i],600-moving.x[i],moving.y[i],520-moving.y[i]);
  if(edgeDistance>32)assert.equal(moving.opacity[i],1,"interior particles must not fade on a timer");
}
const [a,b]=selected;
const pairRatio=Math.hypot(moving.x[a]-moving.x[b],moving.y[a]-moving.y[b])/Math.hypot(launched.x[a]-launched.x[b],launched.y[a]-launched.y[b]);
assert(Math.abs(pairRatio-Math.exp(.65))<.00001,"relative layer shape must be preserved");
assert.deepEqual(frame(122),moving,"unchanged clock must freeze expansion");
const wide=frame(122,true,1518,800,202.8);
for(const i of selected)assert(Math.abs((wide.x[i]-759)-(moving.x[i]-300))<.001,"wider viewport must not enlarge a radius-capped orbital layer");
const smaller=frame(122,true,300,260);
for(const i of selected)assert(Math.abs(smaller.x[i]*2-moving.x[i])<.001,"resize keeps normalized captured positions");
let exited=false, reentered=false, restored=false;
for(let time=122.1;time<127;time+=.1) {
  const next=frame(time);
  if(selected.every(i=>next.opacity[i]===0)) {
    exited=true;
    for(const i of selected)assert(Math.min(next.x[i],600-next.x[i],next.y[i],520-next.y[i])<=0,"peel reaches the viewport border before disappearing");
  }
  if(exited&&selected.every(i=>next.opacity[i]>0&&next.opacity[i]<1)) {
    reentered=true;for(const i of selected)assert.equal(next.x[i],initial.x[i]);
  }
  if(reentered&&next.opacity.every(alpha=>alpha===1)){restored=true;break;}
}
assert(exited&&reentered&&restored,"peel must leave the viewport before fading back into the normal orbit");
assert.deepEqual(frame(240),initial,'completed action must not restart');
assert.deepEqual(frame(600),initial,'no periodic expansion after recovery');
assert.equal(expansion.expand(),true,'new explicit action can replay');
assert.deepEqual(frame(601,false),initial,"disabling motion restores positions and opacity without a backlog");
assert.deepEqual(frame(900),initial,'reenabling must not replay cancelled requests');
console.log("orbital expansion snapshot, pause, resize, boundary fade, reentry and disable checks passed");

const densePeel=createOrbitExpansion(5000,1200,.42), denseOpacity=new Float32Array(5000).fill(1);
const denseFrame=(time,enabled=true)=>{
  const x=new Float32Array(5000),y=new Float32Array(5000),z=new Float32Array(5000);
  for(let i=1200;i<5000;i++) {
    const band=(i-1200)%19,angle=Math.floor((i-1200)/19)*Math.PI*2/200,radius=(.5+(band%7)*.06)*202.8;
    x[i]=300+Math.cos(angle)*radius;y[i]=244.4+Math.sin(angle)*radius;
  }
  densePeel.update(time,enabled,x,y,denseOpacity,600,520,202.8,z);
  const extra=densePeel.supplement;
  return {count:extra.count,x:[...extra.x.subarray(0,extra.count)],y:[...extra.y.subarray(0,extra.count)],opacity:[...extra.opacity.subarray(0,extra.count)]};
};
assert.equal(denseFrame(0).count,0);
assert.equal(densePeel.expand(),true);
const born=denseFrame(3);assert(born.count>2000&&born.count<=2850);assert(born.opacity.every(alpha=>alpha===0));
const grown=denseFrame(3.6);assert(grown.opacity.some(alpha=>alpha>.5));
for(let i=0;i<grown.count;i++) {
  const ratio=Math.hypot(grown.x[i]-300,grown.y[i]-244.4)/Math.hypot(born.x[i]-300,born.y[i]-244.4);
  assert(Math.abs(ratio-Math.exp(.6*.65))<.00001,"supplement must share the captured layer's uniform scale");
}
assert.deepEqual(denseFrame(3.6),grown,"supplement must freeze on the same clock");
denseFrame(8);assert.equal(denseFrame(8.1).count,0,"all offscreen companions must clear during recovery");
assert.equal(denseFrame(8.1,false).count,0);
console.log("bounded transient density, smooth birth, shared scale, pause, recovery and fallback checks passed");

const awakening=createOrbitExpansion(6,2,.42);
const wakeFrame=(time,enabled=true,width=600,height=520)=>{
  const x=Float32Array.from([width/2,width/2+2,width/2+90,width/2-130,width/2+50,width/2-15]);
  const y=Float32Array.from([height*.47,height*.47+2,height*.47+30,height*.47-20,height*.47-95,height*.47+120]);
  const opacity=new Float32Array(6).fill(1);
  awakening.update(time,enabled,x,y,opacity,width,height,202.8);
  return {x:[...x],y:[...y],opacity:[...opacity]};
};
const wakeBase=wakeFrame(0,false);
awakening.wake();const wakeStart=wakeFrame(1);
assert(wakeStart.opacity.slice(2).every(a=>a===0));
assert.deepEqual(wakeStart.x.slice(0,2),wakeBase.x.slice(0,2));
assert.deepEqual(wakeStart.opacity.slice(0,2),[1,1]);
const wakeMiddle=wakeFrame(3);
const wakeRatio=(wakeMiddle.x[2]-300)/(wakeBase.x[2]-300);
for(let i=2;i<6;i++)assert(Math.abs((wakeMiddle.x[i]-300)/(wakeBase.x[i]-300)-wakeRatio)<.00001);
assert.deepEqual(wakeFrame(3),wakeMiddle,'pause freezes incoming rings');
assert.deepEqual(wakeFrame(4.5),wakeBase,'wake settles exactly into original geometry');
assert.equal(awakening.waking,false);
assert.deepEqual(wakeFrame(120),wakeBase,'wake completion must never schedule outward expansion');
assert.equal(awakening.expand(),true);
awakening.wake();wakeFrame(121);
assert.equal(awakening.expand(),false,'wake must reject an outward action');
assert.deepEqual(wakeFrame(124.5),wakeBase);
assert.deepEqual(wakeFrame(240),wakeBase,'wake clears any pending outward action');
awakening.wake();assert(wakeFrame(241).opacity.slice(2).every(a=>a===0),'wake can replay');
assert.equal(awakening.supplement.count,0);
assert.deepEqual(wakeFrame(241,false),wakeBase,'reduced motion/disable restores rings');
assert.equal(awakening.waking,false);
console.log('wake core preservation, all-ring scale, pause, replay, completion and disable passed');

const rendererSource=await readFile(new URL('../src/lib/cockpitParticleRenderer.js',import.meta.url),'utf8');
assert.match(rendererSource,/kind > 1\.5 \? 1\.0 : orbitalPointScale/,'compact point scaling must exclude core grains');
assert.match(rendererSource,/orbitalPointScale\.value = 1;[\s\S]*setRenderTarget\(coreReference\)/,'center reference must use original orbital footprint');
assert.match(rendererSource,/baseline\.value = false;\s*points\.visible = true;\s*material\.uniforms\.orbitalPointScale\.value = Math\.min\(1,/,'compact scaling belongs only to the enhanced outer pass');
assert.match(rendererSource,/baseline\.value = true;[\s\S]*?points\.visible = false;[\s\S]*?setRenderTarget\(coreReference\)/,'center reference must exclude overlapping orbital light');
assert.match(rendererSource,/baseline\.value = false;\s*points\.visible = true;/,'enhanced outer pass must restore orbital rendering');

// Test native pointer routing on the real component, including drag/click separation.
const componentModule = {exports:{}};
const componentCode = await transformWithEsbuild(await readFile(new URL("../src/components/CockpitSentinel.jsx", import.meta.url), "utf8"), "CockpitSentinel.jsx", {format:"cjs",loader:"jsx",jsx:"automatic"});
const cleanups = [], dragCalls = [];
let opens = 0;
const stateLibrary = await import("../src/lib/cockpitSentinelState.js");
const hookCode=await transformWithEsbuild(await readFile(new URL('../src/hooks/useCockpitSentinelState.js',import.meta.url),'utf8'),'useCockpitSentinelState.js',{format:'cjs',loader:'js'});
vm.runInNewContext(componentCode.code, {module:componentModule,exports:componentModule.exports,clearTimeout,setTimeout,queueMicrotask:fn=>fn(),require:(id)=>{
  if(id === "react") return {useRef:value=>({current:value}),useState:value=>[value,()=>{}],useEffect:fn=>cleanups.push(fn())};
  if(id === "react/jsx-runtime") return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(id.endsWith("cockpitCore.js")) return {createCockpitCore:()=>({configure(){},pulse(){},wake(){},destroy(){}})};
  if(id.endsWith("cockpitSentinelState.js")) return stateLibrary;
  if(id.endsWith('useCockpitSentinelState.js'))return{useCockpitSentinelState:props=>({activity:stateLibrary.cockpitSentinelActivity({...props,...props.sources}),paused:false,setPaused(){},wakeSession:{current:false}})};
  return {};
}});
const rendered = componentModule.exports.CockpitSentinel({authenticated:true,taskPhase:"ready",tasks:[],sources:{goalPhase:"ready",automationPhase:"ready",goals:[],automations:[]},onOpen:()=>opens++,desktopApi:{beginWindowDrag:p=>dragCalls.push(["begin",p.x,p.y]),moveWindowDrag:p=>dragCalls.push(["move",p.x,p.y]),endWindowDrag:()=>dragCalls.push(["end"])}});
const stage = rendered.props.children[0].props;
let captured = false;
const attributes=new Map();
const target = {setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),setPointerCapture:()=>captured=true,hasPointerCapture:()=>captured,releasePointerCapture:()=>captured=false};
const pointer = (x,y,type="pointermove",pointerId=1)=>({button:0,pointerId,screenX:x,screenY:y,type,currentTarget:target});
stage.onPointerDown(pointer(100,100,"pointerdown"));
assert(attributes.has('data-pointer-focus'),'mouse focus must suppress the native pointer focus frame');
stage.onKeyDown({currentTarget:target});assert(!attributes.has('data-pointer-focus'),'keyboard focus remains visible');
stage.onPointerMove(pointer(102,101));assert.equal(dragCalls.length,1,"hand jitter must not move window");
stage.onPointerMove(pointer(120,140));
stage.onPointerUp(pointer(120,140,"pointerup"));
stage.onClick({detail:1});assert.equal(opens,0,"drag release must not open cockpit");
assert.deepEqual(dragCalls,[["begin",100,100],["move",120,140],["end"]]);assert.equal(captured,false);
stage.onPointerDown(pointer(100,100,"pointerdown"));stage.onPointerUp(pointer(100,100,"pointerup"));
stage.onBlur({currentTarget:target});assert(!attributes.has('data-pointer-focus'),'next keyboard visit must not inherit pointer focus');
stage.onClick({detail:1});assert.equal(opens,0,"single click must not open cockpit");
stage.onDoubleClick();assert.equal(opens,1,"double click restores cockpit");
stage.onPointerDown(pointer(100,100,"pointerdown"));stage.onPointerCancel(pointer(100,100,"pointercancel"));
stage.onDoubleClick();assert.equal(opens,1,"cancel must not activate");
stage.onPointerDown(pointer(100,100,"pointerdown"));for(const cleanup of cleanups)cleanup?.();
assert.equal(dragCalls.at(-1)[0],"end","unmount ends native drag");
assert.equal(JSON.stringify(rendered).includes("轨道已"),false);
console.log("sentinel drag threshold, single/double click separation and cancellation passed");

function wakeLifecycle(initiallyPaused=false,wakeSession) {
  const hooks=[],effects=[],microtasks=[],fakeModule={exports:{}},hookModule={exports:{}};let cursor=0,stateIndex=0,wakes=0,tree;
  const react={
    useRef(value){const i=cursor++;return hooks[i]??=( {current:value} );},
    useState(value){const i=cursor++,n=stateIndex++;if(!(i in hooks))hooks[i]=n===1?initiallyPaused:value;return[hooks[i],next=>{hooks[i]=next;}];},
    useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>!Object.is(v,old[j])))effects.push(fn);hooks[i]=deps;}
  };
  vm.runInNewContext(hookCode.code,{module:hookModule,exports:hookModule.exports,setTimeout,clearTimeout,require:id=>id==='react'?react:stateLibrary});
  vm.runInNewContext(componentCode.code,{module:fakeModule,exports:fakeModule.exports,setTimeout,clearTimeout,queueMicrotask:fn=>microtasks.push(fn),require:id=>{
    if(id==='react')return react;
    if(id==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(id.endsWith('cockpitCore.js'))return{createCockpitCore:()=>({configure(){},wake(){wakes++;},destroy(){}})};
    if(id.endsWith('cockpitSentinelState.js'))return stateLibrary;
    if(id.endsWith('useCockpitSentinelState.js'))return hookModule.exports;
    return{};
  }});
  return{
    render(phase='ready',authenticated=true){cursor=stateIndex=0;const props={authenticated,taskPhase:phase,tasks:[],sources:{goalPhase:'ready',automationPhase:'ready',goals:[],automations:[]}};if(wakeSession)props.presentation={wakeSession,activity:stateLibrary.cockpitSentinelActivity({...props,...props.sources}),paused:false,setPaused(){}};tree=fakeModule.exports.CockpitSentinel(props);while(effects.length)effects.shift()();while(microtasks.length)microtasks.shift()();return wakes;},
    resume(){tree.props.children[1].props.children[1].props.onClick();},
    wake(detail=1){tree.props.children[0].props.onClick({detail});}
  };
}
const lifecycle=wakeLifecycle();assert.equal(lifecycle.render(),1);
for(let n=0;n<4;n++){assert.equal(lifecycle.render('loading'),1);assert.equal(lifecycle.render(),1);}
assert.equal(lifecycle.render('ready',false),1);assert.equal(lifecycle.render(),2,'new login may wake once');
const pausedLifecycle=wakeLifecycle(true);assert.equal(pausedLifecycle.render(),0);assert.equal(pausedLifecycle.render('loading'),0);assert.equal(pausedLifecycle.render(),0);
pausedLifecycle.resume();assert.equal(pausedLifecycle.render(),1);assert.equal(pausedLifecycle.render(),1);
console.log('component wake-once, polling, login boundary and paused first-ready checks passed');
const sharedWake={current:false};
assert.equal(wakeLifecycle(false,sharedWake).render(),1,'first ready view wakes once');
for(let n=0;n<6;n++)assert.equal(wakeLifecycle(false,sharedWake).render(),0,'collapse/expand remount must render full rings without replay');
const expandedLifecycle=wakeLifecycle(false,sharedWake);assert.equal(expandedLifecycle.render(),0);
expandedLifecycle.wake();assert.equal(expandedLifecycle.render(),1,'explicit wake remains available');
expandedLifecycle.wake(2);assert.equal(expandedLifecycle.render(),1,'second double-click must not restart wake');
expandedLifecycle.render('ready',false);assert.equal(sharedWake.current,false,'logout resets session wake');
assert.equal(wakeLifecycle(false,sharedWake).render(),1,'next login can wake once');
const cockpitSource=await readFile(new URL('../src/components/PersonalCockpit.jsx',import.meta.url),'utf8');
assert.equal((cockpitSource.match(/presentation=\{sentinelPresentation\}/g)||[]).length,2,'both window modes must share the same parent-owned presentation');
console.log('shared session wake, view remount, explicit replay and logout boundary passed');
