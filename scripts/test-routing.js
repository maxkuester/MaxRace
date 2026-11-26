// node scripts/test-routing.js : routing.js against cases with a known answer
var R = require("../routing.js"), assert = require("assert");
// toy polar: 8 kn at beam and aft in 12 kn of wind, falling to 0 inside 35 deg of the wind; speed scales with wind up to 1x at 12
function polar(twa, tws) { var a = twa < 35 ? 0 : twa < 50 ? (twa - 35) / 15 * 5.5 : twa < 90 ? 5.5 + (twa - 50) / 40 * 2.5 : 8; return a * Math.min(1.5, tws / 12); }
var H = 3600000, t0 = Date.UTC(2026, 10, 26, 12), start = { lat: 43.0, lon: 7.0 };
var constWind = function (twd, tws) { return function () { return { twd_deg: twd, tws_kn: tws }; }; };
// 1. reaching: wind from the west (270), destination 20 nm to the north -> beam reach at 8 kn: 2.5 h
var d1 = R.dest(start.lat, start.lon, 0, 20), r1 = R.route({ start: start, dest: d1, t0: t0, wind: constWind(270, 12), polar: polar, stepMin: 10 });
assert(r1.ok); assert(Math.abs(r1.hours - 2.5) < 0.1, "reach hours " + r1.hours); assert.strictEqual(r1.tacks, 0);
// 2. upwind: wind from the north, destination 20 nm north: best VMG = max over a of polar(a)*cos(a)
var best = 0; for (var a = 36; a < 90; a += 0.5) best = Math.max(best, polar(a, 12) * Math.cos(a * Math.PI / 180));
var r2 = R.route({ start: start, dest: d1, t0: t0, wind: constWind(0, 12), polar: polar, stepMin: 10, headingStep: 5, maxHours: 24 });
assert(r2.ok); var want = 20 / best; console.log("upwind", r2.hours.toFixed(2), "h; ideal", want.toFixed(2), "h; tacks", r2.tacks);
assert(r2.hours >= want - 0.05 && r2.hours < want * 1.12, "upwind close to the VMG limit"); assert(r2.tacks >= 1, "it tacks");
// 3. a tack penalty makes the upwind route slower, never faster
var r3 = R.route({ start: start, dest: d1, t0: t0, wind: constWind(0, 12), polar: polar, stepMin: 10, tackSec: 120, maxHours: 24 });
assert(r3.ok && r3.hours >= r2.hours - 0.02, "penalty slows: " + r3.hours + " vs " + r2.hours);
// 4. exclusion zone on the straight line forces a detour
var mid = R.dest(start.lat, start.lon, 0, 10), box = [[mid.lat - 0.02, mid.lon - 0.12], [mid.lat - 0.02, mid.lon + 0.12], [mid.lat + 0.02, mid.lon + 0.12], [mid.lat + 0.02, mid.lon - 0.12]];
var r4 = R.route({ start: start, dest: d1, t0: t0, wind: constWind(270, 12), polar: polar, stepMin: 10, exclude: [box] });
assert(r4.ok && r4.hours > r1.hours + 0.01, "detour is longer: " + r4.hours);
r4.path.forEach(function (p) { assert(!(p.lat > box[0][0] && p.lat < box[2][0] && p.lon > box[0][1] && p.lon < box[1][1]), "waypoint inside the zone"); });
assert.strictEqual(R.route({ start: { lat: mid.lat, lon: mid.lon }, dest: d1, wind: constWind(270, 12), polar: polar, exclude: [box] }).reason, "start is inside an exclusion zone");
// 5. wind data that does not cover the route: reported, not invented
var r5 = R.route({ start: start, dest: d1, t0: t0, wind: function (t) { return t < t0 + 30 * 60000 ? { twd_deg: 270, tws_kn: 12 } : null; }, polar: polar });
assert(!r5.ok && /does not cover/.test(r5.reason), r5.reason);
// 6. departure planning. (a) the wind data starts two hours late: earlier departures are reported as not possible, the best is the first possible
var late = function (t, lat, lon) { return t < t0 + 2 * H ? null : { twd_deg: 270, tws_kn: 12 }; };
var ds = R.departureScan({ start: start, dest: d1, t0: t0, wind: late, polar: polar, everyMin: 60, count: 5, maxHours: 20 });
assert(!ds.options[0].ok && !ds.options[1].ok && ds.options[2].ok, "no wind data before +2 h"); assert.strictEqual(ds.best.t0, t0 + 2 * H);
// (b) a beam wind that turns head-on after 3 h: leaving at once is best, and later departures arrive later
var turn = function (t) { return { twd_deg: t < t0 + 3 * H ? 270 : 0, tws_kn: 12 }; };
var ds2 = R.departureScan({ start: start, dest: d1, t0: t0, wind: turn, polar: polar, everyMin: 60, count: 4, maxHours: 24 });
assert.strictEqual(ds2.best.t0, t0, "best: leave at once"); assert(ds2.options[3].eta > ds2.options[0].eta);
// 7. ensemble and bias
var en = R.ensemble({ start: start, dest: d1, t0: t0, wind: constWind(0, 12), polar: polar, maxHours: 24, dirErrors: [-15, 0, 15], speedFactors: [0.9, 1.1] });
assert.strictEqual(en.runs.length, 6); assert(en.summary.max >= en.summary.min); console.log("ensemble", JSON.stringify(en.summary, function (k, v) { return typeof v === "number" ? Math.round(v * 100) / 100 : v; }));
var bw = R.biasWind(constWind(350, 10), { dirDeg: 20, speedFactor: 1.5 })(0, 0, 0); assert.strictEqual(Math.round(bw.twd_deg), 10); assert.strictEqual(Math.round(bw.tws_kn), 15);
// 8. compare two winds
var cmp = R.compare({ start: start, dest: d1, t0: t0, polar: polar, winds: { weak: constWind(270, 6), strong: constWind(270, 12) } });
assert(cmp.weak.ok && cmp.strong.ok && cmp.weak.hours > cmp.strong.hours);
console.log("ok");
