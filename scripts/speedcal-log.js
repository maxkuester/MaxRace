// BSP factor and compass offset from saved races: node scripts/speedcal-log.js race.csv [race2.csv ...]
// Reads race CSVs (time_utc, hdg_deg, stw_kt, sog_kt, cog_deg, twa_deg); needs reciprocal steady runs (sail back and forth on opposite courses).
var fs = require("fs"), S = require("../speedcal.js");
var files = process.argv.slice(2); if (!files.length) { console.log("usage: node scripts/speedcal-log.js race.csv [...]"); process.exit(1); }
var pts = [];
files.forEach(function (f) {
  var rows = fs.readFileSync(f, "utf8").trim().split(/\r?\n/), head = rows.shift().split(","), col = function (n) { return head.indexOf(n); };
  var T = col("time_utc"), H = col("hdg_deg"), B = col("stw_kt"), G = col("sog_kt"), C = col("cog_deg"), A = col("twa_deg");
  if ([T, H, B, G, C].some(function (i) { return i < 0; })) { console.log(f + ": columns missing"); return; }
  rows.forEach(function (l) { var c = l.split(","); pts.push({ t: Date.parse(c[T]) / 1000, hdg: +c[H], bsp: +c[B], sog: +c[G], cog: +c[C], twa: A < 0 || c[A] === "" ? undefined : +c[A] }); });
});
pts = pts.filter(function (p) { return isFinite(p.t) && p.sog > 0; });
var r = S.analyse(pts);
console.log("steady runs:", r.runs.length, " reciprocal pairs:", r.pairs.length);
r.pairs.forEach(function (p) { console.log(new Date(p.t * 1000).toISOString().slice(11, 19), p.hdgA + "°/" + p.hdgB + "°", "factor", p.factor.toFixed(3), "offset", p.offset.toFixed(1) + "°", "current", p.current.toFixed(2), "kn"); });
var s = r.summary; console.log(s.n ? "BSP factor " + s.factor + ", HDG offset (COG - HDG) " + s.offset + "°, spread " + s.spread + (s.ok ? " : usable" : " : NOT enough or too scattered, do not apply") : "no reciprocal pairs found");
