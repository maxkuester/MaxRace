// Calibration from a saved race: node scripts/calib-log.js "race.csv" [boat name]
// Reads the race CSV (time_utc, hdg_deg, stw_kt, twa_deg, twd_deg, tws_kt) and the boat's polar from the built-in boats.
var fs = require("fs"), path = require("path"), C = require("../calib.js");
var file = process.argv[2], boat = (process.argv[3] || "").toUpperCase();
var rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/), head = rows.shift().split(",");
var col = function (n) { return head.indexOf(n); }, T = col("time_utc"), H = col("hdg_deg"), B = col("stw_kt"), A = col("twa_deg"), D = col("twd_deg"), W = col("tws_kt");
var pts = rows.map(function (l) { var c = l.split(","); return { t: Date.parse(c[T]) / 1000, hdg: +c[H], bsp: +c[B], twa: +c[A], twd: +c[D], tws: +c[W] }; })
  .filter(function (p) { return isFinite(p.t) && c0(p); });
function c0(p) { return p.hdg || p.bsp; }
var html = fs.readFileSync(path.join(__dirname, "..", "maxrace.html"), "utf8"), m = html.match(/var PRESET_BOATS=(\[.*?\]);\n/);
var boats = m ? JSON.parse(m[1]) : [], b = boats.filter(function (x) { return !boat || x.name.indexOf(boat) >= 0; })[0];
var polar = b ? C.polarFns(b.data.polar) : null;
var res = C.analyse(pts, polar);
console.log("boat:", b ? b.name : "none", " samples:", pts.length);
res.mans.forEach(function (x) { console.log(new Date(x.t * 1000).toISOString().slice(11, 19), x.type.padEnd(8), "turn", String(x.turn).padStart(3), "in", String(x.dur).padStart(2), "s", "rate", String(x.rate).padStart(4), "twa", x.twa0, "->", x.twa1, "v0", x.v0.toFixed(1), x.steady ? "" : "(unsteady)", x.loss != null ? "loss " + x.loss + " s rec " + x.rec + " s" : ""); });
res.beats.forEach(function (x) { console.log("beat", new Date(x.t * 1000).toISOString().slice(11, 19), x.side, x.dur + " s", "twd", x.twd.toFixed(0), "polar", (x.pct * 100).toFixed(0) + "%"); });
console.log(res.summary);
