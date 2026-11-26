// Synthetic check of polarlearn.js: node scripts/test-polarlearn.js
var P = require("../polarlearn.js"), assert = require("assert");
var ref = function (twa, tws) { return Math.min(12, 0.5 * tws + 2) * Math.min(1, twa / 60); };   // toy polar
var pts = [], t = 0, tack = 1;
for (var s = 0; s < 1200; s++, t++) {                                 // 20 min, a tack every 300 s, steady 12 kn upwind
  if (s % 300 === 0 && s) { tack = -tack; for (var q = 0; q < 8; q++, t++) pts.push({ t: t, hdg: 40 + tack * 8 * q, bsp: 4, twa: tack * (45 - q * 2), twd: 0, tws: 12 }); }
  pts.push({ t: t, hdg: tack > 0 ? 45 : 315, bsp: 7.5 + (s % 7) * 0.05, twa: tack * 45, twd: 0, tws: 12 });
}
pts[500].bsp = 30;                                                     // spike
var r = P.learn(null, pts, null, ref);
assert(r.steady.points.length > 800, "steady points kept");
assert(r.steady.points.every(function (p) { return p.bsp < 10; }), "spike and manoeuvres rejected");
var row = r.table.filter(function (x) { return x.source === "learned"; })[0];
assert(row && row.twa === 47.5 && row.tws === 13 || row.twa === 42.5, "learned bin near TWA 45, TWS 12");
assert(row.bsp > 7.5 && row.bsp < 8, "90th percentile of 7.5..7.8");
assert(P.coverage(r.state).binsOk >= 1, "coverage");
console.log("ok", r.steady.points.length, "steady of", r.steady.total, JSON.stringify(r.steady.rejected), row);
