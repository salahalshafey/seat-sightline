// Viewing-angle maths and the plain-language verdicts shown on the seat card.
import { R2D, clamp, eyeOf, headOf, backBox } from './venue.js';

let seats = [], focus = null;
/** Call whenever a venue is (re)loaded. */
export function setSightlineContext(allSeats, focusInfo) { seats = allSeats; focus = focusInfo; }

export function metrics(s) {
  const e = eyeOf(s), T = focus.target;
  const dx = T.x - e.x, dy = T.y - e.y, dz = T.z - e.z;
  const horiz = Math.hypot(dx, dz), dist = Math.hypot(horiz, dy);
  let span = 0;
  for (let i = 0; i < focus.edges.length; i++) for (let j = i + 1; j < focus.edges.length; j++) {
    const a = focus.edges[i].clone().sub(e), b = focus.edges[j].clone().sub(e);
    span = Math.max(span, a.angleTo(b) * R2D);
  }
  const tilt = Math.atan2(dy, horiz) * R2D;
  const off = Math.atan2(Math.abs(e.x - T.x), Math.max(0.01, e.z - T.z)) * R2D;
  let blocked = false;
  if (focus.low) {
    const P = focus.low(e.x), d = P.clone().sub(e), dd = d.lengthSq();
    for (const o of seats) {
      if (!o.taken || o === s) continue;
      const h = headOf(o), t = h.clone().sub(e).dot(d) / dd;
      if (t <= 0.01 || t >= 1) continue;
      if (h.distanceTo(e.clone().addScaledVector(d, t)) < 0.12) { blocked = true; break; }
    }
  }
  return { e, dist, horiz, span, tilt, off, blocked };
}

