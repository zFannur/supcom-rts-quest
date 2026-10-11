// Model thumbnails for the HUD (build grid, factory queue, selection panel).
// After the GLB models are loaded every unit / structure model is rendered once into a small transparent
// offscreen WebGL canvas (3/4 view from above, team-tinted) and kept as an object URL in THUMBS.
// The generator is incremental (a few models per idle slot) and releases its WebGL context when done.
// UI only: not imported by the headless sim / AI code.
import * as THREE from 'three';
import { GLB, getModel } from './models.js';
import { ALL_SPECS, STRUCTS, TEAM_COLORS } from './specs.js';

// key -> object URL for team 1; other teams live under `${key}@${team}` (see thumbURL)
export const THUMBS = {};
const SIZE = 128, BATCH = 3;

export function thumbURL(key, team = 1) { return THUMBS[team === 1 ? key : key + '@' + team] || THUMBS[key] || null; }

// Model shown for a spec: experimental "assembly" structures share the xframe scaffold, so the menu shows the unit they build.
function modelOf(key) {
  const s = ALL_SPECS[key];
  if (!s) return null;
  return (s.spawnsUnit && ALL_SPECS[s.spawnsUnit]?.model) || s.model;
}

// HTML for a thumbnail slot; the glyph is the fallback until the model image is ready (then applyThumbs fills it in).
export function thumbHTML(key, team, glyph, cls = '') {
  const t = team || 1, url = thumbURL(key, t), has = !!THUMBS[t === 1 ? key : key + '@' + t];
  return `<span class="th ${cls}${has ? ' has' : ''}" data-th="${key}" data-tm="${t}"${has ? ` style="background-image:url(${url})"` : ''}>${glyph}</span>`;
}
// Fill every not-yet-filled slot under `root` (called after each generated batch).
export function applyThumbs(root = document) {
  for (const el of root.querySelectorAll('.th:not(.has)')) {
    const t = +el.dataset.tm || 1, k = el.dataset.th;
    if (!THUMBS[t === 1 ? k : k + '@' + t]) continue;
    el.style.backgroundImage = `url(${thumbURL(k, t)})`; el.classList.add('has');
  }
}

// ------------------------------------------------------------------ scene building
function glbModel(renderer, key, team, kind) {
  const model = GLB[key].scene.clone();
  model.traverse(o => { if (o.isMesh) { o.material = renderer.teamMaterial(o.material, team, kind); o.castShadow = o.receiveShadow = false; } });
  return model;
}
// procedural fallback: merged body + glow + turret sub-meshes (no animation)
function procModel(key, team, mats) {
  const { geoms: g, meta } = getModel(key, TEAM_COLORS[team] || 0x888888), root = new THREE.Group();
  if (g.body) root.add(new THREE.Mesh(g.body, mats.body));
  if (g.glow) root.add(new THREE.Mesh(g.glow, mats.glow));
  (meta.turrets || []).forEach((t, i) => {
    const piv = new THREE.Group(); piv.position.set(...t.pos);
    if (g['t' + i]) piv.add(new THREE.Mesh(g['t' + i], mats.body));
    if (g['glowt' + i]) piv.add(new THREE.Mesh(g['glowt' + i], mats.glow));
    root.add(piv);
  });
  // silo doors: shown half-open with the missile standing in the shaft
  (meta.hatches || []).forEach((h, i) => {
    if (!g['h' + i]) return;
    const piv = new THREE.Group(); piv.position.set(...h.pos);
    if (h.lift) piv.position.y += h.lift * 0.55; else piv.rotation[h.axis] = h.open * 0.55;
    piv.add(new THREE.Mesh(g['h' + i], mats.body)); root.add(piv);
  });
  if (meta.legs && g.legL) for (const [k, side] of [['legL', -1], ['legR', 1]]) { const piv = new THREE.Group(); piv.position.set(0, meta.legs.hipY, side * meta.legs.spread); piv.add(new THREE.Mesh(g[k], mats.body)); root.add(piv); }
  return root;
}

// Camera distance / centre that fit the model's box corners into the frame for a given view direction.
function frame(cam, box, dir) {
  const c = box.getCenter(new THREE.Vector3()), t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  cam.up.set(0, 1, 0);
  const fwd = dir.clone().negate().normalize(), right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).sub(c));
  // 2D extents in the view plane first, to re-centre the frame on the silhouette
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of corners) { const px = p.dot(right), py = p.dot(up); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2, target = c.clone().addScaledVector(right, ox).addScaledVector(up, oy);
  let D = 0;
  for (const p of corners) {
    const px = p.dot(right) - ox, py = p.dot(up) - oy, pz = p.dot(fwd); // pz > 0 is away from the camera
    D = Math.max(D, Math.abs(px) / t - pz, Math.abs(py) / t - pz);
  }
  D *= 1.08;
  cam.position.copy(target).addScaledVector(dir, D);
  cam.near = D * 0.05; cam.far = D * 4; cam.updateProjectionMatrix();
  cam.lookAt(target);
}

