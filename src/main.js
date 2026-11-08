// Seat Sightline: seat map + first-person 3D view + booking UI.
import * as THREE from 'three';
import { D2R, R2D, EYE_H, HEAD_H, clamp, hashStr, rng, buildSeats, focusInfo, fwdOf, eyeOf, headOf, validateVenue } from './venue.js';
import { metrics, assess, setSightlineContext } from './sightlines.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- State ---------- */
let venueKey = 'cinema';
let venue = null;
const presetCache = {};
let seats = [], rowsByKey = {}, bounds = null, focus = null;
let viewing = -1;
let cart = new Set();

function clone(o) { return JSON.parse(JSON.stringify(o)); }
const money = n => `${venue?.currency || 'EGP'} ${Number(n).toLocaleString('en-US')}`;

/* ---------- 3D ---------- */
const host = document.getElementById('stage3d');
let renderer = null, scene, camera, group, animators = [], filmTex = null, filmCtx = null;
let seatMeshes = [], personHead = null, personBody = null, personIndex = new Map();
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  host.prepend(renderer.domElement);
} catch (e) { console.error('WebGL init failed', e); renderer = null; document.getElementById('glmsg').hidden = false; }

scene = new THREE.Scene();
camera = new THREE.PerspectiveCamera(58, 16 / 10, 0.05, 900);

function disposeDeep(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}

function makeFilmCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function drawFilm(ctx, W, H, t) {
  const k = (Math.sin(t * 0.06) + 1) / 2;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${215 - 25 * k},55%,${22 + 18 * (1 - k)}%)`);
  g.addColorStop(0.55, `hsl(${28 + 12 * (1 - k)},78%,${58 - 8 * k}%)`);
  g.addColorStop(1, 'hsl(18,55%,22%)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'hsla(42,100%,78%,.95)';
  ctx.beginPath(); ctx.arc(W * 0.66, H * (0.3 + 0.22 * k), H * 0.085, 0, Math.PI * 2); ctx.fill();
  const layers = [[0.58, 26, 0.004, 6, 'hsla(250,25%,38%,.9)'], [0.66, 18, 0.007, 12, 'hsla(255,25%,24%,.95)'], [0.74, 12, 0.012, 22, 'hsl(260,25%,13%)']];
  for (const [base, amp, fr, sp, col] of layers) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, H * base + Math.sin((x + t * sp) * fr) * amp + Math.sin((x + t * sp) * fr * 2.7) * amp * 0.4);
    ctx.lineTo(W, H); ctx.fill();
  }
  ctx.fillStyle = 'hsl(205,45%,18%)'; ctx.fillRect(0, H * 0.82, W, H * 0.18);
  ctx.strokeStyle = 'hsla(40,90%,75%,.5)'; ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) { const y = H * 0.84 + i * 5, x = W * 0.66 + Math.sin(t * 1.3 + i) * 14; ctx.beginPath(); ctx.moveTo(x - 30 + i * 2, y); ctx.lineTo(x + 30 - i * 2, y); ctx.stroke(); }
  const a = clamp(Math.sin(t * 0.25) * 1.6 - 0.4, 0, 1);
  if (a > 0) { ctx.fillStyle = `rgba(255,244,225,${a})`; ctx.font = `800 ${H * 0.13}px "Big Shoulders Display", Impact, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('THE LONG COAST', W / 2, H * 0.24); }
}

