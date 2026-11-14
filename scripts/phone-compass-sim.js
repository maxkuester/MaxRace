// Phone compass simulator: the direction the phone camera points, as the live app will read it.
// In the app every frame carries the phone compass (magnetic), corrected with "Align": the phone held along the bow
// reads X while the H5000 says HDG, so align = HDG - X (it holds the declination and the phone's own error).
// A video from the phone has no compass in it, so for a demo the camera direction is rebuilt and turned into
// the same 10 Hz track the phone would give, live: it moves with the hand and the boat, it never sits still.
//
// Two ways to say where the camera points:
//   --yaw yaw.json --anchor "t:deg"   the turns measured from the video itself ([{t, turn}], turn in degrees,
//                                      + = the scene moved right, i.e. the phone turned LEFT), fixed to a true
//                                      bearing at one known moment (the sun in the picture, the bow)
//   --keys "t:deg,t:deg,..."          known bearings at given seconds; in between the phone turns the short way
//
//   node scripts/phone-compass-sim.js (--yaw yaw.json --anchor 6:245 | --keys "0:330,3.5:330") [--duration 16.7]
//                                     [--decl 2.5] [--phone-error 6] [--hand 1.2] [--boat-yaw 2.5] [--noise 0.8] [--rate 10]
//
// --decl        magnetic declination at the place (east +); about +2.5 off Saint-Tropez in 2026
// --phone-error the phone's own compass error on board (mounting, magnets, the boat's steel)
// --hand        hand tremor, degrees;  --boat-yaw  the boat yawing on the waves, degrees (period about 5 s)
// Output: {"align": decl + phone error, "pts": [{"t": seconds, "mag": phone reading}, ...]}
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const num = (k, d) => { const v = parseFloat(val(k, "")); return isFinite(v) ? v : d; };
const wrap360 = (a) => ((a % 360) + 360) % 360;
const decl = num("decl", 2.5), err = num("phone-error", 6), rate = num("rate", 10);
const hand = num("hand", 1.2), boatYaw = num("boat-yaw", 2.5), noise = num("noise", 0.8);

