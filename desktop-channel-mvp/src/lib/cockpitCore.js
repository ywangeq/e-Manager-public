import { sentinelVisualState, sentinelOrbitalColor, sentinelOrbitalTreatment } from './cockpitSentinelState.js';
import { createOrbitExpansion } from './cockpitOrbitExpansion.js';
const TAU = Math.PI * 2;
const COUNT = 5000;
const CORE = 1200;
const COLORS = [['0,132,155', '174,119,40'], ['166,109,32', '185,140,60']];

export function createCockpitCore(canvas, report = () => {}, particleRendererFactory = null) {
  const ctx = canvas.getContext('2d');
  const trail = document.createElement('canvas');
  const ink = trail.getContext('2d');
  const glow = document.createElement('canvas');
  glow.width = glow.height = 256;
  const g = glow.getContext('2d');
  const lightSprites = ['37,173,241', '242,170,0', '246,218,103', '37,173,241'].map(color => {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 48;
    paintSprite(sprite,color);
    return sprite;
  });
  function paintSprite(sprite,color) {
    const surface = sprite.getContext('2d');
    surface.clearRect(0,0,48,48);
    const light = surface.createRadialGradient(24, 24, 0, 24, 24, 24);
    light.addColorStop(0, 'rgba(255,255,255,.95)');
    light.addColorStop(.08, 'rgba(255,255,255,.9)');
    light.addColorStop(.24, `rgba(${color},.8)`);
    light.addColorStop(.5, `rgba(${color},.22)`);
    light.addColorStop(1, `rgba(${color},0)`);
    surface.fillStyle = light; surface.fillRect(0, 0, 48, 48);
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 1, h = 1, dpr = 1, timer = 0, raf = 0, last = 0, t = 0, elapsed = 0, frames = 0, cost = 0;
  let dead = false, visible = true, pulseAt = -100, orbitBoost = 0;
  let gpu = null, gpuAttempted = false, backend = null;
  let expansion = null, lastWaking = false;
  function rendererStatus(next) {
    if (backend === next) return;
    backend = next; report({ renderer: next });
  }
  let orbitTime = 0, ringOpacity = 0, audioEnergy = 0, wakeAt = -100;
  let pointerX = null, pointerY = null, pointerAt = 0;
  let yawOffset = 0, pitchOffset = 0, yawSpeed = 0, pitchSpeed = 0;
  let lastInjection = -100;
  let injections = [];
  let contacts = [];
  const smoothColor = [0, 132, 155];
  const particleColor = [24, 190, 220];
  const bandCos = new Float32Array(19), bandSin = new Float32Array(19);
  // Sample once per mount: each band keeps its own continuous direction, speed and phase.
  const bandSpeed = Float32Array.from({ length: 19 }, () => (Math.random() < .5 ? -1 : 1) * (.1 + Math.random() * .12));
  const bandPhase = Float32Array.from({ length: 19 }, () => Math.random() * TAU);
  const turnCos = new Float32Array(19), turnSin = new Float32Array(19);
  let options = { warm: false, paused: false, voice: "off", activity: "idle", audioLevel: null, injection: true, quiet: false, orbitThickness: 0, orbitExpansion: false };
  const x = new Float32Array(COUNT), y = new Float32Array(COUNT), z = new Float32Array(COUNT);
  const screenX = new Float32Array(COUNT), screenY = new Float32Array(COUNT), depth = new Float32Array(COUNT);
  const particleOpacity = new Float32Array(COUNT).fill(1);
  const sizes = new Float32Array(COUNT), bucket = new Uint8Array(COUNT);
  const tx = new Float32Array(COUNT), ty = new Float32Array(COUNT), tz = new Float32Array(COUNT);
  const nx = new Float32Array(COUNT), ny = new Float32Array(COUNT), nz = new Float32Array(COUNT);
  const links = new Uint16Array(4000);
  let linkCount = 0, drawCount = 0;
  // Preserve the original 3,800 orbital particles, adding a separate central sphere.
  for (let i = 0; i < COUNT; i++) {
    sizes[i] = .55;
    if (i < CORE) {
      const v = 1 - 2 * (i + .5) / CORE, a = i * 2.39996323;
      const radius = .34 * (i % 5 === 0 ? .4 + Math.random() * .5 : .98 + Math.random() * .025);
      const r = Math.sqrt(1 - v * v);
      x[i] = Math.cos(a) * r * radius; y[i] = v * radius; z[i] = Math.sin(a) * r * radius;
    } else {
      const band = (i - CORE) % 19, a = Math.random() * TAU;
      const r = .48 + (band % 7) * .084 + (Math.random() - .5) * .028;
      const tilt = (band % 5) * .58 + .12, spin = (band % 4) * .82;
      const u = Math.cos(a) * r, v = Math.sin(a) * r;
      const c = Math.cos(spin), q = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
      x[i] = u * c - v * ct * q; y[i] = u * q + v * ct * c; z[i] = v * st;
      tx[i] = -v * c - u * ct * q; ty[i] = -v * q + u * ct * c; tz[i] = u * st;
      const crossSection = ((i * .61803398875) % 1) - .5;
      nx[i] = q * st * crossSection; ny[i] = -c * st * crossSection; nz[i] = ct * crossSection;
    }
  }
  function cacheGlow() {
    paintSprite(lightSprites[0],options.stateColors ? sentinelOrbitalColor(options.activity).join(',') : '37,173,241');
    g.clearRect(0, 0, 256, 256);
    const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    const c = options.palette === 'blue' ? '246,218,103' : COLORS[+options.warm][0];
    if (options.palette === 'blue') {
      gradient.addColorStop(0, 'rgba(255,253,224,.75)');
      gradient.addColorStop(.16, 'rgba(255,229,129,.35)');
    } else gradient.addColorStop(0, `rgba(${c},.2)`);
    gradient.addColorStop(.45, `rgba(${c},.06)`); gradient.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gradient; g.fillRect(0, 0, 256, 256);
  }
  function resize() {
    const bounds = canvas.getBoundingClientRect(); w = bounds.width; h = bounds.height;
    dpr = Math.min(devicePixelRatio || 1, 1.35);
    for (const c of [canvas, trail]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ink.setTransform(dpr, 0, 0, dpr, 0, 0);
    gpu?.resize(w, h, dpr);
    draw(options.paused ? 0 : 1 / 30); schedule();
  }
  function draw(dt) {
    const start = performance.now(), R = Math.min(w * .39, h * .39, Number.isFinite(options.radiusLimit) ? Math.max(1, options.radiusLimit) : Infinity), cx = w / 2, cy = h * .47;
    if (options.palette === 'blue' && options.material === 'gpu' && particleRendererFactory && !gpuAttempted) {
      gpuAttempted = true;
      try {
        gpu = particleRendererFactory(COUNT, CORE, () => { if (!dead && options.palette === 'blue') draw(0); });
        gpu?.resize(w, h, dpr);
      } catch { gpu?.destroy(); gpu = null; }
    }
    const state = sentinelVisualState(options.activity, options.voice);
    const targetColor = options.palette === 'blue' ? [20,122,190] : options.activity === 'idle' && options.warm ? [166,109,32] : state.color;
    const mix = 1 - Math.exp(-dt * 6);
    for (let k = 0; k < 3; k++) smoothColor[k] += (targetColor[k] - smoothColor[k]) * mix;
    const targetParticleColor = options.stateColors ? sentinelOrbitalColor(options.activity) : options.palette === 'blue' ? [37,173,241] : options.warm && options.activity === 'idle' ? [237,176,67] : state.particleColor;
    for (let k = 0; k < 3; k++) particleColor[k] += (targetParticleColor[k] - particleColor[k]) * mix;
    const orbitColors = [particleColor.map(Math.round).join(','), '242,170,0'];
    const colors = [smoothColor.map((value) => Math.round(value * .78 + 255 * .22)).join(','), COLORS[+options.warm][1]];
    orbitTime += dt * (state.voice === 'thinking' ? 1.1 : state.speed);
    ringOpacity += ((state.audioVisible ? 1 : 0) - ringOpacity) * (1 - Math.exp(-dt * 14));
    const inputLevel = Number.isFinite(options.audioLevel) ? Math.min(1, Math.max(0, options.audioLevel)) : 0;
    const previousEnergy = audioEnergy;
    audioEnergy += ((state.audioVisible ? inputLevel : 0) - audioEnergy) * (1 - Math.exp(-dt * (inputLevel > audioEnergy ? 15 : 5)));
    if (!state.audioVisible || !options.injection || reduced.matches) { injections.length = 0; contacts.length = 0; }
    else if (audioEnergy > .5 && previousEnergy <= .5 && t - lastInjection > .85) {
      let peakAngle = 0, peakValue = -1;
      for (let n = 0; n < 48; n++) {
        const a = n / 48 * TAU + t * (.07 + audioEnergy * .22);
        const value = Math.abs(Math.sin(a * 3 - t * 2.3) * Math.sin(a * 2 + t * 1.6));
        if (value > peakValue) { peakAngle = a; peakValue = value; }
      }
      injections.push({start:t, angle:peakAngle, energy:audioEnergy, bend:Math.sin(t*3.1)*.45, arrived:false});
      if (injections.length > 3) injections.shift();
      lastInjection = t;
    }
    const age = t - pulseAt;
    if (age >= 0 && age < 3 && !reduced.matches) orbitBoost += dt * 1.8 * Math.sin(Math.PI * age / 3) ** 2;
    const decay = Math.exp(-dt * 6);
    yawSpeed *= decay; pitchSpeed *= decay;
    if (reduced.matches) yawSpeed = pitchSpeed = 0;
    yawOffset += dt * yawSpeed; pitchOffset += dt * pitchSpeed;
    const yaw = orbitTime * .075 + yawOffset, pitch = -.1 + pitchOffset;
    const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch);
    const waking = state.voice === 'waking' ? Math.min(1, Math.max(0, (t - wakeAt) / 1.1)) : 1;
    const breath = (1 + .018 * Math.sin(t * .9) + .007 * Math.sin(t * 1.7)) * (.82 + .18 * (1 - (1-waking)**3));
    for (let b = 0; b < 19; b++) {
      bandPhase[b] += dt * bandSpeed[b] * (.8 + state.speed * .3);
      const direction = Math.sign(bandSpeed[b]);
      const a = bandPhase[b] + direction * orbitBoost * (.65 + (b % 4) * .12);
      bandCos[b] = Math.cos(a); bandSin[b] = Math.sin(a);
      const turn = bandPhase[b] * .35 + orbitBoost * .6;
      turnCos[b] = Math.cos(turn); turnSin[b] = Math.sin(turn);
    }
    const gpuPath = options.palette === 'blue' && options.material === 'gpu' && gpu;
    if (!gpuPath) {
      ink.globalCompositeOperation = 'destination-out'; ink.fillStyle = `rgba(0,0,0,${1 - Math.exp(-dt * 8.5)})`; ink.fillRect(0, 0, w, h);
      ink.globalCompositeOperation = 'source-over';
    }
    const thickness = Number.isFinite(options.orbitThickness) ? Math.min(.2, Math.max(0, options.orbitThickness)) : 0;
    const coreCos = Math.cos(t * .22), coreSin = Math.sin(t * .22);
    for (let i = 0; i < COUNT; i++) {
      const band = i < CORE ? -1 : (i - CORE) % 19;
      // Click adds a smooth orbital phase advance; the core never receives this offset.
      const c = band < 0 ? 1 : bandCos[band], s = band < 0 ? 0 : bandSin[band];
      let ax = x[i] * c + tx[i] * s, az = z[i] * c + tz[i] * s, ay = y[i] * c + ty[i] * s;
      // The plane normal stays independent of in-plane phase, so thickness cannot collapse during rotation.
      if (band >= 0 && thickness) { ax += nx[i] * thickness; ay += ny[i] * thickness; az += nz[i] * thickness; }
      if (band < 0) { const previousX = ax; ax = ax * coreCos + az * coreSin; az = -previousX * coreSin + az * coreCos; }
      if (band >= 0) { const previousX = ax; ax = ax * turnCos[band] + az * turnSin[band]; az = -previousX * turnSin[band] + az * turnCos[band]; }
      const scale = band < 0 ? 1 + .018 * Math.sin(t * .9) + .007 * Math.sin(t * 1.7) : breath;
      const rx = (ax * ca + az * sa) * scale, rz = (-ax * sa + az * ca) * scale;
      const ry = ay * cb - rz * sb, zz = ay * sb + rz * cb, perspective = 4 / (4 - zz);
      const dx = rx * R * perspective, dy = ry * R * perspective;
      screenX[i] = cx + dx; screenY[i] = cy + dy; depth[i] = zz;
      bucket[i] = (i % 13 === 0 ? 4 : 0) + Math.min(3, Math.max(0, Math.floor((zz + 1.2) / 2.4 * 4)));
    }
    const expand = options.palette === 'blue' && options.orbitExpansion && !reduced.matches;
    if (expand && !expansion) expansion = createOrbitExpansion(COUNT, CORE);
    expansion?.update(t, expand, screenX, screenY, particleOpacity, w, h, R, depth);
    if (!!expansion?.waking !== lastWaking) { lastWaking=!!expansion?.waking; report({waking:lastWaking}); }
    // Sampled local constellation graph: bounded candidates, refreshed at ~10 Hz.
    if (drawCount++ % 3 === 0) {
      linkCount = 0;
      for (let i = CORE; i < COUNT && linkCount < links.length; i += 3) {
        let found = 0;
        for (let n = 1; n <= 32; n++) {
          const j = CORE + ((i - CORE + n * 73) % (COUNT - CORE));
          const dx = screenX[i] - screenX[j], dy = screenY[i] - screenY[j], d = dx * dx + dy * dy;
          if (d > 64 && d < 1600) { links[linkCount++] = i; links[linkCount++] = j; if (++found === 2 || linkCount >= links.length) break; }
        }
      }
    }
    // GPU output replaces these unused offscreen pigment batches.
    if (!gpuPath) {
      for (let b = 0; b < 8; b++) {
        const alpha = (b >= 4 ? [.58, .74, .9, 1] : [.16, .28, .46, .68])[b % 4];
        ink.fillStyle = `rgba(${orbitColors[b >= 4 ? 1 : 0]},${options.palette === 'blue' ? Math.min(1, alpha * [1.05, 1.15, 1.25, 1.3][b % 4]) : alpha})`; ink.beginPath();
        for (let i = CORE; i < COUNT; i++) if (bucket[i] === b) { const r = options.palette === 'blue' ? (b >= 4 ? .85 : sizes[i]) * [.9, .95, 1, 1.18][b % 4] : sizes[i]; ink.moveTo(screenX[i] + r, screenY[i]); ink.arc(screenX[i], screenY[i], r, 0, TAU); }
        ink.fill();
      }
      // Fine periwinkle points distinguish the sphere on a white surface.
      for (let b = 0; b < 4; b++) {
        ink.fillStyle = options.palette === 'blue' ? `rgba(65,135,225,${[.36, .56, .76, .95][b]})` : `rgba(99,143,207,${[.28, .42, .62, .8][b]})`; ink.beginPath();
        for (let i = 0; i < CORE; i++) {
          const layer = Math.min(3, Math.max(0, Math.floor((depth[i] + .35) / .7 * 4)));
          if (layer !== b) continue;
          const r = sizes[i]; ink.moveTo(screenX[i] + r, screenY[i]); ink.arc(screenX[i], screenY[i], r, 0, TAU);
        }
        ink.fill();
      }
    }
    ctx.clearRect(0, 0, w, h); ctx.globalCompositeOperation = 'source-over';
    let particles = null;
    const orbitalTreatment = sentinelOrbitalTreatment(options.stateColors ? options.activity : 'idle');
    if (options.palette === 'blue' && options.material === 'gpu' && gpu) {
      try { particles = gpu.render(screenX, screenY, depth, t, particleOpacity, R, expansion?.supplement, options.stateColors ? particleColor : undefined, orbitalTreatment); }
      catch { gpu.destroy(); gpu = null; }
    }
    if (options.palette === 'blue') {
      rendererStatus(particles ? 'webgl' : options.material === 'gpu' ? 'fallback' : 'canvas');
      if (!particles) ctx.drawImage(glow, cx - R * .65, cy - R * .65, R * 1.3, R * 1.3);
    } else rendererStatus('canvas');
    if (options.palette !== 'blue') ctx.drawImage(trail, 0, 0, w, h);
    // Draw connections once on the live canvas; never accumulate a dark mesh in trails.
    ctx.strokeStyle = `rgba(${colors[0]},.05)`; ctx.lineWidth = .35; ctx.beginPath();
    for (let n = 0; n < linkCount; n += 2) {
      const a = links[n], b = links[n + 1], dx = screenX[a] - screenX[b], dy = screenY[a] - screenY[b];
      if (particleOpacity[a] < .95 || particleOpacity[b] < .95) continue;
      if (dx * dx + dy * dy < 1600) { ctx.moveTo(screenX[a], screenY[a]); ctx.lineTo(screenX[b], screenY[b]); }
    }
    ctx.stroke();
    if (options.palette !== 'blue') ctx.drawImage(glow, cx - R * .65, cy - R * .65, R * 1.3, R * 1.3);
    // Render each cockpit point as light, not a hard disk; keep bloom out of trails.
    if (particles) ctx.drawImage(particles, 0, 0, w, h);
    if (options.palette === 'blue' && !particles) {
      const orbitalPointScale = Math.min(1, R / 202.8);
      for (let layer = 0; layer < 4; layer++) {
        for (let i = 0; i < COUNT; i++) {
          const core = i < CORE, gold = !core && i % 13 === 0;
          const tinted = (((i * 16807) % 2147483647) / 2147483647 * 719.31) % 1 < orbitalTreatment.coverage;
          const focus = Math.min(1, Math.max(0, (depth[i] + (core ? .34 : 1.2)) / (core ? .68 : 2.4)));
          if (Math.min(3, Math.floor(focus * 4)) !== layer) continue;
          const variation = .85 + (i % 7) * .05;
          const size = (core ? 3.8 : gold ? 6 : 4.2) * (.8 + .3 * focus) * variation * (core ? 1 : orbitalPointScale);
          ctx.globalAlpha = (core ? .98 : gold ? .95 : .8) * (.65 + .35 * focus) * particleOpacity[i];
          if (!core && !gold && tinted) ctx.globalAlpha *= orbitalTreatment.energy;
          ctx.drawImage(lightSprites[core ? 2 : gold ? 1 : tinted ? 0 : 3], screenX[i] - size / 2, screenY[i] - size / 2, size, size);
        }
      }
      const extra=expansion?.supplement;
      for(let i=0;i<(extra?.count??0);i++) {
        if(extra.opacity[i]<.015)continue;
        const gold=extra.source[i]%13===0, size=(gold?6:4.2)*orbitalPointScale;
        const tinted=(((i*16807+extra.source[i]*97)%2147483647)/2147483647*719.31)%1<orbitalTreatment.coverage;
        ctx.globalAlpha=extra.opacity[i];
        if(!gold&&tinted)ctx.globalAlpha*=orbitalTreatment.energy;
        ctx.drawImage(lightSprites[gold?1:tinted?0:3],extra.x[i]-size/2,extra.y[i]-size/2,size,size);
      }
      ctx.globalAlpha = 1;
    }
    // Same 1,440 audio particles, wrapped around the whole core rather than a separate strip.
    for (let accent = 0; ringOpacity > .005 && accent < 2; accent++) {
      ctx.fillStyle = `hsla(${182 + audioEnergy * 92},${96 - audioEnergy * 10}%,${38 + audioEnergy * 4}%,${ringOpacity * (.7 + audioEnergy * .3) * (accent ? .8 : 1)})`; ctx.beginPath();
      for (let i = 0; i < 1440; i++) {
        if ((i % 23 === 0 ? 1 : 0) !== accent) continue;
        const angle = (i + .5) / 1440 * TAU + t * (.07 + audioEnergy * .22);
        const phase = i * 2.39996323;
        const voice = Math.abs(Math.sin(angle * 3 - t * 2.3) * Math.sin(angle * 2 + t * 1.6));
        const amplitude = 1.5 + audioEnergy * (7 + voice * 23);
        const radial = R * 1.27 + Math.sin(phase + t * (1.2 + audioEnergy * 2.8)) * amplitude
          + (Math.sin(angle * 5 - t * 2) * voice * audioEnergy * 5);
        const xx = cx + Math.cos(angle) * radial;
        const yy = cy + Math.sin(angle) * radial;
        ctx.moveTo(xx + .55, yy); ctx.arc(xx, yy, .55, 0, TAU);
      }
      ctx.fill(); ctx.fill();
    }
    // Optional bounded experiment: fine packets travel from an actual local waveform crest.
    for (let n = injections.length - 1; n >= 0; n--) {
      const packet = injections[n], age = t - packet.start;
      if (age > 1.7) { injections.splice(n,1); continue; }
      if (age >= 1.05 && !packet.arrived) { packet.arrived = true; contacts.push({start:t, angle:packet.angle}); if (contacts.length > 3) contacts.shift(); }
      for (let strand=0;strand<3;strand++) {
        ctx.fillStyle = strand === 0 ? 'rgba(25,113,180,1)' : strand === 1 ? 'rgba(26,147,165,.95)' : 'rgba(115,91,181,.9)';
        ctx.beginPath();
        for (let i=0;i<80;i++) {
          const progress=(age-i*.0055)/1.05;
          if(progress<0||progress>1)continue;
          const travel=1-(1-progress)**1.7;
          const radius=R*(1.3-.98*travel);
          const swirl=Math.sin(travel*Math.PI)*(packet.bend+(strand-1)*.09);
          const angle=packet.angle+swirl;
          const spread=(1-travel)*3.5+.4;
          const flutter=Math.sin(i*2.4+t*7+strand)*spread;
          const xx=cx+Math.cos(angle)*radius-Math.sin(angle)*flutter;
          const yy=cy+Math.sin(angle)*radius+Math.cos(angle)*flutter;
          ctx.moveTo(xx+.55,yy);ctx.arc(xx,yy,.55,0,TAU);
        }
        ctx.fill();ctx.fill();
      }
    }
    // Light propagates across existing sphere points from the contact side.
    for (let n = contacts.length - 1; n >= 0; n--) {
      const contact = contacts[n], age = t - contact.start;
      if (age > 1.2) { contacts.splice(n, 1); continue; }
      const reach = age / 1.2 * 2.4;
      ctx.fillStyle = `rgba(64,117,192,${.8 * (1 - age / 1.2)})`; ctx.beginPath();
      for (let i = 0; i < CORE; i++) {
        const dx = (screenX[i] - cx) / (R * .34) - Math.cos(contact.angle);
        const dy = (screenY[i] - cy) / (R * .34) - Math.sin(contact.angle);
        const distance = Math.sqrt(dx * dx + dy * dy + (depth[i] / .34) ** 2);
        if (Math.abs(distance - reach) < .2) {
          ctx.moveTo(screenX[i] + .55, screenY[i]); ctx.arc(screenX[i], screenY[i], .55, 0, TAU);
        }
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    return performance.now() - start;
  }
  function stop() { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = 0; last = 0; }
  function schedule() {
    if (dead || options.paused || document.hidden || !visible || timer || raf) return;
    const interval = options.quiet || reduced.matches ? 50 : 33.333;
    timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(tick); }, Math.max(0, interval - (performance.now() - last) - 4));
  }
  function tick(now) {
    raf = 0; if (dead || options.paused || document.hidden || !visible) return;
    const raw = last ? (now - last) / 1000 : 1 / 30;
    if (last && raw < (options.quiet || reduced.matches ? .046 : .03)) { schedule(); return; }
    last = now; const dt = Math.min(raw, .1); t += dt * (reduced.matches ? .3 : 1);
    cost += draw(dt); elapsed += raw; frames++;
    if (elapsed >= 1) { report({fps: Math.round(frames / elapsed), ms: (cost / frames).toFixed(1)}); frames = 0; elapsed = cost = 0; }
    schedule();
  }
  const pointer = e => {
    if (e.buttons) { leave(); return; }
    const now = performance.now();
    if (pointerX !== null && !reduced.matches) {
      const elapsed = Math.max(.008, Math.min(.1, (now - pointerAt) / 1000));
      yawSpeed = Math.max(-3, Math.min(3, (e.clientX - pointerX) / Math.max(1, w) / elapsed * 2));
      pitchSpeed = Math.max(-2.2, Math.min(2.2, (e.clientY - pointerY) / Math.max(1, h) / elapsed * 1.5));
    }
    pointerX = e.clientX; pointerY = e.clientY; pointerAt = now;
  };
  const leave = () => { pointerX = pointerY = null; };
  const visibility = () => { stop(); schedule(); };
  const motionPreference = () => { if (expansion) { ink.clearRect(0,0,w,h); draw(0); } visibility(); };
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; visibility(); }); intersection.observe(canvas);
  canvas.addEventListener('pointermove', pointer); canvas.addEventListener('pointerleave', leave); document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', motionPreference);
  cacheGlow(); resize();
  return {
    expand() {
      if (dead || options.palette !== 'blue' || !options.orbitExpansion || reduced.matches) return false;
      if (!expansion) expansion=createOrbitExpansion(COUNT,CORE);
      if (!expansion.expand()) return false;
      ink.clearRect(0,0,w,h); draw(0); stop(); schedule();
      return true;
    },
    wake() {
      if (dead || options.palette !== 'blue' || !options.orbitExpansion) return;
      if (!expansion) expansion=createOrbitExpansion(COUNT,CORE);
      expansion.wake(); ink.clearRect(0,0,w,h); draw(0); stop(); schedule();
    },
    configure(next) {
      const colorChanged = (next.warm !== undefined && next.warm !== options.warm) || (next.palette !== undefined && next.palette !== options.palette) || (next.stateColors !== undefined && next.stateColors !== options.stateColors) || (options.stateColors && next.activity !== undefined && next.activity !== options.activity);
      const materialChanged = next.material !== undefined && next.material !== options.material;
      const motionChanged = next.orbitExpansion !== undefined && next.orbitExpansion !== options.orbitExpansion;
      if (next.voice === 'waking' && options.voice !== 'waking') { wakeAt = t; pulseAt = t; }
      options = {...options, ...next};
      if (options.stateColors && (options.paused || next.stateColors === true) && colorChanged) particleColor.splice(0,3,...sentinelOrbitalColor(options.activity));
      if (colorChanged || materialChanged || motionChanged) { cacheGlow(); ink.clearRect(0,0,w,h); draw(options.paused || motionChanged ? 0 : 1/30); }
      stop(); schedule();
    },
    pulse() { pulseAt = t; wakeAt = t; },
    destroy() { dead = true; stop(); gpu?.destroy(); resizeObserver.disconnect(); intersection.disconnect(); canvas.removeEventListener('pointermove', pointer); canvas.removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', motionPreference); }
  };
}