function pitchTexture(L, W) {
  const m = 6, s = 8, c = document.createElement('canvas');
  c.width = Math.round((L + m * 2) * s); c.height = Math.round((W + m * 2) * s);
  const x = c.getContext('2d');
  for (let i = 0; i < 18; i++) { x.fillStyle = i % 2 ? '#2f6b39' : '#357a40'; x.fillRect(i * c.width / 18, 0, c.width / 18 + 1, c.height); }
  x.strokeStyle = 'rgba(255,255,255,.85)'; x.lineWidth = 0.14 * s;
  const X = v => (v + L / 2 + m) * s, Y = v => (v + W / 2 + m) * s;
  x.strokeRect(X(-L / 2), Y(-W / 2), L * s, W * s);
  x.beginPath(); x.moveTo(X(0), Y(-W / 2)); x.lineTo(X(0), Y(W / 2)); x.stroke();
  x.beginPath(); x.arc(X(0), Y(0), 9.15 * s, 0, Math.PI * 2); x.stroke();
  for (const sgn of [-1, 1]) {
    const gx = sgn * L / 2;
    x.strokeRect(Math.min(X(gx), X(gx - sgn * 16.5)), Y(-20.16), 16.5 * s, 40.32 * s);
    x.strokeRect(Math.min(X(gx), X(gx - sgn * 5.5)), Y(-9.16), 5.5 * s, 18.32 * s);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return { tex: t, w: L + m * 2, h: W + m * 2 };
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

function build3D() {
  if (!renderer) return;
  if (group) { scene.remove(group); disposeDeep(group); }
  group = new THREE.Group(); scene.add(group); animators = []; filmTex = null; personIndex = new Map();
  const f = venue.focus, b = bounds, add = o => { group.add(o); return o; };
  const indoor = venue.indoor !== false;
  scene.background = new THREE.Color(indoor ? 0x050404 : 0x0a1424);
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });

  let topY = 0;
  if (indoor) {
    const minX = Math.min(b.minX, -(f.width || 0) / 2) - 2.5, maxX = Math.max(b.maxX, (f.width || 0) / 2) + 2.5;
    const minZ = f.type === 'stage' ? -f.depth - 1.5 : -1.2, maxZ = b.maxZ + 2.5;
    topY = Math.max(b.maxY + 4, f.type === 'screen' ? f.bottom + f.height + 1.6 : f.height + 9.5);
    const room = add(new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, topY, maxZ - minZ), std(0x1b1614, { side: THREE.BackSide })));
    room.position.set((minX + maxX) / 2, topY / 2, (minZ + maxZ) / 2);
    const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), std(0x24191a)));
    floor.rotation.x = -Math.PI / 2; floor.position.set((minX + maxX) / 2, 0.005, (minZ + maxZ) / 2);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xf0a84a });
    for (let z = minZ + 3; z < maxZ - 1; z += 3.2) for (const x of [minX + 0.03, maxX - 0.03]) {
      const l = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 1.1), lampMat)); l.position.set(x, 2.6, z);
    }
    add(new THREE.HemisphereLight(0xfff1e0, 0x1a1210, 0.32));
  } else {
    const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(420, 420), std(0x1a2622)));
    ground.rotation.x = -Math.PI / 2;
    add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2a1a, 1.0));
    const sun = add(new THREE.DirectionalLight(0xffffff, 1.3)); sun.position.set(30, 80, 40);
  }

  if (f.type === 'screen') {
    const cy = f.bottom + f.height / 2;
    const mask = add(new THREE.Mesh(new THREE.BoxGeometry(f.width + 1.4, f.height + 1.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x020202 })));
    mask.position.set(0, cy, -0.1);
    const c = makeFilmCanvas(640, Math.round(640 * f.height / f.width));
    filmCtx = c.getContext('2d'); filmTex = new THREE.CanvasTexture(c); filmTex.colorSpace = THREE.SRGBColorSpace;
    const scr = add(new THREE.Mesh(new THREE.PlaneGeometry(f.width, f.height), new THREE.MeshBasicMaterial({ map: filmTex })));
    scr.position.set(0, cy, 0);
    const pl = add(new THREE.PointLight(0xd9e2ff, 0.9, 0, 0)); pl.position.set(0, cy, 6);
  } else if (f.type === 'stage') {
    const deck = add(new THREE.Mesh(new THREE.BoxGeometry(f.width + 2, f.height, f.depth), std(0x5e4029)));
    deck.position.set(0, f.height / 2, -f.depth / 2);
    const c = makeFilmCanvas(640, 320);
    filmCtx = c.getContext('2d'); filmTex = new THREE.CanvasTexture(c); filmTex.colorSpace = THREE.SRGBColorSpace;
    const back = add(new THREE.Mesh(new THREE.PlaneGeometry(f.width, 7), new THREE.MeshStandardMaterial({ map: filmTex, emissive: 0xffffff, emissiveMap: filmTex, emissiveIntensity: 0.55, roughness: 1 })));
    back.position.set(0, f.height + 3.5, -f.depth + 0.05);
    const prosc = std(0x4a1119);
    for (const sx of [-1, 1]) {
      const p = add(new THREE.Mesh(new THREE.BoxGeometry(1.4, f.height + 8.2, 0.8), prosc)); p.position.set(sx * (f.width / 2 + 0.7), (f.height + 8.2) / 2, 0.2);
      const cur = add(new THREE.Mesh(new THREE.BoxGeometry(1.9, 7.2, 0.2), std(0x8c1b28))); cur.position.set(sx * (f.width / 2 - 0.95), f.height + 3.6, -0.3);
    }
    const lintel = add(new THREE.Mesh(new THREE.BoxGeometry(f.width + 2.8, 1.6, 0.8), prosc)); lintel.position.set(0, f.height + 7.4, 0.2);
    const cols = [0xd8c9a8, 0x2e5d8a, 0xa8423a];
    cols.forEach((col, i) => {
      const actor = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 1.15, 4, 10), std(col)));
      const bx = (i - 1) * 3.2, bz = -f.depth * 0.45 + (i % 2) * 1.2;
      actor.position.set(bx, f.height + 0.85, bz);
      animators.push(t => { actor.position.x = bx + Math.sin(t * 0.35 + i * 2) * 1.4; actor.position.z = bz + Math.cos(t * 0.27 + i) * 0.6; });
    });
    const spot = add(new THREE.SpotLight(0xffe6c0, 2.4, 0, 0.5, 0.5, 0)); spot.position.set(0, topY - 1, 9);
    spot.target.position.set(0, f.height, -f.depth / 2); add(spot.target);
    const fill = add(new THREE.PointLight(0xffd7a8, 0.5, 0, 0)); fill.position.set(0, f.height + 3, -2);
  } else {
    const p = pitchTexture(f.length, f.width);
    const pitch = add(new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshStandardMaterial({ map: p.tex, roughness: 1 })));
    pitch.rotation.x = -Math.PI / 2; pitch.position.y = 0.02;
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) { const post = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.44, 0.12), white)); post.position.set(sx * f.length / 2, 1.22, sz * 3.66); }
      const bar = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 7.44), white)); bar.position.set(sx * f.length / 2, 2.44, 0);
    }
    const standMat = std(0x2a3546);
    const s1 = add(new THREE.Mesh(new THREE.BoxGeometry(110, 0.6, 20), standMat)); s1.position.set(0, 6, -f.width / 2 - 16); s1.rotation.x = 0.52;
    const s2 = add(new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, 74), standMat)); s2.position.set(-f.length / 2 - 16, 6, 0); s2.rotation.z = -0.52;
    const poleMat = std(0x5d6672), headMat = new THREE.MeshBasicMaterial({ color: 0xfff6dd });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pole = add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 42, 8), poleMat)); pole.position.set(sx * 74, 21, sz * 56);
      const head = add(new THREE.Mesh(new THREE.BoxGeometry(7, 3, 0.6), headMat)); head.position.set(sx * 74, 42, sz * 56); head.lookAt(0, 0, 0);
    }
    const kits = [0x1f5fbf, 0xe8e2d4];
    for (let i = 0; i < 22; i++) {
      const team = i < 11 ? 0 : 1, side = team ? 1 : -1;
      const pl = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 8), std(kits[team])));
      const r = rng(i * 97 + 3), bx = side * (6 + r() * 40), bz = (r() - 0.5) * 56, ph = r() * 6;
      pl.position.set(bx, 0.9, bz);
      animators.push(t => { pl.position.x = bx + Math.sin(t * 0.3 + ph) * 6 - side * Math.sin(t * 0.12) * 8; pl.position.z = bz + Math.cos(t * 0.25 + ph) * 4; });
    }
    const ball = add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), white));
    animators.push(t => { ball.position.set(Math.sin(t * 0.12) * 28, 0.35, Math.sin(t * 0.31) * 12); });
  }

  // Seats, risers and audience, all instanced
  const n = seats.length;
  const seatColor = new THREE.Color(venue.seatColor || (f.type === 'pitch' ? '#2259a8' : f.type === 'stage' ? '#6e1d2e' : '#7a2229'));
  const cushionG = new THREE.BoxGeometry(0.48, 0.13, 0.5); cushionG.translate(0, 0.45, 0.02);
  const backG = new THREE.BoxGeometry(0.48, 0.58, 0.1); backG.translate(0, 0.76, -0.24);
  const seatMat = std(0xffffff, { roughness: 0.9 });
  const cushion = add(new THREE.InstancedMesh(cushionG, seatMat, n));
  const back = add(new THREE.InstancedMesh(backG, seatMat, n));
  const riserCount = seats.filter(s => s.y > 0.02).length;
  const riser = add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), std(indoor ? 0x2a201b : 0x3b4553), Math.max(1, riserCount)));
  riser.count = riserCount;
  const takenSeats = seats.filter(s => s.taken);
  personHead = add(new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 12, 8), std(0xffffff), Math.max(1, takenSeats.length)));
  personBody = add(new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.55, 0.26), std(0xffffff), Math.max(1, takenSeats.length)));
  personHead.count = personBody.count = takenSeats.length;
  const skin = ['#3b2a20', '#5a3d2b', '#7a5640', '#2a1d16', '#8d6a50'].map(c => new THREE.Color(c));
  const shirts = (f.type === 'pitch' ? ['#1f5fbf', '#1f5fbf', '#e8e2d4', '#16357a', '#d9d9d9'] : ['#2b2b33', '#3a2f2a', '#20303a', '#402a2a', '#33343a']).map(c => new THREE.Color(c));
  const rand = rng(hashStr(venue.name + 'p'));
  let ri = 0, pi = 0;
  seats.forEach((s, i) => {
    tmpQ.setFromAxisAngle(UP, s.a + Math.PI);
    tmpM.compose(tmpP.set(s.x, s.y, s.z), tmpQ, tmpS.set(s.sw / 0.55, 1, 1));
    cushion.setMatrixAt(i, tmpM); back.setMatrixAt(i, tmpM);
    cushion.setColorAt(i, seatColor); back.setColorAt(i, seatColor);
    if (s.y > 0.02) { tmpM.compose(tmpP.set(s.x, s.y / 2, s.z), tmpQ, tmpS.set(s.sw, s.y, s.depth)); riser.setMatrixAt(ri++, tmpM); }
    if (s.taken) {
      const fw = fwdOf(s);
      tmpM.compose(tmpP.set(s.x - fw.x * 0.08, s.y + HEAD_H, s.z - fw.z * 0.08), tmpQ, tmpS.set(1, 1.1, 1)); personHead.setMatrixAt(pi, tmpM);
      tmpM.compose(tmpP.set(s.x - fw.x * 0.05, s.y + 0.78, s.z - fw.z * 0.05), tmpQ, tmpS.set(1, 1, 1)); personBody.setMatrixAt(pi, tmpM);
      personHead.setColorAt(pi, skin[Math.floor(rand() * skin.length)]); personBody.setColorAt(pi, shirts[Math.floor(rand() * shirts.length)]);
      personIndex.set(i, pi); pi++;
    }
  });
  seatMeshes = [cushion, back];
  [cushion, back, riser, personHead, personBody].forEach(m => { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  paintSeats3D();
}

const hiddenPerson = { i: -1, m: null };
function paintSeats3D() {
  if (!renderer || !seatMeshes.length) return;
  const f = venue.focus;
  const base = new THREE.Color(venue.seatColor || (f.type === 'pitch' ? '#2259a8' : f.type === 'stage' ? '#6e1d2e' : '#7a2229'));
  const amber = new THREE.Color('#f0b44c');
  seats.forEach((s, i) => { const c = cart.has(i) ? amber : base; seatMeshes.forEach(m => m.setColorAt(i, c)); });
  seatMeshes.forEach(m => m.instanceColor.needsUpdate = true);
  // hide the person sitting in the seat we are viewing from
  if (hiddenPerson.i >= 0) { personHead.setMatrixAt(hiddenPerson.i, hiddenPerson.mh); personBody.setMatrixAt(hiddenPerson.i, hiddenPerson.mb); hiddenPerson.i = -1; }
  if (viewing >= 0 && personIndex.has(viewing)) {
    const pi = personIndex.get(viewing), mh = new THREE.Matrix4(), mb = new THREE.Matrix4();
    personHead.getMatrixAt(pi, mh); personBody.getMatrixAt(pi, mb);
    Object.assign(hiddenPerson, { i: pi, mh, mb });
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    personHead.setMatrixAt(pi, zero); personBody.setMatrixAt(pi, zero);
  }
  personHead.instanceMatrix.needsUpdate = personBody.instanceMatrix.needsUpdate = true;
}

/* ---------- Camera: fly + drag-to-look ---------- */
const cam = { pos: new THREE.Vector3(0, 10, 30), look: new THREE.Vector3() };
let uYaw = 0, uPitch = 0, fly = null;
function lookDir() {
  const d = cam.look.clone().sub(cam.pos).normalize();
  const yaw = Math.atan2(d.x, d.z) + uYaw, pitch = clamp(Math.asin(clamp(d.y, -1, 1)) + uPitch, -1.45, 1.45);
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}
function applyCam() { camera.position.copy(cam.pos); camera.lookAt(cam.pos.clone().add(lookDir())); }
function flyTo(pos, look, dur = 1400) {
  const dir = lookDir();
  const from = { pos: cam.pos.clone(), look: cam.pos.clone().addScaledVector(dir, Math.max(5, cam.pos.distanceTo(look))) };
  uYaw = uPitch = 0;
  if (reduceMotion || dur === 0) { cam.pos.copy(pos); cam.look.copy(look); fly = null; return; }
  fly = { from, to: { pos: pos.clone(), look: look.clone() }, t0: performance.now(), dur, lift: Math.min(8, from.pos.distanceTo(pos) * 0.18) };
}
function overviewPose() {
  const b = bounds, f = venue.focus;
  if (venue.indoor === false) return { pos: new THREE.Vector3(30, 62, 105), look: new THREE.Vector3(0, 0, 0) };
  const topY = Math.max(b.maxY + 4, f.type === 'screen' ? f.bottom + f.height + 1.6 : f.height + 9.5);
  return { pos: new THREE.Vector3(0, topY - 0.8, b.maxZ + 1.8), look: new THREE.Vector3(0, 0.5, b.maxZ * 0.3) };
}
function seatPose(s) { return { pos: eyeOf(s), look: focus.target.clone() }; }

if (renderer) {
  const el = renderer.domElement; let drag = null;
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw: uYaw, pitch: uPitch }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (!drag || fly) return;
    const k = 2.2 / el.clientWidth;
    uYaw = clamp(drag.yaw + (e.clientX - drag.x) * k, -2.4, 2.4);
    uPitch = clamp(drag.pitch + (e.clientY - drag.y) * k, -1.2, 1.2);
  });
  const end = () => { drag = null; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { uYaw = uPitch = 0; });
}
document.getElementById('btnReset').onclick = () => { uYaw = uPitch = 0; if (viewing >= 0 && !fly) { const p = seatPose(seats[viewing]); cam.pos.copy(p.pos); cam.look.copy(p.look); } };
document.getElementById('btnOverview').onclick = () => { const p = overviewPose(); flyTo(p.pos, p.look, 1300); document.getElementById('ovSeat').innerHTML = '<b>Overview</b> · pick a seat to fly in'; };