let trueAt, dur;
if (val("yaw")) {
  const y = JSON.parse(fs.readFileSync(val("yaw"), "utf8"));
  // --tracks: boats far away (small in the picture) only move sideways when the phone turns, like stars for a
  // navigator. Where they are in view, the turn comes from them; elsewhere from the picture as a whole, which the
  // water and the wake can fool.
  if (val("tracks")) {
    const tr = JSON.parse(fs.readFileSync(val("tracks"), "utf8")).tracks;
    const W = num("width", 1080), F = (W / 2) / Math.tan(num("fov", 42.6) / 2 * Math.PI / 180);
    const ang = (p) => Math.atan((p.box[0] + p.box[2] / 2 - W / 2) / F) * 180 / Math.PI;
    const times = [...new Set(tr.flatMap((T) => T.pts.map((p) => p.t)))].sort((a, b) => a - b);
    const fix = [];                                       // [t0, t1, turn measured by the far boats]
    for (let i = 1; i < times.length; i++) {
      const t0 = times[i - 1], t1 = times[i], d = [];
      if (t1 - t0 > 0.5) continue;
      for (const T of tr) {
        const a = T.pts.find((p) => p.t === t0), b = T.pts.find((p) => p.t === t1);
        if (a && b && a.box[3] < 120 && b.box[3] < 120 && Math.max(a.box[3], b.box[3]) / Math.min(a.box[3], b.box[3]) < 1.4) d.push(ang(b) - ang(a));
      }
      if (d.length) { d.sort((p, q) => p - q); fix.push([t0, t1, d[d.length >> 1]]); }
    }
    // rebuild the turn: picture increments, replaced by the boats' increments inside the fixed stretches
    let acc = 0;
    const out = [{ t: y[0].t, turn: 0 }];
    for (let i = 1; i < y.length; i++) {
      const t0 = y[i - 1].t, t1 = y[i].t, f = fix.find((q) => t1 > q[0] && t1 <= q[1]);
      acc += f ? f[2] * (t1 - t0) / (f[1] - f[0]) : (y[i].turn - y[i - 1].turn);
      out.push({ t: t1, turn: acc });
    }
    y.splice(0, y.length, ...out);
  }
  // keep the real turns, drop the jitter that comes from waves passing through the picture (about 0.7 s median)
  const sm = y.map((p, i) => {
    const w = y.slice(Math.max(0, i - 3), i + 4).map((q) => q.turn).sort((a, b) => a - b);
    return { t: p.t, turn: w[w.length >> 1] };
  });
  const turnAt = (t) => {
    const k = sm.findIndex((p) => p.t >= t);
    if (k <= 0) return sm[k === 0 ? 0 : sm.length - 1].turn;
    const a = sm[k - 1], b = sm[k], u = (t - a.t) / (b.t - a.t);
    return a.turn + (b.turn - a.turn) * u;
  };
  // --anchors "t:deg,t:deg": several known moments. Between two of them the phone turns by exactly the difference
  // (the short way), spread over time as the picture moved: the video says WHEN the phone turned, the anchors HOW
  // MUCH (a fast pan blurs the picture and its measured size is not reliable). Outside them, the small measured
  // movements around the nearest anchor. --anchor "t:deg" is the same with one moment.
  const anchors = String(val("anchors", val("anchor", "0:0"))).split(",").map((s) => s.split(":").map(Number))
    .filter((a) => a.length === 2 && a.every(isFinite)).sort((a, b) => a[0] - b[0]);
  const moved = [0];                                           // how much the picture moved, cumulated, any direction
  for (let i = 1; i < sm.length; i++) moved.push(moved[i - 1] + Math.abs(sm[i].turn - sm[i - 1].turn) + 0.02);
  const movedAt = (t) => {
    const k = sm.findIndex((p) => p.t >= t);
    if (k <= 0) return moved[k === 0 ? 0 : moved.length - 1];
    const u = (t - sm[k - 1].t) / (sm[k].t - sm[k - 1].t);
    return moved[k - 1] + (moved[k] - moved[k - 1]) * u;
  };
  trueAt = (t) => {
    const [ta, aa] = anchors[0], [tb, ab] = anchors[anchors.length - 1];
    if (t <= ta) return wrap360(aa - (turnAt(t) - turnAt(ta)));   // the measured turn is + when the phone turns left
    if (t >= tb) return wrap360(ab - (turnAt(t) - turnAt(tb)));
    for (let i = 1; i < anchors.length; i++) {
      const [t0, a0] = anchors[i - 1], [t1, a1] = anchors[i];
      if (t <= t1) {
        let d = wrap360(a1 - a0); if (d > 180) d -= 360;
        const span = movedAt(t1) - movedAt(t0), u = span > 0 ? (movedAt(t) - movedAt(t0)) / span : (t - t0) / (t1 - t0);
        return wrap360(a0 + d * u);
      }
    }
    return ab;
  };
  dur = num("duration", y[y.length - 1].t);
} else {
  const keys = String(val("keys", "")).split(",").map((s) => s.split(":").map(Number)).filter((k) => k.length === 2 && k.every(isFinite))
    .sort((a, b) => a[0] - b[0]);
  if (!keys.length) { console.error('give --yaw yaw.json --anchor t:deg, or --keys "t:deg,..."'); process.exit(1); }
  dur = num("duration", keys[keys.length - 1][0]);
  trueAt = (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t0, a0] = keys[i - 1], [t1, a1] = keys[i];
      if (t <= t1) {
        let d = wrap360(a1 - a0); if (d > 180) d -= 360;
        const u = (t - t0) / Math.max(1e-6, t1 - t0), s = u * u * (3 - 2 * u);
        return wrap360(a0 + d * s);
      }
    }
    return keys[keys.length - 1][1];
  };
}

// a phone held by hand on a moving boat: tremor (2-3 Hz), the boat yawing on the waves (about 5 s),
// slow sensor wander and reading noise. The reading is magnetic: true minus declination and phone error.
const pts = [], ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28;
let wander = 0;
for (let i = 0; i <= Math.round(dur * rate); i++) {
  const t = i / rate;
  wander = wander * 0.95 + (Math.random() - 0.5) * 0.4;
  const motion = boatYaw * Math.sin(2 * Math.PI * t / 5.2 + ph1) + hand * Math.sin(2 * Math.PI * t * 2.4 + ph2) * (0.6 + 0.4 * Math.random());
  const mag = wrap360(trueAt(t) + motion + wander + (Math.random() - 0.5) * noise - decl - err);
  pts.push({ t: +t.toFixed(2), mag: +mag.toFixed(1) });
}
process.stdout.write(JSON.stringify({ align: decl + err, pts }) + "\n");
