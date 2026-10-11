// Three.js renderer: terrain, water, sky, features, entity views, particles, beams, shields,
// fog of war, AI threat overlay, strategic icons & HUD overlay (2D canvas on top).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getModel, GLB, missileGeom } from './models.js';
import { CAMO_GLSL } from './camo.js';
import { TEAM_COLORS, TEAM_CSS, STRUCTS, nukeZoneLabel } from './specs.js';
import { HN, HCELL, PN } from './terrain.js';
import { MAP_SIZE, fbm } from './maps.js';
import { RangeView } from './ranges.js';
import { LITE } from './quest.js';
import { Fx } from './fx.js';

const S = MAP_SIZE;
const SCN = 256;                                                  // разрешение карты подпалин (ядерные взрывы затемняют землю)
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const AIM_COL = [0xff3a24, 0xff8a30, 0xffd040], AIM_CSS = ['#ff4a34', '#ff9a40', '#ffd850'], AIM_TAC = [6];   // кольца прицела: полное / тяжёлое / слабое поражение
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
// Freeze an object's local matrix (static parts): three.js then skips recomposing it every frame.
const still = (o) => { o.updateMatrix(); o.matrixAutoUpdate = false; return o; };
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lerpAng = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
export const MIN_DIST = 22, MAX_DIST = 2600;   // zoom limits: the far end shows the whole 2048 map
const PITCH_DIST = 1300;                         // camera pitch reaches top-down at this distance
const grow = (a) => { const b = new Float32Array(a.length * 2); b.set(a); return b; };
// A view root that is hidden costs nothing per frame: three.js would still walk (and recompose) its whole node
// subtree in scene.updateMatrixWorld, so hidden roots skip that too. Showing a root again re-syncs via matrixWorldNeedsUpdate.
const OBJ_UMW = THREE.Object3D.prototype.updateMatrixWorld;
function cullable(root) { root.updateMatrixWorld = function (force) { if (this.visible) OBJ_UMW.call(this, force); }; return root; }

