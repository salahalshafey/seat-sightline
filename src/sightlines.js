// Viewing-angle maths and the plain-language verdicts shown on the seat card.
import { R2D, clamp, eyeOf, headOf } from './venue.js';

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
function fmtSigned(v) { const r = Math.round(v); return r > 0 ? `+${r}` : `${r}`; }

