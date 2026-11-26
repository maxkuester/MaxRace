// MaxRace polar learning: builds a polar table (target BSP by TWS and TWA) from the boat's own sailing data.
//
//   steady filter  a 1 s point counts only if the whole window around it is steady: heading rate, heading spread,
//                  TWA spread, TWS spread, BSP trend, no tack/gybe (TWA sign change). All thresholds are in DEFAULTS.
//   outliers       impossible values and, with a reference polar, speeds far above it are rejected.
//   bins           2 kn TWS x 5 deg TWA (absolute TWA); per bin a high percentile (default 90th) of BSP and the sample count.
//   confidence     bins under minN samples fall back to the reference polar (source "ref"), else stay empty.
//   history        state.bins keeps the latest samples per bin (capped), so each session adds to the previous ones.
//
// Samples: [{t (s), hdg, bsp, twa (+ = starboard), twd, tws}] as in calib.js. Reference polar: calib.js polarFns().bsp(twa, tws).
// Works in the page (window.MRPolar) and in Node (module.exports).
(function (root) {
  "use strict";
  var C = (typeof require !== "undefined" && typeof module !== "undefined") ? require("./calib.js") : root.MRCalib;
  var DEFAULTS = {
    twsStep: 2, twaStep: 5, pct: 90, minN: 20, maxPerBin: 400,
    window: 20,            // s, steady window centred on the point
    maxRate: 1.5,          // deg/s heading rate inside the window
    maxHdgSpread: 8,       // deg, max-min heading in the window
    maxTwaSpread: 12,      // deg, max-min TWA in the window
    maxTwsSpread: 4,       // kn, max-min TWS in the window
    maxBspTrend: 0.12,     // kn/s, |BSP slope| over the window (still accelerating or slowing)
    minBsp: 0.5, maxBsp: 40, maxTws: 70, minAbsTwa: 20,
    refFactor: 1.5         // reject BSP above refFactor x reference polar
  };
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function opt(o) { var r = {}, k; for (k in DEFAULTS) r[k] = o && fin(o[k]) ? o[k] : DEFAULTS[k]; return r; }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }

  // true if a raw value set is physically plausible (before looking at the window)
  function plausible(p, o, ref) {
    if (!p || !fin(p.bsp) || !fin(p.twa) || !fin(p.tws)) return false;
    if (p.bsp < o.minBsp || p.bsp > o.maxBsp || p.tws <= 0 || p.tws > o.maxTws || Math.abs(p.twa) < o.minAbsTwa || Math.abs(p.twa) > 180) return false;
    if (ref) { var rb = ref(Math.abs(p.twa), p.tws); if (fin(rb) && rb > 1 && p.bsp > rb * o.refFactor) return false; }
    return true;
  }

  // steady points from a 1 s series: [{tws, twa (abs), bsp, t}]
  function steady(samples, options, ref) {
    var o = opt(options), r = C.resample(samples), out = [], rejected = { gap: 0, unsteady: 0, outlier: 0 };
    if (!r) return { points: out, rejected: rejected, total: 0 };
    var n = r.length, half = Math.floor(o.window / 2);
    for (var i = half; i < n - half; i++) {
      if (!r[i]) continue;
      var ok = true, hmin = 1e9, hmax = -1e9, amin = 1e9, amax = -1e9, wmin = 1e9, wmax = -1e9, side = Math.sign(r[i].twa), maxr = 0;
      for (var k = i - half; k <= i + half; k++) {
        var p = r[k];
        if (!p || !fin(p.twa) || !fin(p.tws)) { rejected.gap++; ok = false; break; }
        if (Math.sign(p.twa) !== side) { rejected.unsteady++; ok = false; break; }     // tack or gybe in the window
        hmin = Math.min(hmin, p.h); hmax = Math.max(hmax, p.h); amin = Math.min(amin, p.twa); amax = Math.max(amax, p.twa); wmin = Math.min(wmin, p.tws); wmax = Math.max(wmax, p.tws);
        if (r[k + 1]) maxr = Math.max(maxr, Math.abs(r[k + 1].h - p.h));
      }
      if (!ok) continue;
      var a = r[i - half], b = r[i + half], trend = (b.bsp - a.bsp) / (2 * half);
      if (maxr > o.maxRate || hmax - hmin > o.maxHdgSpread || amax - amin > o.maxTwaSpread || wmax - wmin > o.maxTwsSpread || Math.abs(trend) > o.maxBspTrend) { rejected.unsteady++; continue; }
      if (!plausible(r[i], o, ref)) { rejected.outlier++; continue; }
      out.push({ t: r[i].t, tws: r[i].tws, twa: Math.abs(r[i].twa), bsp: r[i].bsp });
    }
    return { points: out, rejected: rejected, total: n };
  }

  function key(tws, twa, o) { return Math.floor(tws / o.twsStep) + "," + Math.floor(twa / o.twaStep); }
  function emptyState() { return { v: 1, bins: {} }; }

  // adds steady points to the state (history); returns the state
  function add(state, points, options) {
    var o = opt(options); state = state || emptyState();
    points.forEach(function (p) {
      var k = key(p.tws, p.twa, o), b = state.bins[k] || (state.bins[k] = []);
      b.push(Math.round(p.bsp * 100) / 100);
      if (b.length > o.maxPerBin) b.shift();
    });
    return state;
  }

  function percentile(a, q) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), pos = (s.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  // the table: [{tws, twa, n, bsp, source: "learned"|"ref"|"none", conf 0..1}], centres of the bins
  function table(state, options, ref) {
    var o = opt(options), rows = [], seen = {}, k, i, j;
    var tMax = 0, aMax = 0;
    for (k in state.bins) { var q = k.split(","); tMax = Math.max(tMax, +q[0]); aMax = Math.max(aMax, +q[1]); }
    for (i = 0; i <= tMax; i++) for (j = Math.floor(o.minAbsTwa / o.twaStep); j <= Math.max(aMax, 35); j++) {
      var b = state.bins[i + "," + j] || [], tws = (i + 0.5) * o.twsStep, twa = (j + 0.5) * o.twaStep, n = b.length;
      var row = { tws: tws, twa: twa, n: n, bsp: NaN, source: "none", conf: Math.min(1, n / o.minN) };
      if (n >= o.minN) { row.bsp = percentile(b, o.pct); row.source = "learned"; }
      else if (ref) { var rb = ref(twa, tws); if (fin(rb)) { row.bsp = rb; row.source = "ref"; } }
      if (n || row.source !== "none") rows.push(row);
    }
    return rows;
  }

  // optimum VMG angles per TWS from the table: {tws, up:{twa,bsp,vmg}, down:{twa,bsp,vmg}} (learned bins only unless a ref is used)
  function vmgAngles(rows) {
    var by = {}, out = [];
    rows.forEach(function (r) { if (fin(r.bsp)) (by[r.tws] = by[r.tws] || []).push(r); });
    Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).forEach(function (tws) {
      var up = null, dn = null;
      by[tws].forEach(function (r) {
        var u = r.bsp * Math.cos(r.twa * Math.PI / 180), d = -u;
        if (r.twa < 90 && (!up || u > up.vmg)) up = { twa: r.twa, bsp: r.bsp, vmg: u, source: r.source };
        if (r.twa > 90 && (!dn || d > dn.vmg)) dn = { twa: r.twa, bsp: r.bsp, vmg: d, source: r.source };
      });
      out.push({ tws: tws, up: up, down: dn });
    });
    return out;
  }

  // coverage: per TWS row, per TWA bin the sample count (for the coverage view); text() renders it as a grid
  function coverage(state, options) {
    var o = opt(options), res = { twsStep: o.twsStep, twaStep: o.twaStep, minN: o.minN, cells: [] }, k;
    for (k in state.bins) { var q = k.split(","); res.cells.push({ tws: +q[0] * o.twsStep, twa: +q[1] * o.twaStep, n: state.bins[k].length, ok: state.bins[k].length >= o.minN }); }
    res.cells.sort(function (a, b) { return a.tws - b.tws || a.twa - b.twa; });
    res.binsTotal = res.cells.length; res.binsOk = res.cells.filter(function (c) { return c.ok; }).length;
    return res;
  }

  // one call for a session: steady filter, add to the history, table
  function learn(state, samples, options, ref) {
    var st = steady(samples, options, ref); state = add(state, st.points, options);
    return { state: state, steady: st, table: table(state, options, ref) };
  }

  var api = { DEFAULTS: DEFAULTS, steady: steady, add: add, table: table, vmgAngles: vmgAngles, coverage: coverage, learn: learn, emptyState: emptyState, percentile: percentile };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRPolar = api;
})(this);