export function assess(s) {
  const m = metrics(s), t = focus.type, warns = [];
  let verdict, why, meter, stats;
  if (t === 'screen') {
    const share = Math.round(m.span / 120 * 100);
    if (m.span >= 58) { verdict = 'Front and overwhelming'; why = 'The screen is wider than you can take in at once. Expect to turn your head for subtitles and action at the edges.'; }
    else if (m.span >= 42) { verdict = 'Close and immersive'; why = `The screen fills about ${share}% of your vision. Great for big action films if you like being inside the picture.`; }
    else if (m.span >= 30) { verdict = 'Reference sweet spot'; why = 'Close to the 36–40° viewing angle cinema engineers design for. The whole frame is in view with nothing to strain for.'; }
    else { verdict = 'Distant and relaxed'; why = 'Easy on the eyes and neck, but the picture feels smaller and less immersive.'; }
    if (m.tilt > 14) warns.push(`Head tilted up ${Math.round(m.tilt)}°`);
    if (m.off > 22) warns.push(`${Math.round(m.off)}° off-centre: picture looks slightly skewed`);
    meter = { label: 'Screen width in your view', v: m.span, min: 0, max: 75, band: [30, 40], bandLbl: '30–40° target', unit: '°' };
    stats = [['Distance to screen', m.dist.toFixed(1), 'm'], ['Screen in view', Math.round(m.span), `° · ${share}%`], ['Head tilt', fmtSigned(m.tilt), '°'], ['Off-centre', Math.round(m.off), '°']];
  } else if (t === 'stage') {
    if (m.dist < 9) { verdict = 'Close enough to read faces'; why = 'You will catch expressions and small gestures. Wide moments may stretch beyond a single glance.'; }
    else if (m.dist < 18) { verdict = 'Whole stage in frame'; why = 'The full set and the performers fit comfortably in view, the way the director blocks the show.'; }
    else if (m.dist < 26) { verdict = 'Wide picture, smaller faces'; why = 'You see the full staging and lighting design, but facial detail is hard to read.'; }
    else { verdict = 'Far back'; why = 'Good for spectacle and price. Bring opera glasses for close moments.'; }
    if (m.off > 25) warns.push(`Side view, ${Math.round(m.off)}° off-centre`);
    if (m.tilt < -16) warns.push(`Looking down ${Math.round(-m.tilt)}°`);
    if (m.tilt > 8) warns.push(`Looking up at the stage ${Math.round(m.tilt)}°`);
    meter = { label: 'Distance to the action', v: m.dist, min: 0, max: 35, band: [6, 16], bandLbl: '6–16 m best', unit: ' m' };
    stats = [['Distance to stage', m.dist.toFixed(1), 'm'], ['Stage in view', Math.round(m.span), '°'], ['Sightline angle', fmtSigned(m.tilt), '°'], ['Off-centre', Math.round(m.off), '°']];
  } else if (t === 'road') {
    const pct = Math.round(roadClear(s, m.e) * 100), leg = legroom(s);
    const hasWindow = s.edge && !s.driver;
    if (s.driver) { verdict = 'Driver’s seat'; why = 'Not for sale. This preview shows the road the way the driver sees it.'; }
    else if (pct >= 70) { verdict = 'Front-row panorama'; why = 'The whole road ahead is in view through the windscreen. The best seat if you get car-sick, and you get to chat with the driver.'; }
    else if (pct >= 30) { verdict = 'Road view between the seats'; why = `About ${pct}% of the windscreen shows past the seats and heads in front. Seeing the road ahead helps against car sickness.`; }
    else if (hasWindow) { verdict = 'Side-window seat'; why = 'The seats in front hide most of the road ahead, but you have a window of your own to look out of and lean on.'; }
    else { verdict = 'Boxed in'; why = 'Headrests and heads in front hide the road, and there is no window beside you. Fine for a nap, hard if you get car-sick.'; }
    if (s.kind === 'folding') warns.push('Folding seat: you get up whenever someone behind gets on or off');
    if (focus.rearAxle !== null && !s.driver) {
      if (s.z > focus.rearAxle + 0.5) warns.push('Behind the rear axle: the bounciest row');
      else if (Math.abs(s.z - focus.rearAxle) <= 0.5) warns.push('Over the rear axle: you feel the bumps more');
    }
    if (leg !== null && leg < 0.25) warns.push(`Tight legroom, ${Math.round(leg * 100)} cm`);
    if (focus.door && s.edge && s.x > 0 && s.z > focus.door[0] - 0.3 && s.z < focus.door[1] + 0.3) warns.push({ ok: true, text: 'Next to the sliding door: first off' });
    if (!warns.some(w => typeof w === 'string') && !s.driver) warns.push({ ok: true, text: 'Smooth ride between the axles' });
    meter = { label: 'Road ahead you can see', v: pct, min: 0, max: 100, band: [60, 100], bandLbl: '60%+ eases car sickness', unit: '%' };
    stats = [['Road view', pct, '%'], ['Windscreen width', Math.round(m.span), '°'],
      leg === null ? ['Legroom', 'open', 'aisle ahead'] : ['Legroom', Math.round(leg * 100), 'cm'], ['Seat', s.driver ? 'Driver' : s.spot, '']];
  } else {
    const down = -m.tilt;
    if (down >= 17) { verdict = 'Tactical overview'; why = 'You see shapes, runs and space open up, close to the main TV camera angle.'; }
    else if (down >= 9) { verdict = 'Balanced view'; why = 'High enough to read the game, close enough to hear the players.'; }
    else { verdict = 'Pitch-level atmosphere'; why = 'Close to the noise and the touchline. Distances along the pitch are harder to judge.'; }
    const ang = Math.abs(Math.atan2(s.x, s.z) * R2D);
    if (ang > 60) warns.push('Behind the goal: the far end is hard to judge');
    if (m.dist > 70) warns.push('Far from the centre spot');
    meter = { label: 'How far you look down onto the pitch', v: down, min: 0, max: 30, band: [10, 22], bandLbl: '10–22° TV-like', unit: '°' };
    stats = [['To centre spot', Math.round(m.dist), 'm'], ['Pitch in view', Math.round(m.span), '°'], ['Looking down', Math.round(down), '°'], ['Eye height', m.e.y.toFixed(1), 'm']];
  }
  if (m.blocked) warns.push('A head in front may cover the lower edge');
  if (!warns.length) warns.push({ ok: true, text: 'Clear sightline' });
  return { m, verdict, why, meter, stats, warns };
}
/** Share of the windscreen (sampled on a 9 × 4 grid) not hidden by a seat back, headrest or head in front. */
function roadClear(s, e) {
  const W = focus.windscreen, ahead = seats.filter(o => o !== s && o.z < s.z - 0.2);
  let free = 0;
  for (let i = 0; i < 9; i++) for (let j = 0; j < 4; j++) {
    const px = W.x0 + (i + 0.5) / 9 * (W.x1 - W.x0), py = W.y0 + (j + 0.5) / 4 * (W.y1 - W.y0);
    if (!rayBlocked(e, px - e.x, py - e.y, W.z - e.z, ahead)) free++;
  }
  return free / 36;
}
function rayBlocked(e, dx, dy, dz, ahead) {
  const dd = dx * dx + dy * dy + dz * dz;
  for (const o of ahead) {
    const b = backBox(o), t = (b.z - e.z) / dz;
    if (t > 0 && t < 1) {
      const X = Math.abs(e.x + dx * t - o.x), Y = e.y + dy * t - o.y;
      if (X < b.w / 2 && Y > b.y0 && Y < b.y1) return true;
      if (X < b.hw / 2 && Y >= b.y1 && Y < b.hy1) return true;
    }
    if (o.taken) {
      const h = headOf(o), hx = h.x - e.x, hy = h.y - e.y, hz = h.z - e.z, k = (hx * dx + hy * dy + hz * dz) / dd;
      if (k > 0 && k < 1 && Math.hypot(hx - dx * k, hy - dy * k, hz - dz * k) < 0.12) return true;
    }
  }
  return false;
}
/** Knee room to the seat back (or dashboard) in front, in metres. null = the aisle is in front of you. */
function legroom(s) {
  const ahead = seats.filter(o => o.z < s.z - 0.2);
  if (!ahead.length) return (s.z - 0.27) - focus.dash;            // front row: knees to the dashboard
  const rowZ = Math.max(...ahead.map(o => o.z));                    // only the row directly in front counts
  const o = ahead.find(o => Math.abs(o.z - rowZ) < 0.1 && Math.abs(o.x - s.x) <= s.sw * 0.7);
  return o ? (s.z - 0.27) - (o.z + 0.29) : null;
}
function fmtSigned(v) { const r = Math.round(v); return r > 0 ? `+${r}` : `${r}`; }

