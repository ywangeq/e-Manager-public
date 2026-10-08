const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const fraction = value => value - Math.floor(value);

// Uses the engine clock only; snapshots let a wave leave from the current orbital positions.
export function createOrbitExpansion(count, coreCount, seed = Math.random()) {
  const originX = new Float32Array(count), originY = new Float32Array(count);
  const capacity = Math.ceil((count-coreCount)/4)*3;
  const extraX = new Float32Array(capacity), extraY = new Float32Array(capacity);
  const supplement = {count:0, generation:0, x:new Float32Array(capacity), y:new Float32Array(capacity), depth:new Float32Array(capacity), opacity:new Float32Array(capacity), source:new Uint32Array(capacity)};
  const selected = [];
  let expandRequested = false, startedAt = null, recoveryAt = null, sequence = 0;
  let wakeRequested = false, wakeStartedAt = null, wakeScale = 1;
  const random = salt => fraction(Math.sin(seed * 8191 + salt * 127.1) * 43758.5453);
  return {
    supplement,
    expand() {
      if (expandRequested || startedAt !== null || wakeRequested || wakeStartedAt !== null) return false;
      expandRequested = true;
      return true;
    },
    wake() { wakeRequested = true; },
    get waking() { return wakeRequested || wakeStartedAt !== null; },
    update(time, enabled, x, y, opacity, width, height, sceneRadius = Math.min(width,height)*.39, depth) {
      for (const i of selected) opacity[i] = 1;
      if (!enabled) { opacity.fill(1,coreCount); supplement.count=0; selected.length = 0; startedAt = recoveryAt = wakeStartedAt = null; wakeRequested=expandRequested=false; return; }
      const radius = sceneRadius;
      if (radius <= 0) return;
      const cx = width / 2, cy = height * .47;
      const edgeFade = Math.min(32, Math.min(width,height) * .06);
      if (wakeRequested) {
        opacity.fill(1,coreCount); supplement.count=0; selected.length=0;
        startedAt=recoveryAt=null; expandRequested=false; wakeStartedAt=time; wakeRequested=false;
        wakeScale=1;
        for(let i=coreCount;i<count;i++) {
          const dx=x[i]-cx,dy=y[i]-cy;
          const extent=Math.max(Math.abs(dx)/(width/2),Math.abs(dy)/(height*.53));
          if(extent>1e-6)wakeScale=Math.max(wakeScale,1.1/extent);
        }
      }
      if (wakeStartedAt!==null) {
        const progress=Math.max(0,Math.min(1,(time-wakeStartedAt-.3)/3.2));
        const scale=Math.exp(Math.log(wakeScale)*(1-smooth(progress)));
        for(let i=coreCount;i<count;i++) {
          x[i]=cx+(x[i]-cx)*scale; y[i]=cy+(y[i]-cy)*scale;
          const edgeDistance=Math.min(x[i],width-x[i],y[i],height-y[i]);
          opacity[i]=smooth(progress/.12)*smooth(edgeDistance/edgeFade);
        }
        if(progress===1) { opacity.fill(1,coreCount); wakeStartedAt=null; }
        return;
      }
      if (expandRequested) {
        expandRequested = false;
        const layer = Math.floor(random(++sequence) * 4);
        selected.length = 0;
        for (let i = coreCount; i < count; i++) {
          if ((i - coreCount) % 4 !== layer) continue;
          // Peel only the visible orbital shell; core-covered projections stay on their normal paths.
          if (Math.hypot(x[i]-cx,y[i]-cy)<radius*.36) continue;
          selected.push(i);
          originX[i] = (x[i] - cx) / radius; originY[i] = (y[i] - cy) / radius;
        }
        // Fill short gaps along each captured band, without widening or reshaping the peel.
        const bands = Array.from({length:19},()=>[]);
        for (const i of selected) bands[(i-coreCount)%19].push(i);
        supplement.count=0; supplement.generation++;
        for (const band of bands) {
          if(band.length<2)continue;
          band.sort((a,b)=>Math.atan2(originY[a],originX[a])-Math.atan2(originY[b],originX[b]));
          for(let n=0;n<band.length;n++) {
            const a=band[n], b=band[(n+1)%band.length];
            const angle=(Math.atan2(originY[b],originX[b])-Math.atan2(originY[a],originX[a])+Math.PI*2)%(Math.PI*2);
            if(angle>.45||Math.hypot(originX[b]-originX[a],originY[b]-originY[a])>.3)continue;
            for(let k=1;k<=3;k++) {
              const f=k/4, px=originX[a]*(1-f)+originX[b]*f, py=originY[a]*(1-f)+originY[b]*f;
              if(Math.hypot(px,py)<.36||supplement.count>=capacity)continue;
              const j=supplement.count++;
              extraX[j]=px; extraY[j]=py; supplement.source[j]=a;
              supplement.depth[j]=(depth?.[a]??0)*(1-f)+(depth?.[b]??0)*f;
            }
          }
        }
        startedAt = time;
      }
      if (startedAt === null) return;
      const recoveryDuration = .7;
      if (recoveryAt !== null) {
        supplement.count=0;
        const alpha = smooth((time - recoveryAt) / recoveryDuration);
        for (const i of selected) opacity[i] = alpha;
        if (alpha === 1) {
          selected.length = 0; startedAt = recoveryAt = null;
        }
        return;
      }
      // A single scale preserves every angle, radial ratio and pairwise distance in the captured layer.
      const scale = Math.exp((time - startedAt) * .65);
      let visible = false;
      for (const i of selected) {
        const dx = originX[i] * radius, dy = originY[i] * radius;
        x[i] = cx + dx * scale; y[i] = cy + dy * scale;
        const edgeDistance = Math.min(x[i],width-x[i],y[i],height-y[i]);
        opacity[i] = smooth(edgeDistance / edgeFade);
        visible ||= opacity[i] > 0;
      }
      const densityFade=smooth((scale-1)/.6)*.72;
      for(let j=0;j<supplement.count;j++) {
        supplement.x[j]=cx+extraX[j]*radius*scale; supplement.y[j]=cy+extraY[j]*radius*scale;
        const edgeDistance=Math.min(supplement.x[j],width-supplement.x[j],supplement.y[j],height-supplement.y[j]);
        supplement.opacity[j]=smooth(edgeDistance/edgeFade)*densityFade;
        visible ||= supplement.opacity[j]>0;
      }
      if (!visible) recoveryAt = time;
    },
  };
}
