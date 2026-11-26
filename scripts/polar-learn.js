// Learned polar from saved races: node scripts/polar-learn.js race1.csv [race2.csv ...] [--boat NAME] [--state state.json]
// Reads race CSVs (time_utc, hdg_deg, stw_kt, twa_deg, twd_deg, tws_kt), prints the coverage and the learned table.
var fs = require("fs"), path = require("path"), C = require("../calib.js"), P = require("../polarlearn.js");
var args = process.argv.slice(2), files = [], boat = "", stateFile = "";
for (var i = 0; i < args.length; i++) { if (args[i] === "--boat") boat = (args[++i] || "").toUpperCase(); else if (args[i] === "--state") stateFile = args[++i]; else files.push(args[i]); }
if (!files.length) { console.log("usage: node scripts/polar-learn.js race.csv [...] [--boat NAME] [--state state.json]"); process.exit(1); }
var html = fs.readFileSync(path.join(__dirname, "..", "maxrace.html"), "utf8"), m = html.match(/var PRESET_BOATS=(\[.*?\]);\n/);
var boats = m ? JSON.parse(m[1]) : [], b = boats.filter(function (x) { return !boat || x.name.indexOf(boat) >= 0; })[0];
var ref = b ? C.polarFns(b.data.polar).bsp : null;
var state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : P.emptyState();
files.forEach(function (f) {
  var rows = fs.readFileSync(f, "utf8").trim().split(/\r?\n/), head = rows.shift().split(","), col = function (n) { return head.indexOf(n); };
  var T = col("time_utc"), H = col("hdg_deg"), B = col("stw_kt"), A = col("twa_deg"), D = col("twd_deg"), W = col("tws_kt");
  var pts = rows.map(function (l) { var c = l.split(","); return { t: Date.parse(c[T]) / 1000, hdg: +c[H], bsp: +c[B], twa: +c[A], twd: +c[D], tws: +c[W] }; }).filter(function (p) { return isFinite(p.t); });
  var r = P.learn(state, pts, null, ref); state = r.state;
  console.log(path.basename(f) + ": " + r.steady.total + " s, steady " + r.steady.points.length + ", rejected", JSON.stringify(r.steady.rejected));
});
var cov = P.coverage(state); console.log("boat:", b ? b.name : "none", " bins with data:", cov.binsTotal, " reliable (n >=", cov.minN + "):", cov.binsOk);
P.table(state, null, ref).filter(function (r) { return r.source === "learned"; }).forEach(function (r) { console.log("TWS", r.tws, "TWA", r.twa, "n", r.n, "bsp", r.bsp.toFixed(2)); });
P.vmgAngles(P.table(state, null, ref)).forEach(function (v) { console.log("TWS", v.tws, "upwind", v.up ? v.up.twa + "° " + v.up.bsp.toFixed(1) + " kn (" + v.up.source + ")" : "-", "downwind", v.down ? v.down.twa + "° " + v.down.bsp.toFixed(1) + " kn (" + v.down.source + ")" : "-"); });
if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state));
