import {
  ACESFilmicToneMapping, AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, HalfFloatType,
  Mesh, NormalBlending, OrthographicCamera, PlaneGeometry, Points, Scene, ShaderMaterial,
  Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const quadVertex = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// A render adapter only: projected positions and time belong to CockpitCore.
export function createCockpitParticleRenderer(count, coreCount, onContextChange = () => {}) {
  const surface = document.createElement('canvas');
  const context = surface.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
  if (!context) return null;
  const releaseContext = () => context.getExtension('WEBGL_lose_context')?.loseContext();
  if (!context.getExtension('EXT_color_buffer_float')) { releaseContext(); return null; }
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas: surface, context, alpha: true, premultipliedAlpha: false });
  } catch { releaseContext(); return null; }
  try {
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, .1, 10);
  camera.position.z = 2;
  const coordinates = new Float32Array(count * 3);
  const kinds = Float32Array.from({ length: count }, (_, i) => i < coreCount ? 2 : i % 13 === 0 ? 1 : 0);
  const seeds = Float32Array.from({ length: count }, (_, i) => ((i * 16807) % 2147483647) / 2147483647);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(coordinates, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('kind', new BufferAttribute(kinds, 1));
  geometry.setAttribute('seed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('opacity', new BufferAttribute(new Float32Array(count).fill(1), 1).setUsage(DynamicDrawUsage));
  geometry.setDrawRange(coreCount, count - coreCount);
  const material = new ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
    uniforms: { pixelRatio: { value: 1 }, orbitalPointScale: { value: 1 }, clock: { value: 0 }, baseline: { value: false }, orbitalTint: { value: new Vector3(1,1,1) }, tintAmount: { value: 0 }, tintCoverage: { value: 1 }, tintEnergy: { value: 1 }, frontOnly: { value: false }, viewport: { value: new Vector2(1,1) }, coreRadius: { value: 1 }, sceneRadius: { value: 1 } },
    vertexShader: `attribute float kind; attribute float seed; attribute float opacity; varying float vOpacity; varying float vDepth;
      uniform float pixelRatio; uniform float orbitalPointScale; varying float vKind; varying float vSeed; varying float vFocus;
      void main() {
        vKind = kind; vSeed = fract(seed * 719.31); vOpacity = opacity; vDepth = position.z;
        vFocus = kind > 1.5 ? clamp((position.z+.34)/.68,0.0,1.0) : clamp(position.z * .5 + .5, 0.0, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
        float size = kind > 1.5 ? 3.1 : kind > .5 ? 7.8 : 5.8;
        gl_PointSize = pixelRatio * size * (kind > 1.5 ? 1.0 : orbitalPointScale) * (.72 + .55 * vFocus) * (.7 + .6 * vSeed);
      }`,
    fragmentShader: `uniform float clock; uniform bool baseline; uniform vec3 orbitalTint; uniform float tintAmount; uniform float tintCoverage; uniform float tintEnergy; varying float vKind; varying float vSeed; varying float vFocus; varying float vOpacity;
      uniform bool frontOnly; uniform float pixelRatio; uniform vec2 viewport; uniform float coreRadius; uniform float sceneRadius; varying float vDepth;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float angle = vSeed * 6.2831853;
        p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
        float d = length(p * vec2(1.0, 1.35));
        float edge = 1.0 - smoothstep(.3, .9, d);
        float grain = .8 + .2 * sin(p.x * 18.0 + vSeed * 100.0) * cos(p.y * 13.0);
        float hot = exp(-dot(p - vec2(-.12,.16), p - vec2(-.12,.16)) * 27.0);
        float focus = .4 + .6 * vFocus;
        vec3 pigment = vKind > 1.5 ? vec3(.55,.30,.025) : vKind > .5 ? vec3(.85,.44,.035) : vec3(.025,.25,.54);
        vec3 light = vKind > .5 ? vec3(7.0,5.9,2.6) : vec3(.55,3.2,6.7);
        float sheen = .8 + .2 * sin(clock * .4 + vSeed * 62.0);
        vec3 color = mix(pigment, light, hot * sheen * (vKind > 1.5 ? .18 : .35 + .65 * vFocus));
        float alpha = edge * grain * focus * (vKind > 1.5 ? .48 : .95);
        if (vKind < 1.5) {
          // Accumulate colored light; neutral HDR highlights wash out against the pale backdrop.
          float facet = .5 + .5 * sin(p.x * 23.0 + vSeed * 80.0) * cos(p.y * 19.0 - vSeed * 53.0);
          float body = exp(-d * d * 3.8);
          float pin = exp(-dot(p - vec2(-.09,.12), p - vec2(-.09,.12)) * (baseline ? 100.0 : 45.0));
          float halo = exp(-d * d * 2.5) * (baseline ? .24 : .32);
          vec3 peakLight = baseline ? vec3(3.0,1.3,.05) : vec3(6.0,4.1,.5);
          vec3 bodyLight = vec3(2.5,1.1,.04);
          if (vKind < .5) { peakLight = baseline ? vec3(.035,.75,2.4) : vec3(.7,4.2,6.0); bodyLight = vec3(.015,.65,2.6); }
          color = pigment * (.8 + .8 * facet) + bodyLight * body * (baseline ? .10 : .24);
          color += peakLight * pin * sheen * (.20 + .25 * vFocus);
          alpha = clamp(body * (.7 + .3 * facet) + halo, 0.0, 1.0) * (.65 + .35 * vFocus);
          alpha *= 1.0 - smoothstep(.8,1.0,d);
          if (vKind < .5 && !baseline && vSeed < tintCoverage) color = mix(color,max(color.r,max(color.g,color.b))*orbitalTint*tintEnergy,tintAmount);
        }
        alpha *= vOpacity;
        if (frontOnly) {
          vec2 offset = gl_FragCoord.xy / pixelRatio - viewport * vec2(.5,.53);
          float footprint = 1.0 - smoothstep(coreRadius*1.05,coreRadius*1.45,length(offset));
          // CockpitCore projects positive Z toward the viewer with this same perspective.
          vec2 lateral = offset / (sceneRadius * 4.0 / (4.0-vDepth));
          float surfaceDepth = sqrt(max(0.0,pow(coreRadius/sceneRadius,2.0)-dot(lateral,lateral)));
          alpha *= footprint * smoothstep(surfaceDepth-.015,surfaceDepth+.015,vDepth);
        }
        if (alpha < .015) discard;
        gl_FragColor = vec4(color, alpha);
      }`,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);
  const extraCapacity=Math.ceil((count-coreCount)/4)*3;
  const extraGeometry=new BufferGeometry();
  for(const [name,size] of [['position',3],['kind',1],['seed',1],['opacity',1]]) {
    extraGeometry.setAttribute(name,new BufferAttribute(new Float32Array(extraCapacity*size),size).setUsage(DynamicDrawUsage));
  }
  extraGeometry.setDrawRange(0,0);
  const extraPoints=new Points(extraGeometry,material);
  extraPoints.frustumCulled=false; extraPoints.renderOrder=2; scene.add(extraPoints);
  let extraGeneration=-1;
  // Keep core shading unchanged while orbital light accumulates instead of occluding nearby grains.
  const corePointGeometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) corePointGeometry.setAttribute(name, attribute);
  corePointGeometry.setDrawRange(0, coreCount);
  const corePointMaterial = material.clone();
  corePointMaterial.blending = NormalBlending;
  corePointMaterial.uniforms = material.uniforms;
  const corePoints = new Points(corePointGeometry, corePointMaterial);
  corePoints.frustumCulled = false;
  corePoints.renderOrder = 1;
  scene.add(corePoints);
  const coreMaterial = new ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { clock: material.uniforms.clock }, vertexShader: `varying vec2 vUv;
      void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float clock;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }
      float volume(vec3 p) {
        float layer=floor(p.z); float blend=fract(p.z);
        return mix(noise(p.xy+layer*vec2(17.0,31.0)),noise(p.xy+(layer+1.0)*vec2(17.0,31.0)),blend);
      }
      void main() {
        vec2 p=(vUv-.5)*2.0; float r=length(p);
        float edge=1.0-smoothstep(.985,1.025,r);
        if(edge<.005) discard;
        float z=sqrt(max(0.0,1.0-r*r));
        float turn=clock*.22;
        mat2 rotation=mat2(cos(turn),-sin(turn),sin(turn),cos(turn));
        vec3 light=vec3(0.0); float opacity=0.0;
        float jitter=hash(gl_FragCoord.xy);
        for(int step=0;step<14;step++) {
          float ray=z*(1.0-2.0*(float(step)+jitter)/14.0);
          vec3 q=vec3(p,ray); q.xz=rotation*q.xz;
          float warp=volume(q*4.5);
          float weave=sin(q.x*28.0+warp*9.0)*sin(q.y*25.0-warp*7.0)*sin(q.z*22.0+warp*6.0);
          float thread=pow(max(0.0,1.0-abs(weave)),18.0);
          float fleck=volume(q*47.0);
          float density=thread*(.03+.145*fleck)*edge;
          float front=.55+.45*(ray/max(z,.01)*.5+.5);
          vec3 gold=mix(vec3(.4,.18,.015),vec3(5.2,3.8,.9),pow(fleck,2.0))*front;
          light+=(1.0-opacity)*density*gold;
          opacity+=(1.0-opacity)*density;
        }
        float key=clamp(dot(normalize(vec3(p,z)),normalize(vec3(-.5,.6,1.0))),0.0,1.0);
        float rim=exp(-pow((r-.975)*65.0,2.0))*key;
        float nucleus=exp(-dot(p-vec2(-.10,.08),p-vec2(-.10,.08))*220.0);
        light+=vec3(7.5,7.0,4.5)*(rim*.12+nucleus*.8)*edge;
        opacity=clamp(opacity+rim*.14+nucleus*.5,0.0,.95)*edge;
        gl_FragColor=vec4(light/max(opacity,.01),opacity);
      }`,
  });
  const coreGeometry = new PlaneGeometry(2, 2);
  const core = new Mesh(coreGeometry, coreMaterial);
  scene.add(core);
  const beauty = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const luminous = beauty.clone();
  // Preserve the approved center composition independently of brighter orbital material and supplements.
  const coreReference = beauty.clone();
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 1.1, .25, .3);
  const copyMaterial = new ShaderMaterial({ uniforms: { image: { value: beauty.texture } }, vertexShader: quadVertex,
    fragmentShader: 'uniform sampler2D image; varying vec2 vUv; void main(){gl_FragColor=texture2D(image,vUv);}', depthTest: false, depthWrite: false });
  const copy = new FullScreenQuad(copyMaterial);
  const compositeMaterial = new ShaderMaterial({
    uniforms: { original: { value: beauty.texture }, illuminated: { value: luminous.texture }, viewport: { value: new Vector2(1,1) }, coreRadius: { value: 1 }, baseline: material.uniforms.baseline, coreReference: { value: null }, toneMappingExposure: { value: renderer.toneMappingExposure } },
    vertexShader: quadVertex, depthTest: false, depthWrite: false, toneMapped: false,
    fragmentShader: `#include <tonemapping_pars_fragment>
      uniform sampler2D original; uniform sampler2D illuminated; uniform sampler2D coreReference; uniform bool baseline; uniform vec2 viewport; uniform float coreRadius; varying vec2 vUv;
      void main() {
        vec4 base=texture2D(original,vUv);
        vec3 glow=max(vec3(0.0),texture2D(illuminated,vUv).rgb-base.rgb);
        float distanceToCore=length((vUv-vec2(.5,.53))*viewport);
        float orbitalMask=smoothstep(coreRadius*1.05,coreRadius*1.45,distanceToCore);
        float halo=clamp(max(glow.r,max(glow.g,glow.b))*mix(.28,baseline ? .10 : .14,orbitalMask),0.0,.5);
        // Additive HDR alpha may exceed one; coverage must stay bounded without normalizing away accumulated light.
        float coverage=clamp(base.a,0.0,1.0);
        float haloEnvelope=1.0-smoothstep(coreRadius*2.8,coreRadius*3.55,distanceToCore);
        halo*=haloEnvelope;
        float alpha=coverage+halo*(1.0-coverage);
        vec3 color=(base.rgb+glow*mix(.35,baseline ? .12 : .19,orbitalMask))/max(alpha,.001);
        float peak=max(color.r,max(color.g,color.b));
        vec3 orbitalColor=color*(1.0-exp(-peak))/max(peak,.001);
        gl_FragColor=vec4(color,alpha);
        gl_FragColor.rgb=ACESFilmicToneMapping(gl_FragColor.rgb);
        // Preserve the original core and its immediate halo; apply hue retention outside that footprint.
        gl_FragColor.rgb=mix(gl_FragColor.rgb,orbitalColor,orbitalMask);
        if (!baseline) gl_FragColor=mix(texture2D(coreReference,vUv),gl_FragColor,orbitalMask);
        // Bloom must disappear before the transparent window boundary, including during peel/wake.
        if (!baseline) {
          vec2 edgeDistance=min(vUv,vec2(1.0)-vUv)*viewport;
          gl_FragColor.a*=smoothstep(4.0,20.0,min(edgeDistance.x,edgeDistance.y));
        }
        #include <colorspace_fragment>
      }`,
  });
  const composite = new FullScreenQuad(compositeMaterial);
  // Accumulate foreground grains separately, then cover the core without feeding its Bloom.
  const frontMaterial = new ShaderMaterial({
    uniforms: { image: { value: beauty.texture } }, vertexShader: quadVertex,
    transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false, toneMapped: false,
    fragmentShader: `uniform sampler2D image; varying vec2 vUv;
      void main() {
        vec4 light=texture2D(image,vUv);
        if(light.a<.001) discard;
        vec3 color=light.rgb/max(light.a,.001);
        float peak=max(color.r,max(color.g,color.b));
        color*= (1.0-exp(-peak))/max(peak,.001);
        gl_FragColor=vec4(color,min(light.a,.85));
        #include <colorspace_fragment>
      }`,
  });
  const frontComposite = new FullScreenQuad(frontMaterial);
  let lost = false, dead = false, width = 1, height = 1;
  const contextLost = event => { event.preventDefault(); lost = true; onContextChange(); };
  const contextRestored = () => { lost = false; onContextChange(); };
  surface.addEventListener('webglcontextlost', contextLost);
  surface.addEventListener('webglcontextrestored', contextRestored);
  return {
    resize(w, h, dpr) {
      width = w; height = h;
      renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
      beauty.setSize(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
      luminous.setSize(beauty.width, beauty.height); bloom.setSize(beauty.width, beauty.height);
      coreReference.setSize(beauty.width, beauty.height);
      material.uniforms.pixelRatio.value = dpr;
      material.uniforms.viewport.value.set(w,h);
      compositeMaterial.uniforms.viewport.value.set(w,h);
      const radius = Math.min(w * .39, h * .39) * .34;
      core.scale.set(radius / w * 2, radius / h * 2, 1);
      core.position.y = .06;
    },
    render(screenX, screenY, depth, time, opacity, sceneRadius, supplement, orbitalColor, orbitalTreatment) {
      if (lost || dead) return null;
      for (let i = 0; i < count; i++) {
        coordinates[i * 3] = screenX[i] / width * 2 - 1;
        coordinates[i * 3 + 1] = 1 - screenY[i] / height * 2;
        coordinates[i * 3 + 2] = depth[i];
        geometry.attributes.opacity.array[i] = opacity ? opacity[i] : 1;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.opacity.needsUpdate = true;
      const extraCount=Math.min(supplement?.count??0,extraCapacity), attributes=extraGeometry.attributes;
      extraGeometry.setDrawRange(0,extraCount);
      for(let i=0;i<extraCount;i++) {
        attributes.position.array[i*3]=supplement.x[i]/width*2-1;
        attributes.position.array[i*3+1]=1-supplement.y[i]/height*2;
        attributes.position.array[i*3+2]=supplement.depth[i];
        attributes.opacity.array[i]=supplement.opacity[i];
        if(extraGeneration!==supplement.generation) {
          attributes.kind.array[i]=supplement.source[i]%13===0?1:0;
          attributes.seed.array[i]=((i*16807+supplement.source[i]*97)%2147483647)/2147483647;
        }
      }
      if(extraCount) {
        attributes.position.needsUpdate=attributes.opacity.needsUpdate=true;
        if(extraGeneration!==supplement.generation) {
          attributes.kind.needsUpdate=attributes.seed.needsUpdate=true;extraGeneration=supplement.generation;
        }
      }
      material.uniforms.clock.value = time;
      const tint=orbitalColor??[37,173,241], peak=Math.max(1,...tint);
      material.uniforms.orbitalTint.value.set(tint[0]/peak,tint[1]/peak,tint[2]/peak);
      material.uniforms.tintAmount.value=Math.min(1,Math.hypot(tint[0]-37,tint[1]-173,tint[2]-241)/30);
      material.uniforms.tintCoverage.value=orbitalTreatment?.coverage??1;
      material.uniforms.tintEnergy.value=orbitalTreatment?.energy??1;
      const breath = 1 + .018 * Math.sin(time * .9) + .007 * Math.sin(time * 1.7);
      const radius = (sceneRadius ?? Math.min(width * .39, height * .39)) * .34 * breath;
      compositeMaterial.uniforms.coreRadius.value = radius;
      material.uniforms.coreRadius.value = radius;
      material.uniforms.sceneRadius.value = sceneRadius ?? Math.min(width*.39,height*.39);
      core.scale.set(radius / width * 2, radius / height * 2, 1);
      material.uniforms.baseline.value = true;
      // The core reference must not accumulate orbital light projected over the sphere.
      points.visible = false;
      // Keep the approved center-reference pass independent of compact orbital grain sizing.
      material.uniforms.orbitalPointScale.value = 1;
      extraPoints.visible = false;
      compositeMaterial.uniforms.coreReference.value = null;
      renderer.setRenderTarget(beauty); renderer.render(scene, camera);
      renderer.setRenderTarget(luminous); copy.render(renderer);
      bloom.render(renderer, null, luminous, 0, false);
      renderer.setRenderTarget(coreReference); composite.render(renderer);
      material.uniforms.baseline.value = false;
      points.visible = true;
      material.uniforms.orbitalPointScale.value = Math.min(1,(sceneRadius??Math.min(width*.39,height*.39))/202.8);
      extraPoints.visible = true;
      compositeMaterial.uniforms.coreReference.value = coreReference.texture;
      renderer.setRenderTarget(beauty); renderer.render(scene, camera);
      renderer.setRenderTarget(luminous); copy.render(renderer);
      bloom.render(renderer, null, luminous, 0, false);
      renderer.setRenderTarget(null); composite.render(renderer);
      core.visible = corePoints.visible = false;
      material.uniforms.frontOnly.value = true;
      renderer.setRenderTarget(beauty); renderer.render(scene,camera);
      renderer.setRenderTarget(null);
      renderer.autoClear = false; frontComposite.render(renderer); renderer.autoClear = true;
      material.uniforms.frontOnly.value = false;
      core.visible = corePoints.visible = true;
      return surface;
    },
    destroy() {
      if (dead) return;
      dead = true;
      surface.removeEventListener('webglcontextlost', contextLost);
      surface.removeEventListener('webglcontextrestored', contextRestored);
      geometry.dispose(); material.dispose(); coreGeometry.dispose(); coreMaterial.dispose();
      corePointGeometry.dispose(); corePointMaterial.dispose();
      extraGeometry.dispose();
      beauty.dispose(); luminous.dispose(); coreReference.dispose(); bloom.dispose();
      copy.dispose(); composite.dispose(); frontComposite.dispose(); copyMaterial.dispose(); compositeMaterial.dispose(); frontMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
  } catch {
    renderer.dispose(); releaseContext();
    return null;
  }
}
