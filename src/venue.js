// Turns venue JSON into seats with real-world positions (metres).
// Coordinate system: the focus (screen / stage front / pitch centre) sits at the origin,
// the audience is on +z, y is up. Seat angle `a` = direction the seat faces, measured from -z.
import * as THREE from 'three';

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const EYE_H = 1.18, HEAD_H = 1.12; // seated eye / head-centre height above the seat's floor

export function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function rowName(i) { const L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; return i < L.length ? L[i] : L[Math.floor(i / L.length) - 1] + L[i % L.length]; }

// A row "pattern" spells the row left to right: S seat, F folding seat, D driver, _ gap (aisleWidth wide).
const pick = (v, r) => Array.isArray(v) ? v[Math.min(r, v.length - 1)] : v;

// Where each seat in a row sits across the row (offset from the row's centre) and what kind of spot it is.
function rowSlots(s, r, sw) {
  const pat = pick(s.pattern, r);
  if (pat) {
    const aw = s.aisleWidth ?? sw, cells = [...pat];
    const span = cells.reduce((a, c) => a + (c === '_' ? aw : sw), 0);
    const list = []; let cur = -span / 2;
    cells.forEach((c, ci) => {
      if (c === '_') { cur += aw; return; }
      const edge = !cells.slice(0, ci).some(k => k !== '_') || !cells.slice(ci + 1).some(k => k !== '_');
      const byGap = aw >= 0.25 && (cells[ci - 1] === '_' || cells[ci + 1] === '_');   // a narrow gap is not an aisle
      list.push({ off: cur + sw / 2, kind: c === 'D' ? 'driver' : c === 'F' ? 'folding' : 'seat', edge, spot: c === 'F' ? 'Folding' : edge ? 'Window' : byGap ? 'Aisle' : 'Middle' });
      cur += sw;
    });
    return { list, span };
  }
  const n = pick(s.seats, r), aisle = s.aisle || 0;
  const gaps = aisle && n > aisle * 2 + 2 ? 2 : 0, span = (n + gaps) * sw, list = [];
  for (let i = 0; i < n; i++) {
    const slot = i + (gaps && i >= aisle ? 1 : 0) + (gaps && i >= n - aisle ? 1 : 0);
    list.push({ off: -span / 2 + (slot + 0.5) * sw, kind: 'seat' });
  }
  return { list, span };
}

export function buildSeats(v) {
  const out = []; const byKey = {}; let rowCounter = 0;
  const rand = rng(hashStr(v.name || 'venue'));
  v.sections.forEach((s, si) => {
    const sw = s.seatWidth || 0.55;
    const centerZ = s.layout === 'arc' ? (s.arcCenter || 0) : 0;
    for (let r = 0; r < s.rows; r++) {
      const label = s.rowPrefix ? `${s.rowPrefix}${r + 1}` : rowName(rowCounter);
      const dist = s.firstDist + r * s.rowDepth;
      const y = (s.startY || 0) + r * (s.rise || 0);
      const { list, span } = rowSlots(s, r, sw);
      const key = `${si}-${r}`; byKey[key] = [];
      let num = 0;
      for (const { off, kind, spot, edge } of list) {
        let x, z, a;
        if (s.layout === 'arc') {
          const R = dist - centerZ;
          a = (s.angle || 0) * D2R + off / R;
          x = Math.sin(a) * R; z = centerZ + Math.cos(a) * R;
        } else {
          a = (s.angle || 0) * D2R;
          x = Math.sin(a) * dist + Math.cos(a) * off; z = Math.cos(a) * dist - Math.sin(a) * off;
        }
        const centrality = 1 - Math.abs(off) / (span / 2);
        const driver = kind === 'driver';
        const taken = rand() < 0.16 + 0.3 * centrality * (0.6 + 0.4 * (1 - r / s.rows)) || driver;
        const seat = { idx: out.length, section: si, sectionName: s.name, price: s.price, row: label, rowKey: key, rowIndex: r, num: driver ? 0 : ++num, x, y, z, a, sw, depth: s.rowDepth, taken, kind, spot, edge, driver };
        byKey[key].push(seat.idx); out.push(seat);
      }
      rowCounter++;
    }
  });
  return { out, byKey };
}

