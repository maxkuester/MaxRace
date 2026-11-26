// MaxRace routing: isochrone routing from a position to a destination, with the boat's polar and a wind field that changes in space
// and time (a GRIB, or one measured wind).
//   route(opts)          fastest route: expands a front of positions step by step, keeps the farthest point in each bearing sector,
//                        stops when a segment passes the destination. A tack or gybe costs `tackSec` seconds (take it from the
//                        measured tack loss). Wind comes from opts.wind(tMs, lat, lon) -> {tws_kn, twd_deg} | null.
//   departureScan(opts)  the same route for several start times: best departure.
//   ensemble(opts)       the same route over several wind scenarios (models, or one wind with direction/speed errors): ETA spread.
//   compare(opts)        named winds (e.g. two models) side by side.
//   biasWind(wind, b)    a wind corrected by a measured bias (direction in degrees, speed factor).
// Land: there is no coastline in MaxRace. Keep out of land with exclusion polygons (opts.exclude: [[[lat,lon],...],...]) and/or
// opts.blocked(lat, lon). Without them the route can cross land: check it on the chart.
// Works in the page (window.MRRouting) and in Node (module.exports).
(function (root) {
  "use strict";
  var D2R = Math.PI / 180, R2D = 180 / Math.PI, NM_M = 1852;
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function wrap360(a) { return ((a % 360) + 360) % 360; }

  function dest(lat, lon, brg, nm) {
    var d = nm / 3440.065, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
  }
  function bearDist(lat1, lon1, lat2, lon2) {          // great circle: bearing (deg) and distance (nm)
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var a = Math.sin((p2 - p1) / 2) * Math.sin((p2 - p1) / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return { b: wrap360(Math.atan2(y, x) * R2D), d: 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a))) };
  }
  function inPoly(lat, lon, poly) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function makeBlocked(o) {
    var polys = o.exclude || [];
    return function (lat, lon) { if (o.blocked && o.blocked(lat, lon)) return true; for (var i = 0; i < polys.length; i++) if (inPoly(lat, lon, polys[i])) return true; return false; };
  }
  function segBlocked(blocked, a, b, stepNm) {          // sample the segment every ~stepNm
    var bd = bearDist(a.lat, a.lon, b.lat, b.lon), n = Math.max(1, Math.ceil(bd.d / stepNm));
    for (var i = 1; i <= n; i++) { var p = dest(a.lat, a.lon, bd.b, bd.d * i / n); if (blocked(p.lat, p.lon)) return true; }
    return false;
  }
  // closest approach of the segment p->q to the destination (flat, local): fraction 0..1 and distance nm
  function approach(p, q, dst) {
    var k = Math.cos(p.lat * D2R), ax = 0, ay = 0, bx = (q.lon - p.lon) * 60 * k, by = (q.lat - p.lat) * 60, cx = (dst.lon - p.lon) * 60 * k, cy = (dst.lat - p.lat) * 60;
    var L2 = bx * bx + by * by, f = L2 > 0 ? Math.max(0, Math.min(1, (cx * bx + cy * by) / L2)) : 0;
    return { f: f, d: Math.hypot(cx - bx * f, cy - by * f) };
  }

  function route(o) {
    var start = o.start, dst = o.dest, t0 = o.t0 == null ? Date.now() : o.t0, dtMin = o.stepMin || 10, dt = dtMin * 60000, hs = o.headingStep || 5, binDeg = o.binDeg || 1.5;
    var tackSec = fin(o.tackSec) ? o.tackSec : 0, maxH = o.maxHours || 48, radius = o.arriveNm || 0.1, wind = o.wind, polar = o.polar;
    if (!wind || !polar || !start || !dst) return { ok: false, reason: "missing input" };
    var blocked = makeBlocked(o), nb = Math.round(360 / binDeg), steps = Math.ceil(maxH * 60 / dtMin), keep = !!o.keepFronts;
    if (blocked(start.lat, start.lon)) return { ok: false, reason: "start is inside an exclusion zone" };
    if (blocked(dst.lat, dst.lon)) return { ok: false, reason: "destination is inside an exclusion zone" };
    var front = [{ lat: start.lat, lon: start.lon, t: t0, parent: null, side: 0, hdg: NaN, twa: NaN, tws: NaN, bsp: NaN }], fronts = [], noWind = 0, best = null;
    for (var s = 0; s < steps && !best; s++) {
      var bins = {}, any = false;
      for (var i = 0; i < front.length; i++) {
        var p = front[i], w = wind(p.t, p.lat, p.lon);
        if (!w || !fin(w.tws_kn) || !fin(w.twd_deg)) { noWind++; continue; }
        for (var h = 0; h < 360; h += hs) {
          var twa = wrap180(w.twd_deg - h), side = twa >= 0 ? 1 : -1, v = polar(Math.abs(twa), w.tws_kn);
          if (!(v > 0.05)) continue;
          var sec = dt / 1000 - (p.side && p.side !== side ? tackSec : 0);       // a tack or gybe eats part of the step
          if (sec <= 0) continue;
          var nm = v * sec / 3600, q = dest(p.lat, p.lon, h, nm);
          if (blocked(q.lat, q.lon) || segBlocked(blocked, p, q, 0.5)) continue;
          var nt = p.t + dt, node = { lat: q.lat, lon: q.lon, t: nt, parent: p, side: side, hdg: h, twa: twa, tws: w.tws_kn, bsp: v, nm: nm };
          any = true;
          var ap = approach(p, q, dst);
          if (ap.d <= radius) {                                                         // passes the destination during this step
            var eta = p.t + (p.side && p.side !== side ? tackSec * 1000 : 0) + ap.f * sec * 1000;
            if (!best || eta < best.eta) best = { eta: eta, node: node, from: p, f: ap.f };
          }
          var bd = bearDist(start.lat, start.lon, q.lat, q.lon), k = Math.floor(bd.b / binDeg) % nb;
          node.ds = bd.d;
          if (!bins[k] || node.ds > bins[k].ds) bins[k] = node;
        }
      }
      if (!any) return { ok: false, reason: noWind ? "the wind data does not cover the route" : "no way forward (zones or no wind)", steps: s };
      front = Object.keys(bins).map(function (k) { return bins[k]; });
      if (keep) fronts.push(front.map(function (n) { return [n.lat, n.lon]; }));
    }
    if (!best) return { ok: false, reason: "not reached in " + maxH + " h", steps: steps };
    var path = [], n = best.node;
    path.push({ lat: dst.lat, lon: dst.lon, t: best.eta, hdg: n.hdg, twa: n.twa, tws: n.tws, bsp: n.bsp, final: true });
    for (n = best.from; n; n = n.parent) path.push({ lat: n.lat, lon: n.lon, t: n.t, hdg: n.hdg, twa: n.twa, tws: n.tws, bsp: n.bsp });
    path.reverse();
    var tacks = 0, dist = 0;
    for (var j = 1; j < path.length; j++) { dist += bearDist(path[j - 1].lat, path[j - 1].lon, path[j].lat, path[j].lon).d; if (j > 1 && fin(path[j].twa) && fin(path[j - 1].twa) && Math.sign(path[j].twa) !== Math.sign(path[j - 1].twa)) tacks++; }
    var direct = bearDist(start.lat, start.lon, dst.lat, dst.lon).d;
    return { ok: true, eta: best.eta, hours: (best.eta - t0) / 3600000, path: path, tacks: tacks, sailedNm: dist, directNm: direct, fronts: fronts };
  }

  function departureScan(o) {
    var out = [], base = o.t0 == null ? Date.now() : o.t0, step = (o.everyMin || 60) * 60000, n = o.count || 12;
    for (var i = 0; i < n; i++) { var r = route(Object.assign({}, o, { t0: base + i * step, keepFronts: false })); out.push({ t0: base + i * step, ok: r.ok, eta: r.ok ? r.eta : null, hours: r.ok ? r.hours : null, reason: r.reason }); }
    var good = out.filter(function (x) { return x.ok; }).sort(function (a, b) { return a.eta - b.eta; });
    return { options: out, best: good.length ? good[0] : null };
  }
  function summarise(list) {
    var h = list.filter(function (x) { return x.ok; }).map(function (x) { return x.hours; }).sort(function (a, b) { return a - b; });
    if (!h.length) return { n: 0 };
    var q = function (p) { return h[Math.min(h.length - 1, Math.floor(p * h.length))]; };
    return { n: h.length, of: list.length, min: h[0], median: q(0.5), p10: q(0.1), p90: q(0.9), max: h[h.length - 1] };
  }
  function biasWind(wind, b) {
    b = b || {};
    return function (t, lat, lon) { var w = wind(t, lat, lon); if (!w) return null; return { tws_kn: w.tws_kn * (fin(b.speedFactor) ? b.speedFactor : 1), twd_deg: wrap360(w.twd_deg + (fin(b.dirDeg) ? b.dirDeg : 0)) }; };
  }
  function ensemble(o) {                    // o.scenarios: [{name, wind}] or o.dirErrors/o.speedFactors around o.wind
    var sc = o.scenarios;
    if (!sc) { sc = []; (o.dirErrors || [-10, 0, 10]).forEach(function (d) { (o.speedFactors || [0.9, 1, 1.1]).forEach(function (f) { sc.push({ name: "dir " + d + "°, speed ×" + f, wind: biasWind(o.wind, { dirDeg: d, speedFactor: f }) }); }); }); }
    var res = sc.map(function (s) { var r = route(Object.assign({}, o, { wind: s.wind, keepFronts: false })); return { name: s.name, ok: r.ok, hours: r.ok ? r.hours : null, eta: r.ok ? r.eta : null, tacks: r.ok ? r.tacks : null, reason: r.reason }; });
    return { runs: res, summary: summarise(res) };
  }
  function compare(o) {                     // o.winds: {name: wind}
    var out = {}; Object.keys(o.winds).forEach(function (k) { var r = route(Object.assign({}, o, { wind: o.winds[k], keepFronts: false })); out[k] = r.ok ? { ok: true, hours: r.hours, eta: r.eta, tacks: r.tacks, path: r.path } : { ok: false, reason: r.reason }; });
    return out;
  }
  var api = { route: route, departureScan: departureScan, ensemble: ensemble, compare: compare, biasWind: biasWind, summarise: summarise, dest: dest, bearDist: bearDist };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRRouting = api;
})(this);
