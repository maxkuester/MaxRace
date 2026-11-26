// MaxRace speed and compass calibration from reciprocal runs: BSP factor and HDG-vs-COG offset.
//
//   runs     steady stretches (>= minDur s, heading spread and rate small, SOG >= minSog): mean heading, BSP, SOG, COG, side.
//   pairs    two runs on reciprocal headings (180 deg +- tolCourse) close in time. A current along the track adds to SOG on one
//            run and subtracts on the other, so factor = (SOG1 + SOG2) / (BSP1 + BSP2) cancels it. Across-track current and
//            leeway deflect COG one way on one run and the other way on the other, so offset = mean(COG - HDG) over the pair.
//   result   median factor and offset, the count and the spread; ok only with enough pairs and a small spread.
//
// Samples: [{t (s), hdg, bsp, sog, cog, twa (+ = starboard, optional)}], any rate; the data is used at 1 s.
// Works in the page (window.MRSpeedCal) and in Node (module.exports).
(function (root) {
  "use strict";
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var DEFAULTS = { minDur: 40, maxHdgSpread: 6, maxRate: 1.2, minSog: 3, tolCourse: 20, maxGap: 900, maxBspDiff: 0.25, minPairs: 2, maxSpread: 0.03, factorMin: 0.7, factorMax: 1.3 };
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; }
  function median(a) { a = a.filter(fin).sort(function (x, y) { return x - y; }); if (!a.length) return NaN; var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function cmean(a) { var x = 0, y = 0; a.forEach(function (d) { x += Math.sin(d * D2R); y += Math.cos(d * D2R); }); return a.length ? wrap360(Math.atan2(x, y) * R2D) : NaN; }
  function opt(o) { var r = {}, k; for (k in DEFAULTS) r[k] = o && fin(o[k]) ? o[k] : DEFAULTS[k]; return r; }

  // 1 s series by holding the latest sample (gaps over 5 s leave a hole)
  function series(samples) {
    var s = samples.filter(function (p) { return fin(p.t) && fin(p.hdg) && fin(p.bsp) && fin(p.sog) && fin(p.cog); }).sort(function (a, b) { return a.t - b.t; }), out = [], j = 0;
    if (s.length < 10) return out;
    for (var t = Math.ceil(s[0].t); t <= Math.floor(s[s.length - 1].t); t++) {
      while (j < s.length - 2 && s[j + 1].t <= t) j++;
      var p = s[j]; out.push(Math.abs(t - p.t) > 5 && Math.abs(s[j + 1].t - t) > 5 ? null : { t: t, hdg: p.hdg, bsp: p.bsp, sog: p.sog, cog: p.cog, twa: p.twa });
    }
    return out;
  }

  function runs(samples, options) {
    var o = opt(options), r = series(samples), out = [], i = 0, n = r.length;
    while (i < n) {
      if (!r[i] || r[i].sog < o.minSog) { i++; continue; }
      var a = i, ref = r[i].hdg, k = i;
      while (k < n && r[k] && r[k].sog >= o.minSog && Math.abs(wrap180(r[k].hdg - ref)) <= o.maxHdgSpread / 2 + 1e-9 && (k === a || Math.abs(wrap180(r[k].hdg - r[k - 1].hdg)) <= o.maxRate)) k++;
      if (k - a >= o.minDur) {
        var s = r.slice(a + 5, k), side = fin(s[0].twa) ? Math.sign(mean(s.map(function (p) { return p.twa; }))) : 0;
        out.push({ t: r[a].t, dur: k - a, hdg: cmean(s.map(function (p) { return p.hdg; })), cog: cmean(s.map(function (p) { return p.cog; })), bsp: mean(s.map(function (p) { return p.bsp; })), sog: mean(s.map(function (p) { return p.sog; })), side: side > 0 ? "stbd" : side < 0 ? "port" : "" });
        i = k;
      } else i = a + 1;
    }
    return out;
  }

  function pairs(rs, options) {
    var o = opt(options), out = [], used = {};
    for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) {
      var a = rs[i], b = rs[j];
      if (used[i] || used[j] || b.t - (a.t + a.dur) > o.maxGap) continue;
      if (Math.abs(Math.abs(wrap180(b.hdg - a.hdg)) - 180) > o.tolCourse) continue;
      if (Math.abs(a.bsp - b.bsp) > o.maxBspDiff * Math.max(a.bsp, b.bsp)) continue;
      used[i] = used[j] = true;
      out.push({ t: a.t, factor: (a.sog + b.sog) / (a.bsp + b.bsp), offset: wrap180(mean([wrap180(a.cog - a.hdg), wrap180(b.cog - b.hdg)])),
        current: ((a.sog - a.bsp) - (b.sog - b.bsp)) / 2, hdgA: Math.round(a.hdg), hdgB: Math.round(b.hdg) });
    }
    return out;
  }

  function analyse(samples, options) {
    var o = opt(options), rs = runs(samples, options), ps = pairs(rs, options).filter(function (p) { return p.factor >= o.factorMin && p.factor <= o.factorMax; });
    var f = ps.map(function (p) { return p.factor; }), off = ps.map(function (p) { return p.offset; });
    var med = median(f), spread = f.length > 1 ? Math.max.apply(null, f) - Math.min.apply(null, f) : NaN;
    var r1 = function (v, d) { var k = Math.pow(10, d); return fin(v) ? Math.round(v * k) / k : NaN; };
    return { runs: rs, pairs: ps, summary: { factor: r1(med, 3), offset: r1(median(off), 1), n: ps.length, spread: r1(spread, 3), current: r1(median(ps.map(function (p) { return p.current; })), 2),
      ok: ps.length >= o.minPairs && spread <= o.maxSpread } };
  }

  var api = { DEFAULTS: DEFAULTS, runs: runs, pairs: pairs, analyse: analyse };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRSpeedCal = api;
})(this);