function resize() {
  if (!renderer) return;
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);

let visible = true;
new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(host);
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer || !visible) return;
  const t = now / 1000;
  if (fly) {
    const k = clamp((now - fly.t0) / fly.dur, 0, 1), e = ease(k);
    cam.pos.lerpVectors(fly.from.pos, fly.to.pos, e); cam.pos.y += Math.sin(Math.PI * e) * fly.lift;
    cam.look.lerpVectors(fly.from.look, fly.to.look, e);
    if (k >= 1) fly = null;
  }
  if (filmTex) { drawFilm(filmCtx, filmCtx.canvas.width, filmCtx.canvas.height, t * 6); filmTex.needsUpdate = true; }
  for (const a of animators) a(t);
  applyCam();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

/* ---------- Seat map (SVG) ---------- */
const svg = document.getElementById('map');
let vbFit = null, vb = null;
function buildMap() {
  const f = venue.focus, b = bounds;
  let minX = b.minX, maxX = b.maxX, minZ = b.minZ, maxZ = b.maxZ;
  if (f.type === 'screen') { minX = Math.min(minX, -f.width / 2); maxX = Math.max(maxX, f.width / 2); minZ = Math.min(minZ, -1.4); }
  if (f.type === 'stage') { minX = Math.min(minX, -f.width / 2 - 1); maxX = Math.max(maxX, f.width / 2 + 1); minZ = Math.min(minZ, -f.depth); }
  if (f.type === 'pitch') { minX = Math.min(minX, -f.length / 2); maxX = Math.max(maxX, f.length / 2); minZ = Math.min(minZ, -f.width / 2); maxZ = Math.max(maxZ, f.width / 2); }
  const pad = Math.max(1.2, (maxX - minX) * 0.04);
  vbFit = { x: minX - pad, y: minZ - pad, w: maxX - minX + pad * 2, h: maxZ - minZ + pad * 2 };
  vb = { ...vbFit };
  const fs = vbFit.w / 42;
  let h = '';
  if (f.type === 'screen') {
    h += `<rect class="focus-soft" x="${-f.width / 2}" y="-0.2" width="${f.width}" height="${Math.min(4, b.minZ - 0.6)}" />`;
    h += `<rect class="focus" x="${-f.width / 2}" y="-1" width="${f.width}" height="0.8" rx="0.2"/>`;
    h += `<text class="focus-txt" x="0" y="-0.38" font-size="0.62" text-anchor="middle">SCREEN</text>`;
  } else if (f.type === 'stage') {
    h += `<rect class="focus-soft" x="${-f.width / 2 - 1}" y="${-f.depth}" width="${f.width + 2}" height="${f.depth}" rx="0.4"/>`;
    h += `<rect class="focus" x="${-f.width / 2 - 1}" y="-0.6" width="${f.width + 2}" height="0.6"/>`;
    h += `<text class="lbl" x="0" y="${-f.depth / 2}" font-size="${fs * 1.4}" text-anchor="middle" style="fill:var(--accent);font-family:var(--font-display);font-weight:800;letter-spacing:.1em">STAGE</text>`;
  } else {
    const L = f.length / 2, W = f.width / 2;
    h += `<rect class="pitch" x="${-L}" y="${-W}" width="${f.length}" height="${f.width}"/>`;
    h += `<rect class="pitch-line" x="${-L}" y="${-W}" width="${f.length}" height="${f.width}"/><line class="pitch-line" x1="0" y1="${-W}" x2="0" y2="${W}"/><circle class="pitch-line" cx="0" cy="0" r="9.15"/>`;
    h += `<rect class="pitch-line" x="${-L}" y="-20.16" width="16.5" height="40.32"/><rect class="pitch-line" x="${L - 16.5}" y="-20.16" width="16.5" height="40.32"/>`;
  }
  // section labels + row labels
  venue.sections.forEach((s, si) => {
    const first = seats.filter(x => x.section === si && x.rowIndex === 0);
    if (!first.length) return;
    const mid = first[Math.floor(first.length / 2)], fw = fwdOf(mid), off = s.rowDepth * 0.9 + fs * 0.4;
    const lx = mid.x + fw.x * off, lz = mid.z + fw.z * off;
    const rot = s.layout === 'arc' || s.angle ? ` transform="rotate(${(-mid.a * R2D).toFixed(2)} ${lx} ${lz})"` : '';
    h += `<text class="sec" x="${lx}" y="${lz}" font-size="${fs * 0.75}" text-anchor="middle" dominant-baseline="middle"${rot}>${esc(s.name)} · ${esc(money(s.price))}</text>`;
  });
  const showRowLbl = vbFit.w < 70;
  for (const key in rowsByKey) {
    const ids = rowsByKey[key]; const s0 = seats[ids[0]];
    const dirx = Math.cos(s0.a), dirz = -Math.sin(s0.a);
    for (let i = 0; i < ids.length; i++) {
      const s = seats[ids[i]], w = s.sw * 0.82, d = Math.min(s.depth * 0.72, s.sw * 0.82);
      const rot = Math.abs(s.a) > 1e-4 ? ` transform="rotate(${(-s.a * R2D).toFixed(2)} ${s.x.toFixed(3)} ${s.z.toFixed(3)})"` : '';
      h += `<rect class="s${s.taken ? ' t' : ''}" data-i="${s.idx}" x="${(s.x - w / 2).toFixed(3)}" y="${(s.z - d / 2).toFixed(3)}" width="${w.toFixed(3)}" height="${d.toFixed(3)}" rx="${(w * 0.2).toFixed(3)}"${rot}/>`;
    }
    if (showRowLbl) {
      const off = s0.sw * 1.1;
      const lx = s0.x - dirx * off, lz = s0.z - dirz * off;
      h += `<text class="lbl" x="${lx.toFixed(2)}" y="${lz.toFixed(2)}" font-size="${(fs * 0.5).toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${esc(s0.row)}</text>`;
    }
  }
  h += `<line class="sight" id="sight" x1="0" y1="0" x2="0" y2="0" /><circle class="vring" id="vring" cx="0" cy="0" r="0"/>`;
  svg.innerHTML = h;
  setVB();
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function setVB() {
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.classList.toggle('zoomed', vb.w < vbFit.w * 0.98);
}
function zoomBy(k, cx, cy) {
  const nw = clamp(vb.w * k, vbFit.w * 0.08, vbFit.w), nh = nw * vbFit.h / vbFit.w;
  if (cx === undefined) { cx = vb.x + vb.w / 2; cy = vb.y + vb.h / 2; }
  const rx = (cx - vb.x) / vb.w, ry = (cy - vb.y) / vb.h;
  vb = { x: cx - rx * nw, y: cy - ry * nh, w: nw, h: nh }; clampVB(); setVB();
}
function clampVB() { vb.x = clamp(vb.x, vbFit.x, vbFit.x + vbFit.w - vb.w); vb.y = clamp(vb.y, vbFit.y, vbFit.y + vbFit.h - vb.h); }
function svgPoint(e) { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
document.getElementById('zin').onclick = () => zoomBy(0.6);
document.getElementById('zout').onclick = () => zoomBy(1 / 0.6);
document.getElementById('zfit').onclick = () => { vb = { ...vbFit }; setVB(); };
svg.addEventListener('wheel', e => { e.preventDefault(); const p = svgPoint(e); zoomBy(e.deltaY > 0 ? 1.15 : 0.87, p.x, p.y); }, { passive: false });

let pdown = null;
svg.addEventListener('pointerdown', e => {
  const t = e.target.closest('[data-i]');
  pdown = { x: e.clientX, y: e.clientY, vb: { ...vb }, seat: t ? +t.dataset.i : -1, moved: false };
});
window.addEventListener('pointermove', e => {
  if (!pdown) return;
  const dx = e.clientX - pdown.x, dy = e.clientY - pdown.y;
  if (Math.hypot(dx, dy) > 5) pdown.moved = true;
  if (pdown.moved && svg.classList.contains('zoomed')) {
    const r = svg.getBoundingClientRect(), sc = Math.max(vb.w / r.width, vb.h / r.height);
    vb.x = pdown.vb.x - dx * sc; vb.y = pdown.vb.y - dy * sc; clampVB(); setVB();
  }
});
window.addEventListener('pointerup', () => { if (pdown && !pdown.moved && pdown.seat >= 0) selectSeat(pdown.seat, true); pdown = null; });
window.addEventListener('pointercancel', () => { pdown = null; });

const hoverLine = document.getElementById('hoverLine');
svg.addEventListener('pointerover', e => {
  const t = e.target.closest('[data-i]'); if (!t) return;
  const s = seats[+t.dataset.i];
  hoverLine.textContent = `Row ${s.row} · Seat ${s.num} · ${s.sectionName} · ${money(s.price)} · ${s.taken ? 'Taken (you can still preview it)' : 'Available'}`;
});

svg.addEventListener('keydown', e => {
  if (viewing < 0) return;
  const s = seats[viewing]; let next = -1;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const ids = rowsByKey[s.rowKey], p = ids.indexOf(viewing) + (e.key === 'ArrowRight' ? 1 : -1);
    if (p >= 0 && p < ids.length) next = ids[p];
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const r = s.rowIndex + (e.key === 'ArrowDown' ? 1 : -1), ids = rowsByKey[`${s.section}-${r}`];
    if (ids) { const cur = rowsByKey[s.rowKey]; const frac = cur.indexOf(viewing) / Math.max(1, cur.length - 1); next = ids[Math.round(frac * (ids.length - 1))]; }
  } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCart(viewing); return; }
  if (next >= 0) { e.preventDefault(); selectSeat(next, true); }
});