// ------------------------------------------------------------------ shaders
const WATER_VS = `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main(){ vec4 w = modelMatrix*vec4(position,1.0); vWorld=w.xyz; vec4 mvPosition = viewMatrix*w; gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const WATER_FS = `
#include <common>
#include <fog_pars_fragment>
uniform float time, waterLevel, hMin, hRange, fowOn; uniform sampler2D hTex, fowTex;
uniform vec3 sunDir, sunColor, deep, shallow, foam, skyCol;
varying vec3 vWorld;
void main(){
  vec2 uv = vWorld.xz / ${S.toFixed(1)};
  float inside = step(0.0, uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  float th = texture2D(hTex, clamp(uv,0.0,1.0)).r * hRange + hMin;
  float depth = mix(25.0, waterLevel - th, inside);
  vec2 p = vWorld.xz; float t = time;
  vec3 n = normalize(vec3(
    sin(p.x*0.09+t*1.3)*0.07 + sin((p.x+p.y)*0.15-t*1.7)*0.05 + sin(p.y*0.27+t*0.9)*0.03 + sin((p.x*0.7-p.y)*0.45+t*2.3)*0.02,
    1.0,
    cos(p.y*0.08+t*1.1)*0.07 + cos((p.x-p.y)*0.19+t*1.5)*0.05 + cos(p.x*0.31-t*1.2)*0.03 + cos((p.y*0.8+p.x)*0.5-t*2.1)*0.02));
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
  vec3 H = normalize(sunDir + V);
  float spec = pow(max(dot(n, H), 0.0), 220.0) * 2.5;
  vec3 col = mix(shallow, deep, clamp(depth / 10.0, 0.0, 1.0));
  col = mix(col, skyCol, fres * 0.6) + spec * sunColor;
  // foam: a lapping edge line plus swell bands that roll in to the shore (phase falls with depth), broken up by a cheap noise
  float br = sin(p.x * 0.11 + sin(p.y * 0.07) * 2.0) * sin(p.y * 0.13 + sin(p.x * 0.05 + t * 0.2) * 2.0);
  float edge = smoothstep(0.9, 0.0, depth + sin(t * 1.7 + p.x * 0.09 + p.y * 0.06) * 0.25);
  float band = pow(0.5 + 0.5 * sin(depth * 3.2 + t * 1.25 + br * 1.5), 8.0) * smoothstep(3.5, 0.6, depth) * (0.6 + 0.4 * br);
  float f1 = max(edge, band * 0.9);
  col = mix(col, foam, clamp(f1, 0.0, 1.0) * 0.75);
  float alpha = clamp(0.32 + depth * 0.06, 0.32, 0.78);
  if (fowOn > 0.5) col *= mix(1.0, texture2D(fowTex, clamp(uv,0.0,1.0)).r, inside);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`;
const SKY_FS = `uniform vec3 top, horizon, sunCol; uniform vec3 sunDir; varying vec3 vDir;
void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, pow(max(h,0.0), 0.55));
  float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SHIELD_VS = `varying vec3 vN; varying vec3 vV; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w; }`;
const SHIELD_FS = `uniform vec3 color; uniform float strength, flash, time; varying vec3 vN; varying vec3 vV;
void main(){ float f = pow(1.0-abs(dot(vN,vV)), 2.5); float hex = 0.5+0.5*sin(vN.x*40.0+time*2.0)*sin(vN.y*40.0-time*1.5)*sin(vN.z*40.0);
  float a = (f*0.75 + 0.06 + hex*0.05) * strength + flash*0.5; gl_FragColor = vec4(color*(1.0+flash*2.0), a); }`;

// ------------------------------------------------------------------ renderer
// Tileable value noise (3 octaves, periodic lattice) for drifting cloud shadows on the terrain.
function cloudTexture(N = 128) {
  const lat = (g) => { const a = new Float32Array(g * g); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a; };
  const oct = [[4, 0.55, lat(4)], [8, 0.3, lat(8)], [16, 0.15, lat(16)]], d = new Uint8Array(N * N);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let v = 0;
    for (const [g, w, L] of oct) {
      const x = i / N * g, y = j / N * g, x0 = x | 0, y0 = y | 0, fx = sm(x - x0), fy = sm(y - y0), x1 = (x0 + 1) % g, y1 = (y0 + 1) % g;
      v += w * ((L[y0 * g + x0] * (1 - fx) + L[y0 * g + x1] * fx) * (1 - fy) + (L[y1 * g + x0] * (1 - fx) + L[y1 * g + x1] * fx) * fy);
    }
    d[j * N + i] = v * 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RedFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

export class Renderer {
  constructor(canvas, overlay, settings) {
    this.canvas = canvas; this.overlay = overlay; this.octx = overlay.getContext('2d');
    this.settings = settings;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: !LITE, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.shadowMap.autoUpdate = false;
    this.gl.xr.enabled = true;
    this.vr = null;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 9000);
    this.view = { x: S / 2, y: S / 2, dist: 300, tx: S / 2, ty: S / 2, tdist: 300, shake: 0 };
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3a3528, 0.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.3);
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.matBody = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.5 });
    this.matGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.matWreck = new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 0.95, metalness: 0.3 });
    this.matBuild = new THREE.MeshBasicMaterial({ color: 0x5dffb0, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false });
    this.matSite = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.8, emissive: 0x0a3020 });
    this.teamMats = new Map(); this.camoU = new Map();
    this.matSiteGLB = new THREE.MeshStandardMaterial({ color: 0x8a9a94, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.8, emissive: 0x0a3020 });
    // lit translucent ghosts (form stays readable) + a fainter flat footing under them
    const ghostMat = (c, o) => new THREE.MeshLambertMaterial({ color: c, emissive: new THREE.Color(c).multiplyScalar(0.5), transparent: true, opacity: o, depthWrite: false });
    const footMat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, toneMapped: false });
    this.matGhostOk = ghostMat(0x50ff90, 0.55); this.matGhostBad = ghostMat(0xff4040, 0.55); this.matGhostQueue = ghostMat(0xffe060, 0.38);
    this.matFootOk = footMat(0x50ff90, 0.22); this.matFootBad = footMat(0xff4040, 0.22); this.matFootQueue = footMat(0xffe060, 0.14);
    this.matGhostQueueWire = new THREE.MeshBasicMaterial({ color: 0xffe060, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
    // silhouettes of submerged units, drawn over the water surface
    this.matXray = {}; this.teamColU = new Map();
    for (const t of Object.keys(TEAM_COLORS)) this.matXray[t] = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthTest: false, depthWrite: false, toneMapped: false });
    this.refreshTeamColors();
    this.qGhosts = new Map();
    this.footGeoms = new Map();
    this.windU = { value: 0 };   // shared time uniform: tree sway, cloud shadows
    this.fx = new Fx(this.scene, { lite: LITE });   // js/fx.js: sprite particles, rings, decals, tracers (<= 6 draw calls)
    this.glow = this.fx.glow; this.smoke = this.fx.smoke; this.projPts = this.fx.proj;
    // beams: drawn as fx streaks (js/fx.js), see updateBeams
    this.beamFx = [];
    // selection rings
    const ringG = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringG, new THREE.MeshBasicMaterial({ color: 0x5dff8a, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), 600);
    this.rings.frustumCulled = false; this.rings.renderOrder = 3;
    this.scene.add(this.rings);
    this.shieldMeshes = new Map();
    this.views = new Map();
    this.frameId = 0; this.frustum = new THREE.Frustum(); this._pv = new THREE.Matrix4(); this._sph = new THREE.Sphere();
    this.maxNewViews = 50; this.dl = []; this.dlN = 0; this.dlPos = new Float32Array(3 * 2048); this.dlIcon = []; this.blips = []; this.iconMode = false; this.wreckViews = 0; this.unitScale = 1;
    this.fxScale = 1; this.tmpP = new THREE.Vector3(); this.sx = 0; this.sy = 0; this.metaCache = new Map(); this.colors = new Map();
    this.matRotor = new THREE.MeshBasicMaterial({ color: 0xc8d4dc, transparent: true, opacity: 0.35, depthWrite: false });
    this.perf = { sync: 0, fx: 0, proj: 0, beams: 0, other: 0, gl: 0, overlay: 0, frame: 0 };   // ms per frame (smoothed), see window.__dbg
    this.fxTransient = [];
    this.aimXY = { x: 0, y: 0 }; this.nukeFlash = 0;
    this.missileMeshes = new Map();   // flying missile projectile -> mesh (nukes, interceptors, tactical missiles)
    this.tmpV = new THREE.Vector3(); this.tmpM = new THREE.Matrix4(); this.tmpQ = new THREE.Quaternion(); this.tmpS = new THREE.Vector3();
    this.time = 0;
    this.ghost = null;
    this.ranges = new RangeView();   // attack / defence radius rings on hover, see js/ranges.js
    this.composer = null;
    this.localTeam = 1;
    this.applySettings(settings);
  }

  colorOf(hex) { let c = this.colors.get(hex); if (!c) this.colors.set(hex, c = new THREE.Color(hex)); return c; }

  applySettings(s) {
    this.settings = s;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.pixelRatio));
    this.gl.shadowMap.enabled = !!s.shadows;
    this.sun.castShadow = !!s.shadows;
    this.sun.shadow.mapSize.set(s.shadowRes, s.shadowRes);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.matBody.needsUpdate = true;
    this.resize();
  }

  resize() {
    if (this.gl.xr.isPresenting) return;
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.gl.setSize(w, h, false);
    this.overlay.width = w; this.overlay.height = h;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const pr = this.gl.getPixelRatio();
    const sc = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.fx.setScale(sc);
    if (this.settings.bloom) {
      if (!this.composer) {
        this.composer = new EffectComposer(this.gl);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.5, 0.82);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      }
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    } else if (this.composer) { this.composer.dispose(); this.composer = null; }
  }

  // ---------------------------------------------------------------- map
  loadTerrain(terrain) {
    this.clearWorld();
    this.terrain = terrain;
    const map = terrain.map, pal = map.palette, sky = map.sky;
    const V = HN + 1;
    const st = LITE ? 2 : 1, G = HN / st;   // lite: every 2nd height vertex (4x fewer terrain triangles)
    const geo = new THREE.PlaneGeometry(S, S, G, G);
    geo.rotateX(-Math.PI / 2); geo.translate(S / 2, 0, S / 2);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const water = terrain.water;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getZ(i);
      const h = terrain.h[st === 1 ? i : ((i / (G + 1) | 0) * st) * V + (i % (G + 1)) * st];
      pos.setY(i, h);
      const slope = terrain.slopeAt(x, y);
      const n = fbm(x / 18, y / 18, 5, 3), n2 = fbm(x / 140, y / 140, 9, 3);
      const c = [0, 0, 0];
      const t1 = smooth(16, 34, h + n2 * 8), t2 = smooth(42, 64, h + n2 * 10);
      for (let k = 0; k < 3; k++) {
        let v = lerp(pal.low[k], pal.mid[k], t1);
        v = lerp(v, pal.high[k], t2);
        v = lerp(v, pal.rock[k], smooth(pal.rockSlope * 0.55, pal.rockSlope * 1.15, slope + n * 0.08));
        const snow = smooth(pal.peakH - 6, pal.peakH + 3, h + n * 16 + n2 * 10) * (1 - smooth(0.5, 0.9, slope));
        v = lerp(v, pal.peak[k], snow);
        if (water > -50) {
          v = lerp(v, pal.sand[k], smooth(water + 3.5, water + 0.6, h));
          if (h < water) v = lerp(pal.sand[k], pal.seabed[k], smooth(water - 0.5, water - 6, h)) * (1 - clamp((water - h) / 18) * 0.45);
        }
        c[k] = v * (0.86 + 0.28 * (n * 0.5 + 0.5)) * (0.95 + n2 * 0.1);
      }
      // baked ambient occlusion from local concavity
      const ao = clamp(1 + (terrain.heightAt(x, y) - (terrain.heightAt(x + 12, y) + terrain.heightAt(x - 12, y) + terrain.heightAt(x, y + 12) + terrain.heightAt(x, y - 12)) / 4) * 0.03, 0.72, 1.08);
      cols[i * 3] = Math.pow(c[0] * ao, 2.2); cols[i * 3 + 1] = Math.pow(c[1] * ao, 2.2); cols[i * 3 + 2] = Math.pow(c[2] * ao, 2.2);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    // detail texture
    const dc = document.createElement('canvas'); dc.width = dc.height = 256;
    const dctx = dc.getContext('2d'), img = dctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const v = 200 + 40 * fbm(i / 9, j / 9, 77, 4) + 25 * fbm(i / 2.5, j / 2.5, 91, 2);
      const o = (j * 256 + i) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = clamp(v, 0, 255); img.data[o + 3] = 255;
    }
    dctx.putImageData(img, 0, 0);
    const detail = new THREE.CanvasTexture(dc);
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping; detail.repeat.set(S / 11.4, S / 11.4); detail.anisotropy = 4;
    detail.colorSpace = THREE.NoColorSpace;
    // fog-of-war & AI overlay textures
    this.fowData = new Uint8Array(PN * PN).fill(255);
    this.fowCur = new Float32Array(PN * PN).fill(1);
    this.fowTex = new THREE.DataTexture(this.fowData, PN, PN, THREE.RedFormat);
    this.fowTex.magFilter = THREE.LinearFilter; this.fowTex.minFilter = THREE.LinearFilter; this.fowTex.needsUpdate = true;
    this.scorch = new Uint8Array(SCN * SCN);
    this.scorchTex = new THREE.DataTexture(this.scorch, SCN, SCN, THREE.RedFormat);
    this.scorchTex.magFilter = THREE.LinearFilter; this.scorchTex.minFilter = THREE.LinearFilter; this.scorchTex.needsUpdate = true;
    const ON = S / 32;   // one overlay texel per intel cell
    this.ovData = new Uint8Array(ON * ON * 4);
    this.ovTex = new THREE.DataTexture(this.ovData, ON, ON, THREE.RGBAFormat);
    this.ovTex.magFilter = THREE.LinearFilter; this.ovTex.minFilter = THREE.LinearFilter; this.ovTex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.93, metalness: 0.02 });
    this.terrainUniforms = { fowTex: { value: this.fowTex }, scorchTex: { value: this.scorchTex }, ovTex: { value: this.ovTex }, ovOn: { value: 0 }, gridOn: { value: 0 },
      cloudTex: { value: cloudTexture() }, cloudK: { value: sky.clouds ?? 0.4 }, time: this.windU };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.terrainUniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vMapUv2;\nvarying vec3 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vMapUv2 = vWP.xz / ' + S.toFixed(1) + ';');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D fowTex; uniform sampler2D scorchTex; uniform sampler2D ovTex; uniform float ovOn; uniform float gridOn; uniform sampler2D cloudTex; uniform float cloudK; uniform float time; varying vec2 vMapUv2; varying vec3 vWP;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.04, 0.035), texture2D(scorchTex, vMapUv2).r * 0.92);
          diffuseColor.rgb *= 1.0 - cloudK * smoothstep(0.48, 0.72, texture2D(cloudTex, vWP.xz / 900.0 + vec2(time * 0.0045, time * 0.0021)).r);
          vec4 ov = texture2D(ovTex, vMapUv2);
          diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * ovOn);
          if (gridOn > 0.5) { vec2 gp = abs(fract(vWP.xz / 8.0) - 0.5); float gl = smoothstep(0.47, 0.5, max(gp.x, gp.y)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3,1.0,0.6), gl*0.35); }`)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb *= texture2D(fowTex, vMapUv2).r;\n#include <fog_fragment>');
    };
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = false;
    this.world.add(this.terrainMesh);
    // skirt ground outside the map
    const out = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: new THREE.Color(...pal.low).multiplyScalar(0.25), roughness: 1 }));
    out.position.set(S / 2, terrain.minH - 3, S / 2);
    this.skirt = out;
    this.world.add(out);
    // map border frame
    const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(S, 0, 0), new THREE.Vector3(S, 0, S), new THREE.Vector3(0, 0, S)].map(v => { v.y = terrain.maxH + 2; return v; })), new THREE.LineBasicMaterial({ color: 0x223040, transparent: true, opacity: 0.4 }));
    this.border = border;
    this.world.add(border);
    // water
    if (water > -50) {
      const hData = new Uint8Array(V * V);
      const range = Math.max(1, terrain.maxH - terrain.minH);
      for (let i = 0; i < V * V; i++) hData[i] = Math.round((terrain.h[i] - terrain.minH) / range * 255);
      const hTex = new THREE.DataTexture(hData, V, V, THREE.RedFormat); hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; hTex.needsUpdate = true;
      const wc = map.waterColor || { deep: 0x0b3a5e, shallow: 0x2a8a9a };
      this.waterUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, waterLevel: { value: water }, hMin: { value: terrain.minH }, hRange: { value: range }, hTex: { value: null }, fowTex: { value: null }, fowOn: { value: 1 },
        sunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() }, sunColor: { value: new THREE.Color(sky.sun) },
        deep: { value: new THREE.Color(wc.deep) }, shallow: { value: new THREE.Color(wc.shallow) }, foam: { value: new THREE.Color(0xe8f6ff) }, skyCol: { value: new THREE.Color(sky.horizon) }
      }]);
      this.waterUniforms.hTex.value = hTex; this.waterUniforms.fowTex.value = this.fowTex;
      const wmat = new THREE.ShaderMaterial({ uniforms: this.waterUniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, fog: true, depthWrite: false });
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(S * 5, S * 5, 1, 1).rotateX(-Math.PI / 2), wmat);
      this.water.position.set(S / 2, water, S / 2);
      this.water.renderOrder = 2;
      this.world.add(this.water);
    }
    // sky & light
    const skyU = { top: { value: new THREE.Color(sky.top) }, horizon: { value: new THREE.Color(sky.horizon) }, sunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() }, sunCol: { value: new THREE.Color(sky.sun) } };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 24, 16), new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.sky.renderOrder = -1; this.sky.frustumCulled = false;
    this.world.add(this.sky);
    this.scene.fog = new THREE.Fog(sky.fog, 800, 3000);
    this.scene.background = new THREE.Color(sky.horizon);
    this.sunDir = new THREE.Vector3(...sky.sunDir).normalize();
    this.sun.color.set(sky.sun);
    this.hemi.intensity = sky.ambient;
    this.hemi.color.set(sky.top).lerp(new THREE.Color(0xffffff), 0.5);
    this.hemi.groundColor.set(new THREE.Color(...pal.low));
    this.buildFeatures(terrain);
    this.buildMassDecals(terrain);
  }

  clearWorld() {
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.world = new THREE.Group();
    this.scene.add(this.world);
    for (const v of this.views.values()) this.scene.remove(v.root);
    this.views.clear();
    for (const m of this.shieldMeshes.values()) this.scene.remove(m);
    this.shieldMeshes.clear();
    this.fx.clear(); this.beamFx.length = 0;
    for (const f of this.fxTransient) this.scene.remove(f.mesh);
    this.fxTransient.length = 0;
    for (const m of this.missileMeshes.values()) this.scene.remove(m);
    this.missileMeshes.clear();
    for (const gh of this.qGhosts.values()) this.scene.remove(gh);
    this.qGhosts.clear();
    this.setGhost(null);
  }

  buildFeatures(terrain) {
    const kinds = {};
    for (const f of terrain.features) (kinds[f.type === 'rock' ? 'rock' : f.kind] = kinds[f.type === 'rock' ? 'rock' : f.kind] || []).push(f);
    const pal = terrain.map.palette;
    const colGeo = (g, c) => { g = g.index ? g.toNonIndexed() : g; const n = g.attributes.position.count, a = new Float32Array(n * 3); const cc = new THREE.Color(c); for (let i = 0; i < n; i++) { const k = 0.85 + Math.random() * 0.25; a[i * 3] = cc.r * k; a[i * 3 + 1] = cc.g * k; a[i * 3 + 2] = cc.b * k; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g; };
    const merge = (parts) => {
      const pos = [], col = [], nor = [];
      for (const p of parts) { p.computeVertexNormals(); pos.push(...p.attributes.position.array); col.push(...p.attributes.color.array); nor.push(...p.attributes.normal.array); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); return g;
    };
    const geos = {
      pine: merge([colGeo(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6).translate(0, 1.2, 0), 0x4a3525), colGeo(new THREE.ConeGeometry(2.0, 4.2, 7).translate(0, 3.8, 0), 0x2c4a2a), colGeo(new THREE.ConeGeometry(1.5, 3.2, 7).translate(0, 5.6, 0), 0x335a30)]),
      broadleaf: merge([colGeo(new THREE.CylinderGeometry(0.3, 0.45, 2.6, 6).translate(0, 1.3, 0), 0x503a28), colGeo(new THREE.IcosahedronGeometry(2.3, 0).translate(0, 4.0, 0), 0x3b6a2c), colGeo(new THREE.IcosahedronGeometry(1.6, 0).translate(0.9, 4.9, 0.4), 0x4a7a33)]),
      crystal: merge([colGeo(new THREE.OctahedronGeometry(1.2, 0).scale(0.7, 2.8, 0.7).translate(0, 2.4, 0), 0x8a5cff), colGeo(new THREE.OctahedronGeometry(0.8, 0).scale(0.6, 2.0, 0.6).rotateZ(0.5).translate(0.9, 1.4, 0), 0x5ad0ff)]),
      rock: merge([colGeo(new THREE.DodecahedronGeometry(1.4, 0).scale(1.2, 0.75, 1), new THREE.Color(...pal.rock).multiplyScalar(0.9).getHex())])
    };
    this.featureMeshes = {};
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const [k, list] of Object.entries(kinds)) {
      const mat = k === 'crystal' ? new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0x2a1860, roughness: 0.2, metalness: 0.1 }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
      if (k === 'pine' || k === 'broadleaf') mat.onBeforeCompile = (sh) => {   // wind: the crown sways, the trunk foot stays put; phase per tree
        sh.uniforms.time = this.windU;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float time;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec3 ip = instanceMatrix[3].xyz; float ph = ip.x * 0.071 + ip.z * 0.053;
            float bend = transformed.y * transformed.y * 0.0045;
            transformed.x += (sin(time * 1.3 + ph) * 0.8 + sin(time * 3.1 + ph * 2.7) * 0.25) * bend;
            transformed.z += sin(time * 1.1 + ph * 1.3) * 0.5 * bend;`);
      };
      const im = new THREE.InstancedMesh(geos[k] || geos.pine, mat, list.length);
      im.castShadow = true; im.receiveShadow = true;
      list.forEach((f, i) => {
        q.setFromAxisAngle(up, f.r); sc.setScalar(f.s); p.set(f.x, terrain.heightAt(f.x, f.y) - 0.2, f.y);
        im.setMatrixAt(i, m.compose(p, q, sc)); f._im = im; f._ii = i;
      });
      im.instanceMatrix.needsUpdate = true;
      this.world.add(im); this.featureMeshes[k] = im;
    }
  }
  // Trees between the total-destruction zone (the sim removes those) and the light-damage zone are blown over away from the blast
  // and charred. Render only: the sim keeps them as reclaimable features.
  blastFeatures(t, x, y, Zn) {
    const m = this.tmpM, q = this.tmpQ || (this.tmpQ = new THREE.Quaternion()), q2 = new THREE.Quaternion(), ax = new THREE.Vector3(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const burnt = new THREE.Color(), touched = new Set();
    for (const f of t.featuresNear(x, y, Zn[2])) {
      if (!f.alive || !f._im || f.type === 'rock' || f.kind === 'crystal' || f.blown) continue;
      const dx = f.x - x, dy = f.y - y, d = Math.hypot(dx, dy) || 1, k = d < Zn[1] ? 1 : 1 - (d - Zn[1]) / (Zn[2] - Zn[1]);
      if (k < 0.08) continue;
      f.blown = true;
      ax.set(dy / d, 0, -dx / d);   // up x (dx, 0, dy): rotating up about it tips the crown away from the blast
      q.setFromAxisAngle(ax, Math.min(1.5, k * 1.6 + 0.1) * (0.85 + Math.random() * 0.2)).multiply(q2.setFromAxisAngle(up, f.r));
      p.set(f.x, t.heightAt(f.x, f.y) - 0.2, f.y); sc.setScalar(f.s);
      f._im.setMatrixAt(f._ii, m.compose(p, q, sc));
      f._im.setColorAt(f._ii, burnt.setRGB(1, 1, 1).lerp(new THREE.Color(0.16, 0.13, 0.11), Math.min(1, k * 1.2)));
      touched.add(f._im);
    }
    for (const im of touched) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
  }
  hideFeature(f) {
    if (!f._im) return;
    f._im.setMatrixAt(f._ii, ZERO_M);
    f._im.instanceMatrix.needsUpdate = true;
  }

  buildMassDecals(terrain) {
    const ringG = new THREE.RingGeometry(3.2, 4.2, 24).rotateX(-Math.PI / 2);
    const coreG = new THREE.CircleGeometry(2.6, 20).rotateX(-Math.PI / 2);
    const mr = new THREE.MeshBasicMaterial({ color: 0x3cff78, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false });
    const mc = new THREE.MeshBasicMaterial({ color: 0x1a8a40, transparent: true, opacity: 0.55, depthWrite: false });
    this.massMarks = [];
    for (const d of terrain.mass) {
      const h = terrain.heightAt(d.x, d.y) + 0.3;
      const r = new THREE.Mesh(ringG, mr); r.position.set(d.x, h, d.y); r.renderOrder = 1;
      const c = new THREE.Mesh(coreG, mc); c.position.set(d.x, h - 0.05, d.y); c.renderOrder = 1;
      this.world.add(r, c);
      this.massMarks.push(r);
    }
  }

  // ---------------------------------------------------------------- camera
  updateCamera(dt) {
    const v = this.view, t = this.terrain;
    const k = 1 - Math.pow(0.001, dt);
    v.x = lerp(v.x, v.tx, k); v.y = lerp(v.y, v.ty, k); v.dist = lerp(v.dist, v.tdist, k);
    const z = (v.dist - MIN_DIST) / (PITCH_DIST - MIN_DIST);
    const pitch = THREE.MathUtils.degToRad(lerp(48, 84, Math.pow(clamp(z), 0.6)));
    const gh = t ? Math.max(t.surfaceAt(v.x, v.y), t.map.water > -50 ? t.water : -1e9) : 0;
    this.camTargetH = lerp(this.camTargetH ?? gh, gh, 0.1);
    let sx = 0, sy = 0;
    if (v.shake > 0) { sx = (Math.random() - 0.5) * v.shake; sy = (Math.random() - 0.5) * v.shake; v.shake *= Math.pow(0.02, dt); if (v.shake < 0.05) v.shake = 0; }
    const cp = this.camera.position;
    cp.set(v.x + sx, this.camTargetH + Math.sin(pitch) * v.dist + sy, v.y + Math.cos(pitch) * v.dist);
    if (t) { const minY = t.surfaceAt(cp.x, cp.z) + 6; if (cp.y < minY) cp.y = minY; }
    this.camera.lookAt(v.x + sx, this.camTargetH, v.y);
    this.camera.near = Math.max(0.5, v.dist * 0.02); this.camera.far = 9000; this.camera.updateProjectionMatrix();
    if (this.scene.fog) { this.scene.fog.near = v.dist * 1.6 + 200; this.scene.fog.far = v.dist * 4 + 1400; }
    if (this.sky) this.sky.position.copy(cp);
    // sun & shadow frustum follow the camera target
    const ext = clamp(v.dist * 0.95, 60, 420);
    const sd = this.sunDir || new THREE.Vector3(0.4, 0.8, 0.3);
    this.sun.position.set(v.x + sd.x * 600, this.camTargetH + sd.y * 600, v.y + sd.z * 600);
    this.sun.target.position.set(v.x, this.camTargetH, v.y);
    const sc = this.sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 10; sc.far = 1400; sc.updateProjectionMatrix();
    this.sun.castShadow = this.settings.shadows && v.dist < 560;
  }
  zoomAt(sx, sy, factor) {
    const v = this.view;
    const nd = clamp(v.tdist * factor, MIN_DIST, MAX_DIST);
    const p = this.screenToGround(sx, sy);
    if (p && factor < 1) { const f = 1 - nd / v.tdist; v.tx += (p.x - v.tx) * f; v.ty += (p.y - v.ty) * f; }
    else if (factor > 1) { const f = (nd - v.tdist) / (PITCH_DIST - MIN_DIST); v.tx += (S / 2 - v.tx) * clamp(f * 1.3); v.ty += (S / 2 - v.ty) * clamp(f * 1.3); }
    v.tdist = nd;
    this.clampView();
  }
  clampView() { const v = this.view; v.tx = clamp(v.tx, 0, S); v.ty = clamp(v.ty, -80, S + 40); }
  centerOn(x, y, dist) { this.view.tx = x; this.view.ty = y; if (dist) this.view.tdist = dist; }
  pan(dx, dy) { this.view.tx += dx; this.view.ty += dy; this.clampView(); }

  screenToGround(sx, sy) {
    const w = this.overlay.width, h = this.overlay.height, t = this.terrain;
    if (!t) return null;
    const ndc = new THREE.Vector3(sx / w * 2 - 1, -(sy / h) * 2 + 1, 0.5).unproject(this.camera);
    const o = this.camera.position, d = ndc.sub(o).normalize();
    const step = Math.max(0.5, this.view.dist / 300);
    let prev = 0;
    for (let s = 0; s < 6000; s += step) {
      const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s;
      if (y < t.minH - 5 && d.y < 0) break;
      const gh = x >= 0 && z >= 0 && x <= S && z <= S ? t.surfaceAt(x, z) : t.minH;
      if (y <= gh) {
        let a = prev, b = s;
        for (let k = 0; k < 10; k++) { const m = (a + b) / 2; const yy = o.y + d.y * m, xx = o.x + d.x * m, zz = o.z + d.z * m; if (yy <= t.surfaceAt(xx, zz)) b = m; else a = m; }
        return { x: clamp(o.x + d.x * b, 0, S), y: clamp(o.z + d.z * b, 0, S) };
      }
      prev = s;
    }
    // fallback: intersect with water/min plane
    const py = t.minH; const s2 = (py - o.y) / d.y;
    return s2 > 0 ? { x: clamp(o.x + d.x * s2, 0, S), y: clamp(o.z + d.z * s2, 0, S) } : null;
  }
  project(x, y, z) {
    const v = this.tmpV.set(x, z, y).project(this.camera);
    return { x: (v.x + 1) / 2 * this.overlay.width, y: (1 - v.y) / 2 * this.overlay.height, ok: v.z < 1 && v.z > -1 };
  }

  // ---------------------------------------------------------------- entity views
  makeView(e, game) {
    const s = e.spec;
    const underConstruction = e.kind === 'struct' && !e.built;
    const model = getModel(e.kind === 'wreck' ? e.model : s.model, TEAM_COLORS[e.team] || 0x888888);
    const g = model.geoms, meta = model.meta;
    const glb = GLB[e.kind === 'wreck' ? e.model : s.model];
    if (glb) return this.makeGLBView(e, glb, meta, underConstruction);
    const root = cullable(new THREE.Group());
    const v = { root, key: e.key, built: e.built, turrets: [], legs: null, rotors: [], spin: null, phase: Math.random() * 6, kind: e.kind, meta };
    const bodyMat = e.kind === 'wreck' ? this.matWreck : underConstruction ? this.matSite : this.matBody;
    if (g.body) { const m = new THREE.Mesh(g.body, bodyMat); m.castShadow = true; m.receiveShadow = true; if (!underConstruction) still(m); root.add(m); v.body = m; }
    if (underConstruction && g.body) { const w = new THREE.Mesh(g.body, this.matBuild); root.add(w); v.wire = w; }
    if (g.glow && e.kind !== 'wreck') root.add(still(new THREE.Mesh(g.glow, this.matGlow)));
    (meta.turrets || []).forEach((t, i) => {
      const piv = new THREE.Group(); piv.position.set(...t.pos);
      if (g['t' + i]) piv.add(still(new THREE.Mesh(g['t' + i], bodyMat)));
      if (g['glowt' + i] && e.kind !== 'wreck') piv.add(still(new THREE.Mesh(g['glowt' + i], this.matGlow)));
      root.add(piv); v.turrets[i] = piv;
    });
    // silo doors / rising missile: pivots driven by Structure.doorOpen (see placeView)
    if (meta.hatches && e.kind === 'struct' && !underConstruction) {
      v.hatches = meta.hatches.map((h, i) => {
        const piv = new THREE.Group(); piv.position.set(...h.pos);
        if (g['h' + i]) { const m = new THREE.Mesh(g['h' + i], bodyMat); m.castShadow = true; piv.add(still(m)); }
        root.add(piv);
        return { piv, ...h, y0: h.pos[1] };
      });
    }
    if (meta.legs && g.legL) {
      v.legs = [];
      for (const [k, side] of [['legL', -1], ['legR', 1]]) {
        const piv = new THREE.Group(); piv.position.set(0, meta.legs.hipY, side * meta.legs.spread);
        piv.add(still(new THREE.Mesh(g[k], bodyMat))); root.add(piv); v.legs.push(piv);
      }
    }
    (meta.rotors || []).forEach((p, i) => { if (!g['rotor' + i]) return; const m = new THREE.Mesh(g['rotor' + i], this.matRotor); m.position.set(...p); root.add(m); v.rotors.push(m); });
    if (meta.spin && g.spin) { const m = new THREE.Mesh(g.spin, bodyMat); m.position.set(...meta.spin[0]); root.add(m); v.spin = m; }
    if (e.kind === 'wreck') { root.rotation.z = (Math.random() - 0.5) * 0.3; root.scale.y = 0.6; }
    if (e.kind === 'unit' && g.body && (s.move === 'amph' || s.sub)) {
      v.xray = new THREE.Mesh(g.body, this.matXray[e.team] || this.matXray[1]);
      v.xray.renderOrder = 3; v.xray.visible = false; root.add(v.xray);
    }
    root.rotation.order = 'YZX';
    this.scene.add(root);
    return v;
  }

  // Blender-модель (tools/blender, контракт узлов — docs/MODELS.md 0.4): командные материалы перекрашиваются,
  // turretN/pitchN/barrelN/rotorN/propN/spin двигает игра, клипы Idle/Walk/Build/Fire/Work/Deploy смешиваются по состоянию.
  makeGLBView(e, glb, meta, site) {
    const s = e.spec, model = glb.scene.clone();
    const wreck = e.kind === 'wreck', xray = e.kind === 'unit' && (s.move === 'amph' || s.sub) && (this.matXray[e.team] || this.matXray[1]);
    const meshes = [], xrays = [];
    const v = { root: null, key: e.key, built: e.built, turrets: [], legs: null, rotors: [], spin: null, phase: 0, kind: e.kind, meta, xrays,
      emitter: null, aim: null, T: {}, P: {}, B: {}, M: {}, spinners: [], walkLen: 6, cd: [], recoil: {}, yaw: {}, pitch: {} };
    model.traverse(o => o.isMesh && meshes.push(o));
    for (const o of meshes) {
      o.castShadow = o.receiveShadow = !site;
      const m = o.material;
      if (wreck) o.material = this.matWreck;
      else if (site) { o.material = this.matSiteGLB; o.add(new THREE.Mesh(o.geometry, this.matBuild)); }
      else o.material = this.teamMaterial(m, e.team, e.kind === 'unit' ? 'unit' : 'struct');
      if (xray) { const x = new THREE.Mesh(o.geometry, xray); x.renderOrder = 3; x.visible = false; o.add(x); xrays.push(x); }
    }
    const root = cullable(new THREE.Group()); root.add(model); root.rotation.order = 'YZX';
    if (wreck) { root.rotation.z = (Math.random() - 0.5) * 0.3; model.scale.y = 0.6; }
    if (site) v.body = model;
    v.root = root; this.scene.add(root);
    if (wreck || site) return v;
    // узлы контракта; ось вращения переводится из пространства модели в локальное пространство узла
    model.updateMatrixWorld(true);
    const q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), SIDE = new THREE.Vector3(0, 0, 1), FWD = new THREE.Vector3(1, 0, 0);
    const axis = (o, A) => A.clone().applyQuaternion(o.getWorldQuaternion(q).invert());
    const add = (map, n, x) => (map[n] = map[n] || []).push(x);
    model.traverse(o => {
      if (o.userData.walk) v.walkLen = o.userData.walk;
      if (o.userData.deploy0) v.deploy0 = o.userData.deploy0;
      const m = /^(turret|pitch|barrel|muzzle)(\d+)(?:_\d+)?$/.exec(o.name);
      if (m) {
        const n = +m[2];
        if (m[1] === 'turret') add(v.T, n, { o, q0: o.quaternion.clone(), ax: axis(o, UP) });
        else if (m[1] === 'pitch') add(v.P, n, { o, q0: o.quaternion.clone(), ax: axis(o, SIDE) });
        else if (m[1] === 'barrel') add(v.B, n, { o, p0: o.position.clone(), d: FWD.clone().negate().applyQuaternion(o.parent.getWorldQuaternion(q).invert()) });
        else add(v.M, n, o);
      } else if (/^(rotor|prop)\d+$/.test(o.name) || o.name === 'spin')
        v.spinners.push({ o, q0: o.quaternion.clone(), ax: axis(o, o.name[0] === 'p' ? FWD : UP), w: o.name[0] === 'r' ? 30 : o.name[0] === 'p' ? 25 : 1.5, a: Math.random() * 6 });
      else if (o.name === 'emitter') v.emitter = o;
      else if (/^missile\d$/.test(o.name)) (v.missiles = v.missiles || [])[+o.name[7]] = o;      // ракеты в шахте: видны, пока есть запас
      else if (o.name === 'aim') { v.aim = o; v.aim0 = o.quaternion.clone(); v.aimAxis = axis(o, UP); v.aimYaw = 0; }
    });
    v.recoilLen = Math.min(1.2, (s.radius || 2) * 0.12);
    const mixer = new THREE.AnimationMixer(model), act = {};
    for (const c of glb.animations) act[c.name] = mixer.clipAction(c);
    act.Idle?.play(); act.Work?.play();
    for (const k of ['Walk', 'Build']) act[k]?.setEffectiveWeight(0).play();
    if (act.Fire) { act.Fire.setLoop(THREE.LoopOnce); act.Fire.clampWhenFinished = false; }
    if (act.Deploy) { act.Deploy.setLoop(THREE.LoopOnce); act.Deploy.clampWhenFinished = true; }
    if (act.Open) { act.Open.setLoop(THREE.LoopOnce); act.Open.clampWhenFinished = true; act.Open.play(); act.Open.paused = true; }   // время ведёт doorOpen
    Object.assign(v, { mixer, act, walkW: 0, buildW: 0 });
    return v;
  }

  /** Подхватить TEAM_COLORS после specs.setTeamColor: uniform-ы цвета команды (общие для всех материалов) и силуэты подводных юнитов обновляются на месте. */
  refreshTeamColors() {
    for (const [t, m] of Object.entries(this.matXray)) m.color.set(TEAM_COLORS[t]).lerp(new THREE.Color(0xbfefff), 0.35);
    for (const [t, u] of this.teamColU) u.value.set(TEAM_COLORS[t] || 0x888888);
  }

  // uniform-ы камуфляжа для (вид, команда); camoScale — пятен на единицу мира (2,5 м): у техники узор мельче, чем у зданий: общие для всех клонов материала, меняются на лету через setCamo; по умолчанию узор 'team' (режим 0)
  camoUniforms(kind, team) {
    const k = kind + ':' + team;
    let u = this.camoU.get(k);
    if (!u) this.camoU.set(k, u = { camoMode: { value: 0 }, camoScale: { value: kind === 'struct' ? 0.3 : 1.6 }, camoA: { value: new THREE.Color() }, camoB: { value: new THREE.Color() }, camoC: { value: new THREE.Color() }, camoD: { value: new THREE.Color() } });
    return u;
  }
  /** Камуфляж команды: kind 'unit' | 'struct', look = camoLook(...) из camo.js. */
  setCamo(kind, team, look) {
    const u = this.camoUniforms(kind, team);
    u.camoMode.value = look.mode;
    look.cols.forEach((c, i) => u['camo' + 'ABCD'[i]].value.copy(c));
  }

  // материал атласа, тонированный в цвет команды по маске в канале R текстуры ORM (0 — team, 0.5 — team_dark, 1 — как есть);
  // при камуфляже: team → узор, серая броня (mask 1, низкая насыщенность) → узор, team_dark → чистый цвет команды
  teamMaterial(m, team, kind = 'unit') {
    const key = m.uuid + ':' + team + ':' + kind;
    let c = this.teamMats.get(key);
    if (c) return c;
    c = m.clone();
    let tc = this.teamColU.get(team); if (!tc) this.teamColU.set(team, tc = { value: new THREE.Color(TEAM_COLORS[team] || 0x888888) });
    const u = { teamColor: tc, ...this.camoUniforms(kind, team) };
    c.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'varying vec3 vCamoPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamoPos = position;');   // позиция в пространстве модели (UV фрагментированы)
      sh.fragmentShader = 'uniform vec3 teamColor;\n' + CAMO_GLSL + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_METALNESSMAP
  float teamMask = texture2D(metalnessMap, vMetalnessMapUv).r;
  vec3 baked = diffuseColor.rgb;
  diffuseColor.rgb *= mix(teamColor * (teamMask < 0.25 ? 1.0 : 0.55), vec3(1.0), step(0.75, teamMask));
  if (camoMode > 0.5) {
    float L = dot(baked, vec3(0.2126, 0.7152, 0.0722)), mx = max(baked.r, max(baked.g, baked.b)), sat = (mx - min(baked.r, min(baked.g, baked.b))) / (mx + 1e-4);
    float hull = 1.0 - smoothstep(0.15, 0.35, teamMask), hi = smoothstep(0.65, 0.85, teamMask), mid = (1.0 - hull) * (1.0 - hi);
    float arm = hi * smoothstep(0.012, 0.03, L) * (1.0 - smoothstep(0.32, 0.45, L)) * (1.0 - smoothstep(0.15, 0.3, sat));   // grey armour only: not rubber, white or hazard
    float det = mix(1.0, clamp(L / mix(0.1, 0.3, hull), 0.2, 1.3), 0.35);                                                  // keep a little baked detail / AO
    diffuseColor.rgb = mix(mix(diffuseColor.rgb, camoColor(vCamoPos) * det, max(hull, arm)), teamColor * det, mid);
  }
