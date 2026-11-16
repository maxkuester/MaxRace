// MaxRace calibration: finds the manoeuvres in a stretch of sailing and measures what the start model needs.
//
//   turn rate     degrees per second while turning (luff up, tack, gybe, bear away)
//   luff loss     seconds lost luffing up to close-hauled, against the start model (arc at the speed you had,
//                 then speed decaying to target in 8 s): the same model that times "Bolina, ora!"
//   tack loss     seconds lost tacking, against the start model (arc, then close-hauled at target speed)
//   recovery      seconds after the turn until 95% of target speed
//   polar %       close-hauled speed against the polar target, in steady sailing
//   TWD by tack   the true wind direction seen on starboard minus port, from steady beats one after the other:
//                 a steady difference is the instruments (compass, AWA, leeway), not the wind
//
// Samples: [{t (s), hdg, bsp, twa (+ = starboard), twd, tws}], any rate; resampled to 1 s.
// Polar: {bsp(twa, tws), up(tws) -> {twa, bsp}}. Works in the page (window.MRCalib) and in Node (module.exports).
(function (root) {
  "use strict";
  var D2R = Math.PI / 180, R2D = 180 / Math.PI, KN = 1852 / 3600;
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function median(a) { a = a.filter(fin).slice().sort(function (x, y) { return x - y; }); if (!a.length) return NaN; var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function cmean(a) { var x = 0, y = 0, n = 0; a.forEach(function (d) { if (fin(d)) { x += Math.sin(d * D2R); y += Math.cos(d * D2R); n++; } }); return n ? wrap360(Math.atan2(x, y) * R2D) : NaN; }
  function mean(a) { var s = 0, n = 0; a.forEach(function (v) { if (fin(v)) { s += v; n++; } }); return n ? s / n : NaN; }

  // 1 s series, headings unwrapped so a turn through north is a smooth line
  function resample(samples) {
    var s = samples.filter(function (p) { return fin(p.t) && fin(p.hdg) && fin(p.bsp); }).sort(function (a, b) { return a.t - b.t; });
    if (s.length < 10) return null;
    var t0 = Math.ceil(s[0].t), t1 = Math.floor(s[s.length - 1].t), out = [], j = 0, unwr = [], acc = s[0].hdg;
    for (var i = 0; i < s.length; i++) { if (i) acc += wrap180(s[i].hdg - s[i - 1].hdg); unwr.push(acc); }
    for (var t = t0; t <= t1; t++) {
      while (j < s.length - 2 && s[j + 1].t < t) j++;
      var a = s[j], b = s[j + 1], gap = b.t - a.t;
      if (gap > 8) { out.push(null); continue; }                   // a hole in the data: no made-up turn across it
      var f = gap > 0 ? Math.min(1, Math.max(0, (t - a.t) / gap)) : 0, L = function (x, y) { return fin(x) && fin(y) ? x + (y - x) * f : (fin(x) ? x : y); };
      out.push({ t: t, h: L(unwr[j], unwr[j + 1]), bsp: L(a.bsp, b.bsp), twa: fin(a.twa) && fin(b.twa) ? a.twa + wrap180(b.twa - a.twa) * f : NaN,
        twd: fin(a.twd) && fin(b.twd) ? wrap360(a.twd + wrap180(b.twd - a.twd) * f) : NaN, tws: L(a.tws, b.tws) });
    }
    return out;
  }

  function rates(r) {
    var n = r.length, raw = new Array(n), sm = new Array(n);
    for (var i = 0; i < n; i++) raw[i] = r[i] && r[i - 1] && r[i + 1] ? (r[i + 1].h - r[i - 1].h) / 2 : 0;
    for (i = 0; i < n; i++) { var s = 0, k = 0; for (var d = -1; d <= 1; d++) if (i + d >= 0 && i + d < n) { s += raw[i + d]; k++; } sm[i] = s / k; }
    return sm;
  }

  // turns: the heading rate over 2.5°/s, widened while it keeps over 0.8°/s the same way, at least 25° in all
  function turns(r, rt) {
    var out = [], i = 0, n = r.length;
    while (i < n) {
      if (!r[i] || Math.abs(rt[i]) < 2.5) { i++; continue; }
      var dir = Math.sign(rt[i]), a = i, b = i;
      while (a > 0 && r[a - 1] && Math.sign(rt[a - 1]) === dir && Math.abs(rt[a - 1]) > 0.8) a--;
      while (b < n - 1 && r[b + 1] && ((Math.sign(rt[b + 1]) === dir && Math.abs(rt[b + 1]) > 0.8) ||
        // a short pause inside the same turn (2 s) does not split it
        (b + 3 < n && r[b + 3] && Math.sign(rt[b + 3]) === dir && Math.abs(rt[b + 3]) > 2.5))) b++;
      var turn = r[b].h - r[a].h;
      if (Math.abs(turn) >= 25 && b > a) out.push({ a: a, b: b, turn: turn });
      i = b + 1;
    }
    return out;
  }

  function slice(r, a, b) { var o = []; for (var i = Math.max(0, a); i <= Math.min(r.length - 1, b); i++) if (r[i]) o.push(r[i]); return o; }

  // upwind progress (m) from index a to b, sailing through the water, against the wind direction twd
  function progress(r, a, b, twd) { var p = 0; for (var i = a; i < b; i++) if (r[i]) p += r[i].bsp * KN * Math.cos((r[i].h - twd) * D2R); return p; }

  function measure(r, rt, tr, polar) {
    var a = tr.a, b = tr.b, before = slice(r, a - 15, a - 2), after = slice(r, b + 5, b + 15);
    if (before.length < 8 || after.length < 6) return null;
    var twa0 = cmean(before.map(function (p) { return p.twa; })), twa1 = cmean(after.map(function (p) { return p.twa; }));
    twa0 = wrap180(twa0); twa1 = wrap180(twa1);
    var twd = cmean(slice(r, a - 20, b + 30).map(function (p) { return p.twd; })), tws = mean(slice(r, a - 20, b + 30).map(function (p) { return p.tws; }));
    var hstd = Math.sqrt(mean(before.map(function (p) { var d = p.h - before[0].h; return d * d; })) - Math.pow(mean(before.map(function (p) { return p.h - before[0].h; })), 2));
    var type = !fin(twa0) || !fin(twa1) ? "turn" :
      Math.sign(twa0) !== Math.sign(twa1) ? (Math.abs(twa0) < 90 && Math.abs(twa1) < 90 ? "tack" : Math.abs(twa0) > 90 && Math.abs(twa1) > 90 ? "gybe" : "turn") :
      Math.abs(twa1) < Math.abs(twa0) ? "luff" : "bearaway";
    var m = { t: r[a].t, type: type, turn: Math.round(Math.abs(tr.turn)), dur: b - a, rate: Math.abs(tr.turn) / Math.max(1, b - a),
      twa0: Math.round(twa0), twa1: Math.round(twa1), v0: mean(before.slice(-5).map(function (p) { return p.bsp; })), tws: tws, steady: hstd < 6 };
    m.rate = Math.round(m.rate * 10) / 10;
    // the loss only for turns that end close-hauled, the ones the start model times
    var up = polar && fin(tws) ? polar.up(tws) : null;
    if (up && up.bsp > 0 && Math.abs(twa1) < 60 && (type === "luff" || type === "tack") && fin(twd)) {
      var T = b + 30; if (!slice(r, b, T).length || slice(r, b, T).length < 25) return m;
      var vt = up.bsp, actual = progress(r, a, T, twd), h0 = r[a].h, h1 = r[b].h, model = 0, v = m.v0;
      for (var i = a; i < T; i++) {
        var h = i < b ? h0 + (h1 - h0) * (i - a) / (b - a) : h1;
        if (i >= b) v = type === "luff" ? vt + (m.v0 - vt) * Math.exp(-(i - b) / 8) : vt;
        model += v * KN * Math.cos((h - twd) * D2R);
      }
      m.loss = Math.round((model - actual) / (vt * KN * Math.cos(up.twa * D2R)) * 10) / 10;
      // recovery: seconds after the turn until 95% of target
      for (var k = b; k < Math.min(r.length, b + 90); k++) if (r[k] && r[k].bsp >= 0.95 * vt) { m.rec = k - b; break; }
      if (m.rec == null && r.length > b + 90) m.rec = 90;      // not back to speed in 90 s (unknown if the data ends)
    }
    return m;
  }

  // steady beats (at least 30 s, no turn, 25° to 60° TWA): mean TWD and speed against the polar
  function beats(r, rt, polar) {
    var out = [], i = 0, n = r.length;
    while (i < n) {
      var ok = function (k) { return r[k] && fin(r[k].twa) && Math.abs(r[k].twa) >= 25 && Math.abs(r[k].twa) <= 60 && Math.abs(rt[k]) < 1.2; };
      if (!ok(i)) { i++; continue; }
      var a = i, side = Math.sign(r[i].twa); while (i < n && ok(i) && Math.sign(r[i].twa) === side) i++;
      if (i - a >= 30) {
        var s = slice(r, a + 5, i - 1), pct = NaN;
        if (polar) pct = mean(s.map(function (p) { var u = polar.up(p.tws); return u && u.bsp > 0 ? p.bsp / u.bsp : NaN; }));
        out.push({ t: r[a].t, dur: i - a, side: side > 0 ? "stbd" : "port", twd: cmean(s.map(function (p) { return p.twd; })), pct: pct });
      }
    }
    return out;
  }

  function analyse(samples, polar) {
    var r = resample(samples); if (!r) return { mans: [], beats: [], summary: {} };
    var rt = rates(r), mans = turns(r, rt).map(function (tr) { return measure(r, rt, tr, polar); }).filter(Boolean), bt = beats(r, rt, polar);
    return { mans: mans, beats: bt, summary: summarize(mans, bt) };
  }

  // one number for each thing, from the clean manoeuvres (steady before, a real turn)
  function summarize(mans, bt) {
    var ok = mans.filter(function (m) { return (m.steady || m.guided) && m.turn >= 30; });   // guided ones were asked for
    var pick = function (type, k) { return ok.filter(function (m) { return m.type === type && fin(m[k]); }).map(function (m) { return m[k]; }); };
    var rateAll = ok.filter(function (m) { return m.type !== "turn"; }).map(function (m) { return m.rate; });
    var pairs = [];
    for (var i = 1; i < bt.length; i++) if (bt[i].side !== bt[i - 1].side && bt[i].t - bt[i - 1].t < 900) {
      var s = bt[i].side === "stbd" ? bt[i] : bt[i - 1], p = bt[i].side === "stbd" ? bt[i - 1] : bt[i];
      pairs.push(wrap180(s.twd - p.twd));
    }
    var r1 = function (v) { return fin(v) ? Math.round(v * 10) / 10 : NaN; };
    return {
      rate: r1(median(rateAll)), nRate: rateAll.length,
      luffRate: r1(median(pick("luff", "rate"))), tackRate: r1(median(pick("tack", "rate"))),
      luffLoss: r1(median(pick("luff", "loss"))), nLuff: pick("luff", "loss").length,
      tackLoss: r1(median(pick("tack", "loss"))), nTack: pick("tack", "loss").length,
      rec: r1(median(pick("tack", "rec"))),            // after a luff the boat is usually still above target
      pct: r1(median(bt.map(function (b) { return b.pct * 100; }))), nBeat: bt.length,
      twdTack: r1(median(pairs)), nPairs: pairs.length
    };
  }

  // a polar given as {tws:[...], cols:[{a:[...], v:[...]}]} (the profile format): speed and the upwind target
  function polarFns(P) {
    function seg(xs, x) { if (x <= xs[0]) return [0, 0, 0]; for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return [i - 1, i, (x - xs[i - 1]) / (xs[i] - xs[i - 1])]; var l = xs.length - 1; return [l, l, 0]; }
    function col(c, a) { var w = seg(c.a, a); return c.v[w[0]] + (c.v[w[1]] - c.v[w[0]]) * w[2]; }
    function bsp(twa, tws) { var a = Math.abs(wrap180(twa)), w = seg(P.tws, tws), sc = tws < P.tws[0] ? Math.max(0, tws / P.tws[0]) : 1; return (col(P.cols[w[0]], a) + (col(P.cols[w[1]], a) - col(P.cols[w[0]], a)) * w[2]) * sc; }
    function up(tws) { var best = null; for (var a = 30; a <= 60; a += 0.5) { var v = bsp(a, tws), g = v * Math.cos(a * D2R); if (!best || g > best.vmg) best = { twa: a, bsp: v, vmg: g }; } return best; }
    return { bsp: bsp, up: up };
  }

  var api = { analyse: analyse, summarize: summarize, polarFns: polarFns, resample: resample };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRCalib = api;
})(this);