/** Render thumbnails for every spec for the given team ids. `renderer` is the game Renderer (its teamMaterial keeps the team tint identical). */
export function generateThumbs(renderer, teams = [1, 2], opt = {}) {
  const lite = !!opt.lite, batch = lite ? 1 : BATCH, budget = lite ? 6 : 40;   // lite (Quest): one model per idle slot, so VR frames do not spike
  const jobs = [], done = new Map();
  for (const team of teams) for (const key of Object.keys(ALL_SPECS)) { const m = modelOf(key); if (m) jobs.push({ key, model: m, team, kind: STRUCTS[key] ? 'struct' : 'unit' }); }
  if (!jobs.length) return Promise.resolve();
  if (lite) jobs.sort((a, b) => (b.kind === 'struct') - (a.kind === 'struct'));   // build cards first
  let gl;
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
    gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  } catch (e) { console.warn('thumbs: no WebGL', e); return Promise.resolve(); }
  gl.setPixelRatio(1); gl.setSize(SIZE, SIZE, false); gl.setClearColor(0x000000, 0);
  gl.outputColorSpace = THREE.SRGBColorSpace; gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.15;
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(28, 1, 0.1, 1000);
  const hemi = new THREE.HemisphereLight(0xdbe8ff, 0x4a4438, 0.9);
  const key = new THREE.DirectionalLight(0xfff2dd, 2.6); key.position.set(-0.6, 1.2, 1).multiplyScalar(50);
  const rim = new THREE.DirectionalLight(0x9cc8ff, 0.9); rim.position.set(1, 0.4, -1).multiplyScalar(50);
  scene.add(hemi, key, rim);
  // soft contact shadow under the model
  const sc = document.createElement('canvas'); sc.width = sc.height = 64;
  const sx = sc.getContext('2d'), grad = sx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)'); sx.fillStyle = grad; sx.fillRect(0, 0, 64, 64);
  const shadowTex = new THREE.CanvasTexture(sc);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  const mats = { body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.5 }), glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }) };
  const dir = new THREE.Vector3(0.85, 0.62, 0.95).normalize(); // front is +X: look at the nose from the right, above

  const render = (job) => {
    const id = job.model + ':' + job.team;
    if (done.has(id)) return Promise.resolve(done.get(id));
    let obj;
    try { obj = GLB[job.model] ? glbModel(renderer, job.model, job.team, job.kind) : procModel(job.model, job.team, mats); } catch (e) { return Promise.resolve(null); }
    const wrap = new THREE.Group(); wrap.add(obj); scene.add(wrap); wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    if (box.isEmpty()) { scene.remove(wrap); return Promise.resolve(null); }
    const sz = box.getSize(new THREE.Vector3()), r = Math.max(sz.x, sz.z) * 0.62;
    shadow.scale.set(r * 2.1, 1, r * 2.1); shadow.position.set((box.min.x + box.max.x) / 2, box.min.y + 0.02, (box.min.z + box.max.z) / 2); scene.add(shadow);
    frame(cam, box, dir);
    gl.clear(); gl.render(scene, cam);
    scene.remove(wrap, shadow);
    return new Promise(res => gl.domElement.toBlob(b => { const u = b ? URL.createObjectURL(b) : null; done.set(id, u); res(u); }, 'image/png'));
  };

  return new Promise(resolve => {
    let i = 0;
    const finish = () => {
      for (const m of [mats.body, mats.glow, shadow.material]) m.dispose();
      shadow.geometry.dispose(); shadowTex.dispose();
      gl.dispose(); gl.forceContextLoss();
      resolve();
    };
    const step = async () => {
      const t0 = performance.now();
      for (let n = 0; n < batch && i < jobs.length && performance.now() - t0 < budget; n++, i++) {
        const j = jobs[i], url = await render(j);
        if (url) THUMBS[j.team === 1 ? j.key : j.key + '@' + j.team] = url;
      }
      applyThumbs();
      if (i < jobs.length) schedule(); else finish();
    };
    const schedule = () => (window.requestIdleCallback ? requestIdleCallback(step, { timeout: lite ? 400 : 200 }) : setTimeout(step, lite ? 50 : 16));
    schedule();
  });
}