#endif`);
    };
    c.customProgramCacheKey = () => 'teamTint';
    this.teamMats.set(key, c);
    return c;
  }

  animGLB(e, v, dt) {
    const a = v.act, sp = e.speed || 0, k = Math.min(1, dt * 6), Q = this.tmpQ;
    const rotate = (n, ang) => n.o.quaternion.copy(n.q0).multiply(Q.setFromAxisAngle(n.ax, ang));
    if (e.kind === 'unit') {
      v.walkW = lerp(v.walkW, sp > 0.3 ? 1 : 0, k);
      a.Walk?.setEffectiveWeight(v.walkW); if (a.Walk) a.Walk.timeScale = Math.max(0.4, sp / v.walkLen * a.Walk.getClip().duration);
      a.Idle?.setEffectiveWeight(1 - v.walkW);
    }
    v.buildW = lerp(v.buildW, (e.kind === 'unit' ? e.beam : e.building) ? 1 : 0, k); a.Build?.setEffectiveWeight(v.buildW);
    if (a.Deploy) {                                               // сошники/опоры: вниз, пока стоим с целью
      const on = sp < 0.3 && e.weapons.some(w => w.target);
      if (on !== v.deployOn) { v.deployOn = on; a.Deploy.timeScale = on ? 1 : -1; a.Deploy.paused = false; a.Deploy.play(); }
    }
    if (a.Open) {                                                 // шахты: створки раскрываются вперёд при пуске / перехвате и назад при закрытии
      const o = clamp(e.doorOpen || 0), own = !this.localTeam || e.team === this.localTeam;   // (клип прокручивается по состоянию дверей симуляции)
      a.Open.time = o * a.Open.getClip().duration;
      if (v.missiles) v.missiles.forEach((m, i) => { m.visible = !!(e.silo && (e.silo.stock > i || (i === 0 && e.launch)) && (own || o > 0.05)); });
    }
    if (e.beam && !e.weapons.length) {                            // сборщики: стрелы поворачиваются к цели луча
      const ang = -(Math.atan2(e.beam.y - e.y, e.beam.x - e.x) - e.yaw);
      for (const n of Object.values(v.T).flat()) { n.cur = lerpAng(n.cur || 0, ang, k * 0.5); rotate(n, n.cur); }
    }
    for (const ws of e.weapons) {
      const i = ws.w.turret, wi = ws.i;
      if (ws.cd > (v.cd[wi] ?? 0) + 0.05) {                       // выстрел: откат ствола, клип Fire
        if (wi === 0) a.Fire?.reset().play();
        (v.B[i] || []).forEach((n, j) => { v.recoil[i + ':' + j] = 1; });   // залп — все стволы разом
      }
      v.cd[wi] = ws.cd;
      if (wi === 0 && v.aim) { v.aimYaw = lerpAng(v.aimYaw, -ws.yaw, 0.25); v.aim.quaternion.copy(v.aim0).multiply(Q.setFromAxisAngle(v.aimAxis, v.aimYaw)); }
      if (i < 0) continue;
      // без цели модуль юнита «сканирует» — медленно водит по сторонам
      const yaw = -ws.yaw + (ws.target || e.kind !== 'unit' ? 0 : Math.sin(this.time * 0.6 + e.id) * 0.5);
      v.yaw[i] = lerpAng(v.yaw[i] ?? 0, yaw, 0.3);
      for (const n of v.T[i] || []) rotate(n, v.yaw[i]);
      v.pitch[i] = lerp(v.pitch[i] ?? 0, ws.pitch || (ws.target && v.deploy0) || 0, k * 0.5);
      for (const n of v.P[i] || []) rotate(n, v.pitch[i]);
    }
    for (const key in v.recoil) {
      const [i, j] = key.split(':'), n = v.B[i][j], r = v.recoil[key] = Math.max(0, v.recoil[key] - dt * 3);
      n.o.position.copy(n.p0).addScaledVector(n.d, v.recoilLen * r * r);
    }
    if (e.kind === 'unit' || e.built) for (const n of v.spinners) { n.a += dt * n.w; rotate(n, n.a); }
    if (v.mixDt > 0) v.mixer.update(v.mixDt);
  }

  // мировые точки дул оружия wi (muzzleN, muzzleN_1 …) или null, если у модели их нет
  muzzlesAt(id, wi) {
    const ms = this.views.get(id)?.M?.[wi];
    return ms ? ms.map(o => o.getWorldPosition(new THREE.Vector3())) : null;
  }

  // Entity views are created lazily and only for what is on screen: in strategic-icon mode units have no 3D view at all
  // (their icons are drawn by drawOverlay), everything outside the camera frustum is hidden (its subtree is skipped by
  // three.js, see cullable()) and views that stay hidden for a few seconds are dropped. Animation mixers tick only for
  // views placed this frame: the ones nearest to the camera focus every frame, the rest at a quarter of the rate.
  // Also fills this.dl / this.dlPos (world positions of everything that should get an overlay: icon, bar) and this.blips.
  syncViews(game, alpha, dt) {
    const lt = this.localTeam, t = game.terrain, fog = game.opts.fog, frame = ++this.frameId;
    const cam = this.camera; cam.updateMatrixWorld();
    this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this._pv);
    const fr = this.frustum, sph = this._sph;
    const inVR = this.gl.xr.isPresenting;
    const iconMode = this.iconMode = inVR ? false : this.view.dist > this.settings.iconDist;   // XR: per-entity vr.iconFor instead
    const xrIcons = inVR && this.vr, di = this.dlIcon;
    this._alpha = alpha;
    const dl = this.dl, blips = this.blips; blips.length = 0;
    let nd = 0;
    const vx = this.view.x, vy = this.view.y, animR2 = Math.pow(this.view.dist * 0.6 + 60, 2);
    let created = 0, fullAnim = 0, nUnits = 0;
    const MAX_NEW = this.maxNewViews, FULL_ANIM = 140, MAX_WRECK_VIEWS = 220, now = performance.now();
    const hide = (v) => { if (v && v.root.visible) { v.root.visible = false; v.hiddenAt = now; } };
    const lists = [game.structs, game.units, game.wrecks];
    for (let li = 0; li < 3; li++) {
      const arr = lists[li];
      for (let i = 0, n = arr.length; i < n; i++) {
        const e = arr[i];
        if (!e.alive) continue;
        let v = this.views.get(e.id);
        if (v) v.stamp = frame;
        const wreck = e.kind === 'wreck', unit = e.kind === 'unit';
        const visible = e.carried ? false : wreck ? (!fog || !lt || this.fowCur[t.cellIdx(e.x, e.y)] > 0.5) : !lt ? true : e.kind === 'struct' ? game.seenBy(lt, e) : game.visibleTo(lt, e);
        if (!visible) {
          hide(v);
          if (lt && unit && !e.carried && fog && e.rad[lt]) blips.push(e);
          continue;
        }
        if (iconMode && wreck) { hide(v); continue; }
        const h = wreck ? e.z : e.kind === 'struct' ? (e.spec.place === 'water' ? t.water : t.heightAt(e.x, e.y))
          : e.spec.move === 'air' ? t.surfaceAt(e.x, e.y) + e.z : e.spec.move === 'naval' ? t.water : t.heightAt(e.x, e.y);
        const ic = xrIcons ? this.vr.iconFor(e, e.x, h, e.y) : false;   // XR: model too small to see at this distance -> icon (units: instead of the model, buildings: on top of it)
        if (ic && wreck) { hide(v); continue; }
        if ((iconMode || ic) && unit) {
          // strategic zoom: no 3D model, only the icon at the interpolated position (if it is on screen)
          hide(v);
          sph.center.set(e.x, h + 2, e.y); sph.radius = 6;
          if (!fr.intersectsSphere(sph)) continue;
          const o = nd * 3; if (o + 3 > this.dlPos.length) this.dlPos = grow(this.dlPos);
          this.dlPos[o] = lerp(e.px, e.x, alpha); this.dlPos[o + 1] = h + 1; this.dlPos[o + 2] = lerp(e.py, e.y, alpha);
          di[nd] = 1; dl[nd++] = e; nUnits++;
          continue;
        }
        sph.center.set(e.x, h + 2, e.y);
        sph.radius = wreck ? (e.spec.radius || 3) * 1.5 + 4 : e.kind === 'struct' ? e.spec.size * 0.9 + 6 : e.spec.radius * 1.8 + (e.spec.move === 'air' ? 14 : 6);
        if (!fr.intersectsSphere(sph)) { hide(v); continue; }
        if (v && (v.key !== e.key || v.built !== e.built)) { this.scene.remove(v.root); this.views.delete(e.id); v = null; }
        if (!v) {
          if (wreck ? this.wreckViews >= MAX_WRECK_VIEWS : (e.kind !== 'struct' && created >= MAX_NEW)) continue;
          v = this.makeView(e, game); v.stamp = frame; this.views.set(e.id, v); created++;
          if (wreck) this.wreckViews++;
        }
        v.root.visible = true;
        let mix = true, mdt = dt;
        if (unit) {
          nUnits++;
          const dx = e.x - vx, dy = e.y - vy;
          if (dx * dx + dy * dy < animR2 && fullAnim < FULL_ANIM) fullAnim++;
          else { v.slowAcc = (v.slowAcc || 0) + dt; mix = ((frame + e.id) & 3) === 0; if (mix) { mdt = v.slowAcc; v.slowAcc = 0; } }
        }
        v.mixDt = mix ? mdt : 0;
        this.placeView(e, v, game, alpha, dt);
        if (e.kind !== 'wreck' && e.hp < e.maxHp * 0.5 && e.hp > 0) {   // smoke / fire from damaged units and buildings
          const ratio = e.hp / e.maxHp, rate = (1.5 + (1 - ratio * 2) * 3) * (e.kind === 'struct' ? 1.5 : 1) * this.fxScale * (this.fx.lite ? 0.5 : 1);
          if (Math.random() < rate * dt) { const p = v.root.position, big = e.kind === 'struct', sz = Math.min(5, (e.spec.radius || 2) * (big ? 0.5 : 0.6)); this.fx.damaged(p.x, p.y + (e.spec.radius || 2) * 0.6, p.z, Math.max(1, sz), ratio, big); }
        }
        // VR table: real-size models are ~1-2 mm, so units / buildings are enlarged (vr.updateDolly sets unitScale)
        const us = wreck ? 1 : unit ? this.unitScale : 1 + (this.unitScale - 1) * 0.3;
        if (v.us !== us) { v.us = us; v.root.scale.setScalar(us); if (!v.root.matrixAutoUpdate) v.root.updateMatrix(); }
        if (!wreck) {
          const o = nd * 3; if (o + 3 > this.dlPos.length) this.dlPos = grow(this.dlPos);
          const p = v.root.position; this.dlPos[o] = p.x; this.dlPos[o + 1] = p.y; this.dlPos[o + 2] = p.z;
          di[nd] = ic ? 1 : 0; dl[nd++] = e;
        }
      }
    }
    dl.length = nd; di.length = nd; this.dlN = nd;
    this.fxScale = clamp(450 / Math.max(450, nUnits), 0.2, 1);
    // sweep: views of dead entities, and views that have been hidden for a while (bounded scene, bounded memory)
    let wr = 0;
    for (const [id, v] of this.views) {
      if (v.stamp !== frame || (!v.root.visible && now - (v.hiddenAt ?? now) > (v.kind === 'struct' ? 25000 : 4000))) { this.scene.remove(v.root); this.views.delete(id); continue; }
      if (v.kind === 'wreck') wr++;
    }
    this.wreckViews = wr;
  }

  // World position of an entity (x, up, z) whether or not it has a view: the view's root when placed, else the interpolated sim state.
  entityPos(e, out = this.tmpP) {
    const v = this.views.get(e.id);
    if (v && v.root.visible) return out.copy(v.root.position);
    const t = this.terrain, a = this._alpha ?? 1;
    if (e.kind === 'wreck') return out.set(e.x, e.z, e.y);
    if (e.kind === 'struct') return out.set(e.x, e.spec.place === 'water' ? t.water : t.heightAt(e.x, e.y) - 0.3, e.y);
    const x = lerp(e.px, e.x, a), y = lerp(e.py, e.y, a), s = e.spec;
    const h = s.move === 'air' ? t.surfaceAt(x, y) + lerp(e.pz, e.z, a) : s.move === 'naval' ? (s.sub ? t.water - 1.6 : t.water - 0.35) : s.move === 'hover' ? t.surfaceAt(x, y) : t.heightAt(x, y);
    return out.set(x, h, y);
  }
  // Model height for label / pick offsets (from the view when there is one, else from the cached model meta).
  metaHeight(e) {
    const v = this.views.get(e.id);
    if (v) return v.meta.height || 0;
    const key = e.kind === 'wreck' ? e.model : e.spec.model;
    let m = this.metaCache.get(key);
    if (m === undefined) { m = getModel(key, TEAM_COLORS[1]).meta.height || 0; this.metaCache.set(key, m); }
    return m;
  }
  // Allocation-free projection for hot loops: world (x, up, z) -> this.sx / this.sy (px); false when behind the camera / clipped.
  projTo(x, y, z) {
    const m = this.camera.matrixWorldInverse.elements, p = this.camera.projectionMatrix.elements;
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12], vy = m[1] * x + m[5] * y + m[9] * z + m[13], vz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const w = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (!(w > 1e-6)) return false;
    const cx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w, cy = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w, cz = (p[2] * vx + p[6] * vy + p[10] * vz + p[14]) / w;
    this.sx = (cx + 1) / 2 * this.overlay.width; this.sy = (1 - cy) / 2 * this.overlay.height;
    return cz < 1 && cz > -1;
  }

  placeView(e, v, game, alpha, dt) {
    const t = game.terrain, root = v.root;
    if (e.kind === 'wreck') { if (root.matrixAutoUpdate) { root.position.set(e.x, e.z, e.y); root.rotation.y = -e.yaw; still(root); } return; }
    if (e.kind === 'struct') {
      if (root.matrixAutoUpdate) { root.rotation.y = -e.yaw; still(root, root.position.set(e.x, e.spec.place === 'water' ? t.water - (v.meta.floats ? 0.3 : 1.2) : t.heightAt(e.x, e.y) - 0.3, e.y)); }
      if (!e.built && v.body) { const p = Math.max(0.04, e.progress); v.body.scale.y = p; }
      if (v.mixer) this.animGLB(e, v, dt);
      for (let i = 0; i < v.turrets.length; i++) { const ws = e.weapons[i]; if (ws) v.turrets[i].rotation.y = -ws.yaw; }
      if (v.hatches) {
        const o = e.doorOpen || 0, own = !this.localTeam || e.team === this.localTeam;
        for (const h of v.hatches) {
          if (h.lift) { h.piv.position.y = h.y0 + h.lift * o; h.piv.visible = !!(e.silo && (e.silo.stock > 0 || e.launch) && (own || o > 0.05)); }
          else h.piv.rotation[h.axis] = h.open * o;
        }
      }
      if (v.spin && e.built) v.spin.rotation.y += dt * (e.key === 'radar' ? 1.2 : 2.5);
      return;
    }
    const s = e.spec;
    const x = lerp(e.px, e.x, alpha), y = lerp(e.py, e.y, alpha), yaw = lerpAng(e.pyaw, e.yaw, alpha);
    let h;
    if (s.move === 'air') h = t.surfaceAt(x, y) + lerp(e.pz, e.z, alpha) + Math.sin(this.time * 2 + e.id) * (s.quad ? 0.08 : 0.3);
    else if (s.move === 'naval') h = (s.sub ? t.water - 1.6 : t.water - 0.35) + Math.sin(this.time * 1.5 + e.id) * 0.12;
    else if (s.move === 'hover') h = t.surfaceAt(x, y);
    else h = t.heightAt(x, y);
    if (v.meta.bob) h += Math.abs(Math.sin(v.phase * 2)) * v.meta.bob * clamp((e.speed || 0) / s.speed * 2);
    root.position.set(x, h, y);
    const under = s.sub || t.water - h > (v.meta.height || 2) * 0.55;
    if (v.xray) v.xray.visible = under;
    if (v.xrays) for (const x of v.xrays) x.visible = under;
    // clips, turret aim and terrain tilt refresh only when syncViews scheduled this view (every frame for the ones near the
    // camera focus, every 4th for the rest); position and heading are always exact
    const tick = v.mixDt > 0;
    if (tick && v.mixer) this.animGLB(e, v, v.mixDt);
    if (v.meta.bob && !v.legs) v.phase += dt * (e.speed || 0) * 0.5;
    if (tick || v.rx === undefined) {
      if (s.move === 'land' || s.move === 'amph') {
        const ge = HCELL, gx = (t.heightAt(x + ge, y) - t.heightAt(x - ge, y)) / (2 * ge), gy = (t.heightAt(x, y + ge) - t.heightAt(x, y - ge)) / (2 * ge);
        const fx = Math.cos(yaw), fy = Math.sin(yaw);
        v.rz = Math.atan(gx * fx + gy * fy);
        v.rx = -Math.atan(-gx * fy + gy * fx);
      } else if (s.move === 'air') { v.rx = clamp(e.bank || 0, -0.8, 0.8); v.rz = -(e.pitch || 0); }   // pitch > 0 — нос вниз (модель смотрит в +X, порядок YZX)
      else { v.rx = Math.sin(this.time * 1.2 + e.id) * 0.03; v.rz = Math.sin(this.time + e.id) * 0.02; }
    }
    root.rotation.set(v.rx, -yaw, v.rz);
    for (let i = 0; i < v.turrets.length; i++) { const ws = e.weapons[i] || e.weapons[0]; if (ws) v.turrets[i].rotation.y = lerp(v.turrets[i].rotation.y, -ws.yaw, 0.35); }
    if (v.legs) {
      const sp = e.speed || 0;
      v.phase += dt * sp * (2.2 / Math.max(1, s.radius));
      const a = Math.sin(v.phase) * v.meta.legs.stride * clamp(sp / s.speed * 1.5);
      v.legs[0].rotation.z = a; v.legs[1].rotation.z = -a;
    }
    for (const r of v.rotors) r.rotation.y += dt * 40;
    // engine trails for aircraft & wakes for ships
    if (s.move === 'air' && Math.random() < 0.35 * this.fxScale && (this.settings.particles > 0)) {
      const bx = x - Math.cos(yaw) * s.radius, by = y - Math.sin(yaw) * s.radius;
      this.glow.emit(bx, h, by, 0, 0, 0, s.radius * 0.9, 0.18, 1, 0.6, 0.25, { alpha: 0.7 });
    } else if (s.move === 'naval' && !s.sub && e.speed > 1 && Math.random() < 0.4 * this.fxScale) {
      this.fx.wake(x - Math.cos(yaw) * s.radius * 1.2, t.water, y - Math.sin(yaw) * s.radius * 1.2, s.radius);
    }
  }

  // ---------------------------------------------------------------- effects
  consumeFx(game, audio) {
    const pq = this.settings.particles; // 0 low, 1 med, 2 high
    this.fx.exN = 0;
    const mul = [0.35, 0.7, 1][pq] ?? 1;
    const n = (k) => Math.max(1, Math.round(k * mul));
    const t = game.terrain;
    // Big battles emit thousands of events per frame: small ones (muzzle flash, hit, miss) are dropped when far from the
    // camera, in strategic zoom, and thinned to a per-frame budget; explosions / nukes / warps always go through.
    const vw = this.view, farR = vw.dist * 1.8 + 250, farR2 = farR * farR;
    let smallSeen = 0; for (const f of game.fx) if (f.type === 'muzzle' || f.type === 'hit' || f.type === 'miss') smallSeen++;
    const keepSmall = this.iconMode ? 0 : Math.min(1, 220 / Math.max(1, smallSeen));
    for (const f of game.fx) {
      if (this.localTeam && game.opts.fog && f.x !== undefined && f.type !== 'nuke') {
        if (this.fowCur[t.cellIdx(f.x, f.y)] < 0.9 && f.type !== 'feature') continue;
      }
      const small = f.type === 'muzzle' || f.type === 'hit' || f.type === 'miss';
      if (small && (keepSmall < 1 && Math.random() > keepSmall || (f.x - vw.x) * (f.x - vw.x) + (f.y - vw.y) * (f.y - vw.y) > farR2)) continue;
      const X = f.x, Y = f.y, Z = f.z;
      switch (f.type) {
        case 'muzzle': {
          const c = this.colorOf(f.color || 0xffc070);
          // из дул модели (узлы muzzleN), иначе — из приблизительной точки симуляции
          for (const p of this.muzzlesAt(f.src, f.wi) || [{ x: X, y: Z, z: Y }]) this.fx.muzzle(p.x, p.y, p.z, f.size, c, mul);
          break;
        }
        case 'hit': {
          const c = this.colorOf(f.color || 0xffc070);
          this.fx.hit(X, Z, Y, c, mul);
          break;
        }
        case 'miss': {
          this.fx.miss(X, Z, Y, f.water, mul);
          break;
        }
        case 'explode': {
          this.fx.explosion(X, Z, Y, Math.max(1.5, f.size), { air: f.air, water: f.water, struct: f.struct, oc: f.oc, waterY: t.water, groundY: t.heightAt(X, Y) }, mul);
          if (f.burst) { this.addFlash(X, Z, Y, 13, 0.6); this.addShock(X, Z, Y, 44, 1.2, 0xa8ffff, 0.9); }
          break;
        }
        case 'beam': if (this.beamFx.length < 400) this.beamFx.push({ x: X, y: Y, z: Z, tx: f.tx, ty: f.ty, tz: f.tz, c: this.colorOf(f.color), life: 0.14, w: f.w }); this.glow.emit(f.tx, f.tz, f.ty, 0, 0, 0, 3, 0.12, 0.6, 0.9, 1); break;
        case 'launch': {
          // silo blast-off: fire and a column of smoke around the collar
          this.addShock(X, Z - 1, Y, f.size * 1.6, 1.0, 0xffc890);
          this.addFlash(X, Z + 4, Y, 7, 0.5);
          for (let i = 0; i < n(50); i++) {
            const a = Math.random() * 6.28, sp = 3 + Math.random() * 9, g = 0.55 + Math.random() * 0.25;
            this.smoke.emit(X + Math.cos(a) * 2, Z + Math.random() * 3, Y + Math.sin(a) * 2, Math.cos(a) * sp, 2 + Math.random() * 6, Math.sin(a) * sp, 4 + Math.random() * 3, 3 + Math.random() * 3, g, g, g * 0.97, { grow: 4, alpha: 0.7, drag: 0.96 });
          }
          for (let i = 0; i < n(30); i++) this.glow.emit(X + (Math.random() - 0.5) * 3, Z + 2, Y + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 8, 10 + Math.random() * 30, (Math.random() - 0.5) * 8, 2.5 + Math.random() * 2, 0.6 + Math.random() * 0.6, 1, 0.65, 0.25, { drag: 0.94 });
          this.view.shake = Math.max(this.view.shake, 1.2);
          break;
        }
        case 'nuke': {
          if (f.mega) {
            // strategic warhead, scaled to the blast zones (the effect is tuned for K = 1 ~ 30 units): flash across the map, shock rings out to the
            // outer zone, fireball over the total-destruction zone, stem and cap of the mushroom cloud, dust ring, scorched ground
            const Zn = f.zones, K = Zn[0] / 30, R = Math.random;
            this.addShock(X, Z, Y, Zn[0] * 1.1, 1.6, 0xfff0c0, 0.9); this.addShock(X, Z, Y, Zn[1], 3.4, 0xffb060, 0.95); this.addShock(X, Z, Y, Zn[2], 5.6, 0xff8040, 0.97);
            this.addFlash(X, Z + 8 * K, Y, Zn[0] * 0.9, 2.4);
            this.nukeFlash = Math.max(this.nukeFlash || 0, clamp(1.1 - Math.hypot(X - this.view.x, Y - this.view.y) / (Zn[2] * 6), 0.3, 1));
            this.paintScorch(X, Y, Zn);
            this.fx.nuke(X, Z, Y, Zn, mul, (x, z) => t.heightAt(x, z));
            this.blastFeatures(t, X, Y, Zn);
            this.view.shake = Math.max(this.view.shake, 30);
            break;
          }
          const big = !f.small, k = big ? 1 : 0.5;
          this.addShock(X, Z, Y, 120 * k, 2.2, 0xffd080);
          this.addFlash(X, Z, Y, 45 * k, 1.6);
          this.fx.nuke(X, Z, Y, [20 * k, 50 * k, 80 * k], mul, (x, z) => t.heightAt(x, z));
          if (big) this.view.shake = Math.max(this.view.shake, 14);
          break;
        }
        case 'warp': {
          this.addShock(X, Z, Y, f.big ? 40 : 22, 1.2, 0x7fe7ff);
          for (let i = 0; i < n(60); i++) { const a = Math.random() * 6.28, r = Math.random() * 3; this.glow.emit(X + Math.cos(a) * r, Z, Y + Math.sin(a) * r, 0, 10 + Math.random() * 30, 0, 1.5, 1.0 + Math.random(), 0.5, 0.9, 1); }
          break;
        }
        case 'built': {
          for (let i = 0; i < n(30); i++) { const a = Math.random() * 6.28, r = f.size * 0.6; this.glow.emit(X + Math.cos(a) * r, Z + 1, Y + Math.sin(a) * r, 0, 4 + Math.random() * 6, 0, 1.0, 0.8, 0.35, 1, 0.55); }
          break;
        }
        case 'shieldhit': {
          const m = this.shieldMeshes.get(f.sid); if (m) m.material.uniforms.flash.value = 1;
          for (let i = 0; i < n(6); i++) this.glow.emit(X, Z, Y, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, 0.8, 0.3, 0.5, 0.8, 1);
          break;
        }
        case 'feature': this.hideFeature(f.f); break;
      }
    }
    game.fx.length = 0;
    if (audio) {
      const vrS = this.vr && this.vr.inVR ? this.vr.s : 0;   // physical metres per scene unit in VR, 0 on PC
      audio.listen(this.camera, vrS);
      const cx = this.view.x, cy = this.view.y, d = this.view.dist;
      for (const s of game.sounds) {
        if (this.localTeam && game.opts.fog && this.fowCur[t.cellIdx(s.x, s.y)] < 0.9 && s.kind !== 'nuke') continue;
        const dd = Math.hypot(s.x - cx, s.y - cy);
        const vol = clamp(1 - dd / (d * 1.3 + 150)) * clamp(1.4 - d / 900, 0.25, 1);
        if (vol > 0.03 || s.kind === 'nuke' || vrS) audio.play(s.kind, s.kind === 'nuke' ? 1 : vol, { x: s.x, y: t.heightAt(s.x, s.y), z: s.y });
      }
    }
    game.sounds.length = 0;
  }

  // Darken the ground around a blast: full soot in the total-destruction zone, fading out to the light-damage zone.
  paintScorch(x, y, Zn) {
    const D = this.scorch, N = SCN, cs = S / N, Rm = Zn[2];
    const i0 = Math.max(0, ((x - Rm) / cs) | 0), i1 = Math.min(N - 1, ((x + Rm) / cs) | 0), j0 = Math.max(0, ((y - Rm) / cs) | 0), j1 = Math.min(N - 1, ((y + Rm) / cs) | 0);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const r = Math.hypot((i + 0.5) * cs - x, (j + 0.5) * cs - y);
      if (r >= Rm) continue;
      const d = r < Zn[0] ? 0.95 - 0.1 * r / Zn[0] : r < Zn[1] ? 0.85 - 0.4 * (r - Zn[0]) / (Zn[1] - Zn[0]) : 0.45 * (1 - (r - Zn[1]) / (Zn[2] - Zn[1]));
      const v = d * 255, k = j * N + i;
      if (v > D[k]) D[k] = v;
    }
    this.scorchTex.needsUpdate = true;
  }

  addShock(x, z, y, r, life, color, inner = 0.7) {
    const m = new THREE.Mesh(new THREE.RingGeometry(inner, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
    m.position.set(x, z + 0.8, y); this.scene.add(m);
    this.fxTransient.push({ mesh: m, t: 0, life, r, kind: 'ring' });
  }
  addFlash(x, z, y, r, life) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    m.position.set(x, z, y); this.scene.add(m);
    this.fxTransient.push({ mesh: m, t: 0, life, r, kind: 'flash' });
  }

  updateTransient(dt) {
    for (let i = this.fxTransient.length - 1; i >= 0; i--) {
      const f = this.fxTransient[i]; f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) { this.scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); this.fxTransient.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      const s = f.r * (f.kind === 'flash' ? 0.3 + e * 0.7 : e);
      f.mesh.scale.set(s, s, s);
      f.mesh.material.opacity = (1 - k) * (f.kind === 'flash' ? 1 : 0.9);
    }
  }

  updateProjectiles(game, dt) {
    const P = this.projPts, fx = this.fx; fx.beginProj();
    const pl = this.settings.particles;
    const seenM = new Set(), emitP = Math.min(1, dt * 60);
    const vw = this.view, farR = vw.dist * 1.8 + 250, farR2 = farR * farR, iconMode = this.iconMode;
    for (const p of game.projectiles) {
      const strategic = p.type === 'nuke';   // ballistic missiles are visible from afar (launch warning), everything else needs vision
      if (!strategic && this.localTeam && game.opts.fog && this.fowCur[game.terrain.cellIdx(p.x, p.y)] < 0.9) continue;
      if (strategic || p.type === 'amissile' || (p.type === 'missile' && p.tac)) { this.drawMissile(p, seenM, pl, emitP); continue; }
      if ((p.x - vw.x) * (p.x - vw.x) + (p.y - vw.y) * (p.y - vw.y) > farR2) continue;
      if (iconMode && p.type !== 'shell' && p.type !== 'bomb' && p.type !== 'oc' && p.type !== 'missile') continue;
      const c = this.colorOf(p.color || 0xffc070);
      const big = p.type === 'shell' || p.type === 'bomb' || p.type === 'oc';
      P.emit(p.x, p.z, p.y, 0, 0, 0, p.type === 'oc' ? 4 : big ? 1.6 : p.type === 'aamissile' || p.type === 'missile' ? 1.2 : p.type === 'torpedo' ? 1.0 : 0.8, 1, c.r, c.g, c.b);
      if (p.type === 'bullet' || p.type === 'flak') {
        // short tracer tail
        const dx = p.tx - p.sx, dy = p.ty - p.sy, dz = p.tz - p.sz, l = Math.hypot(dx, dy, dz) || 1;
        fx.tracer(p.x, p.z, p.y, dx / l, dz / l, dy / l, p.type === 'flak' ? 3.5 : 6, c.r, c.g * 0.9, c.b * 0.7);
        P.emit(p.x - dx / l * 1.2, p.z - dz / l * 1.2, p.y - dy / l * 1.2, 0, 0, 0, 0.45, 1, c.r * 0.8, c.g * 0.7, c.b * 0.5);
      }
      if (p.type === 'missile' && pl > 0 && Math.random() < (pl === 2 ? 0.6 : 0.3)) this.smoke.emit(p.x, p.z, p.y, 0, 0.4, 0, 0.7, 0.8, 0.42, 0.42, 0.44, { grow: 1.6, alpha: 0.3 });
      if ((p.type === 'missile' || p.type === 'aamissile') && pl > 0 && Math.random() < 0.5) this.glow.emit(p.x, p.z, p.y, 0, 0, 0, 0.9, 0.1, 1, 0.6, 0.3);
      if (p.type === 'torpedo' && Math.random() < 0.5) this.smoke.emit(p.x, game.terrain.water + 0.1, p.y, 0, 0.3, 0, 0.8, 1.2, 0.9, 0.95, 1, { grow: 1.5, alpha: 0.5 });
    }
    for (const [p, m] of this.missileMeshes) if (!seenM.has(p)) { this.scene.remove(m); this.missileMeshes.delete(p); }
    P.update(0);
  }

  // Mesh + exhaust of a nuke / interceptor / tactical missile, pointing along its velocity.
  drawMissile(p, seen, pl, emitP) {
    seen.add(p);
    const kind = p.type === 'nuke' ? 'nuke' : p.type === 'amissile' ? 'anti' : 'tac';
    let m = this.missileMeshes.get(p);
    if (!m) { m = new THREE.Mesh(missileGeom(kind), this.matBody); m.castShadow = true; m.frustumCulled = false; this.scene.add(m); this.missileMeshes.set(p, m); }
    m.position.set(p.x, p.z, p.y);
    let dx = p.vx || 0, dy = p.vz || 0, dz = p.vy || 0;   // sim (x, y, z) -> three (x, z, y)
    const l = Math.hypot(dx, dy, dz);
    if (l < 0.5) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
    m.quaternion.setFromUnitVectors(this.tmpV.set(0, 1, 0), this.tmpS.set(dx, dy, dz));
    const len = kind === 'nuke' ? 6.5 : 2;   // exhaust starts at the tail of the missile
    const tx = p.x - dx * len, ty = p.z - dy * len, tz = p.y - dz * len;
    if (kind === 'nuke') {
      this.glow.emit(tx, ty, tz, 0, 0, 0, 7, 0.09, 1, 0.75, 0.35, { alpha: 0.9 });
      this.glow.emit(tx - dx * 2, ty - dy * 2, tz - dz * 2, 0, 0, 0, 5, 0.12, 1, 0.5, 0.15);
      if (pl > 0 && Math.random() < emitP * (pl === 2 ? 1 : 0.6)) { const g = 0.72 + Math.random() * 0.15; this.smoke.emit(tx, ty, tz, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 4.2, 5.5, g, g, g * 0.97, { grow: 3.4, alpha: 0.6, drag: 0.98 }); }
    } else if (kind === 'anti') {
      this.glow.emit(tx, ty, tz, 0, 0, 0, 2.4, 0.08, 0.5, 0.95, 1);
      if (pl > 0 && Math.random() < emitP) this.smoke.emit(tx, ty, tz, 0, 0, 0, 1.6, 1.6, 0.85, 0.95, 1, { grow: 1.6, alpha: 0.5 });
    } else {
      this.glow.emit(tx, ty, tz, 0, 0, 0, 1.8, 0.08, 1, 0.7, 0.3);
      if (pl > 0 && Math.random() < emitP) this.smoke.emit(tx, ty, tz, 0, 0.3, 0, 1.4, 2.2, 0.62, 0.62, 0.64, { grow: 1.8, alpha: 0.5 });
    }
  }

  updateBeams(game, dt) {
    const fx = this.fx;
    // three coordinates come in as (x, z=up, y) like the old line buffer; w = half width (nano streams thin, weapon lasers thick)
    const put = (x, y, z, tx, ty, tz, c, k = 1, w = 0.08) => fx.beam(x, z, y, tx, tz, ty, c.r * k, c.g * k, c.b * k, w);
    const build = new THREE.Color(0x40ff90), recl = new THREE.Color(0xffb040), bad = new THREE.Color(0x40a060);
    const lt = this.localTeam;
    for (const st of game.structs) {
      const v = st.building && this.views.get(st.id);
      if (!v?.emitter || !v.root.visible) continue;
      const p = v.emitter.getWorldPosition(this.tmpV), ex = st.exit || st, t = game.terrain;
      const wob = st.spec.size * 0.08, tz = t.surfaceAt(ex.x, ex.y) + 1;
      for (let k = 0; k < 2; k++) put(p.x, p.z, p.y, ex.x + Math.sin(this.time * 6 + k * 2 + st.id) * wob, ex.y + Math.cos(this.time * 4 + k * 2) * wob, tz, build, 0.9);
    }
    for (const u of game.units) {
      if (!u.beam || (lt && !game.visibleTo(lt, u))) continue;
      const b = u.beam, t = game.terrain;
      const v = this.views.get(u.id);
      let sx = v ? v.root.position.x : u.x, sy = v ? v.root.position.z : u.y, sz = (v ? v.root.position.y : t.heightAt(u.x, u.y)) + (u.spec.model === 'acu' ? 5 : u.spec.radius + 0.8);
      if (v?.emitter) { const p = v.emitter.getWorldPosition(this.tmpV); sx = p.x; sy = p.z; sz = p.y; }
      const tz = (b.unit ? game.groundZ(b.unit) : t.surfaceAt(b.x, b.y)) + (b.size || 2) * 0.4;
      const c = b.kind === 'reclaim' ? recl : b.ok ? build : bad;
      const wob = (b.size || 2) * 0.35;
      for (let k = 0; k < 3; k++) put(sx, sy, sz, b.x + Math.sin(this.time * 7 + k * 2 + u.id) * wob, b.y + Math.cos(this.time * 5 + k * 2.1 + u.id) * wob, tz + Math.sin(this.time * 3 + k) * wob * 0.5, c, 0.9);
      if (Math.random() < 0.3) this.glow.emit(b.x + (Math.random() - 0.5) * wob * 2, tz, b.y + (Math.random() - 0.5) * wob * 2, 0, 2, 0, 0.8, 0.3, c.r, c.g, c.b);
    }
    for (let i = this.beamFx.length - 1; i >= 0; i--) {
      const b = this.beamFx[i]; b.life -= dt;
      if (b.life <= 0) { this.beamFx.splice(i, 1); continue; }
      const k = b.life / 0.14 * 2;
      put(b.x, b.y, b.z, b.tx, b.ty, b.tz, b.c, k, b.w > 1 ? 0.45 : 0.25);
    }
  }

  updateShields(game) {
    const seen = new Set();
    for (const u of game.units) {
      const ps = u.pshield;
      if (!ps || u.carried || (this.localTeam && !game.visibleTo(this.localTeam, u))) continue;
      const v = this.views.get(u.id); if (!v) continue;
      seen.add(u.id);
      let m = this.shieldMeshes.get(u.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.ShaderMaterial({
          uniforms: { color: { value: new THREE.Color(TEAM_COLORS[u.team]).lerp(new THREE.Color(0x9fdfff), 0.6) }, strength: { value: 1 }, flash: { value: 0 }, time: { value: 0 } },
          vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        }));
        m.renderOrder = 7; this.scene.add(m); this.shieldMeshes.set(u.id, m);
      }
      m.visible = ps.hp > 0;
      m.position.copy(v.root.position); m.position.y += (v.meta.height || 3) * 0.45;
      m.scale.setScalar(ps.r);
      const un = m.material.uniforms;
      un.strength.value = 0.3 + 0.6 * ps.hp / ps.max; un.flash.value = Math.max(ps.flash, un.flash.value - 0.05); un.time.value = this.time;
    }
    for (const s of game.structs) {
      if (!s.shield || !s.built) continue;
      if (this.localTeam && !game.seenBy(this.localTeam, s)) continue;
      seen.add(s.id);
      let m = this.shieldMeshes.get(s.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
          uniforms: { color: { value: new THREE.Color(TEAM_COLORS[s.team]).lerp(new THREE.Color(0x9fdfff), 0.6) }, strength: { value: 1 }, flash: { value: 0 }, time: { value: 0 } },
          vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        }));
        m.renderOrder = 7; this.scene.add(m); this.shieldMeshes.set(s.id, m);
      }
      const sh = s.shield;
      m.visible = sh.on && sh.hp > 0;
      m.position.set(s.x, game.terrain.heightAt(s.x, s.y), s.y);
      m.scale.setScalar(sh.r);
      const u = m.material.uniforms;
      u.strength.value = 0.35 + 0.65 * sh.hp / sh.max; u.flash.value = Math.max(0, u.flash.value - 0.05); u.time.value = this.time;
    }
    for (const [id, m] of this.shieldMeshes) if (!seen.has(id)) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); this.shieldMeshes.delete(id); }
  }

  updateRings(sel) {
    let n = 0;
    for (const e of sel) {
      if (n >= 600) break;
      if (!e.alive || e.carried) continue;
      const p = this.entityPos(e);
      const r = e.kind === 'struct' ? e.spec.size * 0.75 : e.spec.radius * 1.5 + 0.8;
      const y = e.kind === 'unit' && e.spec.move === 'air' ? this.terrain.surfaceAt(e.x, e.y) + 0.3 : p.y + 0.3;
      this.tmpM.compose(this.tmpV.set(p.x, y, p.z), this.tmpQ.identity(), this.tmpS.set(r, 1, r));
      this.rings.setMatrixAt(n++, this.tmpM);
    }
    this.rings.count = n;
    this.rings.visible = n > 0;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  updateFow(game, dt) {
    const lt = this.localTeam;
    const T = lt ? game.teams[lt] : null;
    const on = game.opts.fog && T;
    const k = Math.min(1, dt * (game.over ? 3 : 6));   // fog lifts in ~1 s after the match ends
    // VR table: the whole map is ~1 m and mostly unexplored, so the PC dimming leaves a black slab
    const [ex, un] = this.vr?.inVR ? [0.8, 0.62] : [0.55, 0.28];
    for (let i = 0; i < PN * PN; i++) {
      const target = !on ? 1 : T.vis[i] ? 1 : T.explored[i] ? ex : un;
      this.fowCur[i] += (target - this.fowCur[i]) * k;
      this.fowData[i] = this.fowCur[i] * 255;
    }
    this.fowTex.needsUpdate = true;
    if (this.waterUniforms) this.waterUniforms.fowOn.value = on ? 1 : 0;
  }

  setOverlay(ai) {
    this.terrainUniforms && (this.terrainUniforms.ovOn.value = ai ? 0.75 : 0);
    if (!ai) return;
    const I = ai.intel;
    const NI = I.thrLand.length;
    let mx = 1; for (let i = 0; i < NI; i++) mx = Math.max(mx, I.thrLand[i] + I.thrAir[i]);
    for (let i = 0; i < NI; i++) {
      const l = I.thrLand[i] / mx, a = I.thrAir[i] / mx, loss = Math.min(1, I.loss[i] / 400), val = Math.min(1, I.value[i] / 400);
      this.ovData[i * 4] = clamp(l * 2.5 + loss) * 255;
      this.ovData[i * 4 + 1] = clamp(val * 1.5) * 200;
      this.ovData[i * 4 + 2] = clamp(a * 2.5) * 255;
      this.ovData[i * 4 + 3] = clamp(Math.max(l * 2.5, a * 2.5, loss, val) * 0.85) * 255;
    }
    this.ovTex.needsUpdate = true;
  }

  // Queued build orders are shown as translucent buildings at their future spots (SupCom-style).
  // Selected units always; with Shift held — every own builder.
  queuedBuilds(game, ui) {
    const out = [];
    if (!ui || !ui.team) return out;
    const shift = ui.keys.ShiftLeft || ui.keys.ShiftRight || (this.vr && this.vr.inVR && this.vr.shift);   // VR: left trigger
    const src = shift ? game.units.filter(u => u.team === ui.team && u.spec.canBuild) : ui.selection;
    for (const u of src) {
      if (u.kind !== 'unit' || !u.alive || u.team !== ui.team) continue;
      u.orders.forEach((o, i) => { if (o.type === 'build' && (!o.site || !o.site.alive)) out.push({ u, o, i }); });
    }
    return out;
  }
  updateOrderGhosts(game, ui) {
    const seen = new Set(), t = game.terrain;
    for (const { o } of this.queuedBuilds(game, ui)) {
      const k = `${o.key}@${o.x},${o.y}`;
      if (seen.has(k) || (seen.size >= 40 && this.gl.xr.isPresenting)) continue;   // Quest: at most 40 queued ghosts
      seen.add(k);
      let gh = this.qGhosts.get(k);
      if (!gh) {
        const S2 = STRUCTS[o.key];
        gh = this.makeGhostModel(S2, this.matGhostQueue, this.matGhostQueueWire, this.matFootQueue, 0.3).root;
        gh.position.set(o.x, S2.place === 'water' ? t.water : t.heightAt(o.x, o.y), o.y);
        gh.renderOrder = 3;
        this.scene.add(gh); this.qGhosts.set(k, gh);
      }
    }
    // ghost materials and geometries are shared (GLB / procedural / footprint cache), so removal only detaches the group
    for (const [k, gh] of this.qGhosts) if (!seen.has(k)) { this.scene.remove(gh); this.qGhosts.delete(k); }
  }

  // Translucent preview of a structure: the real GLB model (all meshes swapped for the ghost material, geometry shared,
  // no mixer), or the procedural model when there is no GLB, plus a size x size footing. Returns { root, meshes, foot }.
  makeGhostModel(spec, mat, wireMat, footMat, footH) {
    const root = new THREE.Group(), meshes = [];
    const glb = GLB[spec.model];
    if (glb) {
      const model = glb.scene.clone();
      model.traverse(o => { if (o.isMesh) { o.material = mat; o.castShadow = o.receiveShadow = false; meshes.push(o); } });
      // wire overlay is added after the traversal (traverse would otherwise visit the new children forever)
      if (wireMat) for (const o of meshes.slice()) { const w = new THREE.Mesh(o.geometry, wireMat); w.castShadow = w.receiveShadow = false; o.add(w); }
      root.add(model);
    } else {
      const body = getModel(spec.model, TEAM_COLORS[1]).geoms.body;
      if (body) {
        const m = new THREE.Mesh(body, mat); root.add(m); meshes.push(m);
        if (wireMat) root.add(new THREE.Mesh(body, wireMat));
      }
    }
    let fg = this.footGeoms.get(spec.size + ':' + footH);
    if (!fg) this.footGeoms.set(spec.size + ':' + footH, fg = new THREE.BoxGeometry(spec.size, footH, spec.size));
    const foot = new THREE.Mesh(fg, footMat); foot.castShadow = foot.receiveShadow = false;
    root.add(foot);
    return { root, meshes, foot };
  }

  // Blast-zone marker under the cursor in launch mode: up to three rings (total / heavy / light damage, radii from the silo spec; sp = null — a single
  // small ring for tactical missiles) and a crosshair; setAim(null) hides it. The ring labels are drawn on the overlay (drawAimLabels).
  setAim(x, y, sp) {
    if (x === null || x === undefined) { if (this.aim) this.aim.visible = false; this.aimSp = null; return; }
    if (!this.aim) {
      const mat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const g = new THREE.Group();
      for (const c of AIM_COL) { g.add(new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2), mat(c, 0.95))); g.add(new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), mat(c, 0.1))); }
      for (const r of [0, Math.PI / 2]) g.add(new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.02).rotateX(-Math.PI / 2).rotateY(r), mat(AIM_COL[0], 0.9)));
      g.children.forEach(m => { m.renderOrder = 9; });
      this.aim = g; this.scene.add(g);
    }
    const a = this.aim, t = this.terrain, Zn = sp ? sp.zones : AIM_TAC;
    a.visible = true; a.position.set(x, (t ? Math.max(t.surfaceAt(x, y), t.water) : 0) + 1.5, y);
    for (let i = 0; i < 3; i++) { const on = i < Zn.length; a.children[i * 2].visible = a.children[i * 2 + 1].visible = on; if (on) a.children[i * 2].scale.setScalar(Zn[i]), a.children[i * 2 + 1].scale.setScalar(Zn[i]); }
    a.children[6].scale.setScalar(Zn[0] * 0.7); a.children[7].scale.setScalar(Zn[0] * 0.7);
    a.children[0].material.opacity = 0.7 + 0.25 * Math.sin(performance.now() / 120);
    this.aimSp = sp; this.aimXY.x = x; this.aimXY.y = y;
  }
  // Ring labels of the nuke aim («Полное уничтожение 500 м» ...), stacked so they never overlap.
  drawAimLabels(c, game) {
    const sp = this.aimSp; if (!sp || !this.aim || !this.aim.visible) return;
    const { x, y } = this.aimXY, t = game.terrain;
    c.save(); c.font = 'bold 12px Rajdhani, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    let ly = -1e9;
    for (let i = 0; i < sp.zones.length; i++) {
      const px = x + Math.cos(0.7) * sp.zones[i], py = y + Math.sin(0.7) * sp.zones[i];
      if (!this.projTo(px, t.surfaceAt(clamp(px, 1, S - 1), clamp(py, 1, S - 1)), py)) continue;
      const txt = nukeZoneLabel(sp, i), tw = c.measureText(txt).width + 12, sx = clamp(this.sx, tw / 2 + 4, this.overlay.width - tw / 2 - 4), sy = Math.max(this.sy, ly + 18);
      ly = sy;
      c.fillStyle = 'rgba(8,10,14,0.82)'; c.fillRect(sx - tw / 2, sy - 8, tw, 16);
      c.strokeStyle = AIM_CSS[i]; c.lineWidth = 1; c.strokeRect(sx - tw / 2 + 0.5, sy - 7.5, tw - 1, 15);
      c.fillStyle = AIM_CSS[i]; c.fillText(txt, sx, sy + 0.5);
    }
    c.restore();
  }

  setGhost(key, x, y, ok, team, z) {
    if (!key) { if (this.ghost) { this.scene.remove(this.ghost.root); this.ghost = null; } if (this.terrainUniforms) this.terrainUniforms.gridOn.value = 0; return; }
    if (!this.ghost || this.ghost.key !== key) {
      if (this.ghost) this.scene.remove(this.ghost.root);
      const g = this.makeGhostModel(STRUCTS[key], this.matGhostOk, null, this.matFootOk, 0.4);
      g.root.renderOrder = 3;
      this.ghost = { key, root: g.root, meshes: g.meshes, foot: g.foot, ok: true };
      this.scene.add(g.root);
    }
    const gh = this.ghost;
    gh.root.position.set(x, z, y); gh.x = x; gh.y = y;
    if (gh.ok !== !!ok) { gh.ok = !!ok; const mat = ok ? this.matGhostOk : this.matGhostBad; for (const m of gh.meshes) m.material = mat; gh.foot.material = ok ? this.matFootOk : this.matFootBad; }
    if (this.terrainUniforms) this.terrainUniforms.gridOn.value = 1;
  }

  // ---------------------------------------------------------------- frame
  render(game, alpha, dt, ui) {
    this.time += dt;
    if (!this.gl.xr.isPresenting) {
      this.updateCamera(dt);
    }
    if (this.waterUniforms) this.waterUniforms.time.value = this.time;
    this.windU.value = this.time;
    const P = this.perf, tk = (k, t0) => { const t1 = performance.now(); P[k] += ((t1 - t0) - P[k]) * 0.1; return t1; };
    let tp = performance.now(); const tStart = tp;
    const inXR = this.gl.xr.isPresenting;
    if (inXR) {
      // input / table first, then the eye camera, so syncViews culls against this frame's real eye frustum
      if (this.vr) this.vr.update(game, ui, dt);
      this.updateXRCamera();
    }
    if (game) {
      this.updateFow(game, dt); tp = tk('other', tp);
      this.syncViews(game, alpha, dt); tp = tk('sync', tp);
      this.consumeFx(game, ui && ui.audio); tp = tk('fx', tp);
      this.updateProjectiles(game, dt); tp = tk('proj', tp);
      this.updateBeams(game, dt);
      this.updateShields(game);
      this.updateRings(ui ? ui.selection : []);
      this.updateOrderGhosts(game, ui); tp = tk('beams', tp);
    }
    for (const m of this.massMarks || []) m.material.opacity = 0.55 + Math.sin(this.time * 2.5) * 0.25;
    this.fx.update(dt);
    this.updateTransient(dt);
    if (this.nukeFlash > 0) this.nukeFlash = Math.max(0, this.nukeFlash - dt * 0.75);
    // ponytail: shadows re-rendered every 2nd frame (1-frame lag is invisible, saves ~8% of frame time)
    this.gl.shadowMap.needsUpdate = (this.frameN = (this.frameN || 0) + 1) % 2 === 0;
    tp = performance.now();
    if (inXR) {
      if (this.vr) this.vr.updateMarks(game, ui);
      tp = performance.now();
      const xr = this.gl.xr;
      xr.cameraAutoUpdate = false;
      this.gl.render(this.scene, this.camera);
      xr.cameraAutoUpdate = true;
      tp = tk('gl', tp);
      P.frame += ((tp - tStart) - P.frame) * 0.1;
    } else {
      if (this.composer) this.composer.render(); else this.gl.render(this.scene, this.camera);
      tp = tk('gl', tp);
      this.drawOverlay(game, ui); tp = tk('overlay', tp);
      P.frame += ((tp - tStart) - P.frame) * 0.1;
    }
  }

  setVR(vr) { this.vr = vr; }

  // XR eye camera for this frame. three r169's stereo-union frustum assumes an unscaled camera parent; our meters->game dolly
  // scales the IPD but not near/far, and the union then comes out with near ~25 m and culls the whole table. That union
  // projection was also copied into this.camera, and syncViews culled every unit/building against it (models were never created).
  // Use the left eye frustum widened by the physical IPD at the near plane (covers both eyes) for both.
  updateXRCamera() {
    const xr = this.gl.xr, cam = this.camera;
    // xr.updateCamera passes cam.near/far to the session as depthNear/depthFar in metres (vr.js startSession sets 0.02 / 100). A PC frame
    // that ran during `await setSession` (isPresenting still false -> updateCamera) left game units here (near 22 = 22 m): the headset clipped
    // everything closer than 22 m and showed only passthrough after a first flash (random, by timing; also 11.15).
    if (cam.near !== 0.02 || cam.far !== 100) { cam.near = 0.02; cam.far = 100; }
    xr.updateCamera(cam);
    const cameraXR = xr.getCamera();
    if (cameraXR.cameras.length === 2) {
      const eye = cameraXR.cameras[0];
      cameraXR.matrixWorld.copy(eye.matrixWorld);
      cameraXR.matrixWorldInverse.copy(eye.matrixWorldInverse);
      cameraXR.projectionMatrix.copy(eye.projectionMatrix);
      const ipd = eye.position.distanceTo(cameraXR.cameras[1].position);
      cameraXR.projectionMatrix.elements[0] /= 1 + ipd * Math.abs(eye.projectionMatrix.elements[0]) / cam.near;
      cameraXR.projectionMatrixInverse.copy(cameraXR.projectionMatrix).invert();
      // user camera (dolly child) = the same frustum, used by syncViews / VR marks
      cam.matrix.copy(cam.parent.matrixWorld).invert().multiply(cameraXR.matrixWorld);
      cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
      cam.updateMatrixWorld(true);
      cam.projectionMatrix.copy(cameraXR.projectionMatrix);
      cam.projectionMatrixInverse.copy(cameraXR.projectionMatrixInverse);
      // particle sizes are in game units, but XR view space is in meters (dolly scale): px = size * scale / depth
      const fbH = xr.getBaseLayer?.()?.framebufferHeight || 1600;
      const sc = fbH * eye.projectionMatrix.elements[5] / 2 * (this.vr?.s || 1);
      this.fx.setScale(sc);
    }
  }

  // ---------------------------------------------------------------- 2D overlay: icons, bars, orders
  drawOverlay(game, ui) {
    const c = this.octx, W = this.overlay.width, H = this.overlay.height;
    c.clearRect(0, 0, W, H);
    if (!game) return;
    const lt = this.localTeam;
    if (this.nukeFlash > 0.01) { c.fillStyle = `rgba(255,244,214,${(this.nukeFlash * this.nukeFlash * 0.92).toFixed(3)})`; c.fillRect(0, 0, W, H); }   // nuclear flash over the whole screen
    const iconMode = this.iconMode;
    const bars = this.settings.healthBars; // 0 none 1 damaged 2 always
    const sel = new Set(ui ? ui.selection : []);
    const t = game.terrain;
    // radar-only contacts
    if (this.blips.length) {
      c.fillStyle = 'rgba(255,90,60,0.8)'; c.strokeStyle = 'rgba(255,200,180,0.5)';
      for (const e of this.blips) {
        if (!this.projTo(e.x, game.groundZ(e), e.y)) continue;
        c.beginPath(); c.arc(this.sx, this.sy, 3.5, 0, 6.28); c.fill(); c.stroke();
      }
    }
    this.ranges.draw(this, c, game, ui);
    // everything syncViews found on screen (frustum-culled, interpolated positions): project once, keep the survivors
    const dl = this.dl, dlPos = this.dlPos, n = this.dlN;
    if (!this.dlScr || this.dlScr.length < n * 2) this.dlScr = new Float32Array(Math.max(1024, n * 2 + 512));
    const scr = this.dlScr, keep = this._keep || (this._keep = []);
    let nk = 0;
    for (let k = 0; k < n; k++) {
      const e = dl[k], o = k * 3;
      const top = e.kind === 'struct' ? (this.metaHeight(e) || 4) : (this.metaHeight(e) || 2) + 0.5;
      if (!this.projTo(dlPos[o], dlPos[o + 1] + top + 1, dlPos[o + 2])) continue;
      const x = this.sx, y = this.sy;
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      scr[nk * 2] = x; scr[nk * 2 + 1] = y; keep[nk++] = e;
    }
    if (ui && ui.staffUI) ui.staffUI.drawZones(c, this, game); // lieutenants: zones of responsibility on the terrain
    const pp = this._pp || (this._pp = { x: 0, y: 0 });
    const thin = iconMode && nk > 350, skip = thin ? this.thinIcons(keep, scr, nk, sel, W, H) : null;
    for (let k = 0; k < nk; k++) {
      const e = keep[k];
      if (iconMode) {
        const selected = sel.has(e);
        if (!(thin && skip[k])) this.drawIcon(c, e, scr[k * 2], scr[k * 2 + 1] + 6, selected);
      }
      if (ui && e.lt !== undefined && ui.staffUI) { pp.x = scr[k * 2]; pp.y = scr[k * 2 + 1]; ui.staffUI.markEntity(c, e, pp, iconMode, sel.has(e)); } // handed over to a lieutenant
    }
    // health bars, batched by colour (few fillStyle switches instead of ~4 per entity)
    const bx = this._bx || (this._bx = []), by = this._by || (this._by = []), bw = this._bw || (this._bw = []), bf = this._bf || (this._bf = []);
    let nb = 0;
    for (let k = 0; k < nk; k++) {
      const e = keep[k], p0x = scr[k * 2], p0y = scr[k * 2 + 1];
      const selected = sel.has(e);
      const damaged = e.hp < e.maxHp - 0.5;
      const showBar = selected || bars === 2 || (bars === 1 && damaged) || (e.kind === 'struct' && !e.built);
      if (showBar && !(iconMode && !selected && !damaged)) {
        const w = e.kind === 'struct' ? 34 : e.spec.role === 'exp' ? 60 : e.spec.model === 'acu' ? 40 : 22;
        bx[nb] = p0x - w / 2; by[nb] = p0y - (iconMode ? 12 : 4); bw[nb] = w; bf[nb] = Math.max(0, e.hp / e.maxHp);
        nb++;
        if (e.kind === 'struct') {
          const x = p0x - w / 2, y = p0y - (iconMode ? 12 : 4);
          if (!e.built) { c.fillStyle = '#5dffb0'; c.fillRect(x, y + 4, w * e.progress, 2); }
          if (e.shield && e.shield.on) { c.fillStyle = '#7fcfff'; c.fillRect(x, y - 3, w * e.shield.hp / e.shield.max, 2); }
          if (e.upgrading || (e.queue && e.queue.length)) { c.fillStyle = '#ffb040'; c.fillRect(x, y + 4, w * (e.upgrading ? e.upgrading.prog : e.prog), 2); }
        }
      }
      if (e.silo && e.built && (!lt || e.team === lt)) this.drawSiloPips(c, e, p0x, p0y - (iconMode ? 20 : 12));
      if (e.vet && !iconMode && (selected || damaged || bars === 2)) {
        c.font = 'bold 9px Rajdhani, sans-serif'; c.textAlign = 'center'; c.fillStyle = '#ffd040';
        c.fillText('★'.repeat(e.vet), p0x, p0y - 7);
      }
      if (selected && this.settings.unitThoughts && e.kind === 'unit' && e.brain && sel.size <= 12 && !iconMode) {
        c.font = '600 11px Rajdhani, sans-serif'; c.textAlign = 'center';
        const txt = e.brain.thought;
        const tw = c.measureText(txt).width + 10;
        c.fillStyle = 'rgba(8,16,24,0.78)'; c.fillRect(p0x - tw / 2, p0y - 24, tw, 15);
        c.strokeStyle = 'rgba(93,255,176,0.5)'; c.strokeRect(p0x - tw / 2, p0y - 24, tw, 15);
        c.fillStyle = '#bff5d8'; c.fillText(txt, p0x, p0y - 13);
      }
    }
    if (nb) {
      c.fillStyle = 'rgba(0,0,0,0.65)';
      for (let i = 0; i < nb; i++) c.fillRect(bx[i] - 1, by[i] - 1, bw[i] + 2, 5);
      for (let pass = 0; pass < 3; pass++) {
        c.fillStyle = pass === 0 ? '#46e070' : pass === 1 ? '#e8c440' : '#ff4a3a';
        for (let i = 0; i < nb; i++) { const f = bf[i]; if ((f > 0.6 ? 0 : f > 0.3 ? 1 : 2) === pass) c.fillRect(bx[i], by[i], bw[i] * f, 3); }
      }
    }
    this.drawNukeMarkers(c, game, lt);
    this.drawAimLabels(c, game);
    // command queue (SupCom-style): path through every queued order with a typed waypoint marker
    if (ui && ui.selection.length || ui && (ui.keys.ShiftLeft || ui.keys.ShiftRight)) this.drawOrders(c, game, ui);
    // formation preview while right-dragging
    if (ui && ui.formPreview) {
      const fp = ui.formPreview;
      c.fillStyle = 'rgba(93,255,138,0.85)'; c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1;
      for (const p of fp.pts) { const q = this.project(p.x, p.y, t.surfaceAt(p.x, p.y) + 0.3); c.beginPath(); c.arc(q.x, q.y, 3.5, 0, 6.28); c.fill(); c.stroke(); }
      const a = this.project(fp.x, fp.y, t.surfaceAt(fp.x, fp.y)), L = 30;
      const b = this.project(fp.x + Math.cos(fp.facing) * L, fp.y + Math.sin(fp.facing) * L, t.surfaceAt(fp.x, fp.y));
      c.strokeStyle = '#5dff8a'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x - Math.cos(ang - 0.5) * 10, b.y - Math.sin(ang - 0.5) * 10); c.lineTo(b.x - Math.cos(ang + 0.5) * 10, b.y - Math.sin(ang + 0.5) * 10); c.closePath(); c.fillStyle = '#5dff8a'; c.fill();
    }
    // adjacency links of selected structures
    if (ui) for (const e of ui.selection) {
      if (e.kind !== 'struct' || !e.adj || !e.adj.n.length) continue;
      const a = this.project(e.x, e.y, t.heightAt(e.x, e.y) + 2);
      c.strokeStyle = '#9fffd0'; c.lineWidth = 2; c.setLineDash([3, 3]);
      for (const id of e.adj.n) {
        const o = game.structs.find(s => s.id === id); if (!o) continue;
        const b = this.project(o.x, o.y, t.heightAt(o.x, o.y) + 2);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        c.fillStyle = '#9fffd0'; c.font = 'bold 12px Rajdhani, sans-serif'; c.textAlign = 'center'; c.fillText('⬡', b.x, b.y + 4);
      }
      c.setLineDash([]);
    }
    // click pings
    if (ui) for (const pg of ui.pings) {
      const k = (performance.now() - pg.t) / 600;
      if (k > 1) continue;
      const q = this.project(pg.x, pg.y, t.surfaceAt(pg.x, pg.y));
      c.strokeStyle = pg.color; c.globalAlpha = 1 - k; c.lineWidth = 2;
      c.beginPath(); c.ellipse(q.x, q.y, 6 + k * 18, (6 + k * 18) * 0.55, 0, 0, 6.28); c.stroke(); c.globalAlpha = 1;
    }
    if (ui && ui.drag) {
      const d = ui.drag;
      c.strokeStyle = '#7dffb0'; c.lineWidth = 1.2; c.fillStyle = 'rgba(93,255,160,0.1)';
      c.fillRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0); c.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
    }
  }

  // Missile stock of a silo: one pip per missile (filled = ready) and the progress bar of the next one.
  drawSiloPips(c, e, x, y) {
    const sp = e.spec.silo, n = sp.max, w = 7, gap = 2, tot = n * w + (n - 1) * gap;
    const col = sp.kind === 'nuke' ? '#ff6a3c' : sp.kind === 'anti' ? '#5fe8ff' : '#ffd060';
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.65)'; c.fillRect(x - tot / 2 - 2, y - 2, tot + 4, 11);
    for (let i = 0; i < n; i++) {
      const px = x - tot / 2 + i * (w + gap);
      c.strokeStyle = col; c.lineWidth = 1; c.strokeRect(px + 0.5, y + 0.5, w - 1, 5);
      if (i < e.silo.stock) { c.fillStyle = col; c.fillRect(px + 1, y + 1, w - 2, 4); }
      else if (i === e.silo.stock && !e.paused) { c.fillStyle = col; c.globalAlpha = 0.45; c.fillRect(px + 1, y + 1, (w - 2) * e.silo.prog, 4); c.globalAlpha = 1; }
    }
    c.restore();
  }

  // Incoming / own strategic missiles: impact zone, trajectory and time to impact (the launch warning gives the target away).
  drawNukeMarkers(c, game, lt) {
    for (const p of game.projectiles) {
      if (p.type !== 'nuke') continue;
      const own = !lt || game.allied(lt, p.team), col = own ? '#7dffb0' : '#ff3a2a', Z = p.zones;
      const q = this.project(p.tx, p.ty, p.tz), m = this.project(p.x, p.y, p.z);
      if (!q.ok) continue;
      const ring = (z) => { const q2 = this.project(p.tx + z, p.ty, p.tz); return Math.max(10, Math.hypot(q2.x - q.x, q2.y - q.y)); };
      const r = ring(Z[2]), pulse = 0.55 + 0.45 * Math.sin(performance.now() / 160);
      c.save();
      c.strokeStyle = col; c.fillStyle = col;
      if (m.ok) { c.globalAlpha = 0.45; c.setLineDash([6, 6]); c.lineWidth = 1.5; c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(q.x, q.y); c.stroke(); c.setLineDash([]); }
      c.globalAlpha = 0.18 * pulse + 0.1; c.beginPath(); c.ellipse(q.x, q.y, r, r * 0.62, 0, 0, 6.28); c.fill();
      c.globalAlpha = 0.5 + 0.5 * pulse; c.lineWidth = 2.5; c.beginPath(); c.ellipse(q.x, q.y, r, r * 0.62, 0, 0, 6.28); c.stroke();
      c.globalAlpha = 0.45; c.lineWidth = 1.4; for (let i = 0; i < 2; i++) { const ri = ring(Z[i]); c.beginPath(); c.ellipse(q.x, q.y, ri, ri * 0.62, 0, 0, 6.28); c.stroke(); }
      c.globalAlpha = 0.5 + 0.5 * pulse; c.lineWidth = 2; for (const a of [0, 1.5708, 3.1416, 4.7124]) { c.beginPath(); c.moveTo(q.x + Math.cos(a) * r * 0.55, q.y + Math.sin(a) * r * 0.34); c.lineTo(q.x + Math.cos(a) * r * 1.15, q.y + Math.sin(a) * r * 0.7); c.stroke(); }
      c.globalAlpha = 1; c.font = 'bold 12px Rajdhani, sans-serif'; c.textAlign = 'center';
      const txt = (own ? 'НАШ УДАР' : 'ЯДЕРНЫЙ УДАР') + ' · ' + Math.max(0, Math.ceil(p.T - p.t)) + ' с';
      const tw = c.measureText(txt).width + 10;
      c.fillStyle = 'rgba(8,10,14,0.8)'; c.fillRect(q.x - tw / 2, q.y - r * 0.62 - 22, tw, 16);
      c.strokeStyle = col; c.lineWidth = 1; c.strokeRect(q.x - tw / 2, q.y - r * 0.62 - 22, tw, 16);
      c.fillStyle = col; c.fillText(txt, q.x, q.y - r * 0.62 - 10);
      c.restore();
    }
  }

  drawOrders(c, game, ui) {
    const t = game.terrain;
    const colors = { move: '#5dff8a', amove: '#ff9a3c', attack: '#ff4a3a', patrol: '#5fd0ff', build: '#ffe060', assist: '#5dffb0', repair: '#5dffb0', reclaim: '#ffb040', guard: '#7fb0ff', retreatTo: '#ffffff', unload: '#5dffb0', board: '#5dffb0', pickup: '#5dffb0', enhance: '#ffe060' };
    const glyph = { move: '›', amove: 'A', attack: '✕', patrol: '⟲', build: '▣', assist: '+', repair: '+', reclaim: '♻', guard: '◎', retreatTo: '«', unload: '⇩', board: '⇧', pickup: '⇧', enhance: '★' };
    const shift = ui.keys.ShiftLeft || ui.keys.ShiftRight;
    const sel = new Set(ui.selection);
    const list = shift && ui.team ? game.units.filter(u => u.team === ui.team && (sel.has(u) || u.orders.some(o => !o.auto))).concat(ui.selection.filter(e => e.kind === 'struct')) : ui.selection;
    const marks = new Set();
    let n = 0;
    c.font = 'bold 10px Rajdhani, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const e of list) {
      if (n > 160) break;
      if (e.kind === 'struct' && e.rally) {
        const a = this.project(e.x, e.y, t.surfaceAt(e.x, e.y) + 2), b = this.project(e.rally.x, e.rally.y, t.surfaceAt(e.rally.x, e.rally.y));
        c.lineWidth = 1.5; c.strokeStyle = '#5fd0ff'; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.setLineDash([]);
        c.fillStyle = '#5fd0ff'; c.beginPath(); c.arc(b.x, b.y, 5, 0, 6.28); c.fill(); c.fillStyle = '#081018'; c.fillText('⚑', b.x, b.y + 0.5);
        continue;
      }
      if (e.kind !== 'unit' || !e.orders.length || e.carried) continue;
      n++;
      const strong = sel.has(e);
      let prev = this.project(e.x, e.y, game.groundZ(e));
      e.orders.forEach((o, i) => {
        const tg = o.target, P = o.pts;
        const tx = tg ? tg.x : P ? P[o.idx].x : o.x, ty = tg ? tg.y : P ? P[o.idx].y : o.y;
        if (tx === undefined || (o.type === 'enhance')) return;
        const q = this.project(tx, ty, t.surfaceAt(tx, ty) + 0.5);
        const col = colors[o.type] || '#fff';
        c.globalAlpha = o.auto ? 0.3 : strong ? 0.9 : 0.5; c.strokeStyle = col; c.lineWidth = strong ? 1.8 : 1.2;
        if (i > 0) c.setLineDash([6, 4]);
        c.beginPath(); c.moveTo(prev.x, prev.y); c.lineTo(q.x, q.y); c.stroke(); c.setLineDash([]);
        if (P) { // full patrol loop
          c.beginPath(); P.forEach((p, k) => { const pp = this.project(p.x, p.y, t.surfaceAt(p.x, p.y) + 0.5); k ? c.lineTo(pp.x, pp.y) : c.moveTo(pp.x, pp.y); }); c.closePath(); c.setLineDash([2, 4]); c.stroke(); c.setLineDash([]);
        }
        const mk = o.type + Math.round(q.x / 5) + ',' + Math.round(q.y / 5);
        if (!marks.has(mk)) {
          marks.add(mk);
          c.fillStyle = col; c.beginPath(); c.arc(q.x, q.y, 6, 0, 6.28); c.fill();
          c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1; c.stroke();
          c.fillStyle = '#081018'; c.fillText(glyph[o.type] || '•', q.x, q.y + 0.5);
          if (e.orders.length > 1 && strong) { c.fillStyle = '#fff'; c.fillText(String(i + 1), q.x + 9, q.y - 8); }
        }
        c.globalAlpha = 1;
        prev = q;
      });
    }
    c.textBaseline = 'alphabetic';
  }

  // Strategic zoom with > 350 icons: a unit icon (not selected) is skipped when a drawn icon of the same team is closer than
  // SHOW px on screen. Stable while the camera moves: icons drawn last frame go first and keep their place down to HOLD px
  // (hysteresis), so winners no longer flip as icons cross fixed 6 px screen cells. Returns skip flags per keep[] index; no allocations.
  thinIcons(keep, scr, nk, sel, W, H) {
    const SHOW = 6, HOLD = 4, M = 40, cols = Math.ceil((W + 2 * M) / SHOW) + 1, rows = Math.ceil((H + 2 * M) / SHOW) + 1, need = cols * rows;
    if (!this._occ || this._occ.length < need) { this._occ = new Int32Array(need); this._occFr = new Int32Array(need); }
    if (!this._thSkip || this._thSkip.length < nk) { const n = nk + 512; this._thSkip = new Uint8Array(n); this._thNext = new Int32Array(n); }
    if (!this._thId) { this._thId = new Int32Array(8192).fill(-1); this._thFr = new Int32Array(8192); this._thFrame = 0; }
    const occ = this._occ, ofr = this._occFr, skip = this._thSkip, nxt = this._thNext, tid = this._thId, tfr = this._thFr, fr = ++this._thFrame;
    skip.fill(0, 0, nk);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < nk; k++) {   // pass 0: drawn last frame, pass 1: the rest
      const e = keep[k];
      if (e.kind !== 'unit' || sel.has(e)) continue;
      const h = e.id & 8191, held = tid[h] === e.id && tfr[h] >= fr - 1;   // (>= : kept in pass 0 -> not re-tested in pass 1)
      if (held !== (pass === 0)) continue;
      const x = scr[k * 2], y = scr[k * 2 + 1], D = held ? HOLD : SHOW, D2 = D * D, team = e.team;
      const cx = Math.min(cols - 1, Math.max(0, ((x + M) / SHOW) | 0)), cy = Math.min(rows - 1, Math.max(0, ((y + M) / SHOW) | 0));
      let hit = false;
      for (let yy = Math.max(0, cy - 1); yy <= cy + 1 && yy < rows && !hit; yy++) for (let xx = Math.max(0, cx - 1); xx <= cx + 1 && xx < cols && !hit; xx++) {
        const ci = yy * cols + xx;
        if (ofr[ci] !== fr) continue;
        for (let j = occ[ci]; j >= 0; j = nxt[j]) {
          if (keep[j].team !== team) continue;
          const dx = scr[j * 2] - x, dy = scr[j * 2 + 1] - y;
          if (dx * dx + dy * dy < D2) { hit = true; break; }
        }
      }
      if (hit) { skip[k] = 1; continue; }
      const ci = cy * cols + cx; nxt[k] = ofr[ci] === fr ? occ[ci] : -1; occ[ci] = k; ofr[ci] = fr;
      tid[h] = e.id; tfr[h] = fr;
    }
    return skip;
  }

  // Icons are painted once per (unit type, team, selection) into a small canvas and blitted: ~10x cheaper than paths + text.
  drawIcon(c, e, x, y, selected) {
    if (!this.iconCache) { this.iconCache = new WeakMap(); document.fonts?.ready.then(() => { this.iconCache = new WeakMap(); }); }
    let per = this.iconCache.get(e.spec);
    if (!per) this.iconCache.set(e.spec, per = []);
    const idx = (e.team << 1) | (selected ? 1 : 0);
    let img = per[idx];
    if (!img) {
      img = document.createElement('canvas'); img.width = img.height = 40;
      this.paintIcon(img.getContext('2d'), e, 20, 22, selected);
      per[idx] = img;
    }
    c.drawImage(img, Math.round(x) - 20, Math.round(y) - 22);
  }

  paintIcon(c, e, x, y, selected) {
    const s = e.spec;
    const col = TEAM_CSS[e.team] || '#aaa';
    const r = e.kind === 'struct' ? 7 : s.role === 'exp' ? 11 : s.model === 'acu' ? 9 : 5.5;
    c.save();
    c.translate(x, y);
    c.lineWidth = selected ? 2.4 : 1.3;
    c.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.85)';
    c.fillStyle = col;
    c.beginPath();
    const icon = s.icon;
    if (e.kind === 'struct') { c.rect(-r, -r, r * 2, r * 2); }
    else if (s.move === 'air') { c.moveTo(0, -r * 1.1); c.lineTo(r * 1.1, r * 0.8); c.lineTo(0, r * 0.3); c.lineTo(-r * 1.1, r * 0.8); c.closePath(); }
    else if (s.move === 'naval') { c.moveTo(0, -r); c.lineTo(r * 1.2, 0); c.lineTo(0, r); c.lineTo(-r * 1.2, 0); c.closePath(); }
    else if (icon === 'cmd' || icon === 'scmd' || icon === 'exp') { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.5 : r * 1.15; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); }
    else if (icon === 'bot') { c.arc(0, 0, r, 0, 6.28); }
    else { c.rect(-r, -r * 0.8, r * 2, r * 1.6); }
    c.fill(); c.stroke();
    c.fillStyle = '#081018'; c.strokeStyle = '#081018'; c.lineWidth = 1.2;
    if (icon === 'nuke' || icon === 'antinuke' || icon === 'tml' || icon === 'tmd') {
      // missile-system icons drawn as shapes (no font dependency): rocket, rocket in a ring, small rocket, crosshair ring
      c.fillStyle = '#081018'; c.strokeStyle = '#081018'; c.lineWidth = 1.4;
      const rocket = (k, ox = 0) => { c.beginPath(); c.moveTo(ox, -5 * k); c.lineTo(ox + 1.9 * k, -1.5 * k); c.lineTo(ox + 1.9 * k, 3.5 * k); c.lineTo(ox + 3.4 * k, 5.5 * k); c.lineTo(ox - 3.4 * k, 5.5 * k); c.lineTo(ox - 1.9 * k, 3.5 * k); c.lineTo(ox - 1.9 * k, -1.5 * k); c.closePath(); c.fill(); };
      if (icon === 'nuke') { rocket(1.15); c.fillStyle = '#ffd040'; c.beginPath(); c.arc(0, -0.5, 1.5, 0, 6.28); c.fill(); }
      else if (icon === 'antinuke') { rocket(0.8); c.beginPath(); c.arc(0, 0.5, 6, Math.PI, 0); c.stroke(); }
      else if (icon === 'tml') { c.save(); c.rotate(0.6); rocket(0.85); c.restore(); }
      else { c.beginPath(); c.arc(0, 0, 3.6, 0, 6.28); c.stroke(); c.beginPath(); c.moveTo(-6, 0); c.lineTo(6, 0); c.moveTo(0, -6); c.lineTo(0, 6); c.stroke(); }
    }
    const g = { scmd: 'S', eng: 'E', arty: '▲', aa: '^', mex: 'M', pgen: 'E', fac_land: 'L', fac_air: 'A', fac_naval: 'N', pd: '+', aa_s: '^', torp: 'T', radar: 'R', shield: 'S', arty_s: '▲', store: '◦', mfab: 'F', transport: 't', scout: 'o', bomber: 'b', gunship: 'g', fighter: 'f', sub: 's', tank: '', frigate: '', destroyer: 'D', cruiser: 'C', battleship: 'B' }[icon];
    if (g) { c.font = `bold ${e.kind === 'struct' ? 10 : 8}px Rajdhani, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(g, 0, 0.5); }
    else if (icon === 'tank') { c.beginPath(); c.moveTo(-r, -r * 0.8); c.lineTo(r, r * 0.8); c.moveTo(r, -r * 0.8); c.lineTo(-r, r * 0.8); c.stroke(); }
    const tier = s.tier >= 4 ? 0 : s.tier;
    for (let i = 0; i < tier; i++) { c.fillStyle = '#fff'; c.fillRect(-r + 1 + i * 3.5, -r - 5, 2.5, 2.5); }
    c.restore();
  }
}