export function focusInfo(v) {
  const f = v.focus;
  if (f.type === 'screen') {
    const cy = f.bottom + f.height / 2;
    return { type: 'screen', target: new THREE.Vector3(0, cy, 0),
      edges: [new THREE.Vector3(-f.width / 2, cy, 0), new THREE.Vector3(f.width / 2, cy, 0)],
      low: x => new THREE.Vector3(clamp(x, -f.width / 2, f.width / 2), f.bottom + f.height * 0.12, 0) };
  }
  if (f.type === 'road') {
    // Passengers look down the road; the numbers are about the windscreen, which sits just in front of z = 0.
    const W = f.width / 2 - 0.06, y0 = f.windscreenBottom ?? 1.1, y1 = f.windscreenTop ?? 1.7, z = -0.12, cy = (y0 + y1) / 2;
    return { type: 'road', target: new THREE.Vector3(0, 0.5, -40), mapTarget: new THREE.Vector3(0, cy, z),
      edges: [new THREE.Vector3(-W, cy, z), new THREE.Vector3(W, cy, z)], low: null,
      windscreen: { x0: -W, x1: W, y0, y1, z }, dash: 0.3, halfWidth: f.width / 2,
      rearAxle: f.rearAxle ?? null, door: f.doorFrom !== undefined ? [f.doorFrom, f.doorTo] : null };
  }
  if (f.type === 'stage') {
    return { type: 'stage', target: new THREE.Vector3(0, f.height + 1.4, -f.depth * 0.4),
      edges: [new THREE.Vector3(-f.width / 2, f.height + 1, -1), new THREE.Vector3(f.width / 2, f.height + 1, -1)],
      low: x => new THREE.Vector3(clamp(x * 0.3, -f.width / 2, f.width / 2), f.height + 0.25, -2) };
  }
  const L = f.length / 2, W = f.width / 2;
  return { type: 'pitch', target: new THREE.Vector3(0, 0, 0),
    edges: [new THREE.Vector3(-L, 0, -W), new THREE.Vector3(L, 0, -W), new THREE.Vector3(L, 0, W), new THREE.Vector3(-L, 0, W)], low: null };
}

// Vehicle seats have tall backs with headrests (folding seats: a short back, no headrest).
// Heights are above the seat's floor; the back sits 0.24 m behind the seat centre. Used by the 3D model and the road-view maths.
export const VAN_SEAT = { back0: 0.47, back1: 1.1, head1: 1.3, headW: 0.28, fold0: 0.41, fold1: 0.95 };
export function backBox(s) {
  const k = s.sw / 0.55, fold = s.kind === 'folding';
  return { z: s.z + 0.24, w: 0.48 * k, y0: fold ? VAN_SEAT.fold0 : VAN_SEAT.back0, y1: fold ? VAN_SEAT.fold1 : VAN_SEAT.back1,
    hw: fold ? 0 : VAN_SEAT.headW * k, hy1: VAN_SEAT.head1 };
}

export function fwdOf(s) { return new THREE.Vector3(-Math.sin(s.a), 0, -Math.cos(s.a)); }
export function eyeOf(s) { const f = fwdOf(s); return new THREE.Vector3(s.x - f.x * 0.12, s.y + EYE_H, s.z - f.z * 0.12); }
export function headOf(s) { const f = fwdOf(s); return new THREE.Vector3(s.x - f.x * 0.08, s.y + HEAD_H, s.z - f.z * 0.08); }


export function validateVenue(v) {
  if (!v || typeof v !== 'object') throw new Error('The data must be a JSON object.');
  if (!v.focus || !['screen', 'stage', 'pitch', 'road'].includes(v.focus.type)) throw new Error('focus.type must be "screen", "stage", "pitch" or "road".');
  if (v.focus.type === 'road' && !(v.focus.width > 0)) throw new Error('A road venue needs focus.width (the inside width of the vehicle).');
  if (!Array.isArray(v.sections) || !v.sections.length) throw new Error('Add at least one section in "sections".');
  v.sections.forEach((s, i) => {
    for (const k of ['rows', 'firstDist', 'rowDepth', 'price']) if (typeof s[k] !== 'number') throw new Error(`Section ${i + 1} needs a number for "${k}".`);
    if (s.pattern !== undefined) {
      const pats = Array.isArray(s.pattern) ? s.pattern : [s.pattern];
      if (!pats.length || pats.some(p => typeof p !== 'string' || !/^[SDF_]+$/.test(p) || !/[SDF]/.test(p)))
        throw new Error(`Section ${i + 1}: "pattern" rows may only use S (seat), F (folding seat), D (driver) and _ (gap), with at least one seat.`);
    } else if (!(typeof s.seats === 'number' || Array.isArray(s.seats))) throw new Error(`Section ${i + 1} needs "seats" as a number or a list of numbers, or a "pattern".`);
  });
  const perRow = s => s.pattern !== undefined ? Math.max(...[].concat(s.pattern).map(p => p.replace(/_/g, '').length)) : Array.isArray(s.seats) ? Math.max(...s.seats) : s.seats;
  const n = v.sections.reduce((a, s) => a + s.rows * perRow(s), 0);
  if (n > 6000) throw new Error(`That is about ${n} seats. Keep it under 6,000 for this prototype.`);
}