function paintMap() {
  svg.querySelectorAll('.s.c, .s.v').forEach(el => el.classList.remove('c', 'v'));
  cart.forEach(i => svg.querySelector(`[data-i="${i}"]`)?.classList.add('c'));
  const ring = svg.querySelector('#vring'), sight = svg.querySelector('#sight');
  if (viewing >= 0) {
    const s = seats[viewing];
    svg.querySelector(`[data-i="${viewing}"]`)?.classList.add('v');
    ring.setAttribute('cx', s.x); ring.setAttribute('cy', s.z); ring.setAttribute('r', s.sw * 0.95);
    sight.setAttribute('x1', s.x); sight.setAttribute('y1', s.z); sight.setAttribute('x2', focus.target.x); sight.setAttribute('y2', focus.target.z);
  }
}

/* ---------- Card + cart ---------- */
const $ = id => document.getElementById(id);
function renderCard() {
  const s = seats[viewing], A = assess(s);
  $('cSection').textContent = `${s.sectionName}${s.taken ? ' · taken' : ''}`;
  $('cSeat').textContent = `Row ${s.row} · Seat ${s.num}`;
  $('cPrice').textContent = money(s.price);
  $('cVerdict').textContent = A.verdict;
  $('cWhy').textContent = A.why;
  const M = A.meter, pct = v => clamp((v - M.min) / (M.max - M.min) * 100, 0, 100);
  $('mLabel').textContent = `${M.label}: ${M.v.toFixed(M.unit === ' m' ? 1 : 0)}${M.unit}`;
  $('mBand').style.left = pct(M.band[0]) + '%'; $('mBand').style.width = (pct(M.band[1]) - pct(M.band[0])) + '%';
  $('mPin').style.left = pct(M.v) + '%';
  $('mMin').textContent = `${M.min}${M.unit}`; $('mMax').textContent = `${M.max}${M.unit}`; $('mBandLbl').textContent = M.bandLbl;
  $('cStats').innerHTML = A.stats.map(([k, v, u]) => `<div><dt>${k}</dt><dd>${v}<small>${u}</small></dd></div>`).join('');
  $('cWarn').innerHTML = A.warns.map(w => typeof w === 'string' ? `<li>${esc(w)}</li>` : `<li class="ok">${esc(w.text)}</li>`).join('');
  const btn = $('cAdd');
  btn.classList.remove('remove');
  if (s.taken) { btn.disabled = true; btn.textContent = 'Taken. You can preview it, not book it'; }
  else if (cart.has(viewing)) { btn.disabled = false; btn.classList.add('remove'); btn.textContent = 'Remove from booking'; }
  else { btn.disabled = false; btn.textContent = `Add Row ${s.row} · Seat ${s.num} · ${money(s.price)}`; }
  $('ovSeat').innerHTML = `<b>Row ${esc(s.row)} · Seat ${s.num}</b> · ${esc(s.sectionName)}`;
}
function renderCart() {
  const list = [...cart].map(i => seats[i]);
  $('total').textContent = money(list.reduce((a, s) => a + s.price, 0));
  $('chips').innerHTML = list.length ? list.map(s => `<span class="chip">${esc(s.row)}-${s.num} · ${esc(money(s.price))}<button type="button" data-rm="${s.idx}" aria-label="Remove Row ${esc(s.row)} Seat ${s.num}">×</button></span>`).join('') : '<p class="empty">No seats yet. Preview a seat, then add it.</p>';
  $('proceed').disabled = !list.length;
  $('status').hidden = true;
}
$('chips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) toggleCart(+b.dataset.rm); });
$('cAdd').onclick = () => toggleCart(viewing);
$('proceed').onclick = () => {
  const list = [...cart].map(i => `${seats[i].row}-${seats[i].num}`);
  $('status').textContent = `Prototype ends here. In a live app, seats ${list.join(', ')} would now be held for 10 minutes while you pay.`;
  $('status').hidden = false;
};
function toggleCart(i) {
  if (i < 0 || seats[i].taken) return;
  cart.has(i) ? cart.delete(i) : cart.add(i);
  renderCart(); renderCard(); paintMap(); paintSeats3D();
}

function selectSeat(i, animate) {
  viewing = i;
  const p = seatPose(seats[i]);
  flyTo(p.pos, p.look, animate ? 1500 : 0);
  renderCard(); paintMap(); paintSeats3D();
}

/* ---------- Venue loading ---------- */
function loadVenue(v, { intro = true } = {}) {
  validateVenue(v);
  venue = v;
  const r = buildSeats(v); seats = r.out; rowsByKey = r.byKey;
  bounds = seats.reduce((b, s) => ({ minX: Math.min(b.minX, s.x), maxX: Math.max(b.maxX, s.x), minZ: Math.min(b.minZ, s.z), maxZ: Math.max(b.maxZ, s.z), maxY: Math.max(b.maxY, s.y) }), { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9, maxY: 0 });
  focus = focusInfo(v);
  setSightlineContext(seats, focus);
  cart = new Set(); viewing = -1; hiddenPerson.i = -1;
  $('vname').textContent = v.name || 'Custom venue'; $('vsub').textContent = v.subtitle || '';
  build3D(); buildMap();
  // start on the best available seat for this venue
  let best = 0, bestScore = Infinity;
  seats.forEach((s, i) => {
    if (s.taken) return;
    const A = assess(s), M = A.meter, mid = (M.band[0] + M.band[1]) / 2;
    const score = Math.abs(M.v - mid) + (focus.type === 'pitch' ? Math.abs(s.x) * 0.2 : metrics(s).off * 0.4) + (A.warns.some(w => typeof w === 'string') ? 6 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  const o = overviewPose(); cam.pos.copy(o.pos); cam.look.copy(o.look); uYaw = uPitch = 0;
  viewing = best; renderCard(); renderCart(); paintMap(); paintSeats3D();
  if (intro) setTimeout(() => { if (viewing === best) selectSeat(best, true); }, 700); else selectSeat(best, false);
  $('json').value = JSON.stringify(v, null, 2); $('jsonErr').textContent = '';
}

async function getPreset(key) {
  if (!presetCache[key]) {
    const res = await fetch(`venues/${key}.json`);
    if (!res.ok) throw new Error(`Couldn't load venues/${key}.json (${res.status}).`);
    presetCache[key] = await res.json();
  }
  return clone(presetCache[key]);
}
async function openPreset(key) {
  venueKey = key;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.v === key ? 'true' : 'false'));
  try { loadVenue(await getPreset(key)); }
  catch (e) { $('ovSeat').textContent = e.message; }
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openPreset(b.dataset.v));
$('applyJson').onclick = () => {
  try { loadVenue(JSON.parse($('json').value)); }
  catch (e) { $('jsonErr').textContent = e instanceof SyntaxError ? `That isn't valid JSON: ${e.message}` : e.message; }
};
$('resetJson').onclick = () => openPreset(venueKey);

const start = new URLSearchParams(location.search).get('venue');
openPreset(['cinema', 'theatre', 'stadium'].includes(start) ? start : 'cinema');
resize();
