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

export function buildSeats(v) {
  const out = []; const byKey = {}; let rowCounter = 0;
  const rand = rng(hashStr(v.name || 'venue'));
  v.sections.forEach((s, si) => {
    const sw = s.seatWidth || 0.55;
    const centerZ = s.layout === 'arc' ? (s.arcCenter || 0) : 0;
    for (let r = 0; r < s.rows; r++) {
      const n = Array.isArray(s.seats) ? s.seats[Math.min(r, s.seats.length - 1)] : s.seats;
      const label = s.rowPrefix ? `${s.rowPrefix}${r + 1}` : rowName(rowCounter);
      const dist = s.firstDist + r * s.rowDepth;
      const y = (s.startY || 0) + r * (s.rise || 0);
      const aisle = s.aisle || 0;
      const gaps = aisle && n > aisle * 2 + 2 ? 2 : 0;
      const span = (n + gaps) * sw;
      const key = `${si}-${r}`; byKey[key] = [];
      for (let i = 0; i < n; i++) {
        const slot = i + (gaps && i >= aisle ? 1 : 0) + (gaps && i >= n - aisle ? 1 : 0);
        const off = -span / 2 + (slot + 0.5) * sw;
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
        const taken = rand() < 0.16 + 0.3 * centrality * (0.6 + 0.4 * (1 - r / s.rows));
        const seat = { idx: out.length, section: si, sectionName: s.name, price: s.price, row: label, rowKey: key, rowIndex: r, num: i + 1, x, y, z, a, sw, depth: s.rowDepth, taken };
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
  if (f.type === 'stage') {
    return { type: 'stage', target: new THREE.Vector3(0, f.height + 1.4, -f.depth * 0.4),
      edges: [new THREE.Vector3(-f.width / 2, f.height + 1, -1), new THREE.Vector3(f.width / 2, f.height + 1, -1)],
      low: x => new THREE.Vector3(clamp(x * 0.3, -f.width / 2, f.width / 2), f.height + 0.25, -2) };
  }
  const L = f.length / 2, W = f.width / 2;
  return { type: 'pitch', target: new THREE.Vector3(0, 0, 0),
    edges: [new THREE.Vector3(-L, 0, -W), new THREE.Vector3(L, 0, -W), new THREE.Vector3(L, 0, W), new THREE.Vector3(-L, 0, W)], low: null };
}

export function fwdOf(s) { return new THREE.Vector3(-Math.sin(s.a), 0, -Math.cos(s.a)); }
export function eyeOf(s) { const f = fwdOf(s); return new THREE.Vector3(s.x - f.x * 0.12, s.y + EYE_H, s.z - f.z * 0.12); }
export function headOf(s) { const f = fwdOf(s); return new THREE.Vector3(s.x - f.x * 0.08, s.y + HEAD_H, s.z - f.z * 0.08); }


export function validateVenue(v) {
  if (!v || typeof v !== 'object') throw new Error('The data must be a JSON object.');
  if (!v.focus || !['screen', 'stage', 'pitch'].includes(v.focus.type)) throw new Error('focus.type must be "screen", "stage" or "pitch".');
  if (!Array.isArray(v.sections) || !v.sections.length) throw new Error('Add at least one section in "sections".');
  v.sections.forEach((s, i) => {
    for (const k of ['rows', 'firstDist', 'rowDepth', 'price']) if (typeof s[k] !== 'number') throw new Error(`Section ${i + 1} needs a number for "${k}".`);
    if (!(typeof s.seats === 'number' || Array.isArray(s.seats))) throw new Error(`Section ${i + 1} needs "seats" as a number or a list of numbers.`);
  });
  const n = v.sections.reduce((a, s) => a + s.rows * (Array.isArray(s.seats) ? Math.max(...s.seats) : s.seats), 0);
  if (n > 6000) throw new Error(`That is about ${n} seats. Keep it under 6,000 for this prototype.`);
}
